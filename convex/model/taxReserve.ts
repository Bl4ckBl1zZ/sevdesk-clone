import { chartAt } from "../../src/domain/accounting/period";
import { chartAccounts } from "../../src/domain/rules/accounting";
import { euerMappingFor } from "../../src/domain/rules/euer";
import { cashBasisItems, computeEuer } from "../../src/domain/tax/euer";
import { estimateTaxReserve, type TaxEntity, type TaxReserveResult } from "../../src/domain/tax/reserve";
import { filingPeriodLabel } from "../../src/domain/tax/ustva";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { calendarDate } from "../../src/domain/time/calendar-date";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { euerContext, isBilanz } from "./euer";
import { ledgerAccountsOf } from "./ledgerAccounts";
import { reportLines } from "./reports";
import { taxDeadlines } from "./taxFilings";
import type { ModelCtx, ReadCtx } from "./types";
import { kuOn } from "./vouchers";

/**
 * Tax reserve read model (F08 RPT-010/011): loads the YTD profit (EÜR cash basis, or the accrual result for Bilanz
 * companies), the open USt liability from the VAT accounts, the ESt/GewSt/KSt prepayments recorded as tax-payment
 * vouchers of the year and the saved assumptions, then hands them to `estimateTaxReserve` (pure).
 */

const CORPORATIONS = new Set(["gmbh", "ug", "ag"]);
const PARTNERSHIPS = new Set(["gbr", "egbr", "ohg", "kg", "gmbh_co_kg", "partg"]);
const NO_GEWERBE = new Set(["freiberufler", "partg"]);
const VAT_KEYS = new Set(["BE.UST_VEREINNAHMT", "BA.VORSTEUER", "BA.UST_GEZAHLT"]);

export type TaxReserveOverrides = {
  profitOverrideCents?: number;
  deductionsCents?: number;
  splitting?: boolean;
  churchTaxBp?: 0 | 800 | 900;
  hebesatzBp?: number;
};

export const entityOf = (legalForm: string): TaxEntity =>
  CORPORATIONS.has(legalForm) ? "corporation" : PARTNERSHIPS.has(legalForm) ? "partnership" : "natural";

export async function taxReserveInputsOf(ctx: ReadCtx, year: number): Promise<Doc<"taxReserveInputs"> | null> {
  return ctx.db
    .query("taxReserveInputs")
    .withIndex("by_year", (q) => q.eq("year", year))
    .first();
}

/** Profit of `year` up to today: EÜR (Zufluss/Abfluss) or the accrual result of the journal (Bilanz). */
async function ytdProfit(ctx: ReadCtx, profile: Doc<"companyProfile">, year: number, today: string) {
  const to = today < `${year}-12-31` ? today : `${year}-12-31`;
  if (!isBilanz(profile, year)) {
    const { context, entries } = await euerContext(ctx, profile, year);
    const items = cashBasisItems(entries, context).filter((i) => i.date <= to);
    const mapping = euerMappingFor(year) ?? euerMappingFor(2026);
    const sheet = computeEuer(year, items, mapping, { ku: kuOn(profile, `${year}-12-31`) });
    return { cents: sheet.sums.gewinnCents, basis: "euer" as const };
  }
  const chart = chartAt(profile.chartOfAccounts, profile.fiscalYearStartMonth ?? 1, to);
  const seed = chartAccounts(chart, calendarDate(to));
  const types = new Map<string, string>();
  for (const a of seed.ok ? seed.value : []) types.set(a.number, a.type);
  for (const a of (await ledgerAccountsOf(ctx, chart)).custom) types.set(a.number, a.type);
  let cents = 0;
  for (const l of await reportLines(ctx, to)) {
    if (!l.date.startsWith(String(year))) continue;
    const t = types.get(l.account);
    if (t === "revenue" || t === "expense") cents += l.creditCents - l.debitCents;
  }
  return { cents, basis: "accrual" as const };
}

/** Accounts holding the USt liability (Umsatzsteuer, Vorsteuer, USt-Vorauszahlungen) of the chart valid on `date`. */
export async function vatAccountSet(
  ctx: ReadCtx,
  profile: Doc<"companyProfile">,
  date: string,
  o: { withPrepayments: boolean } = { withPrepayments: true },
) {
  const chart = chartAt(profile.chartOfAccounts, profile.fiscalYearStartMonth ?? 1, date);
  const seed = chartAccounts(chart, calendarDate(date));
  const keep = (k: string) => VAT_KEYS.has(k) && (o.withPrepayments || k !== "BA.UST_GEZAHLT");
  const vat = new Set<string>();
  for (const a of seed.ok ? seed.value : []) if (keep(a.euerKey)) vat.add(a.number);
  for (const a of (await ledgerAccountsOf(ctx, chart)).custom) if (keep(a.euerKey)) vat.add(a.number);
  return vat;
}

/** Open USt liability: balance of the VAT accounts (Umsatzsteuer − Vorsteuer − Vorauszahlungen) on `today`. */
async function openUst(ctx: ReadCtx, profile: Doc<"companyProfile">, today: string) {
  if (kuOn(profile, today)) return 0;
  const vat = await vatAccountSet(ctx, profile, today);
  let cents = 0;
  for (const l of await reportLines(ctx, today)) if (vat.has(l.account)) cents += l.creditCents - l.debitCents;
  return cents;
}

