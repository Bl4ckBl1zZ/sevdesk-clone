/**
 * E-mail-in message processing (F06 INB-050/051, EC-INB-21/26/30/31). The raw `.eml` from the R2 inbox bucket is the
 * original; this module only reads it (postal-mime, pure computation, no I/O) and decides per attachment:
 *
 *  - `classify`          enters the classification pipeline (stored as an original-derived file with its own hash)
 *  - `skip_inline_logo`  inline image < 20 KB (logo/signature), kept only inside the `.eml`
 *  - `skip_cid`          image referenced by `cid:` in the HTML body, kept only inside the `.eml`
 *  - `unsupported`       ZIP and any type the upload sniffing rejects (Q-08), listed, kept only inside the `.eml`
 *  - `too_large`         > 20 MB (EC-INB-26), listed without bytes, kept only inside the `.eml`
 *
 * An attached message/rfc822 is unpacked one level (its attachments carry `nested: true`); deeper messages are
 * listed as `unsupported`. Headers (`from`, `subject`, `messageId`) come from the parsed message — the R2 object
 * metadata written by the Worker is only a hint. Mail text is untrusted input (INB-030) and returned as plain text.
 */
import PostalMime, { type Attachment, type Email } from "postal-mime";
import { err, ok, type Result } from "../result";
import { MAX_UPLOAD_BYTES, sniffMime } from "../vouchers/capture";

export type AttachmentDecision = "classify" | "skip_inline_logo" | "skip_cid" | "unsupported" | "too_large";

export interface InboundAttachment {
  filename: string;
  /** Sniffed from the bytes (capture.ts), else the declared type. */
  mime: string;
  /** Absent for `too_large`. */
  bytes?: Uint8Array;
  size: number;
  decision: AttachmentDecision;
  /** Unpacked from an attached message/rfc822. */
  nested?: boolean;
}

export interface ParsedInbound {
  /** Address only, lower case. */
  from?: string;
  fromName?: string;
  to?: string;
  subject?: string;
  /** Without angle brackets. */
  messageId?: string;
  /** ISO 8601 (UTC). */
  date?: string;
  /** Plain text body (HTML converted to text if there is no plain part), at most 20 000 characters. */
  text: string;
  hasHtml: boolean;
  /** SPF/DKIM/DMARC `fail` in `Authentication-Results` (EC-INB-31). */
  authFailed: boolean;
  attachments: InboundAttachment[];
}

export interface MailParseIssue {
  code: "mail_unparseable";
  message: string;
}

/** Inline images below this size are logos/signatures (INB-050). */
export const INLINE_LOGO_MAX_BYTES = 20 * 1024;
/** Attachments above this size are listed but not classified (EC-INB-26). */
export const MAX_ATTACHMENT_BYTES = MAX_UPLOAD_BYTES;
export const MAX_MAIL_TEXT_CHARS = 20_000;

/** German texts of F06 §5.1 (exact). */
export const INBOX_MAIL_MESSAGES = {
  noAttachment: "Keine Anlage gefunden – Rechnung ist ggf. im E-Mail-Text oder über einen Link abrufbar.",
  tooLarge: (name: string) =>
    `Anhang ${name} ist zu groß für die automatische Verarbeitung (max. 20 MB). Bitte Beleg manuell erfassen.`,
  unparseable: "Die E-Mail konnte nicht ausgelesen werden. Bitte Original prüfen und Beleg manuell erfassen.",
  unknownSender: (from: string) => `Unbekannter Absender ${from} – bitte prüfen.`,
  authFailed:
    "Absender konnte nicht verifiziert werden (SPF/DKIM/DMARC). Vorsicht vor gefälschten Rechnungen – Bankverbindung des Lieferanten prüfen.",
  duplicateMessage: (date: string) => `Diese E-Mail wurde bereits empfangen (${date}).`,
  staleObjects: (n: number, time: string) =>
    `E-Mail-Posteingang: ${n} Nachricht(en) konnten seit ${time} nicht importiert werden.`,
  unreachable: (error: string) =>
    `E-Mail-Posteingang nicht erreichbar: ${error}. Bitte R2-Zugang prüfen (Einstellungen › Posteingang).`,
} as const;

const unparseable = (): MailParseIssue => ({ code: "mail_unparseable", message: INBOX_MAIL_MESSAGES.unparseable });

// message/rfc822 parts always arrive as attachments; this module unpacks exactly one level itself.
const OPTIONS = { forceRfc822Attachments: true, attachmentEncoding: "arraybuffer" as const };

async function parseRaw(raw: Uint8Array): Promise<Email | null> {
  if (raw.byteLength === 0) return null;
  try {
    const email = await PostalMime.parse(raw, OPTIONS);
    // postal-mime is lenient: garbage yields a message without any header. A real mail always has headers.
    if (email.headers.length === 0) return null;
    if (!email.headers.some((h) => /^[a-z0-9-]+$/.test(h.key))) return null;
    return email;
  } catch {
    return null;
  }
}

