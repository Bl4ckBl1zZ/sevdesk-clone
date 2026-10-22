import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { prefixedId } from "@/domain/schemas/api/common";
import {
  type DatevExportWire,
  datevExportWire,
  datevStartArgs,
  type JobRecord,
  serializeJob,
} from "@/domain/schemas/api/exports";
import { refuseBlocking, startDatev, validateDatev } from "../../api/resources/exports";
import { rawId } from "../../api/resources/shared";
import { confirmTokenArg, defineTool, type ToolContext } from "../tool";
import type { PreviewPlan } from "./previews";

/**
 * 06 §3 / F09 §7 MCP: ⚠ `export_datev` (it can lock the period, E-EXP-19, CLAUDE.md rule 8) and the read-only
 * `export_job_status` for the download link. The token comes from `preview_action { action: "export_datev" }`, which
 * runs the same DATEV validation as REST `POST /exports/datev/validate` and binds exactly the arguments of
 * `datev.start` / `datev.startWithLock` (built by the shared `datevStartArgs`, incl. `lockPeriod`). No token while the
 * report blocks. No MCP tools for imports, GDPdU or the full export (F09 §7).
 */

export const exportDatevParams = datevExportWire;

const monthLabel = (date: string) => `${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** `preview_action { action: "export_datev" }`: the validation report and — with `lock_period` — the months to lock. */
export async function exportDatevPlan(params: DatevExportWire, { convex }: ToolContext): Promise<PreviewPlan> {
  const report = await validateDatev(convex, params);
  refuseBlocking(report);
  const args = datevStartArgs(params);
  return {
    args,
    entities: [],
    effect: {
      range: { from: params.from, to: params.to },
      include: args.scope,
      mode: params.mode,
      lock_period: params.lock_period,
      lock: params.lock_period
        ? `⚠ Alle noch offenen Monate bis einschließlich ${monthLabel(params.to)} werden vor dem Export unumkehrbar festgeschrieben (Grund „DATEV-Export“).`
        : null,
      festschreibung: report.festschreibung,
      files: report.files,
      row_count: report.row_count,
      sum_umsatz_cents: report.sum_umsatz_cents,
      is_repeat: report.is_repeat,
      advisor_acceptance_recorded: report.accepted,
      notes: report.issues.filter((i) => i.level !== "error"),
      summary: `DATEV-Export ${params.from} – ${params.to}: ${report.row_count} Buchungszeilen${params.lock_period ? ", Zeitraum wird festgeschrieben" : ""}.`,
    },
  };
}

export const exportTools = [
  defineTool({
    name: "export_datev",
    title: "DATEV-Export starten ⚠",
    description:
      '⚠ Startet den DATEV-Export (EXTF-Buchungsstapel, Stammdaten, Belege) für { from, to, include?, mode?: "new" | "full", lock_period? }. lock_period: true schreibt die Monate vorher unumkehrbar fest. Erst preview_action {action:"export_datev", params:{…dieselben Argumente…}} aufrufen (Prüfbericht; kein Token bei Fehlern), Auswirkung zeigen und bestätigen lassen, dann mit denselben Argumenten und confirm_token. Liefert job_id; den Download-Link gibt export_job_status, sobald der Auftrag fertig ist.',
    kind: "danger",
    confirmIntent: "export_datev",
    scopes: ["exports:run"],
    input: exportDatevParams.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, ...params }, { convex }) => ({
      ...(await startDatev(convex, params, confirm_token)),
      next: "export_job_status mit job_id aufrufen, bis status = done; dann result.url (Download-Link).",
    }),
  }),
  defineTool({
    name: "export_job_status",
    title: "Exportauftrag abfragen",
    description:
      "Status und Fortschritt eines eigenen Exportauftrags (job_…); wenn fertig: result.url (kurzlebiger Download-Link, nur im Tailnet) mit Dateiname und SHA-256; bei Fehler error mit den deutschen Meldungen.",
    kind: "read",
    scopes: ["exports:run"],
    input: z.object({ job_id: prefixedId("jobs") }),
    handler: async ({ job_id }, { convex }) =>
      serializeJob((await convex.query(api.jobs.get, { id: rawId("jobs", job_id) })) as JobRecord),
  }),
];
