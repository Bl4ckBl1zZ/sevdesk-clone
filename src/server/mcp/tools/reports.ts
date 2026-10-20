import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { serializeTaxReserve, taxReserveArgs } from "@/domain/schemas/api/reports";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { defineTool } from "../tool";

/** Report tools (06 §3, F08 §8): `tax_reserve_estimate` (RPT-010/011) — read only, always labelled an estimate. */
export const reportTools = [
  defineTool({
    name: "tax_reserve_estimate",
    title: "Steuer-Rücklage (Schätzung)",
    description:
      "Schätzung – keine Steuerberatung: offene Umsatzsteuer und geschätzte Einkommen-/Gewerbe-/Körperschaftsteuer des Jahres, Rücklage jetzt und Monatsbetrag. Gib immer den Hinweis „Schätzung – keine Steuerberatung“ und die Annahmen mit aus; nie als Wert für eine Steuererklärung darstellen.",
    kind: "read",
    scopes: ["reports:read"],
    input: z.object({
      year: z.number().int().min(2000).max(2100).optional(),
      profit_override_cents: z.number().int().optional(),
      deductions_cents: z.number().int().min(0).optional(),
      splitting: z.boolean().optional(),
      church_tax_bp: z.union([z.literal(0), z.literal(800), z.literal(900)]).optional(),
      hebesatz_bp: z.number().int().min(20_000).max(150_000).optional(),
    }),
    handler: async (a, { convex }) =>
      serializeTaxReserve(
        await convex.query(
          api.reports.taxReserve,
          taxReserveArgs(
            {
              ...(a.year !== undefined ? { year: a.year } : {}),
              ...(a.profit_override_cents !== undefined ? { profit_override_cents: a.profit_override_cents } : {}),
              ...(a.deductions_cents !== undefined ? { deductions_cents: a.deductions_cents } : {}),
              ...(a.hebesatz_bp !== undefined ? { hebesatz_bp: a.hebesatz_bp } : {}),
              ...(a.splitting !== undefined ? { splitting: a.splitting ? ("true" as const) : ("false" as const) } : {}),
              ...(a.church_tax_bp !== undefined
                ? { church_tax_bp: String(a.church_tax_bp) as "0" | "800" | "900" }
                : {}),
            },
            Number(berlinCalendarDate(Date.now()).slice(0, 4)),
          ),
        ),
      ),
  }),
];
