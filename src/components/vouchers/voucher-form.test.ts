import { describe, expect, test } from "vitest";
import {
  bookButtonLabel,
  defaultPaymentForm,
  emptyLine,
  emptyVoucherForm,
  paymentInput,
  paymentMethodsFor,
  taxPaymentHasPeriod,
  taxPaymentOptions,
  toDraftInput,
  updateLine,
  voucherFormFrom,
} from "./voucher-form";

describe("VOU-001 VOU-002 voucher editor state (F06 §6.3)", () => {
  test("VOU-001 VOU-002 German input becomes cents and basis points; blank lines are dropped", () => {
    const f = emptyVoucherForm("2026-10-19");
    const { input, issues } = toDraftInput({
      ...f,
      supplierName: " Büro Schmidt GmbH ",
      supplierVatId: "de 123 456 789",
      documentNumber: "RE-4711",
      statedGross: "1.190,00",
      lines: [
        { ...emptyLine(), account: "6815", description: "Papier", amount: "1.000,00", rate: "19" },
        { ...emptyLine("7"), account: "6815", amount: "190,00", rate: "7", vat: "12,43" },
        { ...emptyLine(), description: "  " },
      ],
    });
    expect(issues).toEqual([]);
    expect(input).toMatchObject({
      direction: "expense",
      kind: "standard",
      supplierName: "Büro Schmidt GmbH",
      supplierVatId: "DE123456789",
      documentDate: "2026-10-19",
      priceMode: "gross",
      currency: "EUR",
      statedTotals: { grossCents: 119_000 },
    });
    expect(input.lines).toEqual([
      { account: "6815", description: "Papier", amountCents: 100_000, vatRateBp: 1900 },
      { account: "6815", amountCents: 19_000, vatRateBp: 700, vatCents: 1243 },
    ]);
    expect("taxRule" in input).toBe(false);
  });

  test("VOU-002 invalid numbers are reported per line; a foreign currency needs a valid rate", () => {
    const f = emptyVoucherForm("2026-10-19");
    const { issues, input } = toDraftInput({
      ...f,
      currency: "USD",
      fxRate: "abc",
      lines: [
        { ...emptyLine(), account: "6815", amount: "12,345", rate: "19" },
        { ...emptyLine(), amount: "5", rate: "x" },
      ],
    });
    expect(issues.map((i) => i.field)).toEqual(["lines.0.amount", "lines.1.rate", "fxRate"]);
    expect(input.lines).toEqual([]);
    const ok = toDraftInput({ ...f, currency: "USD", fxRate: "1,0850" });
    expect(ok.input.fxRateToEur).toEqual({ rate: "1.0850", source: "manual", date: "2026-10-19" });
  });

  test("VOU-002 a typed VAT is dropped when amount or rate change (EC-VOU-04 tolerance applies to the document)", () => {
    const l = { ...emptyLine(), amount: "119,00", vat: "19,00" };
    expect(updateLine(l, { description: "Druckerpapier" }).vat).toBe("19,00");
    expect(updateLine(l, { amount: "120,00" }).vat).toBe("");
    expect(updateLine(l, { rate: "7" }).vat).toBe("");
    expect(updateLine(l, { amount: "120,00", vat: "19,16" }).vat).toBe("19,16");
  });

  test("VOU-001 the stored draft round-trips through the form", () => {
    const form = voucherFormFrom(
      {
        direction: "expense",
        kind: "bewirtung",
        supplierName: "Trattoria",
        documentDate: "2026-10-10",
        supplyDate: { kind: "date", date: "2026-10-09" },
        currency: "EUR",
        priceMode: "gross",
        taxRule: "input_vat_deductible",
        statedTotals: { grossCents: 11_900 },
      },
      [
        {
          account: "6640",
          netCents: 10_000,
          vatRateBp: 1900,
          vatCents: 1900,
          grossCents: 11_900,
          nonDeductibleShareBp: 3000,
        },
      ],
      "2026-10-19",
    );
    expect(form).toMatchObject({ kind: "bewirtung", supplyDate: "2026-10-09", statedGross: "119,00" });
    expect(form.lines[0]).toMatchObject({ amount: "119,00", rate: "19", vat: "19,00", nonDeductible: "30" });
    const { input } = toDraftInput(form);
    expect(input).toMatchObject({
      taxRule: "input_vat_deductible",
      supplyDate: { kind: "date", date: "2026-10-09" },
      lines: [{ account: "6640", amountCents: 11_900, vatRateBp: 1900, vatCents: 1900, nonDeductibleShareBp: 3000 }],
    });
  });
});

