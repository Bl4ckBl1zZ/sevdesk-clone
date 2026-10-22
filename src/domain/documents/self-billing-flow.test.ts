import { makeContact, makeContext, makeDraft, SELLERS, serviceLine, TODAY } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import { parseReceivedXml } from "../einvoice/parse";
import { serializeEinvoice } from "../einvoice/serialize";
import { buildSnapshot } from "./build-snapshot";
import type { ContactContext, DocumentContext, DraftDocument } from "./draft";
import { buildSnapshotInput } from "./finalize";
import { buildRenderModel } from "./render-model";
import { selfBillingContext } from "./self-billing";
import { validateDocument } from "./validate";

const AGREEMENT = { agreedOn: "2026-01-02", scope: "Provisionsabrechnungen", validFrom: "2026-01-01" };

const SUPPLIER: ContactContext = makeContact({
  id: "supplier-1",
  buyer: {
    name: "Agentur Nord GmbH",
    address: { street: "Speicherstadt 4", postalCode: "20457", city: "Hamburg", countryCode: "DE" },
    contactNumber: "70010",
    vatId: "DE811907980",
    taxNumber: "2275000100",
    invoiceEmail: "abrechnung@agentur-nord.de",
    contactPerson: { name: "Nina Nord" },
    isConsumer: false,
    isPublicAuthority: false,
  },
  vatId: "DE811907980",
  phone: "+49 40 123456",
  selfBillingAgreement: AGREEMENT,
});

const commission = (patch: Partial<DraftDocument> = {}) =>
  makeDraft({
    type: "self_billing",
    contactId: "supplier-1",
    documentDate: TODAY,
    supplyDate: { kind: "month", month: "2026-09" },
    lines: [
      serviceLine({
        name: "Provision September 2026",
        quantityMilli: 1_000,
        unitCode: "C62",
        unitPriceMicros: 50_000_000,
      }),
    ],
    ...patch,
  });

function swapped(contact: ContactContext = SUPPLIER, company: Partial<DocumentContext["company"]> = {}) {
  return selfBillingContext("self_billing", makeContext({ contact }, company));
}

function finalSnapshot(draft: DraftDocument, ctx: DocumentContext) {
  const v = validateDocument(draft, ctx);
  const errors = v.findings.filter((f) => f.severity === "E");
  if (errors.length) throw new Error(errors.map((e) => e.code).join(", "));
  const s = buildSnapshot(
    buildSnapshotInput(draft, ctx, v.resolved, {
      number: "GS-2026-0001",
      documentDate: TODAY,
      layoutVersionId: "layout-v1",
      plan: v.einvoice,
    }),
  );
  if (!s.ok) throw new Error(s.error.code);
  return s.value;
}

