import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import {
  ADDRESS_CHANGED_BANNER,
  addressChanged,
  attentionLine,
  buildBuyerSnapshot,
  draftChangeBanner,
} from "./snapshot";
import { computeContactStats, revenueOf, type StatsDocument } from "./stats";
import { deriveTaxProfile, type TaxProfileInput } from "./tax-profile";

const d = calendarDate;
const today = d("2026-10-12");
const doc = (over: Partial<StatsDocument>): StatsDocument => ({
  docType: "invoice",
  documentDate: d("2026-03-01"),
  netCents: 0,
  grossCents: 0,
  currency: "EUR",
  ...over,
});

describe("CON-150 statistics (§5.9)", () => {
  test("T-CON-056 golden: invoice 1,000 €, advance 500 € + final 1,500 € deducting it, Storno −200 € → 2,300 €", () => {
    const docs = [
      doc({ netCents: 100_000, grossCents: 119_000 }),
      doc({ docType: "advance_invoice", netCents: 50_000, grossCents: 59_500 }),
      doc({ docType: "final_invoice", netCents: 150_000, grossCents: 178_500, deductedAdvanceNetCents: 50_000 }),
      doc({ docType: "cancellation", netCents: -20_000, grossCents: -23_800 }),
      doc({ docType: "quote", netCents: 999_999, accepted: true }),
      doc({ docType: "delivery_note", netCents: 999_999 }),
    ];
    const s = computeContactStats(docs, today);
    expect(s.revenueThisYearCents).toBe(230_000);
    expect(s.revenueAllTimeCents).toBe(230_000);
    expect(s.revenueLastYearCents).toBe(0);
    expect(s.quoteConversionBp).toBe(10_000);
    expect(s.invoiceCount).toBe(3);
  });

  test("T-CON-056 days-to-pay is gross-weighted over fully paid invoices of the last 24 months (≥ 3)", () => {
    const paid = (gross: number, docDate: string, settled: string, due?: string) =>
      doc({
        grossCents: gross,
        documentDate: d(docDate),
        settledOn: d(settled),
        paymentStatus: "paid",
        ...(due ? { dueDate: d(due) } : {}),
      });
    const docs = [
      paid(100_000, "2026-01-01", "2026-01-11", "2026-01-15"), // 10 days, delay 0 (−4 → 0)
      paid(300_000, "2026-02-01", "2026-03-03", "2026-02-15"), // 30 days, delay 16
      paid(100_000, "2026-04-01", "2026-04-21", "2026-04-15"), // 20 days, delay 6
      doc({
        grossCents: 900_000,
        documentDate: d("2026-05-01"),
        settledOn: d("2026-12-01"),
        paymentStatus: "paid",
        settledByStorno: true,
      }),
      paid(100_000, "2023-01-01", "2023-06-01"), // older than 24 months
    ];
    const s = computeContactStats(docs, today);
    // (100k·10 + 300k·30 + 100k·20) / 500k = 24
    expect(s.avgDaysToPay).toEqual({ days: 24, invoices: 3 });
    // (100k·0 + 300k·16 + 100k·6) / 500k = 10.8 → 11
    expect(s.avgDelay).toEqual({ days: 11, invoices: 3 });
    expect(computeContactStats(docs.slice(0, 2), today).avgDaysToPay).toBeNull();
  });

  test("CON-150 open and overdue sum openAmountCents; overdue is derived from today", () => {
    const docs = [
      doc({ grossCents: 119_000, openAmountCents: 119_000, paymentStatus: "open", dueDate: d("2026-10-01") }),
      doc({ grossCents: 119_000, openAmountCents: 50_000, paymentStatus: "partially_paid", dueDate: d("2026-10-30") }),
      doc({ grossCents: 119_000, openAmountCents: 0, paymentStatus: "paid", dueDate: d("2026-01-01") }),
      doc({ docType: "reminder" }),
    ];
    const s = computeContactStats(docs, today);
    expect(s.openCents).toBe(169_000);
    expect(s.overdueCents).toBe(119_000);
    expect(s.reminderCount).toBe(1);
    expect(s.lastInvoiceDate).toBe("2026-03-01");
  });

  test("T-CON-029 CON-E30 foreign currency is converted with the document rate", () => {
    expect(revenueOf(doc({ netCents: 108_500, currency: "USD", fxRateToEur: "1.085" }))).toBe(100_000);
    expect(revenueOf(doc({ docType: "quote", netCents: 1 }))).toBe(0);
  });

  test("CON-151 revenue by month for the last 12 months", () => {
    const s = computeContactStats(
      [doc({ netCents: 1000, documentDate: d("2026-10-01") }), doc({ netCents: 500, documentDate: d("2025-11-30") })],
      today,
    );
    expect(s.revenueByMonth).toHaveLength(12);
    expect(s.revenueByMonth[0]).toEqual({ month: "2025-11", cents: 500 });
    expect(s.revenueByMonth[11]).toEqual({ month: "2026-10", cents: 1000 });
    expect(computeContactStats([], d("2026-01-15")).revenueByMonth[0]?.month).toBe("2025-02");
  });
});

