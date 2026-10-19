import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PDFDocument } from "@cantoo/pdf-lib";
import { OCR_SYSTEM_PROMPT, OCR_USER_TEXT } from "../../src/domain/inbox/ocr-prompt";
import {
  extractionFromWire,
  type ReceiptExtraction,
  ReceiptExtractionWire,
} from "../../src/domain/schemas/receipt-extraction";
import { isTest } from "./env";

/**
 * Claude OCR adapter (F06 INB-025, F01 SET-111/112). Runs inside a Convex action. Uses the official SDK with
 * structured outputs (`output_config.format` = JSON schema of `ReceiptExtractionWire`); the answer is untrusted
 * input (INB-030) and is validated again by `extractionFromWire` (zod) and `postValidateExtraction` (domain).
 *
 *  - PDFs are cut to the first `pageLimit` pages before sending (INB-025); images (JPEG/PNG/WebP/GIF) go as image
 *    blocks; any other type (HEIC, TIFF, XML, EML, encrypted PDF) returns `unsupported` without a request (manual).
 *  - `thinking` and sampling parameters are not set (Sonnet 5.5 rejects disabled thinking); a `refusal` or a
 *    truncated answer is not retried — the item goes to manual entry.
 *  - No server-side `fallbacks`: the model is the owner's configured choice (possibly an EU endpoint that does not
 *    know the parameter); a refusal simply means manual entry.
 *  - Tests swap the transport through `claudeFake` (a `fetch` that answers like the Messages API), so the SDK path
 *    including request serialisation and response parsing is exercised and calls can be counted.
 */

export interface OcrFile {
  mime: string;
  bytes: Uint8Array;
}

export type OcrResult =
  | { ok: true; extraction: ReceiptExtraction; raw: unknown; model: string }
  | { ok: false; retryable: boolean; detail: string };

export type OcrTestResult = { ok: true; model: string; latencyMs: number } | { ok: false; detail: string };

export interface ClaudeOcr {
  extract(args: { model: string; file: OcrFile; pageLimit: number }): Promise<OcrResult>;
  test(model: string): Promise<OcrTestResult>;
}

export interface ClaudeOcrConfig {
  apiKey: string;
  baseURL?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_TOKENS = 8_000;
const TIMEOUT_MS = 90_000;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** INB-025 „first 5 pages only“: a copy with the first `limit` pages; the original stays untouched. */
export async function firstPages(pdf: Uint8Array, limit: number): Promise<Uint8Array | "encrypted"> {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(pdf, { updateMetadata: false });
  } catch (e) {
    if (e instanceof Error && /encrypt/i.test(e.message)) return "encrypted";
    throw e;
  }
  if (doc.getPageCount() <= limit) return pdf;
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(
    doc,
    Array.from({ length: limit }, (_, i) => i),
  );
  for (const p of pages) out.addPage(p);
  return out.save();
}

const format = (() => {
  const f = zodOutputFormat(ReceiptExtractionWire);
  return { type: f.type, schema: f.schema };
})();

function failure(e: unknown): { ok: false; retryable: boolean; detail: string } {
  if (e instanceof Anthropic.APIError) {
    const status = e.status;
    const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
    return { ok: false, retryable, detail: `HTTP ${status ?? "?"}: ${e.message}`.slice(0, 300) };
  }
  return { ok: false, retryable: true, detail: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
}

export function claudeOcrClient(config: ClaudeOcrConfig): ClaudeOcr {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.baseURL ? { baseURL: config.baseURL } : {}),
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
    maxRetries: config.maxRetries ?? 2,
    timeout: TIMEOUT_MS,
  });
  return {
    async extract({ model, file, pageLimit }) {
      let block: Anthropic.ContentBlockParam;
      if (file.mime === "application/pdf") {
        let bytes: Uint8Array | "encrypted";
        try {
          bytes = await firstPages(file.bytes, Math.max(1, pageLimit));
        } catch (e) {
          return { ok: false, retryable: false, detail: `pdf_unreadable: ${String(e).slice(0, 200)}` };
        }
        if (bytes === "encrypted") return { ok: false, retryable: false, detail: "encrypted" };
        block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(bytes) } };
      } else if (IMAGE_TYPES.has(file.mime)) {
        block = {
          type: "image",
          source: {
            type: "base64",
            media_type: file.mime as "image/jpeg" | "image/png" | "image/webp" | "image/gif",
            data: toBase64(file.bytes),
          },
        };
      } else {
        return { ok: false, retryable: false, detail: "unsupported" };
      }
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model,
          max_tokens: MAX_TOKENS,
          system: OCR_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [block, { type: "text", text: OCR_USER_TEXT }] }],
          output_config: { format },
        });
      } catch (e) {
        return failure(e);
      }
      if (message.stop_reason === "refusal") return { ok: false, retryable: false, detail: "refusal" };
      if (message.stop_reason === "max_tokens") return { ok: false, retryable: false, detail: "max_tokens" };
      const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
      if (!text) return { ok: false, retryable: false, detail: "empty_response" };
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        return { ok: false, retryable: false, detail: "invalid_json" };
      }
      const wire = ReceiptExtractionWire.safeParse(raw);
      if (!wire.success) return { ok: false, retryable: false, detail: "schema_mismatch" };
      try {
        return { ok: true, extraction: extractionFromWire(wire.data), raw, model: message.model };
      } catch {
        return { ok: false, retryable: false, detail: "schema_mismatch" };
      }
    },
    async test(model) {
      const start = Date.now();
      try {
        const message = await client.messages.create({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Antworte nur mit OK." }],
        });
        return { ok: true, model: message.model, latencyMs: Date.now() - start };
      } catch (e) {
        return { ok: false, detail: failure(e).detail };
      }
    },
  };
}

