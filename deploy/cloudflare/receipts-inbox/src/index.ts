/**
 * Email Worker `receipts-inbox` (08 §3.4, F06 INB-048, EC-INB-25).
 *
 * Cloudflare Email Routing (`belege@in.<domain>`) → this Worker → R2 bucket `rechnungen-inbox`, key
 * `inbox/<epochMs>-<uuid>.eml`. The app polls the bucket from inside the tailnet (INB-049).
 *
 * The Worker is deliberately dumb: it stores the unaltered raw message, never parses, never filters senders
 * (INB-051 flags unknown senders app-side) and never deletes. A failed `put` throws, so Email Routing does not
 * accept the message silently (retry/bounce behaviour: P2 spike, 08 §3.4).
 *
 * Types are declared locally (subset of @cloudflare/workers-types) to keep the repo free of extra dependencies.
 */

export interface InboundEmail {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

export interface InboxBucket {
  put(
    key: string,
    value: ArrayBuffer,
    options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface Env {
  INBOX: InboxBucket;
}

export interface Deps {
  now: () => number;
  uuid: () => string;
}

/** 25 MiB — Cloudflare Email Routing's own message limit; larger mails bounce (EC-INB-25). */
export const MAX_RAW_BYTES = 25 * 1024 * 1024;
export const REJECT_TOO_LARGE =
  "Nachricht zu groß (max. 25 MB) – bitte Rechnung in mehreren E-Mails oder als Link senden";

/** R2 limits custom metadata to 2 KiB in total; the app re-reads all headers from the .eml anyway (INB-050). */
const META_LIMITS = { from: 320, to: 320, subject: 600, messageId: 400 } as const;

function clip(value: string, max: number): string {
  // Strip control characters (header folding etc.) so the metadata stays a single printable line.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function objectKey(epochMs: number, uuid: string): string {
  return `inbox/${epochMs}-${uuid}.eml`;
}

export async function handleEmail(message: InboundEmail, env: Env, deps: Deps): Promise<string | null> {
  if (message.rawSize > MAX_RAW_BYTES) {
    message.setReject(REJECT_TOO_LARGE);
    return null;
  }
  // R2 needs a known length; reading the stream also yields the byte-exact original (GoBD: the .eml is the original).
  const raw = await new Response(message.raw).arrayBuffer();
  if (raw.byteLength > MAX_RAW_BYTES) {
    message.setReject(REJECT_TOO_LARGE);
    return null;
  }
  const key = objectKey(deps.now(), deps.uuid());
  await env.INBOX.put(key, raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      from: clip(message.from, META_LIMITS.from),
      to: clip(message.to, META_LIMITS.to),
      subject: clip(message.headers.get("subject") ?? "", META_LIMITS.subject),
      messageId: clip(message.headers.get("message-id") ?? "", META_LIMITS.messageId),
      rawSize: String(message.rawSize),
    },
  });
  return key;
}

export default {
  async email(message: InboundEmail, env: Env): Promise<void> {
    await handleEmail(message, env, { now: () => Date.now(), uuid: () => crypto.randomUUID() });
  },
};
