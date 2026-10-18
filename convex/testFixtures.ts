import { v } from "convex/values";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { backdateDraftForTest } from "./model/dunning";
import { invoicePaymentArgs, recordPayment as recordPaymentModel } from "./model/payments";
import { ensureInvoicingSetupForTest } from "./model/seeds";
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

/**
 * Integration tests only (IS_TEST, test/integration/refund-race.test.ts): fills the invoicing setup an API key needs
 * to create, finalise and refund documents (company profile, number ranges incl. Rechnungskorrekturen, invoice bank
 * account, seeded lookups) — gaps only, an existing setup stays. Returns null and writes nothing unless IS_TEST=true.
 */
export const ensureInvoicingSetup = systemMutation({
  job: "test",
  args: {},
  handler: async (ctx) => {
    if (!isTest()) return null;
    return { added: await ensureInvoicingSetupForTest(ctx) };
  },
});

/**
 * E2E only (IS_TEST): makes the invoice draft `id` due `dueDaysAgo` days ago (document date in the past, due the same
 * day, backdating reason) so that after „Fertigstellen“ and „Als versendet markieren“ the dunning run plans level 1
 * (F05 T05-161). Drafts only — finalised documents stay immutable. Returns null and writes nothing unless IS_TEST=true.
 */
export const backdateDraft = systemMutation({
  job: "test",
  args: { id: v.id("salesDocuments"), dueDaysAgo: v.number() },
  handler: async (ctx, { id, dueDaysAgo }) => {
    if (!isTest()) return null;
    return backdateDraftForTest(ctx, id, Math.max(0, Math.min(180, Math.floor(dueDaysAgo))));
  },
});