// ── test fake ───────────────────────────────────────────────────────────────────────────────────────────

/** Messages API response JSON for a structured-output answer (tests). */
export function claudeFakeMessage(
  output: unknown,
  opts: { model?: string; stopReason?: string } = {},
): Record<string, unknown> {
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-sonnet-5-5",
    content: [{ type: "text", text: typeof output === "string" ? output : JSON.stringify(output) }],
    stop_reason: opts.stopReason ?? "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

/** A plausible wire answer: Telekom invoice 119,00 € (100,00 + 19,00). */
export const CLAUDE_FAKE_EXTRACTION = {
  documentType: "invoice",
  supplier: {
    name: "Telekom Deutschland GmbH",
    address: "Landgrabenweg 151, 53227 Bonn",
    vatId: "DE123456788",
    taxNumber: null,
    iban: null,
    email: null,
  },
  buyerName: null,
  invoiceNumber: "R-2026-0815",
  invoiceDate: "2026-10-01",
  supplyDate: null,
  supplyPeriod: null,
  dueDate: null,
  currency: "EUR",
  totals: { net: "100.00", vat: "19.00", gross: "119.00" },
  vatLines: [{ ratePercent: "19", net: "100.00", vat: "19.00" }],
  lineItems: [{ description: "Mobilfunk", quantity: "1", net: "100.00", gross: "119.00", ratePercent: "19" }],
  skonto: null,
  paymentHint: "transfer_due",
  hospitality: { isRestaurant: false, tip: null, tseDataPresent: false },
  categoryHint: "Telefon",
  fieldConfidence: [
    { field: "supplier.name", confidence: 0.98 },
    { field: "invoiceDate", confidence: 0.97 },
    { field: "totals.gross", confidence: 0.99 },
  ],
} as const;

type FakeResponse = { status: number; body: unknown } | Record<string, unknown>;

/**
 * Module state shared by all actions of one convex-test process (like `memoryCheckpointStore`). `respond` receives
 * the parsed request body and returns either a Messages API JSON body or `{ status, body }`.
 */
export const claudeFake = {
  enabled: false,
  calls: 0,
  requests: [] as unknown[],
  respond: null as null | ((req: unknown) => FakeResponse),
  reset() {
    this.enabled = false;
    this.calls = 0;
    this.requests = [];
    this.respond = null;
  },
};

export const claudeFakeFetch: typeof fetch = async (_input, init) => {
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  claudeFake.calls++;
  claudeFake.requests.push(body);
  const answer = claudeFake.respond ? claudeFake.respond(body) : claudeFakeMessage(CLAUDE_FAKE_EXTRACTION);
  const { status, payload } =
    typeof answer.status === "number" && "body" in answer
      ? { status: answer.status, payload: answer.body }
      : { status: 200, payload: answer };
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
};

/** The real client, or — with IS_TEST and `claudeFake.enabled` — a client whose transport is the fake. */
export function claudeOcrFor(config: ClaudeOcrConfig): ClaudeOcr {
  if (isTest() && claudeFake.enabled) {
    return claudeOcrClient({
      ...config,
      apiKey: config.apiKey || "test-key",
      fetchImpl: claudeFakeFetch,
      maxRetries: 0,
    });
  }
  return claudeOcrClient(config);
}
