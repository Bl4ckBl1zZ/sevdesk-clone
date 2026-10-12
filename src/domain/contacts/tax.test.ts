import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import {
  checkElectronicAddress,
  documentFormatFor,
  effectiveElectronicAddress,
  nextFreeAccount,
  normalizeContactVatId,
  paymentTermWarnings,
  type TaxFields,
  validateTaxFields,
} from "./tax";

const today = calendarDate("2026-10-12");
const biz: TaxFields = { isConsumer: false, isPublicAuthority: false, preferredFormat: "auto" };
const errs = (f: TaxFields, ctx = {}) => validateTaxFields(f, ctx).errors.map((e) => e.code);
const warns = (f: TaxFields, ctx = {}) => validateTaxFields(f, ctx).warnings.map((e) => e.code);

describe("CON-043 CON-050 VAT ID on the contact", () => {
  test("T-CON-033 CON-050 DE123456788 valid, DE123456789 → VAT_ID_CHECKSUM, format per country", () => {
    expect(normalizeContactVatId("DE 123 456 788")).toEqual({ vatId: "DE123456788" });
    expect(normalizeContactVatId("DE123456789").error?.code).toBe("VAT_ID_CHECKSUM");
    expect(normalizeContactVatId("FR123").error).toMatchObject({
      code: "VAT_ID_FORMAT_INVALID",
      message: "Die USt-IdNr hat nicht das Format für FR.",
    });
    expect(normalizeContactVatId("").vatId).toBeUndefined();
  });

  test("T-CON-012 CON-E12 GB IDs → VAT_ID_NOT_EU; on the check date the EU table decides", () => {
    expect(normalizeContactVatId("GB123456789").error?.code).toBe("VAT_ID_NOT_EU");
    expect(normalizeContactVatId("CHE123456789").error?.code).toBe("VAT_ID_NOT_EU");
    expect(normalizeContactVatId("XI123456789", { today }).vatId).toBe("XI123456789");
    expect(normalizeContactVatId("XI123456789", { today: calendarDate("2020-06-01") }).error?.code).toBe(
      "VAT_ID_NOT_EU",
    );
  });

  test("§5.4 own USt-IdNr → VAT_ID_OWN; GR is converted to EL with a hint", () => {
    expect(normalizeContactVatId("DE123456788", { today, ownVatId: "DE123456788" }).error?.message).toBe(
      "Das ist Ihre eigene USt-IdNr.",
    );
    const gr = normalizeContactVatId("GR123456789", { today });
    expect(gr.vatId).toBe("EL123456789");
    expect(gr.warning?.code).toBe("VAT_ID_GR_CONVERTED");
  });

  test("T-CON-025 CON-E26 consumer with a VAT ID → warning only", () => {
    expect(warns({ ...biz, isConsumer: true, vatId: "ATU12345678" })).toContain("CONSUMER_WITH_VAT_ID");
  });
});

describe("CON-044 default tax case §5.3", () => {
  test("CON-044 kleinunternehmer is not allowed; §13b not for consumers; K/AE without foreign VAT ID warns", () => {
    expect(errs({ ...biz, defaultTaxCase: "kleinunternehmer" })).toEqual(["TAX_CASE_NOT_ALLOWED"]);
    expect(errs({ ...biz, defaultTaxCase: "unknown_imported" })).toEqual(["TAX_CASE_NOT_ALLOWED"]);
    expect(errs({ ...biz, isConsumer: true, defaultTaxCase: "reverse_charge_13b" })).toEqual(["TAX_CASE_CONFLICT"]);
    expect(warns({ ...biz, defaultTaxCase: "eu_b2b_service", vatId: "DE123456788" })).toEqual([
      "TAX_CASE_NEEDS_VAT_ID",
    ]);
    expect(warns({ ...biz, defaultTaxCase: "intra_community_supply", vatId: "ATU12345678" })).toEqual([]);
  });
});

