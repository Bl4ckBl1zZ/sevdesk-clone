import { makeContact, makeContext, SELLERS, TODAY } from "@test/factories/documents";
import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import {
  agreementIssues,
  companyAsBuyer,
  SELF_BILLING_MESSAGES,
  selfBillingContext,
  selfBillingFindings,
  selfBillingVoucherInput,
} from "./self-billing";

const AGREEMENT = { agreedOn: "2026-01-02", scope: "Provisionsabrechnungen", validFrom: "2026-01-01" };
const SUPPLIER = {
  address: { street: "Speicherstadt 4", postalCode: "20457", city: "Hamburg", countryCode: "DE" },
  taxNumber: "2275000100",
  phone: "+49 40 123456",
  email: "abrechnung@agentur-nord.de",
};
const findings = (over: Partial<Parameters<typeof selfBillingFindings>[0]> = {}) =>
  selfBillingFindings({
    type: "self_billing",
    documentDate: TODAY,
    supplierName: "Agentur Nord GmbH",
    agreement: AGREEMENT,
    supplier: SUPPLIER,
    ...over,
  }).map((f) => [f.code, f.message]);

describe("self-billing Pflichtangaben of the supplier (UST-33, UST-03, UST-04, ER-10)", () => {
  test("UST-33 only Gutschriften are checked; a complete supplier block passes", () => {
    expect(findings({ type: "invoice", agreement: null })).toEqual([]);
    expect(findings()).toEqual([]);
    expect(findings({ supplier: undefined, agreement: null }).map(([c]) => c)).toEqual([
      "self_billing_agreement_missing",
    ]);
  });

  test("UST-03 an incomplete supplier address is named; without a name the message says „dem Lieferanten“", () => {
    expect(
      findings({ supplierName: "", supplier: { ...SUPPLIER, address: { ...SUPPLIER.address, city: " " } } }),
    ).toEqual([["self_billing_supplier_address", SELF_BILLING_MESSAGES.supplierAddress("dem Lieferanten")]]);
    expect(findings({ supplier: { ...SUPPLIER, address: undefined } }).map(([c]) => c)).toEqual([
      "self_billing_supplier_address",
    ]);
  });

  test("UST-33 a supplier seated abroad is refused (LEGAL-OPEN: foreign suppliers)", () => {
    expect(findings({ supplier: { ...SUPPLIER, address: { ...SUPPLIER.address, countryCode: "AT" } } })).toEqual([
      ["self_billing_foreign_supplier", SELF_BILLING_MESSAGES.foreignSupplier],
    ]);
  });

  test("UST-04 ER-10 tax ID, e-invoice contact and XRechnung payout IBAN of the supplier", () => {
    const bare = { address: SUPPLIER.address, taxNumber: " ", vatId: "" };
    expect(findings({ supplier: bare, einvoice: true, xrechnung: true }).map(([c]) => c)).toEqual([
      "self_billing_supplier_tax_id",
      "self_billing_supplier_contact",
      "self_billing_supplier_iban",
    ]);
    expect(findings({ supplier: { ...bare, vatId: "DE136695976" } })).toEqual([]);
    expect(
      findings({ einvoice: true, xrechnung: true, agreement: { ...AGREEMENT, iban: "DE89370400440532013000" } }),
    ).toEqual([]);
  });
});

describe("self-billing agreement validation (INV-16)", () => {
  test("INV-16 dates, end before start, scope and IBAN are checked", () => {
    expect(agreementIssues({ agreedOn: "", validFrom: "01.01.2026", validTo: "bald", scope: " " })).toEqual([
      "Bitte das Datum der Vereinbarung angeben.",
      "Bitte angeben, ab wann die Vereinbarung gilt.",
      "Ungültiges Enddatum.",
      "Bitte den Umfang der Vereinbarung beschreiben (z. B. Provisionsabrechnungen).",
    ]);
    expect(agreementIssues({ ...AGREEMENT, validTo: "2025-12-31" })).toEqual(["Das Enddatum liegt vor dem Beginn."]);
    expect(agreementIssues({ ...AGREEMENT, iban: "DE12" })).toEqual(["Ungültige IBAN des Lieferanten."]);
    expect(agreementIssues({ ...AGREEMENT, iban: "de89 3704 0044 0532 0130 00", validTo: "2026-12-31" })).toEqual([]);
  });
});

