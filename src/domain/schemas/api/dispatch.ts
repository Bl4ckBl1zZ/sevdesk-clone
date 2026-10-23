import { z } from "zod";
import type {} from "zod-openapi";
import { type DocumentIdType, decodeDocumentId, decodeId } from "../../api/ids";
import { SEND_CHANNELS } from "../../documents/dispatch";
import { isoDate } from "./common";
import type { finalizeWire } from "./documents";

/**
 * Finalise preview, export and „Als versendet markieren“ on the wire (F04 §7.1/§7.2, SND-07/16/17/24; 06 §3.4).
 * The `*Args` mappers build exactly the arguments of the Convex functions — REST handlers, the MCP previews and the
 * ⚠ MCP tools all use them, so a confirm token's params hash (06 §2.3) matches the act byte for byte (absent optional
 * fields are omitted, never sent as `undefined`).
 */

// ── any document id (quo_ ord_ dln_ inv_ cor_ rem_) ──────────────────────────────────────────────────────────────

/** Prefixes resolved by the dispatch tools; `inv_` covers every invoice type incl. proforma and Storno. */
export const DISPATCH_ID_TYPES = [
  "quote",
  "order_confirmation",
  "delivery_note",
  "invoice",
  "correction",
  "reminder",
  "self_billing",
] as const satisfies readonly DocumentIdType[];
export type DispatchIdType = (typeof DISPATCH_ID_TYPES)[number];

/** `quo_…` / `inv_…` / `cor_…` / `rem_…` → raw id + the prefix family; null for anything else. */
export function decodeDispatchId(value: string): { id: string; idType: DispatchIdType } | null {
  for (const idType of DISPATCH_ID_TYPES) {
    const id = decodeDocumentId(idType, value);
    if (id) return { id, idType };
  }
  return null;
}

export const dispatchDocId = z
  .string()
  .max(100)
  .meta({ description: "Beleg-ID (quo_…, ord_…, dln_…, inv_…, cor_…, rem_…, sbc_…)" });

// ── finalise ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FinalizeArgs {
  id: string;
  version: number;
  documentDate?: string;
  backdateReason?: string;
  overrides?: { vatCheck?: { reason: string }; rc13bCertificate?: { reason: string } };
}

/** Finalise body → `invoices.finalize` / `invoices.commit` arguments (without `confirmToken`). */
export function finalizeArgs(id: string, w: z.output<typeof finalizeWire>): FinalizeArgs {
  const overrides = {
    ...(w.overrides?.vat_id_unverified_reason ? { vatCheck: { reason: w.overrides.vat_id_unverified_reason } } : {}),
    ...(w.overrides?.rc13b_confirmation ? { rc13bCertificate: { reason: w.overrides.rc13b_confirmation } } : {}),
  };
  return {
    id,
    version: w.version,
    ...(w.document_date ? { documentDate: w.document_date } : {}),
    ...(w.backdate_reason ? { backdateReason: w.backdate_reason } : {}),
    ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
  };
}

/** `POST /{type}/{id}/preview` and `document_preview` (intent finalize): the finalisation options to check. */
export const finalizePreviewWire = z
  .object({
    document_date: isoDate.optional(),
    backdate_reason: z.string().max(1000).optional(),
    overrides: z
      .object({
        vat_id_unverified_reason: z.string().max(1000).optional(),
        rc13b_confirmation: z.string().max(1000).optional(),
      })
      .optional(),
  })
  .strict()
  .meta({ id: "DocumentFinalizePreviewRequest" });

const findingOut = z.object({
  code: z.string(),
  rule: z.string().nullable(),
  field: z.string().nullable(),
  message: z.string(),
});

export const finalizePreviewOut = z
  .object({
    id: z.string(),
    type: z.string(),
    version: z.number().int(),
    status: z.string(),
    allowed: z.boolean().meta({ description: "true = keine Fehler; Fertigstellen ist möglich" }),
    document_date: isoDate.nullable(),
    errors: z.array(findingOut),
    warnings: z.array(findingOut),
    totals: z
      .object({
        net_cents: z.number().int(),
        vat_cents: z.number().int(),
        gross_cents: z.number().int(),
        payable_cents: z.number().int(),
      })
      .nullable(),
    tax_case: z.object({ value: z.string().nullable(), reasons: z.array(z.string()) }),
    einvoice: z.object({ decision: z.string(), reason: z.string().nullable(), format: z.string() }),
    pdf_preview_url: z.string().nullable().meta({ description: "P1: noch nicht verfügbar (null)" }),
    confirm_token: z
      .string()
      .nullable()
      .meta({ description: "Nur MCP (document_preview); REST liefert null und ignoriert es beim Fertigstellen" }),
  })
  .meta({ id: "DocumentFinalizePreview" });

export interface FinalizeCheckLike {
  status: string;
  version: number;
  type: string;
  check: {
    findings: { code: string; severity: string; message: string; rule: string; field?: string }[];
    canFinalize: boolean;
    documentDate: string;
    taxCase: string | null;
    taxCaseReasons: readonly string[];
    totals: { netCents: number; vatCents: number; grossCents: number; payableCents: number } | null;
    einvoice: { decision: string; reason: string | null; format: string };
  } | null;
}