describe("CON-041 CON-084 Leitweg-ID and buyer reference", () => {
  test("T-CON-039 CON-084 valid Leitweg-IDs; checksum and format errors", () => {
    const b2g: TaxFields = { ...biz, isPublicAuthority: true };
    for (const id of ["04011000-1234512345-06", "991-33333TEST-33", "991-01234-38"]) {
      expect(errs({ ...b2g, buyerReference: id }), id).toEqual([]);
    }
    expect(errs({ ...b2g, buyerReference: "991-01234-44" })).toEqual(["LEITWEG_ID_CHECKSUM"]);
    expect(errs({ ...b2g, buyerReference: "ABC-12" })).toEqual(["LEITWEG_ID_FORMAT"]);
    expect(validateTaxFields({ ...b2g, buyerReference: "991-33333test-33" }).normalized.buyerReference).toBe(
      "991-33333TEST-33",
    );
  });

  test("T-CON-040 CON-041 B2G without Leitweg-ID → LEITWEG_ID_REQUIRED; pdf → FORMAT_NOT_ALLOWED", () => {
    const v = validateTaxFields({ ...biz, isPublicAuthority: true, preferredFormat: "pdf" });
    expect(v.errors.map((e) => e.code)).toEqual(["LEITWEG_ID_REQUIRED", "FORMAT_NOT_ALLOWED"]);
    expect(v.errors[0]?.message).toBe("Für öffentliche Auftraggeber ist die Leitweg-ID Pflicht.");
  });

  test("CON-084 non-B2G buyer reference is free text ≤ 100 chars", () => {
    expect(errs({ ...biz, buyerReference: "PO-4711" })).toEqual([]);
    expect(errs({ ...biz, buyerReference: "x".repeat(101) })).toEqual(["TOO_LONG"]);
  });
});

describe("CON-080 CON-083 e-invoice preferences", () => {
  test("CON-080 preference → document format mapping", () => {
    expect(documentFormatFor("zugferd", false)).toBe("zugferd_en16931");
    expect(documentFormatFor("pdf", false)).toBe("none");
    expect(documentFormatFor("xrechnung_cii", false)).toBe("xrechnung_cii");
    expect(documentFormatFor("auto", true)).toBe("xrechnung_ubl");
    expect(documentFormatFor("auto", false)).toBe("zugferd_en16931");
  });

  test("§5.6 pdf for a business without consent warns", () => {
    expect(warns({ ...biz, preferredFormat: "pdf" })).toEqual(["PDF_WITHOUT_CONSENT"]);
    expect(warns({ ...biz, preferredFormat: "pdf", hasValidPdfConsent: true })).toEqual([]);
    expect(warns({ ...biz, isConsumer: true, preferredFormat: "pdf" })).toEqual([]);
  });

  test("T-CON-041 CON-083 BT-49 defaults: EM + first invoice e-mail; B2G 0204 + Leitweg-ID", () => {
    expect(effectiveElectronicAddress({ isPublicAuthority: false, invoiceEmails: ["r@m.de", "b@m.de"] })).toEqual({
      scheme: "EM",
      value: "r@m.de",
    });
    expect(
      effectiveElectronicAddress({
        isPublicAuthority: true,
        buyerReference: "991-01234-38",
        invoiceEmails: ["r@m.de"],
      }),
    ).toEqual({ scheme: "0204", value: "991-01234-38" });
    expect(effectiveElectronicAddress({ isPublicAuthority: true, invoiceEmails: [] })).toBeUndefined();
    expect(effectiveElectronicAddress({ isPublicAuthority: false, invoiceEmails: [] })).toBeUndefined();
    const explicit = { scheme: "9930" as const, value: "DE123456788" };
    expect(
      effectiveElectronicAddress({ electronicAddress: explicit, isPublicAuthority: false, invoiceEmails: [] }),
    ).toBe(explicit);
  });

  test("§5.5 electronic address per scheme", () => {
    expect(checkElectronicAddress({ scheme: "0204", value: "991-01234-44" })?.message).toBe(
      "Für das Schema 0204 muss eine gültige Leitweg-ID angegeben werden.",
    );
    expect(checkElectronicAddress({ scheme: "EM", value: "x" })?.code).toBe("ELECTRONIC_ADDRESS_INVALID");
    expect(checkElectronicAddress({ scheme: "9930", value: "ATU12345678" })?.message).toBe(
      "Für das Schema 9930 wird eine deutsche USt-IdNr erwartet.",
    );
    expect(checkElectronicAddress({ scheme: "9930", value: "DE123456788" })).toBeNull();
    expect(checkElectronicAddress({ scheme: "0204", value: "991-01234-38" })).toBeNull();
    expect(errs({ ...biz, electronicAddress: { scheme: "EM", value: "nope" } })).toEqual([
      "ELECTRONIC_ADDRESS_INVALID",
    ]);
  });
});

