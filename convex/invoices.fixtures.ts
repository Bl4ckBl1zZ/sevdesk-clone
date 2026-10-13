import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { BANK_ACCOUNT, BUYERS, SELLERS } from "../test/factories/snapshot";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, CONTACT_RANGE, createValues, orgForm, PRODUCT_RANGE, personForm } from "./catalog.fixtures";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { seedPaymentMethods, seedUnits } from "./model/lookups";
import type { TestT } from "./test.setup";

/**
 * Invoice-slice fixtures (not a Convex module: multi-dot file name). The company matches the golden seller presets
 * (test/factories/snapshot.ts) so a finalisation can be compared with the golden snapshots of the same input.
 */

export const INVOICE_RANGE = {
  key: "invoice",
  name: "Rechnungen",
  format: "RE-{YYYY}-{####}",
  resetPolicy: "yearly",
  next: 1,
};

export type SellerPreset = "gmbh" | "ku";

export async function setupInvoicing(t: TestT, opts: { seller?: SellerPreset; setupComplete?: boolean } = {}) {
  const owner = await t.asUser("owner");
  await owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE] },
  });
  const preset = opts.seller ?? "gmbh";
  const s = SELLERS[preset];
  const ku = preset === "ku";
  const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
  await t.model(actor, async (ctx) => {
    await seedUnits(ctx);
    await seedPaymentMethods(ctx);
    await patchCompanyProfile(
      ctx,
      {
        legalForm: s.legalForm,
        name: s.name,
        address: { name: s.name, ...s.address },
        ...("seat" in s ? { seat: s.seat } : {}),
        contact: { ...s.contact },
        ...("register" in s ? { register: { ...s.register } } : {}),
        representatives: s.representatives.map((r) => ({ ...r })),
        ...("shareCapital" in s ? { shareCapital: { ...s.shareCapital } } : {}),
        taxNumber: s.taxNumber,
        taxNumberState: s.taxNumberState,
        ...("vatId" in s ? { vatId: s.vatId } : {}),
        electronicAddress: { ...s.electronicAddress },
        kleinunternehmer: [{ validFrom: "2020-01-01", isKU: ku }],
        taxationMethod: [{ validFrom: "2020-01-01", method: s.vatAccounting }],
        ustvaPeriod: [{ year: 2026, period: "monthly", dauerfrist: false }],
        chartOfAccounts: [{ validFromFiscalYear: 2020, chart: "SKR03" }],
        priorYearTotalTurnoverCents: [
          { year: 2024, amountCents: ku ? 1_500_000 : 12_000_000 },
          { year: 2025, amountCents: ku ? 2_000_000 : 12_000_000 },
        ],
        ...(opts.setupComplete === false ? {} : { setupCompletedAt: Date.now() }),
      },
      { action: "settings.company.update" },
    );
  });
  const bankAccount = await t.model(actor, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: ku ? "Deutsche Kreditbank" : BANK_ACCOUNT.bankName,
        currency: "EUR",
        iban: ku ? "DE02120300000000202051" : BANK_ACCOUNT.iban,
        bic: ku ? "BYLADEM1001" : BANK_ACCOUNT.bic,
        accountHolder: ku ? "Lena Kleinert" : BANK_ACCOUNT.accountHolder,
        ledgerAccount: "1200",
        showOnInvoices: true,
        isDefaultForInvoices: true,
        autoApplyMatches: true,
      },
      { action: "settings.bank_account.create" },
    ),
  );
  return { owner, bankAccount };
}

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

/** BUYERS.b2b: an organisation with "z. Hd. Max Beispiel" — the invoice goes to the person under it. */
export async function b2bBuyer(owner: Owner) {
  const b = BUYERS.b2b;
  const org = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm(b.name, { number: b.contactNumber, vatId: b.vatId }), {
      address: { ...b.address },
      email: b.invoiceEmail,
    }),
  });
  const person = await owner.mutation(api.contacts.create, {
    values: createValues(personForm("Max", "Beispiel", { parentId: org.id })),
  });
  return { orgId: org.id as Id<"contacts">, personId: person.id as Id<"contacts"> };
}

/** BUYERS.consumer */
export async function consumerBuyer(owner: Owner) {
  const b = BUYERS.consumer;
  const r = await owner.mutation(api.contacts.create, {
    values: createValues(personForm("Erika", "Beispiel", { number: b.contactNumber, isConsumer: true }), {
      address: { ...b.address },
      email: b.invoiceEmail,
    }),
  });
  return r.id as Id<"contacts">;
}

/** A German construction company (§13b) */
export async function constructionBuyer(owner: Owner) {
  const r = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm("Hochbau Schmidt GmbH", { vatId: "DE811907980" }), {
      address: { ...BERLIN },
      email: "rechnungen@hochbau-schmidt.de",
    }),
  });
  return r.id as Id<"contacts">;
}

/** The T-GLD-01 draft: 10 h × 100,00 @ 19 %, 30 days, 2 % Skonto 14 days. */
export function invoiceValues(contactId: string, over: Partial<DraftValues> = {}): DraftValues {
  return {
    type: "invoice",
    contactId,
    supplyDateMode: "explicit",
    supplyDate: { kind: "date", date: "2026-10-09" as CalendarDate },
    currency: "EUR",
    priceMode: "net",
    paymentTerms: { dueDays: 30, skontoPercentBp: 200, skontoDays: 14 },
    showEpcQr: true,
    language: "de",
    lines: [
      {
        kind: "item",
        productType: "service",
        name: "Beratung Webdesign",
        description: "Konzeption der Startseite",
        quantityMilli: 10_000,
        unitCode: "HUR",
        unitPriceMicros: 1_000_000,
        vatRateKey: "standard",
      },
    ],
    ...over,
  };
}

/** Runs the scheduled pipeline steps (render) to completion. */
export async function settle(t: TestT) {
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 5));
    await t.finishInProgressScheduledFunctions();
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter(
        (j) => j.state.kind === "pending" || j.state.kind === "inProgress",
      ),
    );
    if (pending.length === 0) return;
  }
  throw new Error("scheduled functions did not settle");
}

/** T-GLD-01 invoice to the B2B buyer, finalised and rendered. */
export async function finalizedInvoice(t: TestT, over: Partial<DraftValues> = {}) {
  const setup = await setupInvoicing(t);
  const { personId, orgId } = await b2bBuyer(setup.owner);
  const { id } = await setup.owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId, over) });
  const r = await setup.owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { ...setup, id, number: r.number, personId, orgId };
}
