import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import {
  checkTaxRule,
  checkVoucherRate,
  deductsInputVat,
  effectiveTaxRule,
  germanRatesOn,
  isForeignEuVatId,
  suggestTaxRule,
} from "./tax-rules";

const d = (s: string) => s as CalendarDate;

describe("voucher tax rules", () => {
  test("VOU-004 UST-15 RI-22 T06-053: 20 % rejected (foreign), 16 % in 2026 rejected, 16 % on 2020-09-01 accepted", () => {
    expect(germanRatesOn(d("2026-03-01"))).toEqual([1900, 700, 0]);
    expect(germanRatesOn(d("2020-09-01"))).toEqual([1600, 500, 0]);
    expect(checkVoucherRate(2000, "input_vat_deductible", d("2026-03-01"))?.message).toBe(
      "20 % ist kein deutscher Steuersatz. Ausländische Umsatzsteuer ist nicht als Vorsteuer abziehbar – bitte ‚Kein Vorsteuerabzug‘ wählen.",
    );
    expect(checkVoucherRate(1600, "input_vat_deductible", d("2026-03-01"))?.message).toBe(
      "Der Steuersatz 16 % galt am 01.03.2026 nicht.",
    );
    expect(checkVoucherRate(1600, "input_vat_deductible", d("2020-09-01"))).toBeNull();
    // Foreign VAT on `no_input_vat` is fine (VOU-021: gross to expense).
    expect(checkVoucherRate(2000, "no_input_vat", d("2026-03-01"))).toBeNull();
  });

  test("VOU-022 self-assessment lines need the German rate (> 0) valid on the supply date", () => {
    expect(checkVoucherRate(1900, "reverse_charge_eu", d("2026-03-01"))).toBeNull();
    expect(checkVoucherRate(0, "reverse_charge_eu", d("2026-03-01"))?.code).toBe("rate_required");
    expect(checkVoucherRate(2100, "intra_community_acquisition", d("2026-03-01"))?.code).toBe("rate_foreign");
  });

  test("VOU-026 KU-01 EC-VOU-11: a KU company never deducts input VAT — input_vat_deductible → no_input_vat with info", () => {
    expect(effectiveTaxRule("input_vat_deductible", true)).toEqual({
      rule: "no_input_vat",
      info: "Als Kleinunternehmer sind Sie nicht zum Vorsteuerabzug berechtigt. Die USt wird als Aufwand gebucht.",
    });
    expect(effectiveTaxRule("reverse_charge_eu", true)).toEqual({ rule: "reverse_charge_eu" });
    expect(deductsInputVat("reverse_charge_eu", true)).toBe(false);
    expect(deductsInputVat("input_vat_deductible", false)).toBe(true);
  });

  test("VOU-025 EC-VOU-10 EC-165 KU-02: VAT entered for a Kleinunternehmer supplier is blocked", () => {
    expect(checkTaxRule({ taxRule: "kleinunternehmer_supplier", vatShownCents: 190 }).errors[0]?.message).toBe(
      "Kleinunternehmer weisen keine Umsatzsteuer aus. Bitte Steuerregel prüfen.",
    );
    expect(checkTaxRule({ taxRule: "kleinunternehmer_supplier", vatShownCents: 0 }).errors).toEqual([]);
  });

  test("VOU-022 EC-VOU-12 reverse charge with VAT shown is blocked", () => {
    expect(checkTaxRule({ taxRule: "reverse_charge_non_eu", vatShownCents: 500 }).errors[0]?.code).toBe(
      "reverse_charge_vat_shown",
    );
  });

  test("VOU-023 EC-VOU-13/14 MISC-04: RC EU / igE need an EU (non-DE) supplier VAT ID (warning) and igE the own USt-IdNr (error)", () => {
    const rc = checkTaxRule({ taxRule: "reverse_charge_eu", vatShownCents: 0, supplierVatId: "DE123456789" });
    expect(rc.warnings[0]?.message).toBe("USt-IdNr des Lieferanten fehlt oder ist keine EU-Nummer.");
    expect(
      checkTaxRule({ taxRule: "reverse_charge_eu", vatShownCents: 0, supplierVatId: "IE6388047V" }).warnings,
    ).toEqual([]);
    const ige = checkTaxRule({
      taxRule: "intra_community_acquisition",
      vatShownCents: 0,
      supplierVatId: "ATU12345678",
    });
    expect(ige.errors[0]?.message).toBe(
      "Für innergemeinschaftliche Erwerbe ist Ihre USt-IdNr erforderlich (Einstellungen › Unternehmen).",
    );
    expect(isForeignEuVatId("EL123456789")).toBe(true);
  });

  test("VOU-043 T06-092: tax-rule suggestion for EU, non-EU and KU suppliers", () => {
    expect(suggestTaxRule({ supplierVatId: "IE6388047V", vatShown: false }).rule).toBe("reverse_charge_eu");
    expect(suggestTaxRule({ supplierVatId: "ATU12345678", vatShown: false, goods: true }).rule).toBe(
      "intra_community_acquisition",
    );
    expect(suggestTaxRule({ supplierCountry: "US", vatShown: false }).rule).toBe("reverse_charge_non_eu");
    expect(suggestTaxRule({ supplierIsKu: true, vatShown: false }).rule).toBe("kleinunternehmer_supplier");
    expect(suggestTaxRule({ supplierCountry: "DE", vatShown: true }).rule).toBe("input_vat_deductible");
    expect(suggestTaxRule({ supplierCountry: "FR", vatShown: true }).rule).toBe("no_input_vat");
  });

  test("VOU-013 EC-164: a VAT-able add-on invoice from a provider in Lithuania suggests reverse_charge_eu", () => {
    expect(suggestTaxRule({ supplierVatId: "LT100011718610", vatShown: false }).rule).toBe("reverse_charge_eu");
  });
});
