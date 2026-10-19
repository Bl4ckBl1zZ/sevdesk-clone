import type { BusinessEvent } from "../src/domain/accounting/events";
import type { Id } from "./_generated/dataModel";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { type PostJournalOptions, postJournalEntry } from "./model/journal";
import type { TestT } from "./test.setup";

/**
 * F08 P2 bookkeeping fixtures (not a Convex module: multi-dot file name): a company (Soll or Ist, KU or regular,
 * monthly or quarterly UStVA), one EUR bank account on 1200 and a customer/supplier contact; `post` runs the real
 * posting path (`postJournalEntry`) as the owner.
 */
export const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

export interface Books {
  bank: Id<"bankAccounts">;
  customer: Id<"contacts">;
}

export interface BooksOptions {
  ku?: boolean;
  method?: "soll" | "ist";
  period?: "monthly" | "quarterly";
  dauerfrist?: boolean;
  chart?: "SKR03" | "SKR04";
  bookkeepingStartDate?: string;
  legalForm?: "einzelunternehmen" | "gmbh";
}

export async function setupBooks(t: TestT, o: BooksOptions = {}): Promise<Books> {
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: "Muster Einzelunternehmen",
        legalForm: o.legalForm ?? "einzelunternehmen",
        chartOfAccounts: [{ validFromFiscalYear: 2025, chart: o.chart ?? "SKR03" }],
        taxationMethod: [{ validFrom: "2025-01-01", method: o.method ?? "soll" }],
        kleinunternehmer: [{ validFrom: "2025-01-01", isKU: o.ku ?? false }],
        ustvaPeriod: [2025, 2026, 2027].map((year) => ({
          year,
          period: o.period ?? "monthly",
          dauerfrist: o.dauerfrist ?? false,
        })),
        taxNumber: "21/815/08150",
        taxNumberState: "BE",
        address: {
          name: "Muster Einzelunternehmen",
          street: "Musterstr. 1",
          postalCode: "10115",
          city: "Berlin",
          countryCode: "DE",
        },
        ...(o.bookkeepingStartDate ? { bookkeepingStartDate: o.bookkeepingStartDate } : {}),
      },
      { action: "settings.tax.update" },
    ),
  );
  const bank = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "bankAccounts",
      {
        kind: "bank",
        name: "Revolut EUR",
        currency: "EUR",
        iban: "DE89370400440532013000",
        accountHolder: "Muster",
        ledgerAccount: "1200",
        showOnInvoices: true,
        isDefaultForInvoices: true,
        autoApplyMatches: true,
      },
      { action: "settings.bank_account.create" },
    ),
  );
  const customer = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "contacts",
      {
        kind: "organization",
        number: "10000",
        numberNormalized: "10000",
        roles: ["customer"],
        status: "active",
        organizationName: "Kunde GmbH",
        displayName: "Kunde GmbH",
        searchText: "kunde gmbh 10000",
        isConsumer: false,
        isPublicAuthority: false,
        reverseCharge13bCertificates: [],
        einvoice: { preferredFormat: "auto", pdfConsents: [] },
        language: "de",
        currency: "EUR",
        tags: [],
        customFields: {},
        version: 1,
      },
      { action: "contact.create" },
    ),
  );
  return { bank, customer };
}

export const post = (t: TestT, event: BusinessEvent, options?: PostJournalOptions) =>
  t.model(OWNER, (ctx) => postJournalEntry(ctx, event, options));

/** S1 domestic 19 % invoice (net in cents). */
export const invoiceEvent = (
  customer: string,
  id: string,
  date: string,
  net: number,
  over: Partial<Extract<BusinessEvent, { kind: "invoice_finalised" }>> = {},
): BusinessEvent => ({
  kind: "invoice_finalised",
  documentId: id,
  documentNumber: `RE-${id}`,
  documentType: "invoice",
  date,
  supplyDate: { kind: "date", date },
  taxCase: "domestic",
  contactId: customer,
  vatGroups: [{ category: "S", rateBp: 1900, netCents: net, vatCents: Math.round(net * 0.19) }],
  ...over,
});