describe("self-billing party swap through the P1 pipeline (F04 §4.9, INV-16; UST-11, UST-33)", () => {
  test("INV-16 UST-11 T-INV-013 seller = the supplier, buyer = our company, title „Gutschrift“, TypeCode 389", () => {
    const s = finalSnapshot(commission(), swapped());
    expect(s.type).toBe("self_billing");
    expect(s.seller).toMatchObject({ name: "Agentur Nord GmbH", vatId: "DE811907980", kleinunternehmer: false });
    expect(s.seller.contact).toEqual({
      name: "Nina Nord",
      phone: "+49 40 123456",
      email: "abrechnung@agentur-nord.de",
    });
    expect(s.buyer).toMatchObject({ name: SELLERS.gmbh.name, vatId: SELLERS.gmbh.vatId, isConsumer: false });
    expect(s.issuer?.name).toBe(SELLERS.gmbh.name);
    expect(s.totals).toMatchObject({ netCents: 500_000, vatCents: 95_000, grossCents: 595_000 });
    expect(s.notes.find((n) => n.id === "sb_info")?.de).toBe(
      "Gutschrift (Abrechnung durch den Leistungsempfänger, § 14 Abs. 2 Satz 2 UStG).",
    );
    // our bank account is not the payee and no due date / EPC QR asks anybody to pay us
    expect(s.payment.bankAccount).toBeUndefined();
    expect(s.dueDate).toBeUndefined();

    const m = buildRenderModel(s);
    expect(m.title).toBe("Gutschrift");
    expect(m.recipient.slice(0, 3)).toEqual(["Agentur Nord GmbH", "Speicherstadt 4", "20457 Hamburg"]);
    expect(m.sellerName).toBe(SELLERS.gmbh.name);
    expect(m.info).toContainEqual({ label: "USt-IdNr. des Leistenden", value: "DE811907980" });
    expect(m.footer?.flat().join(" ")).toContain("Amtsgericht Charlottenburg"); // our Geschäftsbrief footer
    expect(m.payment.epcPayload).toBeNull();
    expect(m.payment.lines).toContain("Den Gutschriftsbetrag überweisen wir auf Ihr Konto.");

    for (const format of ["zugferd_en16931", "xrechnung_ubl", "xrechnung_cii"] as const) {
      const xml = serializeEinvoice(s, format).xml;
      const parsed = parseReceivedXml(xml);
      expect(parsed.ok, format).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value.invoice).toMatchObject({
        typeCode: "389",
        number: "GS-2026-0001",
        seller: { name: "Agentur Nord GmbH", vatId: "DE811907980" },
        buyer: { name: SELLERS.gmbh.name, vatId: SELLERS.gmbh.vatId },
      });
      if (format === "xrechnung_ubl") expect(xml).toContain("<Invoice ");
    }
  });

  test("INV-16 the VAT follows the supplier: a Kleinunternehmer owner still issues 19 % to a regular supplier", () => {
    const s = finalSnapshot(
      commission(),
      swapped(SUPPLIER, { kleinunternehmer: [{ validFrom: "2020-01-01", isKU: true }] }),
    );
    expect(s.taxCase).toBe("domestic");
    expect(s.totals.vatCents).toBe(95_000);
  });

  test("INV-16 a KU supplier (agreement flag) gets a KU Gutschrift with the § 19 note although we are regular", () => {
    const ku = { ...SUPPLIER, selfBillingAgreement: { ...AGREEMENT, supplierKleinunternehmer: true } };
    const s = finalSnapshot(commission(), swapped(ku));
    expect(s.taxCase).toBe("kleinunternehmer");
    expect(s.totals).toMatchObject({ vatCents: 0, grossCents: 500_000 });
    expect(s.notes.map((n) => n.id)).toContain("ku_note_19");
  });

  test("UST-33 INV-16 the supplier's Pflichtangaben block: tax ID, address, foreign seat, e-invoice contact", () => {
    const codes = (c: ContactContext) =>
      validateDocument(commission(), swapped(c))
        .findings.filter((f) => f.severity === "E")
        .map((f) => f.code);
    expect(codes(SUPPLIER)).toEqual([]);
    const noTax = {
      ...SUPPLIER,
      buyer: { ...SUPPLIER.buyer, vatId: undefined, taxNumber: undefined },
      vatId: undefined,
    };
    expect(codes(noTax as ContactContext)).toContain("self_billing_supplier_tax_id");
    const at = {
      ...SUPPLIER,
      buyer: { ...SUPPLIER.buyer, address: { street: "Ring 1", postalCode: "1010", city: "Wien", countryCode: "AT" } },
    };
    expect(codes(at as ContactContext)).toContain("self_billing_foreign_supplier");
    const noPhone = { ...SUPPLIER, phone: undefined };
    expect(codes(noPhone)).toContain("self_billing_supplier_contact");
    const missing = validateDocument(commission(), swapped({ ...SUPPLIER, selfBillingAgreement: undefined })).findings;
    expect(missing.find((f) => f.code === "self_billing_agreement_missing")?.message).toBe(
      "Mit Agentur Nord GmbH ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG).",
    );
  });

  test("INV-16 ER-03 runs with the roles swapped: the supplier is the issuer with unknown turnover → MUST_E in 2027", () => {
    const ctx = { ...swapped(), today: "2027-02-01" as typeof TODAY };
    const v = validateDocument(
      commission({ documentDate: "2027-02-01", supplyDate: { kind: "date", date: "2027-01-29" } }),
      ctx,
    );
    expect(v.einvoice.er03).toMatchObject({ decision: "MUST_E", warnings: ["turnover_missing"] });
    // our own (high) prior-year turnover is not used for the supplier
    expect(ctx.company.priorYearTurnover).toEqual([]);
  });

  test("INV-16 the supplier's payout IBAN is the BG-17 payee account, printed in the payment text but never in our footer", () => {
    const withIban = {
      ...SUPPLIER,
      selfBillingAgreement: { ...AGREEMENT, iban: "de75 5121 0800 1245 1261 99" },
    };
    const s = finalSnapshot(commission(), swapped(withIban));
    expect(s.payment.bankAccount).toEqual({ iban: "DE75512108001245126199", accountHolder: "Agentur Nord GmbH" });
    const m = buildRenderModel(s);
    expect(m.payment.lines).toContain(
      "Den Gutschriftsbetrag überweisen wir auf Ihr Konto DE75 5121 0800 1245 1261 99.",
    );
    expect(m.payment.bank).toBeUndefined();
    expect(m.footer?.flat().join(" ")).not.toContain("DE75");
    const parsed = parseReceivedXml(serializeEinvoice(s, "xrechnung_ubl").xml);
    expect(parsed.ok && parsed.value.invoice.payment.iban).toBe("DE75512108001245126199");
    // XRechnung without the payout account: BR-DE-23 would reject the credit transfer → blocked before finalising
    const xr = validateDocument(commission({ einvoiceFormat: "xrechnung_ubl" }), swapped());
    expect(xr.einvoice.format === "xrechnung_ubl" ? xr.findings.map((f) => f.code) : ["format not chosen"]).toContain(
      "self_billing_supplier_iban",
    );
  });

  test("INV-16 other document types are not swapped", () => {
    const ctx = makeContext({ contact: SUPPLIER });
    expect(selfBillingContext("invoice", ctx)).toBe(ctx);
  });
});
