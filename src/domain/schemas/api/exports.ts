import { z } from "zod";
import type {} from "zod-openapi";
import { encodeId } from "../../api/ids";
import type { DatevReport } from "../../datev/run";
import { isoDate, toInstant, toOptionalInstant } from "./common";

/**
 * Wire schemas of the F09 exports over REST (05 §4.7, F09 §7: `/exports/datev[/validate]`, `/exports/gdpdu`,
 * `/exports/full`, `/jobs/{id}`) and the MCP tool `export_datev` (06 §3). REST and MCP build the Convex arguments
 * with the same `datevStartArgs`, so the arguments a `preview_action` token binds are exactly the ones the ⚠ tool
 * passes to `datev.start` / `datev.startWithLock` (06 §2.3).
 */

export const DATEV_INCLUDE = [
  "revenue",
  "vouchers",
  "payments",
  "assets",
  "manual",
  "master_data",
  "documents",
] as const;
export type DatevInclude = (typeof DATEV_INCLUDE)[number];

export const datevExportWire = z
  .object({
    from: isoDate.meta({ description: "Beginn (Buchungsdatum)" }),
    to: isoDate.meta({ description: "Ende (Buchungsdatum)" }),
    include: z
      .array(z.enum(DATEV_INCLUDE))
      .min(1)
      .optional()
      .meta({ description: "Umfang (EXP-008); Standard: alles" }),
    mode: z
      .enum(["new", "full"])
      .default("new")
      .meta({ description: "new = nur neue Buchungen (Standard), full = vollständig neu (EXP-010)" }),
    lock_period: z
      .boolean()
      .default(false)
      .meta({ description: "⚠ Zeitraum vor dem Export festschreiben (EXP-011, unumkehrbar)" }),
    festschreibung: z.boolean().optional().meta({ description: "Festschreibungskennzeichen (Standard: automatisch)" }),
    confirm_replace: z
      .boolean()
      .optional()
      .meta({ description: "E-EXP-05: Steuerberater löscht den vorherigen Stapel vor dem Import" }),
  })
  .strict();

export type DatevExportWire = z.output<typeof datevExportWire>;

/** Wire → arguments of `datev.validate` / `datev.start` (optional keys omitted, never `undefined`). */
export function datevStartArgs(w: DatevExportWire) {
  return {
    from: w.from,
    to: w.to,
    scope: [...(w.include ?? DATEV_INCLUDE)],
    mode: w.mode,
    ...(w.festschreibung !== undefined ? { festschreibung: w.festschreibung } : {}),
    ...(w.confirm_replace !== undefined ? { confirmReplace: w.confirm_replace } : {}),
    ...(w.lock_period ? { lockPeriod: true as const } : {}),
  };
}

export const datevReportOut = z
  .object({
    blocking: z.boolean().meta({ description: "Blockierende Fehler: es wird keine Datei erzeugt" }),
    nothing_to_export: z.boolean(),
    needs_confirmation: z.string().nullable().meta({ description: "E-EXP-05: Bestätigung mit confirm_replace" }),
    festschreibung: z.union([z.literal(0), z.literal(1)]),
    is_repeat: z.boolean(),
    do_not_reimport: z.boolean(),
    accepted: z.boolean().meta({ description: "Steuerberater-Abnahme erfasst (EXP-016)" }),
    files: z.array(z.object({ name: z.string(), rows: z.number().int() })),
    row_count: z.number().int(),
    entry_count: z.number().int(),
    sum_umsatz_cents: z.number().int(),
    issues: z.array(
      z.object({
        level: z.enum(["error", "warning", "info"]),
        code: z.string(),
        message: z.string(),
      }),
    ),
  })
  .meta({ id: "DatevValidationReport" });

export function serializeDatevReport(r: DatevReport): z.infer<typeof datevReportOut> {
  return {
    blocking: r.blocking,
    nothing_to_export: r.nothingToExport,
    needs_confirmation: r.needsConfirmation,
    festschreibung: r.festschreibung,
    is_repeat: r.isRepeat,
    do_not_reimport: r.doNotReimport,
    accepted: r.accepted,
    files: r.files.map((f) => ({ name: f.name, rows: f.rows })),
    row_count: r.rowCount,
    entry_count: r.entryCount,
    sum_umsatz_cents: r.sumUmsatzCents,
    issues: r.issues.map((i) => ({ level: i.level, code: i.code.toLowerCase(), message: i.message })),
  };
}

export const jobStartOut = z
  .object({
    job_id: z.string().meta({ description: "job_…; Status über GET /jobs/{id}" }),
    status: z.literal("queued"),
  })
  .meta({ id: "JobStarted" });

export const jobStarted = (jobId: string): z.infer<typeof jobStartOut> => ({
  job_id: encodeId("jobs", jobId),
  status: "queued",
});

