import { v } from "convex/values";
import { actorMutation, mutation, query, systemQuery } from "./functions";
import { auditorScopedDb } from "./lib/auditorScope";
import { appendAudit } from "./model/audit";
import { getCompanyProfile } from "./model/companyProfile";
import { forecastView, plannedItems, removePlannedItem, savePlannedItem } from "./model/forecast";
import { kpiView } from "./model/kpis";
import { bwaView, ledgerView, oposView, revenueView, susaView } from "./model/reports";
import { taxReserveView } from "./model/taxReserve";
import { verprobungView } from "./model/verprobung";

/**
 * Auswertungen (F08 §6 /auswertungen; RPT-001, RPT-003…RPT-007): SuSa, Kontenblatt, BWA-light, Offene Posten as of a
 * date and revenue reports. Read only (`reports:read`, every role; the auditor sees the granted fiscal years only via
 * the scoped db). Every result carries `meta` (parameters, generation time, rule versions, „vorläufig“).
 */

const range = { from: v.string(), to: v.string() };
const bwaArgs = {
  month: v.string(),
  variant: v.union(v.literal("accrual"), v.literal("cash")),
  costCenterId: v.optional(v.string()),
};
const oposArgs = { side: v.union(v.literal("debtors"), v.literal("creditors")), asOf: v.string() };
const revenueArgs = {
  ...range,
  groupBy: v.union(
    v.literal("customer"),
    v.literal("product"),
    v.literal("month"),
    v.literal("cost_center"),
    v.literal("project"),
  ),
  basis: v.union(v.literal("document_date"), v.literal("supply_date"), v.literal("cash")),
};
const susaArgs = { ...range, accountClass: v.optional(v.string()), includePersonal: v.optional(v.boolean()) };
const ledgerArgs = { ...range, account: v.string() };

/** RPT-004 Summen- und Saldenliste. */
export const susa = query({
  permission: "reports.read",
  args: susaArgs,
  handler: async (ctx, a) => susaView(ctx, a, ctx.now()),
});

/** RPT-005 Kontenblatt of one account (running balance, contra account, Belegfeld 1, drill-down). */
export const ledger = query({
  permission: "reports.read",
  args: ledgerArgs,
  handler: async (ctx, a) => ledgerView(ctx, a, ctx.now()),
});

/** RPT-003 BWA-light: month, fiscal year to date and prior year (accrual from the journal or cash basis). */
export const bwa = query({
  permission: "reports.read",
  args: bwaArgs,
  handler: async (ctx, a) => bwaView(ctx, a, ctx.now()),
});

/** RPT-006 Offene Posten (debtors/creditors) as of a date with reconciliation to the account balance (E-RPT-06). */
export const openItems = query({
  permission: "reports.read",
  args: oposArgs,
  handler: async (ctx, a) => oposView(ctx, a, ctx.now()),
});

/** RPT-007 revenue by customer / product / month / cost centre / project. */
export const revenue = query({
  permission: "reports.read",
  args: revenueArgs,
  handler: async (ctx, a) => revenueView(ctx, a, ctx.now()),
});

/** RPT-009 USt-Verprobung: booked VAT per rate vs. bases × rate, differences per document. */
export const verprobung = query({
  permission: "reports.read",
  args: range,
  handler: async (ctx, a) => verprobungView(ctx, a, ctx.now()),
});

/**
 * RPT-010/011 tax reserve estimate of a year: always `estimate: true` with the disclaimer „Schätzung – keine
 * Steuerberatung“, assumptions and inputs. Optional overrides (REST query / MCP arguments) are not saved.
 */
export const taxReserve = query({
  permission: "reports.read",
  args: {
    year: v.number(),
    profitOverrideCents: v.optional(v.number()),
    deductionsCents: v.optional(v.number()),
    splitting: v.optional(v.boolean()),
    churchTaxBp: v.optional(v.union(v.literal(0), v.literal(800), v.literal(900))),
    hebesatzBp: v.optional(v.number()),
  },
  handler: async (ctx, { year, ...overrides }) => taxReserveView(ctx, year, ctx.now(), overrides),
});

