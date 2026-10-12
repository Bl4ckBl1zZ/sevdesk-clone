/**
 * Draft and context fixtures for the document domain tests (F04 §5, T-TAB-06). Valid by default: a GmbH invoicing a
 * German business one service line at 19 % — `validateDocument` returns no E findings for `makeDraft()` +
 * `makeContext()`.
 */
import type { ContactContext, DocumentContext, DraftDocument, DraftLine } from "@/domain/documents/draft";
import type { CalendarDate } from "@/domain/time/calendar-date";
import { BANK_ACCOUNT, BUYERS, SELLERS } from "./snapshot";

const { kleinunternehmer: _ku, vatAccounting: _va, ...GMBH } = SELLERS.gmbh;

export const TODAY = "2026-10-12" as CalendarDate;

export const serviceLine = (patch: Partial<DraftLine> = {}): DraftLine => ({
  kind: "item",
  productType: "service",
  name: "Webdesign Startseite",
  quantityMilli: 10_000,
  unitCode: "HUR",
  unitPriceMicros: 950_000,
  vatRateKey: "standard",
  ...patch,
});

export const goodLine = (patch: Partial<DraftLine> = {}): DraftLine => ({
  kind: "item",
  productType: "good",
  name: "Netzwerkkabel Cat. 7, 5 m",
  quantityMilli: 2_000,
  unitCode: "C62",
  unitPriceMicros: 129_000,
  vatRateKey: "standard",
  ...patch,
});

export function makeDraft(patch: Partial<DraftDocument> = {}): DraftDocument {
  return {
    type: "invoice",
    contactId: "contact-1",
    supplyDate: { kind: "date", date: "2026-10-09" },
    supplyDateMode: "explicit",
    currency: "EUR",
    priceMode: "net",
    paymentTerms: { dueDays: 14 },
    showEpcQr: true,
    language: "de",
    lines: [serviceLine()],
    ...patch,
  };
}

export function makeContact(patch: Partial<ContactContext> = {}): ContactContext {
  return {
    id: "contact-1",
    buyer: BUYERS.b2b,
    countryCode: "DE",
    isConsumer: false,
    isPublicAuthority: false,
    vatId: BUYERS.b2b.vatId,
    vatChecks: [],
    preferredFormat: "auto",
    pdfConsents: [],
    certificates13b: [],
    ...patch,
  };
}

export function makeContext(
  patch: Partial<DocumentContext> = {},
  company: Partial<DocumentContext["company"]> = {},
): DocumentContext {
  return {
    today: TODAY,
    setupComplete: true,
    integrityAlertOpen: false,
    numberRangeAvailable: true,
    company: {
      seller: GMBH,
      validation: { blocking: [], warnings: [] },
      kleinunternehmer: [],
      taxationMethod: [{ validFrom: "2020-01-01", method: "soll" }],
      priorYearTurnover: [{ year: 2025, amountCents: 50_000_000 }],
      backdateWindowDays: 10,
      ...company,
    },
    contact: makeContact(),
    bankAccount: BANK_ACCOUNT,
    paymentMethod: { kind: "transfer", text: "Überweisung" },
    unitCodes: new Set(["HUR", "C62", "DAY", "MON", "KGM", "LS", "MTR"]),
    ...patch,
  };
}

export { BUYERS, SELLERS };
