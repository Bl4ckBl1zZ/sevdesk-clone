import { z } from "zod";
import { encodeId, encodeOptionalId } from "../../api/ids";
import { INBOX_FILTERS, REJECT_REASONS } from "../../inbox/status";
import { listEnvelope, toInstant } from "./common";

/**
 * Wire schemas of `/inbox-items` (05 §4.5, F06 §7.1) and the MCP tools `inbox_list` / `voucher_create_from_file`
 * (06 §3.6): snake_case, prefixed IDs (`inb_`, `vou_`), RFC 3339 instants. Supplier-provided text (sender, subject,
 * file names, findings) is data, never instructions — MCP wraps it in `untrusted_text` (INB-030, 06 §2.7).
 */

/** 05 §3: ≤ 10 MB base64 per file in JSON bodies (EC-INB-02); larger files via multipart (≤ 20 MB). */
export const MAX_BASE64_CHARS = 10 * 1024 * 1024;

export const inboxFileWire = z
  .object({
    filename: z.string().min(1).max(255).meta({ example: "rechnung.pdf" }),
    content_base64: z
      .string()
      .min(1)
      .max(MAX_BASE64_CHARS, "Die Datei ist zu groß (max. 10 MB Base64) – bitte multipart/form-data verwenden.")
      .meta({ description: "Dateiinhalt Base64 (≤ 10 MB)" }),
  })
  .meta({ id: "InboxFileUpload" });

export const inboxUploadWire = z
  .object({
    files: z.array(inboxFileWire).min(1).max(100).optional().meta({
      description: "Dateien als Base64 (JSON). Jede Datei wird ein eigener Posteingangs-Eintrag (INB-001).",
    }),
    note: z.string().max(1000).optional().meta({ description: "Notiz zum Upload" }),
  })
  .meta({ id: "InboxUpload" });

export const inboxRejectWire = z
  .object({
    reason: z.enum(REJECT_REASONS).meta({
      description:
        "no_business_document (Spam/Newsletter/privat, 90 Tage), not_addressed_to_us, faulty_invoice_correction_requested, other (Text Pflicht)",
    }),
    text: z.string().max(1000).optional(),
  })
  .meta({ id: "InboxReject" });