describe("CON-090 … CON-093 payment defaults", () => {
  test("§5.3 due days 0–365, Skonto 0,01–10 %, Skonto days < due days", () => {
    expect(errs({ ...biz, paymentTerms: { dueDays: 366 } })).toEqual(["OUT_OF_RANGE"]);
    expect(errs({ ...biz, paymentTerms: { dueDays: 14, skontoPercentBp: 2000, skontoDays: 7 } })).toEqual([
      "OUT_OF_RANGE",
    ]);
    expect(errs({ ...biz, paymentTerms: { dueDays: 14, skontoPercentBp: 200, skontoDays: 14 } })).toEqual([
      "SKONTO_INVALID",
    ]);
    expect(errs({ ...biz, paymentTerms: { dueDays: 14, skontoPercentBp: 200 } })).toEqual(["SKONTO_INCOMPLETE"]);
    expect(errs({ ...biz, paymentTerms: { dueDays: 30, skontoPercentBp: 200, skontoDays: 10, text: "x" } })).toEqual(
      [],
    );
  });

  test("T-CON-046 CON-091 MAHN-04: business 61 days → warning; public authority 31 → warning", () => {
    expect(paymentTermWarnings(61, { isConsumer: false, isPublicAuthority: false })[0]?.message).toBe(
      "Zahlungsziele über 60 Tage sind im B2B-Verkehr nur eingeschränkt zulässig (§ 271a BGB).",
    );
    expect(paymentTermWarnings(60, { isConsumer: false, isPublicAuthority: false })).toEqual([]);
    expect(paymentTermWarnings(31, { isConsumer: false, isPublicAuthority: true })[0]?.code).toBe(
      "DUE_DAYS_PUBLIC_AUTHORITY",
    );
    expect(paymentTermWarnings(90, { isConsumer: true, isPublicAuthority: false })).toEqual([]);
    expect(
      warns({ ...biz, isPublicAuthority: true, buyerReference: "991-01234-38", paymentTerms: { dueDays: 45 } }),
    ).toEqual(["DUE_DAYS_PUBLIC_AUTHORITY"]);
  });

  test("CON-092 discount 0–100 %, warning above 50 %", () => {
    expect(errs({ ...biz, defaultDiscountBp: 10001 })).toEqual(["OUT_OF_RANGE"]);
    expect(warns({ ...biz, defaultDiscountBp: 5001 })).toEqual(["DISCOUNT_HIGH"]);
  });

  test("CON-093 IBAN validated and stored electronically; BIC validated", () => {
    const v = validateTaxFields({ ...biz, iban: "DE89 3704 0044 0532 0130 00", bic: "cobadeffxxx" });
    expect(v.errors).toEqual([]);
    expect(v.normalized).toMatchObject({ iban: "DE89370400440532013000", bic: "COBADEFFXXX" });
    expect(errs({ ...biz, iban: "DE00 1234" })).toEqual(["IBAN_INVALID"]);
    expect(errs({ ...biz, bic: "XYZ" })).toEqual(["BIC_INVALID"]);
  });
});

describe("CON-100 CON-101 DATEV personal accounts", () => {
  test("T-CON-048 CON-100 account 70001 as debtor → DEBTOR_ACCOUNT_RANGE (L = 4)", () => {
    const e = validateTaxFields({ ...biz, debtorAccount: "70001" }, { accountLength: 4 }).errors[0];
    expect(e).toMatchObject({
      code: "DEBTOR_ACCOUNT_RANGE",
      message: "Debitorenkonten liegen zwischen 10000 und 69999.",
    });
    expect(errs({ ...biz, creditorAccount: "69999" }, { accountLength: 4 })).toEqual(["CREDITOR_ACCOUNT_RANGE"]);
    expect(errs({ ...biz, debtorAccount: "10000", creditorAccount: "70000" }, { accountLength: 4 })).toEqual([]);
    expect(errs({ ...biz, debtorAccount: "100000" }, { accountLength: 5 })).toEqual([]);
  });

  test("T-CON-047 CON-101 next free number = max used + 1 within the range", () => {
    const range = { from: 10000, to: 69999 };
    expect(nextFreeAccount([], range)).toBe("10000");
    expect(nextFreeAccount(["10000", "10007", "70001", "abc"], range)).toBe("10008");
    expect(nextFreeAccount(["69999"], range)).toBeNull();
  });
});