export const datevHistoryOut = z
  .object({
    id: z.string().meta({ description: "dvx_…" }),
    from: z.string(),
    to: z.string(),
    include: z.array(z.string()),
    mode: z.enum(["new", "full"]),
    format_version: z.number().int(),
    festschreibung: z.boolean(),
    is_repeat: z.boolean(),
    do_not_reimport: z.boolean(),
    row_count: z.number().int(),
    sum_umsatz_cents: z.number().int(),
    file_name: z.string(),
    sha256: z.string(),
    actor: z.string(),
    created_at: z.string(),
  })
  .meta({ id: "DatevExport" });

export function serializeDatevHistory(r: {
  id: string;
  from: string;
  to: string;
  scope: readonly string[];
  mode: "new" | "full";
  formatVersion: number;
  festschreibung: boolean;
  isRepeat: boolean;
  doNotReimport: boolean;
  rowCount: number;
  sumUmsatzCents: number;
  sha256: string;
  name: string;
  actor: string;
  at: number;
}): z.infer<typeof datevHistoryOut> {
  return {
    id: encodeId("datevExports", r.id),
    from: r.from,
    to: r.to,
    include: [...r.scope],
    mode: r.mode,
    format_version: r.formatVersion,
    festschreibung: r.festschreibung,
    is_repeat: r.isRepeat,
    do_not_reimport: r.doNotReimport,
    row_count: r.rowCount,
    sum_umsatz_cents: r.sumUmsatzCents,
    file_name: r.name,
    sha256: r.sha256,
    actor: r.actor,
    created_at: toInstant(r.at),
  };
}

export const datevFileQuery = z
  .object({
    test_confirmed: z.enum(["true", "false"]).optional().meta({
      description:
        "„Testexport – mir ist bekannt, dass der DATEV-Import noch nicht geprüft wurde“ (EXP-016; nötig bis zur Steuerberater-Abnahme)",
    }),
  })
  .strict();

export const downloadLinkOut = z
  .object({
    file_name: z.string(),
    sha256: z.string().nullable(),
    url: z.string().nullable().meta({ description: "Kurzlebiger Download-Link (nur im Tailnet erreichbar)" }),
  })
  .meta({ id: "DownloadLink" });

export const gdpduExportWire = z
  .object({
    year: z.number().int().min(2000).max(2100),
    include_files: z.boolean().default(true).meta({ description: "Belegdateien im Ordner belege/ (Standard: ja)" }),
    encoding: z.enum(["utf8", "ansi"]).default("utf8").meta({ description: "UTF-8 (Standard) oder ANSI" }),
  })
  .strict();

export const fullExportWire = z
  .object({
    encrypt_to_age_recipient: z
      .string()
      .max(200)
      .optional()
      .meta({ description: "age-Empfängerschlüssel (noch nicht unterstützt → 501)" }),
  })
  .strict();

export const JOB_KINDS = [
  "csv_export",
  "bulk_export",
  "bulk_mark_sent",
  "pdf_zip",
  "datev_export",
  "gdpdu_export",
  "full_export",
  "verfahrensdoku_pdf",
  "purge",
  "dsgvo_export",
] as const;

export const jobOut = z
  .object({
    id: z.string().meta({ description: "job_…" }),
    kind: z.string(),
    label: z.string(),
    status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
    progress: z.object({ done: z.number().int(), total: z.number().int() }),
    result: z
      .object({
        file_name: z.string(),
        sha256: z.string().nullable(),
        bytes: z.number().int().nullable(),
        url: z.string().nullable().meta({ description: "Download-Link (30 Tage, EXP-026)" }),
      })
      .nullable(),
    error: z.string().nullable(),
    actor: z.string(),
    created_at: z.string(),
    finished_at: z.string().nullable(),
    expires_at: z.string().nullable(),
  })
  .meta({ id: "Job" });

export interface JobRecord {
  id: string;
  kind: string;
  label: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  progress: { done: number; total: number };
  resultName: string | null;
  resultSha256: string | null;
  resultBytes: number | null;
  resultUrl: string | null;
  error: string | null;
  actor: string;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
}

export function serializeJob(j: JobRecord): z.infer<typeof jobOut> {
  return {
    id: encodeId("jobs", j.id),
    kind: j.kind,
    label: j.label,
    status: j.status,
    progress: j.progress,
    result: j.resultName
      ? { file_name: j.resultName, sha256: j.resultSha256, bytes: j.resultBytes, url: j.resultUrl }
      : null,
    error: j.error,
    actor: j.actor,
    created_at: toInstant(j.createdAt),
    finished_at: toOptionalInstant(j.finishedAt),
    expires_at: toOptionalInstant(j.expiresAt),
  };
}
