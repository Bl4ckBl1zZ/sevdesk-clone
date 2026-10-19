import { describe, expect, test } from "vitest";
import { INBOX_MAIL_MESSAGES, parseInboundEmail } from "./email";

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/.{76}/g, "$&\r\n");
};
const pdf = (tag: string) => enc.encode(`%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n% ${tag}\n%%EOF\n`);
const png = (size: number) => {
  const out = new Uint8Array(size);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return out;
};
const zip = () => new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);

interface Part {
  type: string;
  name?: string;
  inline?: boolean;
  cid?: string;
  body: Uint8Array | string;
  raw?: boolean;
}

function part(p: Part): string {
  const headers = [`Content-Type: ${p.type}${p.name ? `; name="${p.name}"` : ""}`];
  if (p.raw) {
    headers.push(`Content-Disposition: attachment${p.name ? `; filename="${p.name}"` : ""}`);
    return `${headers.join("\r\n")}\r\n\r\n${p.body as string}`;
  }
  if (p.name || p.inline) {
    headers.push(`Content-Disposition: ${p.inline ? "inline" : "attachment"}${p.name ? `; filename="${p.name}"` : ""}`);
  }
  if (p.cid) headers.push(`Content-ID: <${p.cid}>`);
  if (typeof p.body === "string") return `${headers.join("\r\n")}\r\n\r\n${p.body}`;
  headers.push("Content-Transfer-Encoding: base64");
  return `${headers.join("\r\n")}\r\n\r\n${b64(p.body)}`;
}