const bytesOf = (content: Attachment["content"]): Uint8Array =>
  typeof content === "string"
    ? new TextEncoder().encode(content)
    : content instanceof Uint8Array
      ? content
      : new Uint8Array(content);

const stripBrackets = (id: string) => id.trim().replace(/^<|>$/g, "").trim();

function referencedCids(html: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!html) return out;
  for (const m of html.matchAll(/cid:([^"'\s>)]+)/gi)) out.add(stripBrackets(m[1] ?? "").toLowerCase());
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Minimal HTML → text for mails without a plain part (display/search only; never interpreted). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === "#") {
        const code = e[1]?.toLowerCase() === "x" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n[ \n]*/g, "\n")
    .trim();
}

function decide(a: Attachment, bytes: Uint8Array, cids: ReadonlySet<string>): Omit<InboundAttachment, "filename"> {
  const declared = (a.mimeType || "application/octet-stream").toLowerCase();
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    return { mime: declared, size: bytes.byteLength, decision: "too_large" };
  }
  const sniffed = sniffMime(bytes);
  const mime = sniffed ?? declared;
  const base = { mime, bytes, size: bytes.byteLength };
  const isImage = mime.startsWith("image/");
  if (isImage && a.contentId && cids.has(stripBrackets(a.contentId).toLowerCase())) {
    return { ...base, decision: "skip_cid" };
  }
  const inline = a.disposition === "inline" || a.related === true || (!a.disposition && !!a.contentId);
  if (isImage && inline && bytes.byteLength < INLINE_LOGO_MAX_BYTES) return { ...base, decision: "skip_inline_logo" };
  if (!sniffed || sniffed === "message/rfc822") return { ...base, decision: "unsupported" };
  return { ...base, decision: "classify" };
}

const isRfc822 = (a: Attachment) => a.mimeType?.toLowerCase() === "message/rfc822";

const nameOf = (a: Attachment, i: number) => a.filename?.trim() || `anhang-${i + 1}`;

/** INB-050: reads the raw message. Never throws; an unreadable message is `mail_unparseable` (EC-INB-30). */
export async function parseInboundEmail(raw: Uint8Array): Promise<Result<ParsedInbound, MailParseIssue>> {
  const email = await parseRaw(raw);
  if (!email) return err(unparseable());

  const cids = referencedCids(email.html);
  const attachments: InboundAttachment[] = [];
  for (const [i, a] of email.attachments.entries()) {
    const bytes = bytesOf(a.content);
    if (isRfc822(a)) {
      // One level: the inner message's attachments enter the pipeline; deeper messages stay in the .eml.
      const inner = bytes.byteLength <= MAX_ATTACHMENT_BYTES ? await parseRaw(bytes) : null;
      if (!inner) {
        attachments.push({ filename: nameOf(a, i), ...decide(a, bytes, cids) });
        continue;
      }
      const innerCids = referencedCids(inner.html);
      for (const [j, ia] of inner.attachments.entries()) {
        const ib = bytesOf(ia.content);
        const d = isRfc822(ia)
          ? { mime: "message/rfc822", bytes: ib, size: ib.byteLength, decision: "unsupported" as const }
          : decide(ia, ib, innerCids);
        attachments.push({ filename: nameOf(ia, j), ...d, nested: true });
      }
      continue;
    }
    attachments.push({ filename: nameOf(a, i), ...decide(a, bytes, cids) });
  }

  const from = email.from && "address" in email.from && email.from.address ? email.from : undefined;
  const firstTo = email.to?.find((t) => !!t.address);
  const text = (email.text?.trim() ? email.text : email.html ? htmlToText(email.html) : "").trim();
  const date = email.date ? new Date(email.date) : null;
  const authResults = email.headers.filter((h) => h.key === "authentication-results").map((h) => h.value);

  return ok({
    ...(from?.address ? { from: from.address.trim().toLowerCase() } : {}),
    ...(from?.name?.trim() ? { fromName: from.name.trim() } : {}),
    ...(firstTo?.address ? { to: firstTo.address.trim().toLowerCase() } : {}),
    ...(email.subject?.trim() ? { subject: email.subject.trim() } : {}),
    ...(email.messageId?.trim() ? { messageId: stripBrackets(email.messageId) } : {}),
    ...(date && !Number.isNaN(date.getTime()) ? { date: date.toISOString() } : {}),
    text: text.slice(0, MAX_MAIL_TEXT_CHARS),
    hasHtml: !!email.html,
    authFailed: authResults.some((v) => /\b(spf|dkim|dmarc)=fail\b/i.test(v)),
    attachments,
  });
}
