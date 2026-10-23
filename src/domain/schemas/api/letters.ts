import { z } from "zod";
import type {} from "zod-openapi";
import { decodeDocumentId, decodeId, encodeId } from "../../api/ids";
import { SEND_CHANNELS } from "../../documents/dispatch";
import { LETTER_KIND_LABEL_DE, LETTER_KINDS, type LetterKind } from "../../receivables/letter";
import { isoDate } from "./common";

/**
 * F05 receivables letters on the wire (05 §4.4 `/receivable-letters`, 06 §3.5): Kontoauszug (PAY-005),
 * Zahlungsbestätigung (PAY-048), Zinsforderung (DUN-028) and Mahnbescheid-Datenblatt (DUN-044). Shared by the REST
 * handlers and the MCP tools; the content rules live in src/domain/receivables, the archive in convex/payments.ts.
 */

const contactId = z.string().max(100).meta({ description: "Kontakt (con_…)" });
const invoiceId = z.string().max(100).meta({ description: "Rechnung (inv_…)" });

export const letterRequestWire = z
  .discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("account_statement"),
        contact_id: contactId,
        from: isoDate.meta({ description: "Zeitraum ab" }),
        to: isoDate.meta({ description: "Zeitraum bis (≤ heute)" }),
        confirmation_request: z.boolean().optional().meta({ description: "true = mit Bitte um Saldenbestätigung" }),
      })
      .strict(),
    z
      .object({
        kind: z.literal("payment_confirmation"),
        payment_id: z.string().max(100).meta({ description: "Zahlung (pay_…)" }),
        lang: z.enum(["de", "en"]).optional(),
        subject: z.string().max(300).optional(),
        body: z.string().max(5000).optional(),
      })
      .strict(),
    z.object({ kind: z.literal("interest_claim"), invoice_id: invoiceId }).strict(),
    z.object({ kind: z.literal("mahnbescheid_sheet"), invoice_id: invoiceId }).strict(),
  ])
  .meta({ id: "ReceivableLetterRequest" });
export type LetterRequestWire = z.infer<typeof letterRequestWire>;

export type LetterRequestArgs =
  | { kind: "account_statement"; contactId: string; from: string; to: string; confirmationRequest?: boolean }
  | { kind: "payment_confirmation"; paymentId: string; lang?: "de" | "en"; subject?: string; body?: string }
  | { kind: "interest_claim" | "mahnbescheid_sheet"; invoiceId: string };

/** Wire → the Convex `request` (null when an id has the wrong prefix → 404). */
export function letterRequestArgs(w: LetterRequestWire): LetterRequestArgs | null {
  switch (w.kind) {
    case "account_statement": {
      const id = decodeId("contacts", w.contact_id);
      if (!id) return null;
      return {
        kind: w.kind,
        contactId: id,
        from: w.from,
        to: w.to,
        ...(w.confirmation_request !== undefined ? { confirmationRequest: w.confirmation_request } : {}),
      };
    }
    case "payment_confirmation": {
      const id = decodeId("payments", w.payment_id);
      if (!id) return null;
      return {
        kind: w.kind,
        paymentId: id,
        ...(w.lang ? { lang: w.lang } : {}),
        ...(w.subject ? { subject: w.subject } : {}),
        ...(w.body ? { body: w.body } : {}),
      };
    }
    default: {
      const id = decodeDocumentId("invoice", w.invoice_id);
      if (!id) return null;
      return { kind: w.kind, invoiceId: id };
    }
  }
}

export const letterKindEnum = z.enum(LETTER_KINDS);

