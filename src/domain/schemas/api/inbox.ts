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
