import { v } from "convex/values";
import { suggestUstvaPeriod } from "../src/domain/tax/filing-calendar";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { getCompanyProfile, patchCompanyProfile } from "./model/companyProfile";
import {
  activeFiling,
  filingsOf,
  filingsOfYear,
  kennzahlenOfSource,
  notifyTaxDeadlines,
  recordSubmission,
  svzView,
  taxDeadlines,
  ustvaView,
  zmView,
} from "./model/taxFilings";

/**
 * Steuern (F08 §6 /steuern/ustva, /steuern/zm; TAX-001…TAX-011, TAX-019…TAX-021): Kennzahlen sheets with drill-down,
 * the Mein ELSTER guides, the deadline calendar and the manual submission records (which lock the months). Reads are
 * `reports:read`; recording a submission is a UI-only owner/bookkeeper act with a fresh session (never MCP).
 */

/** UStVA sheet, guide, blockers, filings and correction worklist of a period (`YYYY-MM` / `YYYY-Qn`). */
export const ustva = query({
  permission: "tax.read",
  args: { period: v.string() },
  handler: async (ctx, { period }) => ustvaView(ctx, period, ctx.now()),
});

/** ZM rows per USt-IdNr, reconciliation with Kz 41/21, guide and BZSt CSV. */
export const zm = query({
  permission: "tax.read",
  args: { period: v.string() },
  handler: async (ctx, { period }) => zmView(ctx, period, ctx.now()),
});

/** Dauerfristverlängerung / Sondervorauszahlung of a year (USt 1 H). */
export const sondervorauszahlung = query({
  permission: "tax.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => svzView(ctx, year, ctx.now()),
});

/** TAX-019 deadline calendar of a tax year with done flags. */
export const deadlines = query({
  permission: "tax.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => taxDeadlines(ctx, year),
});

/** All submission records of a year. */
export const filings = query({
  permission: "tax.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => filingsOfYear(ctx, year),
});

/** TAX-005 back-link on document/voucher detail pages: „UStVA 2026-09 Kz 81“. */
export const sourceKennzahlen = query({
  permission: "tax.read",
  args: { kind: v.union(v.literal("salesDocument"), v.literal("voucher"), v.literal("payment")), id: v.string() },
  handler: async (ctx, source) => kennzahlenOfSource(ctx, source),
});

/** TAX-001: current setting and suggestion for a year (prior-year Kz 83 sum of the recorded filings). */
export const filingSettings = query({
  permission: "tax.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => {
    const profile = await getCompanyProfile(ctx);
    const row = profile?.ustvaPeriod.find((p) => p.year === year) ?? null;
    let priorTax: number | null = null;
    for (const p of [
      ...Array.from({ length: 12 }, (_, i) => `${year - 1}-${String(i + 1).padStart(2, "0")}`),
      ...[1, 2, 3, 4].map((q) => `${year - 1}-Q${q}`),
    ]) {
      const active = activeFiling(await filingsOf(ctx, "ustva", p));
      if (!active) continue;
      const v83 = active.values.find((x) => x.kz === "83")?.cents ?? 0;
      const v39 = active.values.find((x) => x.kz === "39")?.cents ?? 0;
      priorTax = (priorTax ?? 0) + v83 + v39;
    }
    return {
      year,
      setting: row,
      suggestion: suggestUstvaPeriod({ year, priorYearTaxCents: priorTax, foundedOn: profile?.foundedOn }),
      priorYearTaxCents: priorTax,
    };
  },
});

/** TAX-001/TAX-002 owner setting: Voranmeldungszeitraum and Dauerfristverlängerung of a year (audited). */
export const setFilingPeriod = mutation({
  permission: "tax.settings",
  args: {
    year: v.number(),
    period: v.union(v.literal("monthly"), v.literal("quarterly"), v.literal("annual_only")),
    dauerfrist: v.boolean(),
  },
  handler: async (ctx, { year, period, dauerfrist }) => {
    const profile = await getCompanyProfile(ctx);
    if (!profile) throw appError("setup_incomplete");
    if (dauerfrist && period === "annual_only") {
      throw appError("invalid_input", "Eine Dauerfristverlängerung gibt es nur bei Voranmeldungen.");
    }
    const rows = profile.ustvaPeriod.filter((p) => p.year !== year);
    rows.push({ year, period, dauerfrist });
    rows.sort((a, b) => a.year - b.year);
    await patchCompanyProfile(ctx, { ustvaPeriod: rows }, { action: "settings.tax.update" });
  },
});

/** Upload URL for the optional ELSTER Übermittlungsprotokoll (PDF). */
export const protocolUploadUrl = mutation({
  permission: "tax.submit",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/**
 * TAX-021 „Übermittlung erfassen“: date, Transferticket (mandatory), protocol PDF, cross-check value and the sheet
 * hash the owner worked from; blocked on changed values or a mismatching cross-check unless „abweichend übermittelt“.
 */
export const recordFilingSubmission = mutation({
  permission: "tax.submit",
  args: {
    form: v.union(v.literal("ustva"), v.literal("zm"), v.literal("sondervorauszahlung")),
    period: v.string(),
    submittedOn: v.string(),
    transferTicket: v.string(),
    protocolStorageId: v.optional(v.id("_storage")),
    crossCheckCents: v.number(),
    sheetHash: v.string(),
    valuesDifferReason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.submittedOn > berlinCalendarDate(ctx.now())) {
      throw appError("invalid_input", "Das Übermittlungsdatum darf nicht in der Zukunft liegen.");
    }
    return recordSubmission(ctx, args);
  },
});

/** `deadlines.notify` part for tax deadlines (TAX-019): daily 08:00 Europe/Berlin, idempotent per deadline. */
export const notifyTaxDeadlinesCron = systemMutation({
  job: "cron.deadlines.notify",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return { created: 0 };
    return { created: await notifyTaxDeadlines(ctx) };
  },
});
