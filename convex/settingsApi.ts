import { v } from "convex/values";
import { resolveRate } from "../src/domain/products/pricing";
import { VAT_RATE_KEY_LABELS, VAT_RATE_KEYS } from "../src/domain/rules/vat-rates";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { isCalendarDate } from "../src/domain/time/calendar-date";
import { query } from "./functions";
import { appError } from "./lib/errors";
import { getCompanyProfile } from "./model/companyProfile";

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
