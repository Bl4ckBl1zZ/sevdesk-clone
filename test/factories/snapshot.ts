/**
 * Snapshot test data shared by unit tests and the golden suite (07 §3.3, §4): seller/buyer presets and a builder
 * around `buildSnapshot` that throws on errors (fixtures must be valid).
 */
import { buildSnapshot, type SnapshotInput } from "@/domain/documents/build-snapshot";
import type { DocumentSnapshot, SnapshotBuyer, SnapshotSeller } from "@/domain/documents/snapshot";

export const SELLERS = {
  gmbh: {
    legalForm: "gmbh",
    name: "Muster Design GmbH",
    address: { street: "Hauptstraße 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
    seat: "Berlin",
    contact: {
      name: "Erika Musterfrau",
      phone: "+49 30 1234567",
      email: "rechnung@muster-design.de",
      website: "www.muster-design.de",
    },
    register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
    representatives: [{ name: "Max Mustermann" }, { name: "Erika Musterfrau" }],
    shareCapital: { amountCents: 2_500_000 },
    taxNumber: "1121081508150",
    taxNumberState: "BE",
    vatId: "DE123456788",
    electronicAddress: { scheme: "EM", value: "rechnung@muster-design.de" },
    kleinunternehmer: false,
    vatAccounting: "soll",
  },
  ek: {
    legalForm: "ek",
    name: "Bauer Elektrotechnik e.K.",
    address: { street: "Werkstraße 12", postalCode: "80331", city: "München", countryCode: "DE" },
    seat: "München",
    contact: { name: "Hans Bauer", phone: "+49 89 7654321", email: "info@bauer-elektro.de" },
    register: { court: "Amtsgericht München", type: "HRA", number: "98765" },
    representatives: [{ name: "Hans Bauer" }],
    taxNumber: "9143081508150",
    taxNumberState: "BY",
    vatId: "DE811569869",
    electronicAddress: { scheme: "EM", value: "info@bauer-elektro.de" },
    kleinunternehmer: false,
    vatAccounting: "ist",
  },
  ku: {
    legalForm: "einzelunternehmen",
    name: "Lena Kleinert Fotografie",
    address: { street: "Gartenweg 3", postalCode: "04109", city: "Leipzig", countryCode: "DE" },
    contact: { name: "Lena Kleinert", phone: "+49 341 555123", email: "hallo@kleinert-foto.de" },
    representatives: [],
    taxNumber: "3201081508150",
    taxNumberState: "SN",
    electronicAddress: { scheme: "EM", value: "hallo@kleinert-foto.de" },
    kleinunternehmer: true,
    vatAccounting: "ist",
  },
} as const satisfies Record<string, SnapshotSeller>;

export const BUYERS = {
  b2b: {
    name: "Beispiel Kunde GmbH",
    address: { street: "Musterweg 5", postalCode: "50667", city: "Köln", countryCode: "DE" },
    contactNumber: "K-10023",
    vatId: "DE811907980",
    invoiceEmail: "buchhaltung@beispiel-kunde.de",
    contactPerson: { name: "Max Beispiel" },
    isConsumer: false,
    isPublicAuthority: false,
  },
  consumer: {
    name: "Erika Beispiel",
    address: { street: "Lindenallee 12", postalCode: "04109", city: "Leipzig", countryCode: "DE" },
    contactNumber: "K-20007",
    invoiceEmail: "erika.beispiel@example.org",
    isConsumer: true,
    isPublicAuthority: false,
  },
  at: {
    name: "Alpen Consulting GmbH",
    address: { street: "Mariahilfer Straße 10", postalCode: "1060", city: "Wien", countryCode: "AT" },
    contactNumber: "K-30001",
    vatId: "ATU12345675",
    invoiceEmail: "office@alpen-consulting.at",
    isConsumer: false,
    isPublicAuthority: false,
  },
  fr: {
    name: "Atelier Lumière SARL",
    address: { street: "12 Rue de la Paix", postalCode: "75002", city: "Paris", countryCode: "FR" },
    contactNumber: "K-30002",
    vatId: "FR40303265045",
    invoiceEmail: "compta@atelier-lumiere.fr",
    isConsumer: false,
    isPublicAuthority: false,
  },
  ch: {
    name: "Bergwerk Maschinen AG",
    address: { street: "Bahnhofstrasse 1", postalCode: "8001", city: "Zürich", countryCode: "CH" },
    contactNumber: "K-30003",
    invoiceEmail: "kreditoren@bergwerk.ch",
    isConsumer: false,
    isPublicAuthority: false,
  },
  us: {
    name: "Pine Software Inc.",
    address: { street: "100 Market Street", postalCode: "94105", city: "San Francisco", countryCode: "US" },
    contactNumber: "K-30004",
    invoiceEmail: "ap@pinesoftware.example",
    isConsumer: false,
    isPublicAuthority: false,
  },
  construction: {
    name: "Hochbau Schmidt GmbH",
    address: { street: "Industriestraße 7", postalCode: "70173", city: "Stuttgart", countryCode: "DE" },
    contactNumber: "K-10040",
    registerNumber: "HRB 724111",
    invoiceEmail: "rechnungen@hochbau-schmidt.de",
    isConsumer: false,
    isPublicAuthority: false,
  },
  public: {
    name: "Stadtverwaltung Musterstadt",
    address: { street: "Rathausplatz 1", postalCode: "28195", city: "Bremen", countryCode: "DE" },
    contactNumber: "K-50001",
    invoiceEmail: "rechnungseingang@musterstadt.example",
    isConsumer: false,
    isPublicAuthority: true,
  },
} as const satisfies Record<string, SnapshotBuyer>;

export const BANK_ACCOUNT = {
  iban: "DE89370400440532013000",
  bic: "COBADEFFXXX",
  accountHolder: "Muster Design GmbH",
  bankName: "Commerzbank",
} as const;

export type SellerPreset = keyof typeof SELLERS;
export type BuyerPreset = keyof typeof BUYERS;

/** A complete standard invoice input (T-GLD-01 shape) that tests override field by field. */
export function makeSnapshotInput(overrides: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    type: "invoice",
    number: "RE-2026-0042",
    documentDate: "2026-10-12",
    supplyDate: { kind: "date", date: "2026-10-09" },
    language: "de",
    currency: "EUR",
    priceMode: "net",
    taxCase: "domestic",
    seller: SELLERS.gmbh,
    buyer: BUYERS.b2b,
    lines: [
      {
        kind: "item",
        name: "Beratung Webdesign",
        description: "Konzeption der Startseite",
        quantityMilli: 10_000,
        unitCode: "HUR",
        unitPriceMicros: 1_000_000,
        vatCategory: "S",
        vatRateBp: 1900,
        vatRuleRowId: "standard@2021-01-01",
      },
    ],
    payment: { method: "transfer", dueDays: 30, bankAccount: BANK_ACCOUNT, showEpcQr: true },
    einvoice: { format: "zugferd_en16931", decision: "PDF_NEEDS_CONSENT" },
    layoutVersionId: "layout-v1",
    ...overrides,
  };
}

export function makeSnapshot(overrides: Partial<SnapshotInput> = {}): DocumentSnapshot {
  const r = buildSnapshot(makeSnapshotInput(overrides));
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
