import { v } from "convex/values";
import { systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { recordStandInPayment } from "./model/settlement";

/**
 * E2E only (IS_TEST): stand-in for the payments slice (F05) so the Storno/correction/final-invoice journeys can put
 * an invoice into „bezahlt“/„teilweise bezahlt“ (F04 INV-11, EC-071). Called with the admin key from e2e/backend.ts;
 * returns null and writes nothing unless the deployment has IS_TEST=true.
 */
export const recordPayment = systemMutation({
  job: "test",
  args: { number: v.string(), amountCents: v.number() },
  handler: async (ctx, { number, amountCents }) => {
    if (!isTest()) return null;
    const doc = await ctx.db
      .query("salesDocuments")
      .withIndex("by_number", (q) => q.eq("number", number))
      .first();
    if (!doc) throw new Error(`unknown document ${number}`);
    const s = await recordStandInPayment(ctx, doc._id, amountCents);
    return { openCents: s.openCents, receivedCents: s.receivedCents };
  },
});
