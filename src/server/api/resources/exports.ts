import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import {
  type DatevExportWire,
  datevExportWire,
  datevFileQuery,
  datevHistoryOut,
  datevReportOut,
  datevStartArgs,
  downloadLinkOut,
  fullExportWire,
  gdpduExportWire,
  type JobRecord,
  jobOut,
  jobStarted,
  jobStartOut,
  serializeDatevHistory,
  serializeDatevReport,
  serializeJob,
} from "@/domain/schemas/api/exports";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, rawId } from "./shared";

/**
 * F09 §7 exports over REST (05 §4.7): DATEV dry run, export job and history with the stored ZIP (EXP-007…016),
 * GDPdU/Z3 per fiscal year (EXP-017), the full export (EXP-023) and the job status (EXP-026). Handlers only map the
 * wire to the Convex functions the /export page uses; jobs are attributed to the key (`api-key:<id>`).
 */

const TAG = "Exporte";

/** EXP-007 „Prüfen“: the validation report of a DATEV export (writes nothing). Shared with MCP `preview_action`. */
export async function validateDatev(convex: ConvexCaller, w: DatevExportWire) {
  return serializeDatevReport(await convex.action(api.datev.validate, datevStartArgs(w)));
}

/** A blocking report (or E-EXP-05 without confirmation) answers 422 with the report; nothing is started. */
export function refuseBlocking(report: z.infer<typeof datevReportOut>): void {
  const errors = report.issues.filter((i) => i.level === "error");
  const running = errors.find((i) => i.code === "datev_running");
  if (running) throw new ApiProblem("conflict", { detail: running.message, extra: { report } }); // E-EXP-20
  if (report.blocking) {
    throw new ApiProblem("validation_failed", {
      detail: "Der DATEV-Export ist blockiert. Bitte die Fehler im Prüfbericht beheben.",
      errors: errors.map((i) => ({ code: i.code, message: i.message })),
      extra: { report },
    });
  }
  if (report.nothing_to_export) {
    const info = report.issues.find((i) => i.level === "info" || i.level === "warning");
    throw new ApiProblem("validation_failed", {
      detail: info?.message ?? "Im Zeitraum gibt es nichts zu exportieren.",
      errors: [{ code: "nothing_to_export", message: info?.message ?? "Im Zeitraum gibt es nichts zu exportieren." }],
      extra: { report },
    });
  }
}

/**
 * Starts the job: `datev.startWithLock` when the period is to be locked first (⚠ EXP-011), else `datev.start`.
 * MCP passes the confirm token of its `preview_action` (06 §2.3); the arguments are those of `datevStartArgs`.
 */
export async function startDatev(convex: ConvexCaller, w: DatevExportWire, confirmToken?: string) {
  const { lockPeriod, ...args } = datevStartArgs(w);
  const token = confirmToken ? { confirmToken } : {};
  const r = lockPeriod
    ? await convex.mutation(api.datev.startWithLock, { ...args, lockPeriod, ...token })
    : await convex.mutation(api.datev.start, { ...args, ...token });
  return jobStarted(r.jobId);
}

async function jobOf(convex: ConvexCaller, id: string) {
  return serializeJob((await convex.query(api.jobs.get, { id: rawId("jobs", id) })) as JobRecord);
}

