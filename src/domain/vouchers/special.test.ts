import { describe, expect, test } from "vitest";
import { formatEuro } from "../money";
import type { CalendarDate } from "../time/calendar-date";
import { assetPrompts, checkAssetDecisions, perItemCost } from "./assets";
import {
  type BewirtungData,
  bewirtungEigenbelegContent,
  checkBewirtungApproval,
  checkBewirtungLines,
  isGenericOccasion,
  splitShare,
} from "./bewirtung";
import { checkEigenbelegApproval, eigenbelegVolumeInfo, voucherEigenbelegContent } from "./eigenbeleg";
import { canTransition, deriveVoucherStatus, VOUCHER_TRANSITIONS, VoucherOverpaidError } from "./lifecycle";
import { checkTaxPayment, normaliseTaxPeriod, suggestTaxPayment, TAX_PAYMENT_ROLE } from "./tax-payment";

const d = (s: string) => s as CalendarDate;

const meal = (over: Partial<BewirtungData> = {}): BewirtungData => ({
  occasionType: "geschaeftlich",
  occasion: "Projektbesprechung Website-Relaunch mit Müller GmbH",
  participants: ["Anna Müller", "Ben Kraus"],
  host: "Max Mustermann",
  place: "Restaurant Lindenhof, Hauptstr. 1, Berlin",
  date: "2026-03-10",
  tipCents: 1000,
  tseConfirmed: true,
  ...over,
});

describe("Bewirtung (MISC-05, VOU-060…062)", () => {
  test("MISC-05 VOU-060 EC-BEW-01 EC-163: missing participants block the approval", () => {
    const r = checkBewirtungApproval(meal({ participants: ["Max Mustermann"] }), 17_650, d("2026-03-10"));
    expect(r.errors.map((e) => e.message)).toEqual(["Bitte alle Teilnehmer der Bewirtung angeben."]);
  });

  test("MISC-05 VOU-060 EC-BEW-02 EC-163: a generic occasion („Geschäftsessen“) is blocked, a specific one accepted", () => {
    expect(isGenericOccasion("Geschäftsessen")).toBe(true);
    expect(isGenericOccasion("Business Lunch.")).toBe(true);
    expect(isGenericOccasion("Projektbesprechung Website-Relaunch mit Müller GmbH")).toBe(false);
    const r = checkBewirtungApproval(meal({ occasion: "Geschäftsessen" }), 17_650, d("2026-03-10"));
    expect(r.errors[0]?.code).toBe("bewirtung_occasion");
    expect(checkBewirtungApproval(meal(), 17_650, d("2026-03-10")).errors).toEqual([]);
  });

  test("MISC-05 VOU-060 EC-BEW-03/04: > 250 € without host confirmation blocked; missing TSE confirmation is a ⚑ warning", () => {
    expect(checkBewirtungApproval(meal(), 30_000, d("2026-03-10")).errors[0]?.message).toBe(
      "Bei Rechnungen über 250 € muss der Name des Bewirtenden auf der Rechnung stehen. Bitte bestätigen oder Rechnung korrigieren lassen.",
    );
    expect(checkBewirtungApproval(meal({ hostOnInvoiceConfirmed: true }), 30_000, d("2026-03-10")).errors).toEqual([]);
    expect(checkBewirtungApproval(meal({ tseConfirmed: false }), 17_650, d("2026-03-10")).warnings[0]?.code).toBe(
      "bewirtung_tse",
    );
  });

  test("VOU-061 EC-BEW-07/08 UST-15: food at 19 % in 2026 warns; a tip with VAT or without its own 0 % line is blocked", () => {
    const lines = [
      { description: "Speisen", vatRateBp: 1900, grossCents: 11_900 },
      { description: "Getränke", vatRateBp: 1900, grossCents: 5950 },
      { description: "Trinkgeld", vatRateBp: 0, grossCents: 1000 },
    ];
    const r = checkBewirtungLines(lines, meal(), d("2026-03-10"));
    expect(r.warnings[0]?.message).toBe(
      "Speisen in der Gastronomie unterliegen seit 01.01.2026 dem ermäßigten Satz von 7 %. Bitte prüfen.",
    );
    expect(r.errors).toEqual([]);
    // 2025: restaurant food at 19 % was correct.
    expect(checkBewirtungLines(lines, meal(), d("2025-06-10")).warnings).toEqual([]);
    const tipVat = checkBewirtungLines(
      [{ description: "Trinkgeld", vatRateBp: 1900, grossCents: 1000 }],
      meal(),
      d("2026-03-10"),
    );
    expect(tipVat.errors[0]?.message).toBe("Trinkgeld bitte als eigene Position ohne Umsatzsteuer erfassen.");
    expect(checkBewirtungLines(lines.slice(0, 2), meal(), d("2026-03-10")).errors[0]?.code).toBe("bewirtung_tip");
  });

  test("VOU-061 split 70/30 per line, the 30 % share half-up (golden B1/B2 amounts)", () => {
    expect([10_000, 5000, 1000].map((a) => splitShare(a, 3000))).toEqual([
      [7000, 3000],
      [3500, 1500],
      [700, 300],
    ]);
    expect([10_700, 5950, 1000].map((a) => splitShare(a, 3000))).toEqual([
      [7490, 3210],
      [4165, 1785],
      [700, 300],
    ]);
  });

  test("VOU-062 MISC-05 Eigenbeleg content lists all fields, the linked receipt and its hash", () => {
    const c = bewirtungEigenbelegContent({
      data: meal({ hostOnInvoiceConfirmed: false }),
      grossCents: 17_650,
      currency: "EUR",
      receipt: { number: "4711", supplierName: "Lindenhof", sha256: "ab".repeat(32) },
      company: { name: "Muster" },
      createdOn: "2026-03-11",
      createdBy: "Max Mustermann",
      version: 2,
      supersedesReason: "Teilnehmer ergänzt",
    });
    expect(c.rows).toContainEqual(["Teilnehmer", "Anna Müller, Ben Kraus"]);
    expect(c.rows).toContainEqual(["Höhe der Aufwendungen", "176,50 €"]);
    expect(c.rows).toContainEqual(["SHA-256 der Rechnung", "ab".repeat(32)]);
    expect(c.rows).toContainEqual(["Grund der Berichtigung", "Teilnehmer ergänzt"]);
    expect(c.fileName).toBe("Bewirtungsbeleg-2026-03-10-v2.pdf");
  });
});