describe("BNK-064 TAX-018 tax-payment type and period in the voucher editor", () => {
  const stored = {
    direction: "expense" as const,
    kind: "tax_payment" as const,
    supplierName: "Finanzamt Berlin-Mitte",
    currency: "EUR",
    priceMode: "gross" as const,
    taxRule: "no_input_vat",
  };

  test("BNK-064 a tax-payment draft from a Finanzamt row loads its type and period; saving sends them back", () => {
    const form = voucherFormFrom(
      { ...stored, taxPayment: { subtype: "ust_prepayment", period: "2026-09", filingId: "f1" } },
      [],
      "2026-10-19",
    );
    expect(form).toMatchObject({ taxPaymentSubtype: "ust_prepayment", taxPaymentPeriod: "2026-09" });
    expect(toDraftInput(form).input.taxPayment).toEqual({
      subtype: "ust_prepayment",
      period: "2026-09",
      filingId: "f1",
    });
  });

  test("BNK-064 a draft without type (the bank reference named none) gets type and period chosen in the editor", () => {
    const form = voucherFormFrom(stored, [], "2026-10-19");
    expect(form).toMatchObject({ taxPaymentSubtype: "", taxPaymentPeriod: "" });
    expect("taxPayment" in toDraftInput(form).input).toBe(false);
    const { input, issues } = toDraftInput({
      ...form,
      taxPaymentSubtype: "ust_prepayment",
      taxPaymentPeriod: "09/2026",
    });
    expect(issues).toEqual([]);
    expect(input.taxPayment).toEqual({ subtype: "ust_prepayment", period: "2026-09" });
    expect(
      toDraftInput({ ...form, taxPaymentSubtype: "sondervorauszahlung", taxPaymentPeriod: "2026" }).input.taxPayment,
    ).toEqual({ subtype: "sondervorauszahlung", period: "2026" });
  });

  test("BNK-064 an invalid period is reported in German on its field; types without a period drop it", () => {
    const form = { ...voucherFormFrom(stored, [], "2026-10-19"), taxPaymentSubtype: "ust_prepayment" };
    const bad = toDraftInput({ ...form, taxPaymentPeriod: "September" });
    expect(bad.issues).toEqual([
      { field: "taxPaymentPeriod", message: "Bitte den Zeitraum als JJJJ, MM/JJJJ oder Qn/JJJJ angeben." },
    ]);
    expect(bad.input.taxPayment).toEqual({ subtype: "ust_prepayment" });
    expect(toDraftInput({ ...form, taxPaymentSubtype: "gewerbesteuer", taxPaymentPeriod: "September" })).toMatchObject({
      issues: [],
      input: { taxPayment: { subtype: "gewerbesteuer" } },
    });
  });

  test("BNK-064 other voucher kinds never send a tax-payment type", () => {
    const form = { ...emptyVoucherForm("2026-10-19"), taxPaymentSubtype: "ust_prepayment", taxPaymentPeriod: "x" };
    const { input, issues } = toDraftInput(form);
    expect(issues).toEqual([]);
    expect("taxPayment" in input).toBe(false);
  });

  test("BNK-064 the type options and the period question come from the domain", () => {
    expect(taxPaymentOptions().map((o) => o.value)).toEqual([
      "ust_prepayment",
      "sondervorauszahlung",
      "ust_annual",
      "gewerbesteuer",
      "est_private",
      "kst",
    ]);
    expect(taxPaymentOptions()[0]?.label).toBe("USt-Vorauszahlung");
    expect(taxPaymentHasPeriod("ust_prepayment")).toBe(true);
    expect(taxPaymentHasPeriod("gewerbesteuer")).toBe(false);
    expect(taxPaymentHasPeriod("")).toBe(false);
  });
});

describe("VOU-136 „Bezahlt mit“ at booking", () => {
  test("VOU-136 the default „Bank folgt“ sends no payment; cash/private carry date, amount and reason", () => {
    expect(paymentInput(defaultPaymentForm())).toEqual({ issues: [] });
    expect(
      paymentInput({ method: "cash", date: "2026-10-01", amount: "50,00", backdateReason: " vergessen " }),
    ).toEqual({
      payment: { method: "cash", date: "2026-10-01", amountCents: 5000, backdateReason: "vergessen" },
      issues: [],
    });
    expect(paymentInput({ ...defaultPaymentForm("private") }).payment).toEqual({ method: "private" });
    expect(paymentInput({ ...defaultPaymentForm("cash"), amount: "0" }).issues).toHaveLength(1);
  });

  test("VOU-136 VOU-010 income vouchers offer Bank and Bar only; the button label follows the choice", () => {
    expect(paymentMethodsFor("income")).toEqual(["bank", "cash"]);
    expect(paymentMethodsFor("expense")).toEqual(["bank", "card_pending", "cash", "private"]);
    expect(bookButtonLabel("cash")).toBe("Buchen – bar bezahlt");
    expect(bookButtonLabel("bank")).toBe("Buchen");
  });
});