describe("self-billing party swap (INV-16, F04 §4.9 step 2)", () => {
  test("INV-16 our company as buyer: trade name, PO box and register number; no contact person without contact data", () => {
    const b = companyAsBuyer({
      ...SELLERS.gmbh,
      tradeName: "Muster Design",
      address: { ...SELLERS.gmbh.address, poBox: "Postfach 12" },
      vatId: undefined,
      electronicAddress: undefined,
      contact: { name: "", phone: "", email: "" },
    });
    expect(b).toMatchObject({
      tradeName: "Muster Design",
      address: { poBox: "Postfach 12" },
      registerNumber: "HRB 123456 B",
      taxNumber: SELLERS.gmbh.taxNumber,
    });
    for (const k of ["vatId", "electronicAddress", "invoiceEmail", "contactPerson"]) expect(b).not.toHaveProperty(k);
    expect(companyAsBuyer({ ...SELLERS.gmbh, contact: { name: "", phone: "+49 1", email: "" } }).contactPerson).toEqual(
      {
        phone: "+49 1",
      },
    );
  });

  test("INV-16 a supplier without address or e-mail: empty address fields, country of the contact, no electronic address", () => {
    const supplier = makeContact({
      id: "s1",
      countryCode: "DE",
      buyer: { name: "Freie Fotografin", isConsumer: false, isPublicAuthority: false },
      selfBillingAgreement: AGREEMENT,
      archived: true,
    });
    const ctx = selfBillingContext(
      "self_billing",
      makeContext({ contact: supplier }, { seller: { ...SELLERS.gmbh, vatId: undefined } }),
    );
    expect(ctx.company.seller).toMatchObject({
      name: "Freie Fotografin",
      address: { street: "", postalCode: "", city: "", countryCode: "DE" },
      contact: { name: "Freie Fotografin", phone: "", email: "" },
    });
    expect(ctx.company.seller).not.toHaveProperty("electronicAddress");
    expect(ctx.contact).toMatchObject({ archived: true });
    expect(ctx.contact).not.toHaveProperty("vatId");
    expect(ctx).not.toHaveProperty("bankAccount");
  });

  test("INV-16 a stored electronic address and contact person of the supplier are used for the seller block", () => {
    const supplier = makeContact({
      buyer: {
        name: "Agentur Nord GmbH",
        tradeName: "Nord",
        address: { street: "Speicherstadt 4", postalCode: "20457", city: "Hamburg", countryCode: "DE", poBox: "PF 1" },
        electronicAddress: { scheme: "9930", value: "DE811907980" },
        contactPerson: { name: "Nina Nord", phone: "+49 40 1", email: "nina@nord.de" },
        isConsumer: false,
        isPublicAuthority: false,
      },
      phone: "+49 40 999",
      selfBillingAgreement: { ...AGREEMENT, iban: "de89 3704 0044 0532 0130 00" },
    });
    const ctx = selfBillingContext("self_billing", makeContext({ contact: supplier }));
    expect(ctx.company.seller).toMatchObject({
      tradeName: "Nord",
      address: { poBox: "PF 1" },
      contact: { name: "Nina Nord", phone: "+49 40 1", email: "nina@nord.de" },
      electronicAddress: { scheme: "9930", value: "DE811907980" },
    });
    expect(ctx.bankAccount).toEqual({ iban: "DE89370400440532013000", accountHolder: "Agentur Nord GmbH" });
  });

  test("INV-16 without a contact the context is returned unchanged", () => {
    const ctx = makeContext({ contact: undefined });
    expect(selfBillingContext("self_billing", ctx)).toBe(ctx);
  });
});

describe("self-billing purchase voucher (INV-16, F04 §4.9 step 4)", () => {
  test("INV-16 a KU supplier's Gutschrift without tax IDs and supply date: 0 % lines, no supplier IDs, no subject", () => {
    const s = makeSnapshot({
      type: "self_billing",
      number: "GS-2026-0001",
      taxCase: "kleinunternehmer",
      supplyDate: undefined,
      supplyDateIsDocumentDate: true,
      lines: [
        {
          kind: "item",
          name: "Fotos",
          quantityMilli: 1000,
          unitCode: "LS",
          unitPriceMicros: 500_000,
          vatCategory: "KU",
          vatRateBp: 0,
        },
      ],
    });
    const v = selfBillingVoucherInput(
      { ...s, seller: { ...s.seller, vatId: undefined, taxNumber: undefined }, supplyDate: undefined },
      "4780",
    );
    expect(v).not.toHaveProperty("supplierVatId");
    expect(v).not.toHaveProperty("supplierTaxNumber");
    expect(v).not.toHaveProperty("supplyDate");
    expect(v.lines).toEqual([
      {
        account: "4780",
        description: "Gutschrift GS-2026-0001 – Fotos",
        amountCents: 5_000,
        vatRateBp: 0,
        vatCents: 0,
      },
    ]);
  });
});