describe("CON-045 CON-046 derived tax profile", () => {
  const base: TaxProfileInput = {
    isConsumer: false,
    isPublicAuthority: false,
    billingCountry: "DE",
    companyIsKleinunternehmer: false,
    today,
  };
  const valid = { status: "valid" as const, qualified: true };

  test("CON-045 French business with a qualified VAT ID: EU-B2B service / intra-Community supply", () => {
    const p = deriveTaxProfile({ ...base, billingCountry: "FR", vatId: "FR12345678901", vatIdStatus: valid });
    expect(p.service).toEqual({
      taxCase: "eu_b2b_service",
      reason: "EU-B2B-Leistung (Frankreich, USt-IdNr qualifiziert geprüft)",
    });
    expect(p.goods.taxCase).toBe("intra_community_supply");
    expect(p.warnings).toEqual([]);
  });

  test("T-CON-067 CON-E33 French VAT ID, goods delivered to Munich → domestic with the notice", () => {
    const p = deriveTaxProfile({
      ...base,
      billingCountry: "FR",
      deliveryCountry: "DE",
      vatId: "FR12345678901",
      vatIdStatus: valid,
    });
    expect(p.goods.taxCase).toBe("domestic");
    expect(p.goods.reason).toContain("keine innergemeinschaftliche Lieferung");
  });

  test("T-CON-068 CON-E34 Belgian business without VAT ID buying a service → B2C (German VAT) with warning", () => {
    const p = deriveTaxProfile({ ...base, billingCountry: "BE" });
    expect(p.service.taxCase).toBe("domestic");
    expect(p.euB2C).toBe(true);
    expect(p.warnings.join(" ")).toContain("USt-IdNr prüfen");
  });

  test("T-CON-010 CON-E10 XI ID: goods → intra-Community supply, services → not taxable (O)", () => {
    const p = deriveTaxProfile({ ...base, billingCountry: "GB", vatId: "XI123456789", vatIdStatus: valid });
    expect(p.goods.taxCase).toBe("intra_community_supply");
    expect(p.service.taxCase).toBe("not_taxable_domestic");
  });

  test("T-CON-011 CON-E11 Austrian VAT ID with German address → country-mismatch warning", () => {
    const p = deriveTaxProfile({ ...base, vatId: "ATU12345678", vatIdStatus: valid });
    expect(p.warnings.some((w) => w.includes("Österreich") && w.includes("Deutschland"))).toBe(true);
  });

  test("T-CON-025 CON-E26 consumer flag with a valid VAT ID is treated as a business for §3a", () => {
    const p = deriveTaxProfile({
      ...base,
      isConsumer: true,
      billingCountry: "AT",
      vatId: "ATU12345678",
      vatIdStatus: valid,
    });
    expect(p.service.taxCase).toBe("eu_b2b_service");
    expect(p.warnings[0]).toContain("Unternehmen angenommen");
  });

  test("T-CON-030 CON-E31 Austrian consumer → EU-B2C flagged", () => {
    const p = deriveTaxProfile({ ...base, isConsumer: true, billingCountry: "AT" });
    expect(p.euB2C).toBe(true);
    expect(p.service.taxCase).toBe("domestic");
    expect(p.goods.taxCase).toBe("domestic");
  });

  test("CON-045 third countries: business service not taxable, consumer service domestic, goods export", () => {
    const biz = deriveTaxProfile({ ...base, billingCountry: "CH" });
    expect(biz.service.taxCase).toBe("not_taxable_domestic");
    expect(biz.goods.taxCase).toBe("export");
    expect(deriveTaxProfile({ ...base, isConsumer: true, billingCountry: "US" }).service.taxCase).toBe("domestic");
  });

  test("CON-045 Kleinunternehmer company and contact override", () => {
    const p = deriveTaxProfile({ ...base, companyIsKleinunternehmer: true, defaultTaxCase: "reverse_charge_13b" });
    expect(p.service.taxCase).toBe("kleinunternehmer");
    expect(p.override).toBe("reverse_charge_13b");
    expect(deriveTaxProfile({ ...base, vatId: "ATU12345678" }).warnings.join(" ")).toContain("nicht (gültig) geprüft");
  });
});

describe("CON-180 CON-182 CON-023 contact data on documents", () => {
  const contact = {
    id: "c1",
    number: "10042",
    displayName: "Müller GmbH",
    organizationName: "Müller GmbH",
    vatId: "ATU12345678",
    isConsumer: false,
    isPublicAuthority: false,
    language: "de" as const,
    customFields: { kostenstelle: "KS-1", intern: "geheim" },
  };
  const billing = {
    name: "Müller GmbH",
    street: "Hauptstr. 1",
    postalCode: "10115",
    city: "Berlin",
    countryCode: "DE",
  };

  test("CON-180 the snapshot freezes buyer data incl. printable custom fields and the check ID", () => {
    const s = buildBuyerSnapshot({
      contact,
      billingAddress: billing,
      attention: attentionLine({ salutation: "frau", academicTitle: "Dr.", firstName: "Anna", lastName: "Müller" }),
      printableCustomFieldKeys: ["kostenstelle"],
      vatIdCheckId: "chk1",
    });
    expect(s).toMatchObject({
      contactId: "c1",
      number: "10042",
      attention: "z. Hd. Frau Dr. Anna Müller",
      vatId: "ATU12345678",
      customFields: { kostenstelle: "KS-1" },
      vatIdCheckId: "chk1",
    });
    expect(s.customFields).not.toHaveProperty("intern");
  });

  test("T-CON-073 CON-182 banner lists what changed since the draft", () => {
    expect(draftChangeBanner({ vatId: "A", isConsumer: false }, { vatId: "B", isConsumer: true })).toBe(
      "Kontaktdaten wurden geändert: USt-IdNr, Kundentyp",
    );
    expect(draftChangeBanner({ vatId: "A" }, { vatId: "A" })).toBeNull();
  });

  test("T-CON-001 CON-023 drafts keep their address copy and ask before taking a new one", () => {
    expect(addressChanged(billing, { ...billing, street: "Ring 5", city: "Köln" })).toBe(true);
    expect(addressChanged(billing, { ...billing })).toBe(false);
    expect(ADDRESS_CHANGED_BANNER).toBe("Die Adresse des Kontakts wurde geändert — neue Adresse übernehmen?");
  });
});
