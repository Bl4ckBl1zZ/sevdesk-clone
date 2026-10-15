import { v } from "convex/values";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { invoicePaymentArgs, recordPayment as recordPaymentModel } from "./model/payments";
import { settlementOf } from "./model/settlement";

/**
 * E2E only (IS_TEST): records a real F05 payment (clearing account of the default invoice bank account, today) so the
 * Storno/correction/final-invoice journeys can put an invoice into „bezahlt“/„teilweise bezahlt“ without the bank
 * import (F04 INV-11, EC-071). Called with the admin key from e2e/backend.ts; returns null and writes nothing unless
 * the deployment has IS_TEST=true.
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
    const account = await defaultInvoiceAccount(ctx, doc.currency);
    if (!account) throw new Error("no default invoice bank account");
    await recordPaymentModel(
      ctx,
      await invoicePaymentArgs(ctx, {
        documentId: doc._id,
        source: { kind: "clearing", accountId: account._id },
        date: berlinCalendarDate(Date.now()),
        amountCents,
      }),
    );
    const s = await settlementOf(ctx, (await ctx.db.get(doc._id)) ?? doc);
    return { openCents: s.openCents, receivedCents: s.receivedCents };
  },
});
