import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "./catalog.fixtures";
import { b2bBuyer, consumerBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import type { TestT } from "./test.setup";

/**
 * Dunning-slice fixtures (not a Convex module: multi-dot file name). The invoice is 1.000,00 net + 19 % = 1.190,00,
 * dated 2026-10-12 with `dueDays` 0 (due the same day) and — unless `markSent: false` — marked sent by e-mail the
 * same day (Zugang 2026-10-12). Callers set the clock to 2026-10-12 before calling.
 */

export const REMINDER_RANGE = {
  key: "reminder",
  name: "Mahnungen",
  format: "MA-{YYYY}-{####}",
  resetPolicy: "yearly",
  next: 1,
};

export type DunningOwner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

/** „Exportieren“ + „Als versendet markieren“ with every exported file (F04 SND-16/17). */
export async function markSent(owner: DunningOwner, id: Id<"salesDocuments">, sentOn: string, channel: string) {
  const r = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
  return owner.mutation(api.invoices.markSent, {
    id,
    values: { sentOn, channel, artifactIds: r.files.map((f) => f.artifactId) },
  });
}

export async function dunningSetup(
  t: TestT,
  opts: { consumer?: boolean; reminderRange?: boolean; markSent?: boolean; dueDays?: number } = {},
) {
  const s = await setupInvoicing(t);
  const ranges = [
    CONTACT_RANGE,
    PRODUCT_RANGE,
    INVOICE_RANGE,
    ...(opts.reminderRange === false ? [] : [REMINDER_RANGE]),
  ];
  await s.owner.mutation(api.settings.saveNumberRanges, { values: { ranges } });
  const contactId = opts.consumer ? await consumerBuyer(s.owner) : (await b2bBuyer(s.owner)).personId;
  const { id } = await s.owner.mutation(api.invoices.createDraft, {
    values: invoiceValues(contactId, { paymentTerms: { dueDays: opts.dueDays ?? 0 } }),
  });
  await s.owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  const invoiceId = id as Id<"salesDocuments">;
  if (opts.markSent !== false) await markSent(s.owner, invoiceId, "2026-10-12", "email_manual");
  return { ...s, invoiceId, contactId };
}
