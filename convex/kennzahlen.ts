import { v } from "convex/values";
import type { SheetFooter } from "../src/domain/exports/kennzahlen";
import type { UstvaSheet } from "../src/domain/tax/ustva";
import type { ZmSheet } from "../src/domain/tax/zm";
import { actorMutation, systemQuery } from "./functions";
import { appendAudit } from "./model/audit";
import { getCompanyProfile } from "./model/companyProfile";
import { periodContext, ustvaView, zmView } from "./model/taxFilings";

/**
 * F09 EXP-020: data of a Kennzahlen sheet download (UStVA or ZM of a filing period) — the F08 sheet as computed for
 * the tax pages plus the footer facts (rule versions, lock status of the period's months, active filing). Read only;
 * rendered by convex/kennzahlenNode.ts.
 */
export type SheetInput =
  | { form: "ustva"; sheet: UstvaSheet; footer: SheetFooter; company: string }
  | { form: "zm"; zm: ZmSheet; footer: SheetFooter; company: string };

export const sheetInput = systemQuery({
  job: "exports.run",
  args: { form: v.union(v.literal("ustva"), v.literal("zm")), period: v.string() },
  handler: async (ctx, { form, period }): Promise<SheetInput | null> => {
    const now = ctx.now();
    const pc = await periodContext(ctx, period, now);
    const periods = await ctx.db.query("periods").collect();
    const lockedMonths = periods
      .filter((p) => p.status === "locked" && pc.months.includes(p.period))
      .map((p) => p.period);
    const company = (await getCompanyProfile(ctx))?.name ?? "";
    const base = { generatedAt: now, months: pc.months, lockedMonths };
    const filingOf = (filings: { status: string; submittedOn: string | null; transmissionTicket: string | null }[]) =>
      filings.find((f) => f.status === "submitted_manually") ?? null;
    if (form === "ustva") {
      const view = await ustvaView(ctx, period, now);
      if (!view.sheet) return null;
      const footer: SheetFooter = {
        ...base,
        ruleVersions: [view.sheet.mappingVersion, view.guide?.id ?? ""],
        filing: filingOf(view.filings),
      };
      return { form, sheet: view.sheet, footer, company };
    }
    const view = await zmView(ctx, period, now);
    const footer: SheetFooter = { ...base, ruleVersions: [view.guide.id ?? ""], filing: filingOf(view.filings) };
    return { form, zm: view.zm, footer, company };
  },
});

/** AUD-001: the sheet leaves the system — audited like every export (attributed to the downloading member). */
export const recordDownload = actorMutation({
  permission: "tax.read",
  args: {
    form: v.union(v.literal("ustva"), v.literal("zm")),
    period: v.string(),
    format: v.union(v.literal("pdf"), v.literal("csv")),
    name: v.string(),
    sha256: v.string(),
  },
  handler: async (ctx, a) => {
    await appendAudit(ctx, {
      action: "export.kennzahlen",
      entity: { table: "exports", id: `kennzahlen-${a.form}-${a.period}`, label: a.name },
      diff: { after: { format: a.format, sha256: a.sha256 } },
    });
  },
});
