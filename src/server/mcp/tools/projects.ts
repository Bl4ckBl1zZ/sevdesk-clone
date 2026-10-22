import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { decodeId, encodeId } from "@/domain/api/ids";
import { appErrorData } from "../../api/http";
import { defineTool } from "../tool";

const ambiguity = new Set(["project_ambiguous", "project_not_found"]);

/** Raw Convex project IDs in the E-PRJ-22 candidates become public `prj_…` IDs. */
function publicCandidates(e: unknown): unknown {
  const data = appErrorData(e);
  if (!data || !ambiguity.has(String(data.reason)) || !Array.isArray(data.candidates)) return e;
  return {
    data: {
      ...data,
      candidates: (data.candidates as { id: string; number: string; name: string }[]).map((c) => ({
        ...c,
        id: encodeId("projects", c.id),
      })),
    },
  };
}

/** F11 §7 / 06 §3.9 project and time tools. Timer tools are not exposed (MCP logs completed durations). */
export const projectTools = [
  defineTool({
    name: "time_entry_log",
    title: "Zeit erfassen",
    description:
      "Erfasst eine erledigte Zeit auf einem Projekt: „2h auf Projekt Website: Workshop-Vorbereitung“. project = prj_…-ID, Projektnummer oder Name; duration wie „2h“, „1:30“, „90m“, „1,5“; date (YYYY-MM-DD) Standard heute. Bei mehrdeutigem oder unbekanntem Projekt kommt ein Fehler mit bis zu 5 candidates: den Nutzer fragen und mit project = prj_…-ID erneut aufrufen. Ergebnis enthält den Budgetstand des Projekts.",
    kind: "write",
    scopes: ["time:write"],
    input: z.object({
      project: z.string().min(1).max(200).meta({ description: "prj_…-ID, Projektnummer (PRJ-00001) oder Name" }),
      duration: z.string().min(1).max(40).meta({ description: "2h, 1:30, 90m, 1,5, 2h 15m" }),
      description: z.string().min(1).max(2000).meta({ description: "Tätigkeit, erscheint so auf der Rechnung" }),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .meta({ description: "YYYY-MM-DD, Standard heute (Europe/Berlin)" }),
      billable: z.boolean().optional(),
      product_id: z.string().optional().meta({ description: "prd_… (Leistung)" }),
    }),
    handler: async (a, { convex }) => {
      const project = a.project.startsWith("prj_") ? (decodeId("projects", a.project) ?? a.project) : a.project;
      const productId = a.product_id ? (decodeId("products", a.product_id) ?? a.product_id) : undefined;
      try {
        const r = await convex.mutation(api.timeEntries.log, {
          project,
          duration: a.duration,
          description: a.description,
          ...(a.date ? { date: a.date } : {}),
          ...(a.billable !== undefined ? { billable: a.billable } : {}),
          ...(productId ? { productId } : {}),
        });
        return {
          id: encodeId("timeEntries", r.id),
          project: { ...r.project, id: encodeId("projects", r.project.id) },
          entry: r.entry
            ? {
                date: r.entry.date,
                duration_minutes: r.entry.durationMinutes,
                description: r.entry.description,
                billable: r.entry.billable,
                hourly_rate_micros: r.entry.hourlyRateMicros,
                status: r.entry.status,
                source: r.entry.source,
              }
            : null,
          budget: r.budget
            ? {
                kind: r.budget.kind,
                consumed: r.budget.consumed,
                budget: r.budget.budget,
                ratio_bp: r.budget.ratioBp,
                level: r.budget.level,
                label: r.budget.label,
              }
            : null,
          warnings: r.warnings,
        };
      } catch (e) {
        throw publicCandidates(e);
      }
    },
  }),
];