describe("Eigenbeleg (VOU-063, GOBD-07)", () => {
  test("VOU-063 GOBD-07 EC-EIG-02: recipient, purpose and reason are required; `other` needs a text", () => {
    expect(checkEigenbelegApproval({ reason: "lost", recipient: "", purpose: "Parken" })?.message).toBe(
      "Bitte Empfänger, Zweck und Grund für das Fehlen des Originalbelegs angeben.",
    );
    expect(checkEigenbelegApproval({ reason: "other", recipient: "Stadt", purpose: "Parken" })?.code).toBe(
      "eigenbeleg_fields",
    );
    expect(
      checkEigenbelegApproval({
        reason: "not_obtainable",
        recipient: "Stadt Berlin",
        purpose: "Parkautomat Kundentermin",
      }),
    ).toBeNull();
  });

  test("VOU-063 T06-111 EC-EIG-03: the 6th Eigenbeleg in a month or > 250 € gives an info", () => {
    expect(eigenbelegVolumeInfo({ countInMonth: 6, grossEurCents: 500 })?.code).toBe("eigenbeleg_many");
    expect(eigenbelegVolumeInfo({ countInMonth: 2, grossEurCents: 30_000 })?.code).toBe("eigenbeleg_many");
    expect(eigenbelegVolumeInfo({ countInMonth: 5, grossEurCents: 500 })).toBeNull();
  });

  test("VOU-063 Eigenbeleg PDF content (date, recipient, amount, purpose, reason, approval)", () => {
    const c = voucherEigenbelegContent({
      data: { reason: "not_obtainable", recipient: "Stadt Berlin", purpose: "Parkautomat Kundentermin" },
      date: "2026-03-10",
      grossCents: 450,
      currency: "EUR",
      company: { name: "Muster" },
      createdOn: "2026-03-10",
      createdBy: "Max",
    });
    expect(c.rows).toEqual([
      ["Datum der Ausgabe", "10.03.2026"],
      ["Betrag", "4,50 €"],
      ["Empfänger", "Stadt Berlin"],
      ["Zweck", "Parkautomat Kundentermin"],
      ["Grund", "Beleg nicht erhältlich (z. B. Parkautomat)"],
      ["Freigegeben am", "10.03.2026 von Max"],
    ]);
  });
});

