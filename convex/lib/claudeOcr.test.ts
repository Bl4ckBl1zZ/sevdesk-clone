import { PDFDocument } from "@cantoo/pdf-lib";
import { afterEach, describe, expect, test } from "vitest";
import { postValidateExtraction } from "../../src/domain/inbox/ocr";
import { CLAUDE_DEFAULTS } from "../../src/domain/inbox/ocr-settings";
import {
  CLAUDE_FAKE_EXTRACTION,
  claudeFake,
  claudeFakeFetch,
  claudeFakeMessage,
  claudeOcrClient,
  claudeOcrFor,
} from "./claudeOcr";

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([200, 200]);
  return doc.save();
}

type Req = {
  model: string;
  max_tokens: number;
  thinking?: unknown;
  temperature?: unknown;
  system: string;
  output_config: { format: { type: string; schema: Record<string, unknown> } };
  messages: { role: string; content: { type: string; source?: { media_type: string; data: string } }[] }[];
};

const client = () => claudeOcrClient({ apiKey: "sk-test", fetchImpl: claudeFakeFetch, maxRetries: 0 });

afterEach(() => claudeFake.reset());

describe("Claude OCR adapter (INB-025)", () => {
  test("INB-025 T06-031 sends the PDF cut to the first 5 pages with a JSON-schema output format; cents, no floats", async () => {
    const r = await client().extract({
      model: CLAUDE_DEFAULTS.model,
      file: { mime: "application/pdf", bytes: await pdfWithPages(7) },
      pageLimit: CLAUDE_DEFAULTS.pageLimit,
    });
    expect(claudeFake.calls).toBe(1);
    const req = claudeFake.requests[0] as Req;
    expect(req.model).toBe("claude-sonnet-5-5");
    expect(req.thinking).toBeUndefined();
    expect(req.temperature).toBeUndefined();
    expect(req.output_config.format.type).toBe("json_schema");
    expect(req.output_config.format.schema.additionalProperties).toBe(false);
    const block = req.messages[0]?.content[0];
    expect(block?.type).toBe("document");
    expect(block?.source?.media_type).toBe("application/pdf");
    const sent = await PDFDocument.load(Uint8Array.from(atob(block?.source?.data ?? ""), (c) => c.charCodeAt(0)));
    expect(sent.getPageCount()).toBe(5);
    expect(req.system).toMatch(/keine Anweisung/);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model).toBe("claude-sonnet-5-5");
    expect(r.extraction.fieldConfidence).toEqual({ "supplier.name": 0.98, invoiceDate: 0.97, "totals.gross": 0.99 });
    const a = postValidateExtraction(r.extraction, { today: "2026-10-19" });
    expect(a.prefill.statedTotals?.grossCents).toBe(11_900);
    expect(Number.isInteger(a.prefill.lines?.[0]?.amountCents)).toBe(true);
    expect(a.confidence).toBe(0.97);
  });

  test("INB-025 images go as image blocks; HEIC/TIFF/XML are unsupported without any request", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const r = await client().extract({
      model: "claude-sonnet-5-5",
      file: { mime: "image/png", bytes: png },
      pageLimit: 5,
    });
    expect(r.ok).toBe(true);
    expect((claudeFake.requests[0] as Req).messages[0]?.content[0]?.type).toBe("image");
    for (const mime of ["image/heic", "image/tiff", "application/xml", "message/rfc822"]) {
      const u = await client().extract({ model: "claude-sonnet-5-5", file: { mime, bytes: png }, pageLimit: 5 });
      expect(u).toEqual({ ok: false, retryable: false, detail: "unsupported" });
    }
    expect(claudeFake.calls).toBe(1);
  });

  test("INB-025 a refusal, a truncated or non-schema answer is not retried (manual entry)", async () => {
    const pdf = await pdfWithPages(1);
    const file = { mime: "application/pdf", bytes: pdf };
    claudeFake.respond = () => claudeFakeMessage("", { stopReason: "refusal" });
    expect(await client().extract({ model: "m", file, pageLimit: 5 })).toEqual({
      ok: false,
      retryable: false,
      detail: "refusal",
    });
    claudeFake.respond = () => claudeFakeMessage('{"documentType":', { stopReason: "max_tokens" });
    expect(await client().extract({ model: "m", file, pageLimit: 5 })).toMatchObject({
      ok: false,
      detail: "max_tokens",
    });
    claudeFake.respond = () => claudeFakeMessage({ hello: "world" });
    expect(await client().extract({ model: "m", file, pageLimit: 5 })).toMatchObject({
      ok: false,
      retryable: false,
      detail: "schema_mismatch",
    });
  });

  test("INB-025 HTTP errors: 429/5xx are retryable, 401 is not", async () => {
    const file = { mime: "application/pdf", bytes: await pdfWithPages(1) };
    claudeFake.respond = () => ({
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "slow" } },
    });
    expect(await client().extract({ model: "m", file, pageLimit: 5 })).toMatchObject({ ok: false, retryable: true });
    claudeFake.respond = () => ({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
    });
    expect(await client().extract({ model: "m", file, pageLimit: 5 })).toMatchObject({ ok: false, retryable: false });
  });

  test("SET-112 the connection test sends a minimal request without business data and reports model and latency", async () => {
    claudeFake.respond = () => claudeFakeMessage("OK");
    const r = await client().test("claude-sonnet-5-5");
    expect(r).toMatchObject({ ok: true, model: "claude-sonnet-5-5" });
    const req = claudeFake.requests[0] as { messages: { content: unknown }[]; max_tokens: number };
    expect(req.messages).toEqual([{ role: "user", content: "Antworte nur mit OK." }]);
    expect(req.max_tokens).toBeLessThanOrEqual(16);
    claudeFake.respond = () => ({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "bad key" } },
    });
    expect(await client().test("claude-sonnet-5-5")).toMatchObject({ ok: false });
  });

  test("T06-034 claudeOcrFor uses the fake only with IS_TEST and claudeFake.enabled; calls are counted", async () => {
    process.env.IS_TEST = "true"; // as in convex/test.setup.ts (TEST_ENV)
    claudeFake.enabled = true;
    const r = await claudeOcrFor({ apiKey: "" }).extract({
      model: "claude-sonnet-5-5",
      file: { mime: "application/pdf", bytes: await pdfWithPages(2) },
      pageLimit: 5,
    });
    expect(r.ok).toBe(true);
    expect(claudeFake.calls).toBe(1);
    expect(CLAUDE_FAKE_EXTRACTION.supplier.vatId).toBe("DE123456788");
  });
});
