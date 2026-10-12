import { describe, expect, test, vi } from "vitest";
import worker, { handleEmail, type InboundEmail, type InboxBucket, MAX_RAW_BYTES, REJECT_TOO_LARGE } from "./index";

const UUID = "0b7c3a52-9c1e-4c55-9f0e-2a4f0d1c9e11";
const deps = { now: () => 1_791_820_800_000, uuid: () => UUID };

function message(
  bytes: Uint8Array<ArrayBuffer>,
  opts: { rawSize?: number; from?: string; headers?: Record<string, string> } = {},
) {
  const setReject = vi.fn();
  const msg: InboundEmail = {
    from: opts.from ?? "rechnung@lieferant.example",
    to: "belege@in.example.de",
    headers: new Headers(opts.headers ?? { subject: "Rechnung 2026-0815", "message-id": "<abc@lieferant.example>" }),
    raw: new Response(bytes).body as ReadableStream<Uint8Array>,
    rawSize: opts.rawSize ?? bytes.byteLength,
    setReject,
  };
  return { msg, setReject };
}

function bucket() {
  const puts: Array<{ key: string; value: ArrayBuffer; options: Parameters<InboxBucket["put"]>[2] }> = [];
  const INBOX: InboxBucket = {
    put: async (key, value, options) => {
      puts.push({ key, value, options });
      return {};
    },
  };
  return { env: { INBOX }, puts };
}

function mime(size: number): Uint8Array<ArrayBuffer> {
  const head = new TextEncoder().encode("From: rechnung@lieferant.example\r\nSubject: Rechnung\r\n\r\n");
  const out = new Uint8Array(size);
  out.set(head);
  for (let i = head.length; i < size; i++) out[i] = (i * 31) % 251;
  return out;
}

describe("receipts-inbox Email Worker", () => {
  test("INB-048 stores a 1 MiB message once under inbox/<epochMs>-<uuid>.eml, byte-identical, with metadata (T06-152)", async () => {
    const bytes = mime(1024 * 1024);
    const { msg, setReject } = message(bytes);
    const { env, puts } = bucket();

    const key = await handleEmail(msg, env, deps);

    expect(key).toBe(`inbox/1791820800000-${UUID}.eml`);
    expect(key).toMatch(/^inbox\/\d{13}-[0-9a-f-]{36}\.eml$/);
    expect(puts).toHaveLength(1);
    expect(new Uint8Array(puts[0]?.value ?? new ArrayBuffer(0))).toEqual(bytes);
    expect(puts[0]?.options).toEqual({
      httpMetadata: { contentType: "message/rfc822" },
      customMetadata: {
        from: "rechnung@lieferant.example",
        to: "belege@in.example.de",
        subject: "Rechnung 2026-0815",
        messageId: "<abc@lieferant.example>",
        rawSize: String(1024 * 1024),
      },
    });
    expect(setReject).not.toHaveBeenCalled();
  });

  test("INB-048 EC-INB-25 rejects a 26 MiB message with the German text and stores nothing (T06-152)", async () => {
    const { msg, setReject } = message(mime(64), { rawSize: 26 * 1024 * 1024 });
    const { env, puts } = bucket();

    expect(await handleEmail(msg, env, deps)).toBeNull();
    expect(setReject).toHaveBeenCalledWith(REJECT_TOO_LARGE);
    expect(REJECT_TOO_LARGE).toBe(
      "Nachricht zu groß (max. 25 MB) – bitte Rechnung in mehreren E-Mails oder als Link senden",
    );
    expect(puts).toHaveLength(0);
  });

  test("INB-048 EC-INB-25 accepts a message of exactly 25 MiB (limit is inclusive)", async () => {
    const { msg, setReject } = message(mime(64), { rawSize: MAX_RAW_BYTES });
    const { env, puts } = bucket();
    await handleEmail(msg, env, deps);
    expect(setReject).not.toHaveBeenCalled();
    expect(puts).toHaveLength(1);
  });

  test("INB-048 INB-051 stores mail from any sender (no filtering in the Worker) (T06-152)", async () => {
    const { msg } = message(mime(256), { from: "unbekannt@spam.example" });
    const { env, puts } = bucket();
    await handleEmail(msg, env, deps);
    expect(puts[0]?.options?.customMetadata?.from).toBe("unbekannt@spam.example");
  });

  test("INB-048 missing headers become empty strings; long values and control characters are clipped to fit R2 metadata", async () => {
    const { msg } = message(mime(128), { headers: { subject: `Rechnung\t${"x".repeat(2000)}` } });
    const { env, puts } = bucket();
    await handleEmail(msg, env, deps);
    const meta = puts[0]?.options?.customMetadata ?? {};
    expect(meta.messageId).toBe("");
    expect(meta.subject?.startsWith("Rechnung x")).toBe(true);
    expect(meta.subject?.length).toBeLessThanOrEqual(600);
    const total = Object.entries(meta).reduce((n, [k, v]) => n + k.length + new TextEncoder().encode(v).length, 0);
    expect(total).toBeLessThanOrEqual(2048);
  });

  test("INB-048 a failed put throws so the message is not silently accepted", async () => {
    const { msg } = message(mime(128));
    const env = { INBOX: { put: async () => Promise.reject(new Error("R2 down")) } };
    await expect(handleEmail(msg, env, deps)).rejects.toThrow("R2 down");
  });

  test("INB-048 the default export uses Date.now() and crypto.randomUUID()", async () => {
    const { msg } = message(mime(128));
    const { env, puts } = bucket();
    await worker.email(msg, env);
    expect(puts[0]?.key).toMatch(
      /^inbox\/\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.eml$/,
    );
  });
});