describe("asset detection (VOU-065, AO-03)", () => {
  const ctx = { chart: "SKR03" as const, date: d("2026-03-10"), deductible: true };

  test("VOU-065 AO-03 golden V5: 3 monitors × 300 € net on one line → asset prompt (per item 300 € > 250 €; GWG possible)", () => {
    const line = { account: "4930", quantityMilli: 3000, netCents: 90_000, grossCents: 107_100 };
    expect(perItemCost(line, true)).toBe(30_000);
    expect(assetPrompts([line], ctx)).toEqual([
      { position: 1, perItemCents: 30_000, options: ["gwg", "pool", "asset", "none"] },
    ]);
    expect(checkAssetDecisions([line], ctx)[0]?.message).toBe(
      "Bitte festlegen, ob Position 1 ein Anlagegut ist (GWG, Sammelposten, Anlage oder kein Anlagegut).",
    );
    expect(checkAssetDecisions([{ ...line, assetDecision: "gwg" }], ctx)).toEqual([]);
    // An expense account that is not goods-type (Telefon) does not ask.
    expect(assetPrompts([{ ...line, account: "4920" }], ctx)).toEqual([]);
    // A fixed-asset account always asks.
    expect(assetPrompts([{ account: "0420", netCents: 10_000, grossCents: 11_900 }], ctx)).toHaveLength(1);
  });

  test("VOU-065 AO-03 T06-121 EC-VOU-29: GWG for 850 € per item is rejected; a KU company uses the gross for the threshold", () => {
    const line = { account: "4930", netCents: 85_000, grossCents: 101_150, assetDecision: "gwg" as const };
    expect(checkAssetDecisions([line], ctx)[0]?.message).toBe(
      `Ein GWG darf höchstens ${formatEuro(80_000)} netto je Wirtschaftsgut kosten.`,
    );
    const ku = { ...ctx, deductible: false };
    const small = { account: "4930", netCents: 22_000, grossCents: 26_180 };
    expect(assetPrompts([small], ctx)).toEqual([]);
    expect(assetPrompts([small], ku)[0]?.perItemCents).toBe(26_180);
  });

  test("VOU-065 MISC-09 T06-122 date-effective: a hypothetical GWG limit of 1.200 € from 2027 allows 1.000 € as GWG", () => {
    const overrides = [
      {
        validFrom: d("2027-01-01"),
        value: { recordingLimitCents: 25_000, gwgLimitCents: 120_000, poolMaxCents: 100_000 },
        source: "Testszenario (MISC-09 harness)",
        id: "override-1",
      },
    ];
    const line = { account: "4930", netCents: 100_000, grossCents: 119_000, assetDecision: "gwg" as const };
    expect(checkAssetDecisions([line], { ...ctx, date: d("2027-02-01"), overrides })).toEqual([]);
    expect(checkAssetDecisions([line], { ...ctx, date: d("2026-12-01"), overrides })[0]?.code).toBe("asset_gwg_limit");
  });
});