function mail(opts: {
  from?: string;
  subject?: string;
  messageId?: string;
  extraHeaders?: string[];
  text?: string;
  html?: string;
  parts?: Part[];
  boundary?: string;
}): string {
  const boundary = opts.boundary ?? "=_b0undary_42";
  const headers = [
    `From: ${opts.from ?? "Telekom Rechnung <Rechnung@Telekom.DE>"}`,
    "To: belege@in.example.de",
    `Subject: ${opts.subject ?? "Ihre Rechnung Oktober"}`,
    `Message-ID: <${opts.messageId ?? "abc-123@telekom.de"}>`,
    "Date: Mon, 12 Oct 2026 09:30:00 +0200",
    "MIME-Version: 1.0",
    ...(opts.extraHeaders ?? []),
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts: string[] = [];
  if (opts.text !== undefined) parts.push(part({ type: "text/plain; charset=utf-8", body: opts.text }));
  if (opts.html !== undefined) parts.push(part({ type: "text/html; charset=utf-8", body: opts.html }));
  for (const p of opts.parts ?? []) parts.push(part(p));
  return `${headers.join("\r\n")}\r\n\r\n${parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("")}--${boundary}--\r\n`;
}

const parse = async (raw: string | Uint8Array) => {
  const r = await parseInboundEmail(typeof raw === "string" ? enc.encode(raw) : raw);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

describe("INB-050 e-mail-in message processing", () => {
  test("INB-050 T06-153 headers come from the parsed message; the PDF is classified, an 8 KB inline logo and a cid: image are skipped", async () => {
    const m = await parse(
      mail({
        text: "Sehr geehrte Damen und Herren, anbei Ihre Rechnung.",
        html: '<p>Anbei Ihre Rechnung</p><img src="cid:sig@telekom">',
        parts: [
          { type: "application/pdf", name: "Rechnung-2026-10.pdf", body: pdf("rechnung") },
          { type: "image/png", name: "logo.png", inline: true, body: png(8 * 1024) },
          { type: "image/png", name: "signatur.png", inline: true, cid: "sig@telekom", body: png(40 * 1024) },
        ],
      }),
    );
    expect(m).toMatchObject({
      from: "rechnung@telekom.de",
      fromName: "Telekom Rechnung",
      to: "belege@in.example.de",
      subject: "Ihre Rechnung Oktober",
      messageId: "abc-123@telekom.de",
      date: "2026-10-12T07:30:00.000Z",
      hasHtml: true,
      authFailed: false,
    });
    expect(m.text).toContain("anbei Ihre Rechnung");
    const byName = Object.fromEntries(m.attachments.map((a) => [a.filename, a]));
    expect(byName["Rechnung-2026-10.pdf"]).toMatchObject({ decision: "classify", mime: "application/pdf" });
    expect(byName["Rechnung-2026-10.pdf"]?.bytes).toEqual(pdf("rechnung"));
    expect(byName["logo.png"]?.decision).toBe("skip_inline_logo");
    expect(byName["signatur.png"]?.decision).toBe("skip_cid");
  });

  test("INB-050 MIME is sniffed from the bytes, not the declared type; ZIP attachments are listed as unsupported (Q-08)", async () => {
    const m = await parse(
      mail({
        text: "x",
        parts: [
          { type: "application/octet-stream", name: "scan", body: pdf("scan") },
          { type: "application/zip", name: "belege.zip", body: zip() },
        ],
      }),
    );
    expect(m.attachments.map((a) => [a.filename, a.mime, a.decision])).toEqual([
      ["scan", "application/pdf", "classify"],
      ["belege.zip", "application/zip", "unsupported"],
    ]);
    expect(m.attachments[1]?.bytes).toBeDefined();
  });

  test("INB-050 an attached message/rfc822 is unpacked one level; its attachments are marked nested", async () => {
    const inner = mail({
      from: "lieferant@example.com",
      subject: "Rechnung 4711",
      messageId: "inner@example.com",
      boundary: "=_inner_7",
      text: "Rechnung anbei",
      parts: [{ type: "application/pdf", name: "4711.pdf", body: pdf("4711") }],
    });
    const m = await parse(
      mail({
        from: "chef@meinefirma.de",
        subject: "WG: Rechnung 4711",
        text: "Bitte buchen",
        parts: [{ type: "message/rfc822", name: "weitergeleitet.eml", body: inner, raw: true }],
      }),
    );
    expect(m.subject).toBe("WG: Rechnung 4711");
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ filename: "4711.pdf", nested: true, decision: "classify" });
    expect(m.attachments[0]?.bytes).toEqual(pdf("4711"));
  });

  test("INB-050 EC-INB-26 T06-156 an attachment > 20 MB is listed as too_large without bytes", async () => {
    const big = new Uint8Array(22 * 1024 * 1024);
    big.set(enc.encode("%PDF-1.7\n"));
    const m = await parse(mail({ text: "gross", parts: [{ type: "application/pdf", name: "riesig.pdf", body: big }] }));
    expect(m.attachments[0]).toMatchObject({ filename: "riesig.pdf", decision: "too_large", size: big.byteLength });
    expect(m.attachments[0]?.bytes).toBeUndefined();
    expect(INBOX_MAIL_MESSAGES.tooLarge("riesig.pdf")).toBe(
      "Anhang riesig.pdf ist zu groß für die automatische Verarbeitung (max. 20 MB). Bitte Beleg manuell erfassen.",
    );
  }, 60_000);

  test("INB-050 EC-INB-30 T06-156 garbage bytes are not parseable", async () => {
    const garbage = new Uint8Array(4096).map((_, i) => (i * 7919 + 13) % 256);
    const r = await parseInboundEmail(garbage);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("mail_unparseable");
      expect(r.error.message).toBe(INBOX_MAIL_MESSAGES.unparseable);
    }
    expect((await parseInboundEmail(new Uint8Array())).ok).toBe(false);
  });

  test("INB-050 EC-INB-21 a mail without attachment keeps the body text; HTML-only bodies become text", async () => {
    const m = await parse(
      mail({ html: "<h1>Ihre Rechnung</h1><p>Abrufbar unter <a href='https://x'>Link</a> &amp; Konto</p>" }),
    );
    expect(m.attachments).toHaveLength(0);
    expect(m.text).toContain("Ihre Rechnung");
    expect(m.text).toContain("Abrufbar unter Link & Konto");
    expect(m.text).not.toContain("<");
    expect(INBOX_MAIL_MESSAGES.noAttachment).toBe(
      "Keine Anlage gefunden – Rechnung ist ggf. im E-Mail-Text oder über einen Link abrufbar.",
    );
  });

  test("INB-050 the body text is capped at 20 000 characters", async () => {
    const m = await parse(mail({ text: "a".repeat(30_000) }));
    expect(m.text.length).toBe(20_000);
  });

  test("INB-051 EC-INB-31 a failed SPF/DKIM/DMARC result in Authentication-Results sets authFailed", async () => {
    const failed = await parse(
      mail({
        text: "x",
        extraHeaders: ["Authentication-Results: mx.cloudflare.net; dkim=pass header.d=x.de; spf=pass; dmarc=fail"],
      }),
    );
    expect(failed.authFailed).toBe(true);
    const passed = await parse(
      mail({
        text: "x",
        extraHeaders: ["Authentication-Results: mx.cloudflare.net; dkim=pass; spf=softfail; dmarc=pass"],
      }),
    );
    expect(passed.authFailed).toBe(false);
    expect(INBOX_MAIL_MESSAGES.authFailed).toBe(
      "Absender konnte nicht verifiziert werden (SPF/DKIM/DMARC). Vorsicht vor gefälschten Rechnungen – Bankverbindung des Lieferanten prüfen.",
    );
  });

  test("INB-052 EC-INB-06/24/28/29 German messages", () => {
    expect(INBOX_MAIL_MESSAGES.unknownSender("a@b.de")).toBe("Unbekannter Absender a@b.de – bitte prüfen.");
    expect(INBOX_MAIL_MESSAGES.duplicateMessage("12.10.2026")).toBe(
      "Diese E-Mail wurde bereits empfangen (12.10.2026).",
    );
    expect(INBOX_MAIL_MESSAGES.staleObjects(2, "09:30")).toBe(
      "E-Mail-Posteingang: 2 Nachricht(en) konnten seit 09:30 nicht importiert werden.",
    );
    expect(INBOX_MAIL_MESSAGES.unreachable("HTTP 403")).toBe(
      "E-Mail-Posteingang nicht erreichbar: HTTP 403. Bitte R2-Zugang prüfen (Einstellungen › Posteingang).",
    );
  });
});
