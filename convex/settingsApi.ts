import { v } from "convex/values";
import { taxationMethodAt } from "../src/domain/accounting/period";
import { resolveRate } from "../src/domain/products/pricing";
import { VAT_RATE_KEY_LABELS, VAT_RATE_KEYS } from "../src/domain/rules/vat-rates";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { isCalendarDate } from "../src/domain/time/calendar-date";
import { query } from "./functions";
import { appError } from "./lib/errors";
import { getCompanyProfile } from "./model/companyProfile";
import { companyContext } from "./model/contacts";
import { setupChecklist } from "./model/setup";

/**
 * Settings reads for REST and MCP (05 §4.8, F01 §7.1). Writes stay UI-only in this slice; tax status, server
 * location and the access concept are owner-only and never leave through the API (SET-142).
 */

/** GET /settings/company: the profile without storage ids and without the owner-only setup facts. */
export const company = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const p = await getCompanyProfile(ctx);
    if (!p) return null;
    const {
      _id,
      _creationTime,
      logoStorageId,
      accessConcept,
      serverLocation,
      euerExemptionConfirmedAt,
      lastRestoreDrillOn,
      chartOfAccounts,
      ...rest
    } = p;
    return {
      ...rest,
      chartOfAccounts: chartOfAccounts.map((c) => ({ validFromFiscalYear: c.validFromFiscalYear, chart: c.chart })),
      hasLogo: logoStorageId !== undefined,
    };
  },
});

/** GET /settings/company/public and MCP resource `rechnung://company` (SET-021: the public subset only). */
export const companyPublic = query({
  permission: "company.public",
  args: {},
  handler: async (ctx) => {
    const p = await getCompanyProfile(ctx);
    if (!p) return null;
    return {
      name: p.name,
      tradeName: p.tradeName ?? null,
      legalForm: p.legalForm,
      address: p.address,
      contact: { name: p.contact.name, phone: p.contact.phone, email: p.contact.email },
      website: p.contact.website ?? null,
      vatId: p.vatId ?? null,
      register: p.register ?? null,
      representatives: p.representatives.map((r) => r.name),
    };
  },
});

/** GET /settings/tax-rates?date= (05 §4.8) and `/settings/vat-rate-keys` (F03 §7.1): keys resolved on the date. */
export const taxRates = query({
  permission: "settings.read",
  args: { date: v.optional(v.string()) },
  handler: async (ctx, { date }) => {
    if (date !== undefined && !isCalendarDate(date)) {
      throw appError("invalid_input", "Datum im Format JJJJ-MM-TT.", { field: "date" });
    }
    const day = date ?? berlinCalendarDate(ctx.now());
    return Object.keys(VAT_RATE_KEYS).flatMap((key) => {
      const r = resolveRate(key, day);
      if (!r.ok) return [];
      return [
        {
          key,
          label: VAT_RATE_KEY_LABELS[key as keyof typeof VAT_RATE_KEY_LABELS],
          rateBp: r.value.value.rateBp,
          category: r.value.value.category,
          ruleRowId: r.value.rowId,
          date: day,
        },
      ];
    });
  },
});

/**
 * MCP `workspace_overview` (06 §3.1): the best first call. Receivables, drafts and tax deadlines arrive with
 * F04/F05/F08; until then the overview reports the company, its tax status, the master-data counts and setup gaps.
 */
export const workspaceOverview = query({
  permission: "workspace.overview",
  args: {},
  handler: async (ctx) => {
    const p = await getCompanyProfile(ctx);
    const cc = await companyContext(ctx, ctx.now());
    const { blocking, warnings } = await setupChecklist(ctx, ctx.now());
    const contacts = await ctx.db
      .query("contacts")
      .withIndex("by_status_name", (q) => q.eq("status", "active"))
      .collect();
    const products = await ctx.db
      .query("products")
      .withIndex("by_active_name", (q) => q.eq("active", true))
      .collect();
    return {
      today: cc.today,
      company: p
        ? {
            name: p.name,
            legalForm: p.legalForm,
            kleinunternehmer: cc.kleinunternehmer,
            taxationMethod: p.taxationMethod.length > 0 ? taxationMethodAt(p.taxationMethod, cc.today) : null,
            setupCompleted: p.setupCompletedAt !== undefined,
          }
        : null,
      counts: {
        activeContacts: contacts.filter((c) => !c.mergedIntoId && c.dsgvo?.restrictedAt === undefined).length,
        activeProducts: products.length,
      },
      setup: {
        blocking: blocking.map((b) => ({ code: b.code, message: b.message })),
        warnings: warnings.map((w) => ({ code: w.code, message: w.message })),
      },
    };
  },
});
