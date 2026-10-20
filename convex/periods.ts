import { v } from "convex/values";
import { mutation, query } from "./functions";
import { lockThrough, periodsOverview, previewLock } from "./model/periodLock";

/**
 * Festschreibung (F08 ACC-015…ACC-017, §6 /buchhaltung/festschreibung): month grid, lock preview (months covered
 * „lückenlos“ + checklist) and the irreversible lock. There is no unlock.
 */

/** Month grid of a fiscal year with status, reason, date and actor of each lock. */
export const overview = query({
  permission: "accounting.read",
  args: { fiscalYear: v.optional(v.number()) },
  handler: async (ctx, { fiscalYear }) => periodsOverview(ctx, ctx.now(), fiscalYear),
});

/** The months a lock of `period` would cover (E-ACC-15) and the pre-lock checklist (ACC-017). */
export const lockPreview = query({
  permission: "accounting.read",
  args: { period: v.string() },
  handler: async (ctx, { period }) => previewLock(ctx, period, ctx.now()),
});

/** ACC-015/016: locks `period` and every open earlier month of its fiscal year; blockers → `period_lock_blocked`. */
export const lock = mutation({
  permission: "accounting.lock",
  args: { period: v.string() },
  handler: async (ctx, { period }) => lockThrough(ctx, period, "manual"),
});