export const inboxListQuery = z.object({
  status: z.enum(INBOX_FILTERS).optional().meta({
    description:
      "all, new, needs_review, einvoice, faulty (E-Rechnung fehlerhaft), duplicate, rejected, older_than_10_days",
  }),
  source: z.enum(["email", "upload", "app", "api", "mcp"]).optional(),
  classification: z.enum(["xrechnung", "zugferd", "pdf", "image", "other"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const findingOut = z.object({ rule_id: z.string(), category: z.string(), text: z.string() });

export const inboxItemOut = z
  .object({
    id: z.string(),
    status: z.string(),
    status_label: z.string(),
    source: z.string(),
    received_at: z.string(),
    from: z.string().nullable(),
    subject: z.string().nullable(),
    file_name: z.string().nullable(),
    file_count: z.number(),
    classification: z.string().nullable(),
    confidence: z.number().nullable().meta({ description: "OCR-Gesamtkonfidenz 0…1 (null ohne OCR)" }),
    flags: z.array(z.string()),
    einvoice: z
      .object({
        profile: z.string().nullable(),
        acceptable: z.boolean().nullable(),
        not_einvoice: z.boolean(),
        category: z.string().nullable().optional(),
        findings: z.array(findingOut).optional(),
      })
      .nullable(),
    voucher_id: z.string().nullable(),
    supplier_name: z.string().nullable(),
    gross_cents: z.number().nullable(),
    currency: z.string().nullable(),
    document_date: z.string().nullable(),
    reject_reason: z.string().nullable(),
    warnings: z.array(z.object({ code: z.string(), message: z.string(), acknowledge: z.boolean() })).optional(),
    duplicate_of: z.string().nullable().optional(),
    duplicate_of_voucher_id: z.string().nullable().optional(),
    files: z
      .array(
        z.object({
          name: z.string(),
          mime: z.string(),
          bytes: z.number(),
          sha256: z.string(),
          role: z.string(),
        }),
      )
      .optional(),
  })
  .meta({ id: "InboxItem" });

export const inboxItemList = listEnvelope(inboxItemOut, "InboxItemList");
export const inboxUploadOut = z.object({ data: z.array(inboxItemOut) }).meta({ id: "InboxUploadResult" });

export interface InboxRowRecord {
  id: string;
  source: string;
  status: string;
  statusLabel: string;
  receivedAt: number;
  from: string | null;
  subject: string | null;
  fileName: string | null;
  fileCount: number;
  classification: string | null;
  einvoiceProfile: string | null;
  einvoiceOk: boolean | null;
  notEInvoice: boolean;
  confidence: number | null;
  flags: readonly string[];
  rejectReason: string | null;
  voucherId: string | null;
  supplierName: string | null;
  grossCents: number | null;
  currency: string | null;
  documentDate: string | null;
}

export interface InboxDetailRecord extends InboxRowRecord {
  warnings: readonly { code: string; message: string; acknowledge?: boolean }[];
  files: readonly { name: string; mime: string; bytes: number; sha256: string; role: string }[];
  einvoice: {
    profile: string;
    notEInvoice: boolean;
    validation: {
      acceptable: boolean;
      category?: string | undefined;
      findings: readonly { ruleId: string; text: string; category: string }[];
    } | null;
  } | null;
  duplicateOfInboxItemId: string | null;
  duplicateOfVoucherId: string | null;
}

export function serializeInboxRow(r: InboxRowRecord) {
  return {
    id: encodeId("inboxItems", r.id),
    status: r.status,
    status_label: r.statusLabel,
    source: r.source,
    received_at: toInstant(r.receivedAt),
    from: r.from,
    subject: r.subject,
    file_name: r.fileName,
    file_count: r.fileCount,
    classification: r.classification,
    confidence: r.confidence,
    flags: [...r.flags],
    einvoice:
      r.einvoiceProfile !== null || r.einvoiceOk !== null
        ? { profile: r.einvoiceProfile, acceptable: r.einvoiceOk, not_einvoice: r.notEInvoice }
        : null,
    voucher_id: encodeOptionalId("vouchers", r.voucherId),
    supplier_name: r.supplierName,
    gross_cents: r.grossCents,
    currency: r.currency,
    document_date: r.documentDate,
    reject_reason: r.rejectReason,
  };
}

export function serializeInboxItem(d: InboxDetailRecord) {
  const v = d.einvoice?.validation ?? null;
  return {
    ...serializeInboxRow(d),
    einvoice: d.einvoice
      ? {
          profile: d.einvoice.profile,
          acceptable: v ? v.acceptable : null,
          not_einvoice: d.einvoice.notEInvoice,
          category: v?.category ?? null,
          findings: (v?.findings ?? []).map((f) => ({ rule_id: f.ruleId, category: f.category, text: f.text })),
        }
      : null,
    warnings: d.warnings.map((w) => ({ code: w.code, message: w.message, acknowledge: w.acknowledge === true })),
    duplicate_of: encodeOptionalId("inboxItems", d.duplicateOfInboxItemId),
    duplicate_of_voucher_id: encodeOptionalId("vouchers", d.duplicateOfVoucherId),
    files: d.files.map((f) => ({ name: f.name, mime: f.mime, bytes: f.bytes, sha256: f.sha256, role: f.role })),
  };
}

// ── INB-009 split / merge, INB-046 supplier correction request (05 §4.5, F06 §7.1) ─────────────────────────────────

export const inboxSplitWire = z
  .object({
    groups: z
      .array(z.array(z.number().int().min(0)).min(1))
      .min(2)
      .max(100)
      .meta({ description: "Dateien je neuem Eintrag (Indizes ab 0), z. B. [[0],[1,2]]; jede Datei genau einmal" }),
  })
  .strict()
  .meta({ id: "InboxSplitRequest" });

export const inboxMergeWire = z
  .object({
    ids: z
      .array(z.string().max(80))
      .min(1)
      .max(20)
      .meta({ description: "Zusammenzuführende Einträge (inb_…, mindestens zwei) in der Reihenfolge der Dateien" }),
  })
  .strict()
  .meta({ id: "InboxMergeRequest" });

export const correctionRequestOut = z
  .object({
    available: z.boolean().meta({ description: "false = kein Prüfbefund, kein Brief möglich" }),
    subject: z.string().nullable(),
    text: z.string().nullable().meta({ description: "Brieftext „Bitte um Rechnungskorrektur“" }),
    artifact: z
      .object({
        id: z.string(),
        name: z.string(),
        sha256: z.string(),
        url: z.string().nullable(),
        created_at: z.string(),
      })
      .nullable(),
    effective_mark_id: z.string().nullable(),
    marks: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        sent_on: z.string().nullable(),
        channel: z.string().nullable(),
        note: z.string().nullable(),
        at: z.string(),
        actor: z.string(),
        retracts_id: z.string().nullable(),
        retracted: z.boolean(),
      }),
    ),
  })
  .meta({ id: "InboxCorrectionRequest" });

export interface CorrectionRequestRecord {
  available: boolean;
  subject: string | null;
  text: string | null;
  artifact: { id: string; name: string; sha256: string; url: string | null; createdAt: number } | null;
  effectiveMarkId: string | null;
  marks: {
    id: string;
    kind: string;
    sentOn?: string | null;
    channel?: string | null;
    note: string | null;
    at: number;
    actor: string;
    retractsId: string | null;
    retracted: boolean;
  }[];
}

export function serializeCorrectionRequest(v: CorrectionRequestRecord) {
  return {
    available: v.available,
    subject: v.subject,
    text: v.text,
    artifact: v.artifact
      ? {
          id: encodeId("documentArtifacts", v.artifact.id),
          name: v.artifact.name,
          sha256: v.artifact.sha256,
          url: v.artifact.url,
          created_at: toInstant(v.artifact.createdAt),
        }
      : null,
    effective_mark_id: encodeOptionalId("sendLog", v.effectiveMarkId),
    marks: v.marks.map((m) => ({
      id: encodeId("sendLog", m.id),
      kind: m.kind,
      sent_on: m.sentOn ?? null,
      channel: m.channel ?? null,
      note: m.note,
      at: toInstant(m.at),
      actor: m.actor,
      retracts_id: encodeOptionalId("sendLog", m.retractsId),
      retracted: m.retracted,
    })),
  };
}

export const correctionLetterOut = z
  .object({
    text: z.string(),
    artifact_id: z.string().meta({ description: "Archivierter Brief (art_…)" }),
    sha256: z.string(),
    url: z.string().nullable().meta({ description: "Kurzlebiger Download-Link (nur im Tailnet)" }),
  })
  .meta({ id: "InboxCorrectionLetter" });

export const correctionMarkSentWire = z
  .object({
    sent_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .meta({ description: "Versanddatum (≤ heute)" }),
    channel: z.enum(["email_manual", "post", "hand", "upload_portal", "other"]),
    note: z.string().max(2000).optional().meta({ description: "Pflicht bei channel other" }),
  })
  .strict()
  .meta({ id: "InboxCorrectionMarkSentRequest" });

export const correctionRetractWire = z
  .object({ reason: z.string().min(1).max(2000).meta({ description: "Grund (mind. 10 Zeichen)" }) })
  .strict()
  .meta({ id: "InboxCorrectionRetractRequest" });