async function prepaid(ctx: ReadCtx, year: number) {
  const out = { est: 0, gewst: 0, kst: 0 };
  for (const v of await ctx.db.query("vouchers").collect()) {
    if (v.status === "draft" || v.status === "cancelled" || !v.taxPayment) continue;
    const of = v.taxPayment.period?.slice(0, 4) ?? v.documentDate?.slice(0, 4);
    if (of !== String(year)) continue;
    const cents = v.totalsEur?.grossCents ?? v.totals.grossCents;
    if (v.taxPayment.subtype === "est_private") out.est += cents;
    else if (v.taxPayment.subtype === "gewerbesteuer") out.gewst += cents;
    else if (v.taxPayment.subtype === "kst") out.kst += cents;
  }
  return out;
}

export async function taxReserveView(
  ctx: ReadCtx,
  year: number,
  now: number,
  overrides: TaxReserveOverrides = {},
): Promise<TaxReserveResult & { saved: Doc<"taxReserveInputs"> | null; legalForm: string }> {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw appError("invalid_input", "Ungültiges Jahr.");
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const today = berlinCalendarDate(now);
  const saved = await taxReserveInputsOf(ctx, year);
  const profit = await ytdProfit(ctx, profile, year, today);
  const openDeadlines = (await taxDeadlines(ctx, year)).filter((d) => d.kind === "ustva" && !d.done && d.period);
  const profitOverride = overrides.profitOverrideCents ?? saved?.profitOverrideCents;
  const deductions = overrides.deductionsCents ?? saved?.deductionsCents;
  const hebesatz = overrides.hebesatzBp ?? saved?.gewerbesteuerHebesatzBp;
  const result = estimateTaxReserve({
    year,
    today,
    entity: entityOf(profile.legalForm),
    gewerbe: !NO_GEWERBE.has(profile.legalForm),
    ytdProfitCents: profit.cents,
    profitBasis: profit.basis,
    ...(profitOverride !== undefined ? { profitOverrideCents: profitOverride } : {}),
    ...(deductions !== undefined ? { deductionsCents: deductions } : {}),
    splitting: overrides.splitting ?? saved?.splitting ?? false,
    churchTaxBp: overrides.churchTaxBp ?? saved?.churchTaxBp ?? 0,
    ...(hebesatz !== undefined ? { hebesatzBp: hebesatz } : {}),
    ...(saved?.partners ? { partners: saved.partners } : {}),
    prepaidCents: await prepaid(ctx, year),
    ust: {
      openCents: await openUst(ctx, profile, today),
      periods: openDeadlines
        .filter((d) => (d.period ?? "") <= today.slice(0, 7))
        .map((d) => filingPeriodLabel(d.period ?? "")),
    },
  });
  if (hebesatz === undefined && result.gewst) {
    result.notices.push("Hebesatz nicht hinterlegt – 400 % angenommen. Bitte den Hebesatz Ihrer Gemeinde eintragen.");
  }
  return { ...result, saved, legalForm: profile.legalForm };
}

export interface TaxReserveInputPatch {
  year: number;
  profitOverrideCents?: number | null;
  deductionsCents?: number | null;
  splitting: boolean;
  churchTaxBp?: 0 | 800 | 900;
  gewerbesteuerHebesatzBp?: number | null;
  partners?: { name: string; shareBp: number }[];
}

export async function saveTaxReserveInputs(ctx: ModelCtx, input: TaxReserveInputPatch) {
  const amounts = [input.profitOverrideCents, input.deductionsCents, input.gewerbesteuerHebesatzBp];
  if (amounts.some((a) => a !== undefined && a !== null && !Number.isInteger(a))) {
    throw appError("invalid_input", "Beträge müssen ganze Cent sein.");
  }
  if ((input.deductionsCents ?? 0) < 0) throw appError("invalid_input", "Abzüge dürfen nicht negativ sein.");
  if (
    input.gewerbesteuerHebesatzBp != null &&
    (input.gewerbesteuerHebesatzBp < 20_000 || input.gewerbesteuerHebesatzBp > 150_000)
  ) {
    // §16 Abs. 4 S. 2 GewStG: at least 200 %
    throw appError("invalid_input", "Der Hebesatz muss zwischen 200 % und 1.500 % liegen.");
  }
  if (input.partners && input.partners.reduce((s, p) => s + p.shareBp, 0) !== 10_000) {
    throw appError("invalid_input", "Die Gewinnanteile müssen zusammen 100 % ergeben.");
  }
  const value = {
    year: input.year,
    splitting: input.splitting,
    ...(input.profitOverrideCents != null ? { profitOverrideCents: input.profitOverrideCents } : {}),
    ...(input.deductionsCents != null ? { deductionsCents: input.deductionsCents } : {}),
    ...(input.churchTaxBp !== undefined ? { churchTaxBp: input.churchTaxBp } : {}),
    ...(input.gewerbesteuerHebesatzBp != null ? { gewerbesteuerHebesatzBp: input.gewerbesteuerHebesatzBp } : {}),
    ...(input.partners ? { partners: input.partners } : {}),
  };
  const existing = await taxReserveInputsOf(ctx, input.year);
  const audit = { action: "settings.tax_reserve.update", label: `Steuer-Rücklage ${input.year}` };
  if (!existing) return auditedInsert(ctx, "taxReserveInputs", value, audit);
  await auditedPatch(
    ctx,
    "taxReserveInputs",
    existing._id,
    {
      ...value,
      profitOverrideCents: value.profitOverrideCents,
      deductionsCents: value.deductionsCents,
      gewerbesteuerHebesatzBp: value.gewerbesteuerHebesatzBp,
    },
    audit,
  );
  return existing._id;
}
