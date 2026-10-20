import { z } from "zod";
import type {} from "zod-openapi";
import type { TaxReserveResult } from "../../tax/reserve";

/**
 * Wire schema of the tax reserve estimate (F08 RPT-010/011): REST `GET /reports/tax-reserve` and the MCP tool
 * `tax_reserve_estimate` share the query and the serializer, so both carry `estimate: true`, the disclaimer
 * „Schätzung – keine Steuerberatung“, `assumptions[]` and `inputs` (TST-RPT-06).
 */

const cents = (description: string) => z.number().int().meta({ description });

export const taxReserveQuery = z
  .object({
    year: z.coerce
      .number()
      .int()
      .min(2000)
      .max(2100)
      .optional()
      .meta({ description: "Jahr (Standard: laufendes Jahr)" }),
    profit_override_cents: z.coerce.number().int().optional().meta({ description: "Jahresgewinn statt Hochrechnung" }),
    deductions_cents: z.coerce.number().int().min(0).optional().meta({ description: "Abzüge je Person" }),
    splitting: z.enum(["true", "false"]).optional().meta({ description: "Zusammenveranlagung" }),
    church_tax_bp: z.enum(["0", "800", "900"]).optional().meta({ description: "Kirchensteuer 0, 8 % oder 9 %" }),
    hebesatz_bp: z.coerce.number().int().min(20_000).max(150_000).optional().meta({ description: "400 % = 40000" }),
  })
  .strict();

export type TaxReserveQuery = z.infer<typeof taxReserveQuery>;

/** Wire query → Convex arguments of `reports.taxReserve`. */
export function taxReserveArgs(q: TaxReserveQuery, currentYear: number) {
  return {
    year: q.year ?? currentYear,
    ...(q.profit_override_cents !== undefined ? { profitOverrideCents: q.profit_override_cents } : {}),
    ...(q.deductions_cents !== undefined ? { deductionsCents: q.deductions_cents } : {}),
    ...(q.splitting ? { splitting: q.splitting === "true" } : {}),
    ...(q.church_tax_bp ? { churchTaxBp: Number(q.church_tax_bp) as 0 | 800 | 900 } : {}),
    ...(q.hebesatz_bp !== undefined ? { hebesatzBp: q.hebesatz_bp } : {}),
  };
}

const person = z.object({
  name: z.string(),
  share_bp: z.number().int(),
  profit_cents: cents("Gewinnanteil"),
  zve_cents: cents("Zu versteuerndes Einkommen (volle Euro)"),
  est_tariff_cents: cents("Einkommensteuer laut Tarif"),
  par35_credit_cents: cents("Gewerbesteueranrechnung § 35 EStG"),
  est_cents: cents("Einkommensteuer nach Anrechnung"),
  soli_cents: cents("Solidaritätszuschlag"),
  church_tax_cents: cents("Kirchensteuer"),
  total_cents: cents("Summe"),
});

export const taxReserveOut = z
  .object({
    estimate: z.literal(true),
    disclaimer: z.literal("Schätzung – keine Steuerberatung"),
    year: z.number().int(),
    rule_version: z.string(),
    rule_source: z.string(),
    banner: z.string().nullable(),
    notices: z.array(z.string()),
    profit: z.object({
      ytd_cents: z.number().int(),
      projected_cents: z.number().int(),
      basis: z.enum(["override", "annualised"]),
      months_elapsed: z.number().int(),
    }),
    ust: z.object({ open_cents: z.number().int(), periods: z.array(z.string()) }),
    persons: z.array(person),
    gewst: z
      .object({
        gewerbeertrag_cents: z.number().int(),
        messbetrag_cents: z.number().int(),
        gewst_cents: z.number().int(),
      })
      .nullable(),
    kst: z.object({ kst_cents: z.number().int(), soli_cents: z.number().int() }).nullable(),
    annual_cents: cents("Geschätzte Jahressteuer (ohne USt)"),
    prepaid_cents: cents("Erfasste Vorauszahlungen"),
    remaining_cents: cents("Noch offen nach Vorauszahlungen"),
    reserve_now_cents: cents("Jetzt zurückzulegen (inkl. offener USt)"),
    monthly_cents: cents("Monatlicher Betrag bis Jahresende"),
    months_left: z.number().int(),
    assumptions: z.array(z.string()),
    inputs: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .meta({ id: "TaxReserveEstimate" });

export function serializeTaxReserve(r: TaxReserveResult): z.infer<typeof taxReserveOut> {
  return {
    estimate: true,
    disclaimer: r.disclaimer,
    year: r.year,
    rule_version: r.ruleVersion,
    rule_source: r.ruleSource,
    banner: r.banner,
    notices: r.notices,
    profit: {
      ytd_cents: r.profit.ytdCents,
      projected_cents: r.profit.projectedCents,
      basis: r.profit.basis,
      months_elapsed: r.profit.monthsElapsed,
    },
    ust: { open_cents: r.ust.openCents, periods: r.ust.periods },
    persons: r.persons.map((p) => ({
      name: p.name,
      share_bp: p.shareBp,
      profit_cents: p.profitCents,
      zve_cents: p.zveCents,
      est_tariff_cents: p.estTariffCents,
      par35_credit_cents: p.par35CreditCents,
      est_cents: p.estCents,
      soli_cents: p.soliCents,
      church_tax_cents: p.churchTaxCents,
      total_cents: p.totalCents,
    })),
    gewst: r.gewst
      ? {
          gewerbeertrag_cents: r.gewst.gewerbeertragCents,
          messbetrag_cents: r.gewst.messbetragCents,
          gewst_cents: r.gewst.gewstCents,
        }
      : null,
    kst: r.kst ? { kst_cents: r.kst.kstCents, soli_cents: r.kst.soliCents } : null,
    annual_cents: r.annualCents,
    prepaid_cents: r.prepaidCents,
    remaining_cents: r.remainingCents,
    reserve_now_cents: r.reserveNowCents,
    monthly_cents: r.monthlyCents,
    months_left: r.monthsLeft,
    assumptions: r.assumptions,
    inputs: r.inputs,
  };
}