/** `invoices.finalizeCheck` → wire (without the token). */
export function serializeFinalizeCheck(wireId: string, c: FinalizeCheckLike) {
  const f = (x: { code: string; message: string; rule: string; field?: string }) => ({
    code: x.code,
    rule: x.rule || null,
    field: x.field ?? null,
    message: x.message,
  });
  const k = c.check;
  return {
    id: wireId,
    type: c.type,
    version: c.version,
    status: c.status,
    allowed: k?.canFinalize === true,
    document_date: k?.documentDate ?? null,
    errors: k ? k.findings.filter((x) => x.severity === "E").map(f) : [],
    warnings: k ? k.findings.filter((x) => x.severity !== "E").map(f) : [],
    totals: k?.totals
      ? {
          net_cents: k.totals.netCents,
          vat_cents: k.totals.vatCents,
          gross_cents: k.totals.grossCents,
          payable_cents: k.totals.payableCents,
        }
      : null,
    tax_case: { value: k?.taxCase ?? null, reasons: [...(k?.taxCaseReasons ?? [])] },
    einvoice: k ? { ...k.einvoice } : { decision: "", reason: null, format: "none" },
    pdf_preview_url: null,
  };
}

// ── export (SND-16, SND-05) ──────────────────────────────────────────────────────────────────────────────────────

export const EXPORT_ENTRIES = ["default", "zugferd_pdf", "xml", "xrechnung_with_reading", "pdf", "zip"] as const;

export const documentExportWire = z
  .object({
    entry: z.enum(EXPORT_ENTRIES).optional().meta({
      description:
        "Exportmenü (SND-16): default (je Format), zugferd_pdf, xml, xrechnung_with_reading, pdf, zip (Dateien für das ZIP). Standard: default",
    }),
    original: z.boolean().optional().meta({ description: "Original erneut exportieren (nach der Markierung)" }),
    reason: z.string().max(2000).optional().meta({ description: "Pflicht bei original nach der Markierung" }),
  })
  .strict()
  .meta({ id: "DocumentExportRequest" });

/** Export body → `documentArtifacts.exportFiles` `request` (exportRequestSchema). */
export const exportRequest = (w: z.output<typeof documentExportWire>) => ({
  entry: w.entry ?? "default",
  ...(w.original ? { original: true } : {}),
  ...(w.reason ? { reason: w.reason } : {}),
});

export const documentExportOut = z
  .object({
    files: z.array(
      z.object({
        artifact_id: z.string().meta({ description: "art_…" }),
        name: z.string(),
        url: z.string().meta({ description: "Kurzlebiger Link (5 min, nur im Tailnet erreichbar)" }),
        sha256: z.string(),
        mime: z.string(),
      }),
    ),
    zip_name: z.string().nullable(),
  })
  .meta({ id: "DocumentExportResult" });

// ── mark sent (SND-07, SND-17) ───────────────────────────────────────────────────────────────────────────────────

export const documentMarkSentWire = z
  .object({
    sent_on: isoDate.meta({ description: "Versanddatum (≤ heute, ≥ Fertigstellung)" }),
    channel: z.enum(SEND_CHANNELS as unknown as [string, ...string[]]).meta({
      description: "email_manual | post | hand | upload_portal | other (other: note Pflicht)",
    }),
    note: z.string().max(2000).optional(),
    artifacts: z
      .array(z.string().max(80))
      .min(1)
      .max(50)
      .meta({ description: "Übergebene Dateien (art_… aus dem Export)" }),
    einvoice_handed_over_electronically: z
      .boolean()
      .optional()
      .meta({ description: "Kanal other: „elektronisch übermittelt“ bestätigt (SND-17)" }),
  })
  .strict()
  .meta({ id: "DocumentMarkSentRequest" });

export interface MarkSentArgs {
  id: string;
  values: { sentOn: string; channel: string; note?: string; electronicConfirmed?: true; artifactIds: string[] };
}

/** Mark-sent body → `invoices.markSent` arguments; `issues` lists malformed artifact ids (422). */
export function markSentArgs(
  id: string,
  w: z.output<typeof documentMarkSentWire>,
): { args: MarkSentArgs; issues: { field: string; message: string }[] } {
  const issues: { field: string; message: string }[] = [];
  const artifactIds = w.artifacts.map((a, i) => {
    const raw = decodeId("documentArtifacts", a);
    if (!raw) issues.push({ field: `artifacts[${i}]`, message: "Erwartet eine Datei-ID (art_…)." });
    return raw ?? "";
  });
  return {
    args: {
      id,
      values: {
        sentOn: w.sent_on,
        channel: w.channel,
        ...(w.note ? { note: w.note } : {}),
        ...(w.einvoice_handed_over_electronically ? { electronicConfirmed: true as const } : {}),
        artifactIds,
      },
    },
    issues,
  };
}

export const documentMarkSentOut = z
  .object({
    send_log_id: z.string().meta({ description: "snd_…" }),
    first_effective: z.boolean(),
    warnings: z.array(z.string()),
  })
  .meta({ id: "DocumentMarkSentResult" });

export const documentRetractWire = z
  .object({ reason: z.string().min(10).max(2000).meta({ description: "Grund (mind. 10 Zeichen, SND-18)" }) })
  .strict()
  .meta({ id: "DocumentMarkSentRetractRequest" });

export interface MarkSentPreviewLike {
  type: string;
  number: string | null;
  statusBefore: string;
  firstEffective: boolean;
  statusAfter: string;
  sentOn: string | null;
  zugang: string | null;
  errors: { code: string; message: string; rule: string }[];
  warnings: { code: string; message: string; rule: string }[];
  einvoiceHandedOverElectronically: boolean;
}

/** `invoices.markSentPreview` → the effect shown in the approval prompt. */
export function serializeMarkSentPreview(p: MarkSentPreviewLike) {
  return {
    number: p.number,
    status_before: p.statusBefore,
    status_after: p.statusAfter,
    first_effective: p.firstEffective,
    sent_on: p.sentOn,
    zugang: p.zugang,
    einvoice_handed_over_electronically: p.einvoiceHandedOverElectronically,
    errors: p.errors,
    warnings: p.warnings,
  };
}
