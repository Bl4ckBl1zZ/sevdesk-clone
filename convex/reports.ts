import { v } from "convex/values";
import { actorMutation, query, systemQuery } from "./functions";
import { appendAudit } from "./model/audit";
import { getCompanyProfile } from "./model/companyProfile";
import { bwaView, ledgerView, oposView, revenueView, susaView } from "./model/reports";

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
  groupBy: v.union(v.literal("customer"), v.literal("product"), v.literal("month"), v.literal("cost_center")),
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

/** RPT-007 revenue by customer / product / month / cost centre. */
export const revenue = query({
  permission: "reports.read",
  args: revenueArgs,
  handler: async (ctx, a) => revenueView(ctx, a, ctx.now()),
});

/** Input of a report download (RPT-014), rendered by convex/reportsNode.ts. */
export const reportInput = systemQuery({
  job: "exports.run",
  args: {
    report: v.union(v.literal("susa"), v.literal("ledger"), v.literal("bwa"), v.literal("opos"), v.literal("revenue")),
    params: v.any(),
  },
  handler: async (ctx, { report, params }) => {
    const now = ctx.now();
    const company = (await getCompanyProfile(ctx))?.name ?? "";
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