/** RPT-012 Liquiditätsvorschau: 90 daily points (erwartet / vorsichtig), items by source, threshold warning. */
export const forecast = query({
  permission: "reports.read",
  args: { thresholdCents: v.optional(v.number()) },
  handler: async (ctx, a) => forecastView(ctx, ctx.now(), a),
});

const vRecurrence = v.union(
  v.literal("once"),
  v.literal("P7D"),
  v.literal("P14D"),
  v.literal("P1M"),
  v.literal("P2M"),
  v.literal("P3M"),
  v.literal("P6M"),
  v.literal("P1Y"),
  v.literal("P2Y"),
  v.literal("P3Y"),
  v.literal("P4Y"),
  v.literal("P5Y"),
);

/** RPT-013 the planned items of the Liquiditätsvorschau (one-off or recurring). */
export const plannedCashItems = query({
  permission: "reports.read",
  args: {},
  handler: async (ctx) => plannedItems(ctx),
});

/** RPT-013 add or edit a planned item (not bookkeeping data; audited). */
export const savePlannedCashItem = mutation({
  permission: "accounting.write",
  args: {
    id: v.optional(v.id("plannedCashItems")),
    label: v.string(),
    amountCents: v.number(),
    date: v.string(),
    recurrence: vRecurrence,
    endDate: v.optional(v.string()),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  },
  handler: async (ctx, a) => savePlannedItem(ctx, a),
});

/** RPT-013 remove a planned item (audited). */
export const removePlannedCashItem = mutation({
  permission: "accounting.write",
  args: { id: v.id("plannedCashItems") },
  handler: async (ctx, { id }) => removePlannedItem(ctx, id),
});

/** RPT-002 dashboard KPIs of a period (month / quarter / year to date or custom). */
export const kpis = query({
  permission: "reports.read",
  args: {
    period: v.union(v.literal("month"), v.literal("quarter"), v.literal("year"), v.literal("custom")),
    from: v.optional(v.string()),
    to: v.optional(v.string()),
  },
  handler: async (ctx, a) => kpiView(ctx, ctx.now(), a),
});

/** Input of a report download (RPT-014), rendered by convex/reportsNode.ts. */
export const reportInput = systemQuery({
  job: "exports.run",
  args: {
    report: v.union(v.literal("susa"), v.literal("ledger"), v.literal("bwa"), v.literal("opos"), v.literal("revenue")),
    params: v.any(),
    /** F12 AUD-023: an auditor's download reads through the same year-scoped db as the screen. */
    auditorYears: v.optional(v.array(v.number())),
  },
  handler: async (rawCtx, { report, params, auditorYears }) => {
    const now = rawCtx.now();
    const profile = await getCompanyProfile(rawCtx);
    const company = profile?.name ?? "";
    const ctx = auditorYears
      ? { ...rawCtx, db: auditorScopedDb(rawCtx.db, auditorYears, profile?.fiscalYearStartMonth ?? 1) }
      : rawCtx;
    switch (report) {
      case "susa":
        return { report, company, data: await susaView(ctx, params, now) } as const;
      case "ledger":
        return { report, company, data: await ledgerView(ctx, params, now) } as const;
      case "bwa":
        return { report, company, data: await bwaView(ctx, params, now) } as const;
      case "opos":
        return { report, company, data: await oposView(ctx, params, now) } as const;
      case "revenue":
        return { report, company, data: await revenueView(ctx, params, now) } as const;
    }
  },
});

/** AUD-001: a report leaving the system is audited (attributed to the downloading member / key). */
export const recordDownload = actorMutation({
  permission: "reports.read",
  args: {
    report: v.string(),
    format: v.union(v.literal("pdf"), v.literal("csv")),
    name: v.string(),
    sha256: v.string(),
  },
  handler: async (ctx, a) => {
    await appendAudit(ctx, {
      action: "export.report",
      entity: { table: "exports", id: `report-${a.report}`, label: a.name },
      diff: { after: { format: a.format, sha256: a.sha256 } },
    });
  },
});