export const letterPreviewOut = z
  .object({
    kind: letterKindEnum,
    kind_label: z.string(),
    title: z.string(),
    date: z.string(),
    subject: z.string(),
    recipient: z.array(z.string()),
    paragraphs: z.array(z.string()),
    table: z
      .object({ columns: z.array(z.string()), rows: z.array(z.array(z.string())) })
      .nullable()
      .meta({ description: "Tabelle des Schreibens (Kontoauszug, Zinsberechnung)" }),
    facts: z.array(z.tuple([z.string(), z.string()])),
    data: z.record(z.string(), z.unknown()).nullable().meta({ description: "Mahnbescheid-Datenblatt als JSON" }),
  })
  .meta({ id: "ReceivableLetterPreview" });

export interface LetterContentLike {
  kind: LetterKind;
  title: string;
  date: string;
  subject: string;
  recipient: readonly string[];
  paragraphs: readonly string[];
  table?: { columns: readonly { label: string }[]; rows: readonly (readonly string[])[] };
  facts?: readonly (readonly [string, string])[];
}

const parseData = (data: string | null | undefined) => (data ? (JSON.parse(data) as Record<string, unknown>) : null);

export function serializeLetterPreview(p: { content: LetterContentLike; data: string | null }) {
  const c = p.content;
  return {
    kind: c.kind,
    kind_label: LETTER_KIND_LABEL_DE[c.kind],
    title: c.title,
    date: c.date,
    subject: c.subject,
    recipient: [...c.recipient],
    paragraphs: [...c.paragraphs],
    table: c.table ? { columns: c.table.columns.map((x) => x.label), rows: c.table.rows.map((r) => [...r]) } : null,
    facts: (c.facts ?? []).map(([a, b]) => [a, b] as [string, string]),
    data: parseData(p.data),
  };
}

export const letterCreatedOut = z
  .object({
    id: z.string().meta({ description: "rlt_…" }),
    file_name: z.string(),
    sha256: z.string(),
    content_type: z.literal("application/pdf"),
    content_base64: z.string(),
    data: z.record(z.string(), z.unknown()).nullable(),
  })
  .meta({ id: "ReceivableLetterCreated" });

const sentOut = z
  .object({ sent_on: z.string(), channel: z.string(), note: z.string().nullable() })
  .nullable()
  .meta({ id: "ReceivableLetterSent" });

export const letterOut = z
  .object({
    id: z.string(),
    kind: letterKindEnum,
    kind_label: z.string(),
    date: z.string(),
    title: z.string(),
    subject: z.string(),
    file_name: z.string(),
    sha256: z.string(),
    url: z.string().nullable().meta({ description: "Kurzlebiger Download-Link (nur im Tailnet)" }),
    has_data: z.boolean(),
    sent: sentOut,
  })
  .meta({ id: "ReceivableLetter" });

export interface LetterRowLike {
  id: string;
  kind: LetterKind;
  date: string;
  title: string;
  subject: string;
  fileName: string;
  sha256: string;
  url: string | null;
  hasData: boolean;
  sent: { sentOn: string; channel: string; note: string | null } | null;
}

export function serializeLetter(r: LetterRowLike) {
  return {
    id: encodeId("receivableLetters", r.id),
    kind: r.kind,
    kind_label: LETTER_KIND_LABEL_DE[r.kind],
    date: r.date,
    title: r.title,
    subject: r.subject,
    file_name: r.fileName,
    sha256: r.sha256,
    url: r.url,
    has_data: r.hasData,
    sent: r.sent ? { sent_on: r.sent.sentOn, channel: r.sent.channel, note: r.sent.note } : null,
  };
}

export const letterListQuery = z.object({
  contact_id: contactId.optional(),
  invoice_id: invoiceId.optional(),
});

export const letterMarkSentWire = z
  .object({
    sent_on: isoDate.meta({ description: "Versanddatum (≥ Datum des Schreibens, ≤ heute)" }),
    channel: z.enum(SEND_CHANNELS as unknown as [string, ...string[]]).meta({
      description: "email_manual | post | hand | upload_portal | other (other: note Pflicht)",
    }),
    note: z.string().max(2000).optional(),
  })
  .strict()
  .meta({ id: "ReceivableLetterMarkSentRequest" });