describe("voucher status machine (VOU-130)", () => {
  test("VOU-130 T06-145 transitions table", () => {
    expect(VOUCHER_TRANSITIONS.draft).toEqual(["open"]);
    expect(canTransition("open", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "paid")).toBe(true);
    expect(canTransition("paid", "cancelled")).toBe(false);
    expect(canTransition("cancelled", "open")).toBe(false);
    expect(canTransition("draft", "paid")).toBe(false);
  });

  test("VOU-130 open amount and status derived from payments (PAY-043 mirrored), scheduled kept until paid", () => {
    const row = (a: number, diff = 0) => ({ amountCents: a, differences: diff ? [{ amountCents: diff }] : [] });
    expect(deriveVoucherStatus({ status: "open", payableCents: 10_000, rows: [] })).toEqual({
      status: "open",
      openAmountCents: 10_000,
    });
    expect(deriveVoucherStatus({ status: "open", payableCents: 10_000, rows: [], scheduled: true }).status).toBe(
      "scheduled",
    );
    expect(deriveVoucherStatus({ status: "scheduled", payableCents: 10_000, rows: [row(4000)] })).toEqual({
      status: "partially_paid",
      openAmountCents: 6000,
    });
    expect(deriveVoucherStatus({ status: "open", payableCents: 10_000, rows: [row(9800, 200)] }).status).toBe("paid");
    expect(
      deriveVoucherStatus({ status: "paid", payableCents: 10_000, rows: [row(10_000), row(-10_000)] }).status,
    ).toBe("open");
    expect(() => deriveVoucherStatus({ status: "open", payableCents: 10_000, rows: [row(12_000)] })).toThrow(
      VoucherOverpaidError,
    );
  });

  test("VOU-012 VOU-134 a supplier credit note (negative payable) is settled by an incoming refund", () => {
    expect(
      deriveVoucherStatus({ status: "open", payableCents: -5000, rows: [{ amountCents: -5000, differences: [] }] }),
    ).toEqual({ status: "paid", openAmountCents: 0 });
    expect(() =>
      deriveVoucherStatus({ status: "open", payableCents: -5000, rows: [{ amountCents: -6000, differences: [] }] }),
    ).toThrow(VoucherOverpaidError);
  });
});

describe("tax payments (TAX-018)", () => {
  test("TAX-018 subtypes map to the F08 §4.2.6 roles; ESt only for sole proprietors, KSt only for corporations", () => {
    expect(TAX_PAYMENT_ROLE).toEqual({
      ust_prepayment: "vat.prepayment",
      sondervorauszahlung: "vat.special_prepayment",
      ust_annual: "vat.prior_year",
      gewerbesteuer: "expense.trade_tax",
      est_private: "private.taxes",
      kst: "expense.corp_tax",
    });
    expect(checkTaxPayment({ subtype: "est_private", corporation: true })?.code).toBe("tax_payment_subtype");
    expect(checkTaxPayment({ subtype: "kst", corporation: false })?.code).toBe("tax_payment_subtype");
    expect(checkTaxPayment({ subtype: "ust_prepayment", period: "2026-09", corporation: false })).toBeNull();
    expect(checkTaxPayment({ subtype: "ust_prepayment", period: "09/2026", corporation: false })?.code).toBe(
      "tax_payment_period",
    );
  });

  test("BNK-064 TAX-018 a period typed the German way is normalised to JJJJ, JJJJ-MM or JJJJ-Qn; anything else is refused", () => {
    expect(normaliseTaxPeriod("2026-09")).toBe("2026-09");
    expect(normaliseTaxPeriod(" 09/2026 ")).toBe("2026-09");
    expect(normaliseTaxPeriod("9/2026")).toBe("2026-09");
    expect(normaliseTaxPeriod("09.2026")).toBe("2026-09");
    expect(normaliseTaxPeriod("2026-q3")).toBe("2026-Q3");
    expect(normaliseTaxPeriod("Q3/2026")).toBe("2026-Q3");
    expect(normaliseTaxPeriod("2026")).toBe("2026");
    for (const bad of ["13/2026", "2026-00", "Q5/2026", "26", "09/26", "Sept 2026", ""]) {
      expect(normaliseTaxPeriod(bad)).toBeNull();
    }
    // The normalised value always passes the period check of the voucher validation.
    expect(checkTaxPayment({ subtype: "ust_prepayment", period: "2026-Q3", corporation: false })).toBeNull();
  });

  test("TAX-018 the subtype is suggested from the Finanzamt reference", () => {
    expect(suggestTaxPayment("FA Berlin StNr 12/345/67890 USt 09/26")).toEqual({
      subtype: "ust_prepayment",
      period: "2026-09",
    });
    expect(suggestTaxPayment("GewSt 2026 III")).toEqual({ subtype: "gewerbesteuer" });
    expect(suggestTaxPayment("ESt-Vz IV/26 Soli KiSt")).toEqual({ subtype: "est_private" });
    expect(suggestTaxPayment("Sondervorauszahlung 2026")).toEqual({ subtype: "sondervorauszahlung", period: "2026" });
    expect(suggestTaxPayment("Miete März")).toBeNull();
  });
});