export const exportsResource = defineResource("exports", "DATEV, GDPdU, Vollexport und Hintergrundaufträge", [
  defineEndpoint({
    method: "POST",
    path: "/exports/datev/validate",
    operationId: "validateDatevExport",
    summary: "DATEV-Export prüfen (Trockenlauf)",
    description:
      "Prüfbericht vor dem Export (EXP-007): blockierende Fehler, Warnungen und Hinweise mit den deutschen Meldungen, Dateien, Zeilen, Σ Umsatz und Festschreibung. Schreibt nichts.",
    tag: TAG,
    scope: "exports:run",
    body: datevExportWire,
    response: { status: 200, schema: datevReportOut, description: "Der Prüfbericht" },
    handler: async ({ convex, body }) => ({ body: await validateDatev(convex, body) }),
  }),
  defineEndpoint({
    method: "POST",
    path: "/exports/datev",
    operationId: "startDatevExport",
    summary: "DATEV-Export starten",
    description:
      "Prüft den Export (EXP-007) und startet bei fehlerfreiem Bericht den Auftrag `datev_export` → `job_…` (Status über GET /jobs/{id}). Blockierender Bericht: 422 mit `report`. `lock_period: true` schreibt die Monate vorher fest (EXP-011, unumkehrbar). Läuft bereits ein Export für einen überlappenden Zeitraum: 409 (E-EXP-20).",
    tag: TAG,
    scope: "exports:run",
    body: datevExportWire,
    response: { status: 202, schema: jobStartOut, description: "Auftrag gestartet" },
    errors: ["conflict", "period_locked"],
    handler: async ({ convex, body }) => {
      refuseBlocking(await validateDatev(convex, body));
      return { status: 202, body: await startDatev(convex, body) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/exports/datev",
    operationId: "listDatevExports",
    summary: "DATEV-Exporthistorie",
    description:
      "Alle DATEV-Exporte (neueste zuerst, höchstens 200): Zeitraum, Umfang, Modus, Festschreibung, Zeilen, Σ Umsatz, SHA-256 (EXP-009).",
    tag: TAG,
    scope: "exports:run",
    response: {
      status: 200,
      schema: z.object({ data: z.array(datevHistoryOut), next_cursor: z.null() }).meta({ id: "DatevExportList" }),
      description: "Die Historie",
    },
    handler: async ({ convex }) => ({
      body: { data: (await convex.query(api.datev.list, {})).map(serializeDatevHistory), next_cursor: null },
    }),
  }),
  defineEndpoint({
    method: "GET",
    path: "/exports/datev/{id}/file",
    operationId: "getDatevExportFile",
    summary: "Gespeicherte DATEV-ZIP herunterladen",
    description:
      "Link auf die unverändert gespeicherte ZIP (nie neu erzeugt, EXP-009); protokolliert. Bis die Steuerberater-Abnahme erfasst ist, nur mit `test_confirmed=true` (EXP-016, E-EXP-18) — sonst 422 `datev_test_confirmation_required`.",
    tag: TAG,
    scope: "exports:run",
    params: idParams("datevExports"),
    query: datevFileQuery,
    response: { status: 200, schema: downloadLinkOut, description: "Der Link" },
    handler: async ({ convex, params, query }) => {
      const id = rawId("datevExports", params.id);
      const row = (await convex.query(api.datev.list, {})).find((r) => r.id === id);
      if (!row) throw new ApiProblem("not_found", { detail: "Export nicht gefunden." });
      const r = await convex.mutation(api.datev.download, {
        id: id as never,
        ...(query.test_confirmed === "true" ? { testConfirmed: true } : {}),
      });
      return { body: { file_name: r.name, sha256: row.sha256, url: r.url } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/exports/gdpdu",
    operationId: "startGdpduExport",
    summary: "GDPdU-/Z3-Export eines Wirtschaftsjahres starten",
    description:
      "Auftrag `gdpdu_export` (EXP-017/018): CSV-Tabellen, `index.xml` (gegen die DTD geprüft), optional Belegdateien, README. Ergebnis über GET /jobs/{id}.",
    tag: TAG,
    scope: "exports:run",
    body: gdpduExportWire,
    response: { status: 202, schema: jobStartOut, description: "Auftrag gestartet" },
    handler: async ({ convex, body }) => {
      const r = await convex.mutation(api.gdpdu.start, {
        year: body.year,
        includeFiles: body.include_files,
        encoding: body.encoding,
      });
      return { status: 202, body: jobStarted(r.jobId) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/exports/full",
    operationId: "startFullExport",
    summary: "Vollexport starten",
    description:
      "Auftrag `full_export` (EXP-023): alle Tabellen (NDJSON), alle Dateien, Manifest mit Prüfketten-Kopf, README. Nur Inhaber-Schlüssel mit `exports:run`. Die Bücher müssen in der EU aufbewahrt werden (§ 146 Abs. 2 AO, E-EXP-42). Die Verschlüsselung mit einem age-Schlüssel ist noch nicht verfügbar (501).",
    tag: TAG,
    scope: "exports:run",
    body: fullExportWire,
    response: { status: 202, schema: jobStartOut, description: "Auftrag gestartet" },
    errors: ["not_implemented"],
    handler: async ({ convex, body }) => {
      if (body.encrypt_to_age_recipient !== undefined) {
        throw new ApiProblem("not_implemented", {
          detail: "Die Verschlüsselung des Vollexports mit einem age-Schlüssel ist noch nicht verfügbar.",
        });
      }
      const r = await convex.mutation(api.fullExport.start, {});
      return { status: 202, body: jobStarted(r.jobId) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/jobs/{id}",
    operationId: "getJob",
    summary: "Hintergrundauftrag",
    description:
      "Status, Fortschritt und — solange gespeichert (30 Tage, EXP-026) — der Download-Link eines eigenen Auftrags. Jeder Scope der Auftragsart genügt (`exports:run` oder ein Lese-Scope).",
    tag: TAG,
    scope: "any",
    params: idParams("jobs"),
    response: { status: 200, schema: jobOut, description: "Der Auftrag" },
    handler: async ({ convex, params }) => ({ body: await jobOf(convex, params.id) }),
  }),
]);
