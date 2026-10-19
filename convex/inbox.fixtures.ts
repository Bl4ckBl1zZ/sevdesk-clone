import { afterEach, beforeEach } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { claudeFake } from "./lib/claudeOcr";
import { type InboundOutcome, inboundValidatorFake } from "./lib/einvoiceInbound";
import { memoryInbox } from "./lib/r2Inbox";
import type { TestT } from "./test.setup";

/**
 * Inbox-slice fixtures (not a Convex module: multi-dot file name): upload through the real `inbox.ingest` action,
 * a settle loop that ignores retries scheduled in the future (sidecar backoff), the fake sidecar / Claude / R2 hooks.
 */

type Caller = { action: TestT["action"]; mutation: TestT["mutation"]; query: TestT["query"] };

export const enc = (s: string) => new TextEncoder().encode(s);

/** Stores the bytes and runs `inbox.ingest` (several files = pages of one item). */
export async function ingest(
  t: TestT,
  caller: Caller,
  files: readonly { bytes: Uint8Array; name: string; clientCapturedAt?: number }[],
  opts: { via?: "upload" | "app" } = {},
) {
  const stored = [];
  for (const f of files) {
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([f.bytes as BlobPart])));
    stored.push({ storageId, name: f.name, ...(f.clientCapturedAt ? { clientCapturedAt: f.clientCapturedAt } : {}) });
  }
  return caller.action(api.inbox.ingest, { files: stored, ...(opts.via ? { via: opts.via } : {}) });
}

/** Runs scheduled functions that are due; retries scheduled in the future stay pending. */
export async function settleInbox(t: TestT) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (j) => j.state.kind === "inProgress" || (j.state.kind === "pending" && j.scheduledTime <= Date.now() + 1000),
      ),
    );
    if (pending.length === 0) return;
  }
  throw new Error("scheduled functions did not settle");
}

/** Runs the classify job of an item again immediately (the retry that the scheduler would run later). */
export async function runRetry(t: TestT, id: Id<"inboxItems">) {
  const item = (await t.run((ctx) => ctx.db.get(id))) as Doc<"inboxItems">;
  const { internal } = await import("./_generated/api");
  await t.action(internal.inboxNode.classify, {
    id,
    actorContext: { actor: item.actor, channel: item.actor.startsWith("system:") ? "cron" : "ui" },
  });
  await settleInbox(t);
}

export const item = (t: TestT, id: Id<"inboxItems">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"inboxItems">>;
export const voucherOf = (t: TestT, id: Id<"vouchers">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"vouchers">>;

export const validatorPasses = (tool = "kosit 1.6.3 / xrechnung 3.0.2"): InboundOutcome => ({
  kind: "done",
  acceptable: true,
  report: JSON.stringify({ acceptable: true, errors: [] }),
  tool,
  findings: [],
});

/** Resets the module-level fakes around every test of a file. */
export function installInboxFakes() {
  beforeEach(() => {
    inboundValidatorFake.reset();
    claudeFake.reset();
    memoryInbox.reset();
    process.env.R2_INBOX_FAKE = "true";
  });
  afterEach(() => {
    inboundValidatorFake.reset();
    claudeFake.reset();
    memoryInbox.reset();
    delete process.env.R2_INBOX_FAKE;
  });
}

export async function enableOcr(caller: Caller, over: Record<string, unknown> = {}) {
  return caller.mutation(api.inbox.saveOcr, {
    enabled: true,
    dpaConfirmed: true,
    region: "eu",
    apiKey: "sk-ant-test-0123456789",
    ...over,
  });
}

export async function enableInbox(caller: Caller, over: Record<string, unknown> = {}) {
  return caller.mutation(api.inbox.saveInbox, {
    enabled: true,
    dpaConfirmed: true,
    receivingAddress: "belege@in.example.de",
    allowlist: "",
    ...over,
  });
}

/** A raw .eml (CRLF) with optional attachments (base64). */
export function eml(opts: {
  from?: string;
  subject?: string;
  messageId?: string;
  text?: string;
  html?: string;
  headers?: string[];
  attachments?: { name: string; mime: string; bytes: Uint8Array; inline?: boolean; cid?: string }[];
}): Uint8Array {
  const b = "BOUNDARY-42";
  const b64 = (u: Uint8Array) => {
    let s = "";
    for (const x of u) s += String.fromCharCode(x);
    return btoa(s).replace(/(.{76})/g, "$1\r\n");
  };
  const lines = [
    `From: ${opts.from ?? "Rechnung <rechnung@lieferant.de>"}`,
    "To: belege@in.example.de",
    `Subject: ${opts.subject ?? "Ihre Rechnung"}`,
    `Message-ID: <${opts.messageId ?? `${Math.random().toString(36).slice(2)}@lieferant.de`}>`,
    "Date: Mon, 19 Oct 2026 08:00:00 +0200",
    ...(opts.headers ?? []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    opts.html ? "Content-Type: text/html; charset=utf-8" : "Content-Type: text/plain; charset=utf-8",
    "",
    opts.html ?? opts.text ?? "Anbei die Rechnung.",
  ];
  for (const a of opts.attachments ?? []) {
    lines.push(
      `--${b}`,
      `Content-Type: ${a.mime}; name="${a.name}"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: ${a.inline ? "inline" : "attachment"}; filename="${a.name}"`,
      ...(a.cid ? [`Content-ID: <${a.cid}>`] : []),
      "",
      b64(a.bytes),
    );
  }
  lines.push(`--${b}--`, "");
  return enc(lines.join("\r\n"));
}

/** Puts an object into the fake R2 bucket. */
export function putR2(key: string, bytes: Uint8Array, lastModified = Date.now()) {
  memoryInbox.objects.set(key, { bytes, lastModified, etag: `"${key.length}-${bytes.byteLength}"` });
}
