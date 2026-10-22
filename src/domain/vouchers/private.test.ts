import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { type AccountContext, accountContextFor } from "./accounts";
import type { VoucherLine } from "./types";
import { type ValidationContext, type VoucherDraft, validateVoucher } from "./validate";

const d = (s: string) => s as CalendarDate;
const accounts = accountContextFor("SKR04", d("2026-03-10"), { bankLedgerAccounts: ["1810"] }) as AccountContext;
const ctx: ValidationContext = { today: d("2026-10-19"), companyIsKu: false, corporation: false, accounts };
const line = (over: Partial<VoucherLine> = {}): VoucherLine => ({
  account: "6815",
  description: "Kinderfahrrad",
  netCents: 30_000,
  vatRateBp: 1900,
  vatCents: 5700,
  grossCents: 35_700,
  ...over,
});
const priv = (over: Partial<VoucherDraft> = {}): VoucherDraft => ({
  direction: "expense",
  kind: "private",
  taxRule: "input_vat_deductible",
  supplierName: "Fahrrad Meier",
  documentNumber: "4711",
  documentDate: "2026-03-10",
  currency: "EUR",
  lines: [line()],
  originalFiles: [{}],
  ...over,
});

describe("private vouchers (VOU-066)", () => {
  test("VOU-066 a private voucher never deducts input VAT and asks no asset or § 14 questions", () => {
    const r = validateVoucher(priv(), ctx);
    expect(r.errors).toEqual([]);
    expect(r.effectiveTaxRule).toBe("no_input_vat");
    expect(r.inputVatAtRisk).toEqual([]);
    expect(r.infos).toContainEqual({
      code: "private_no_input_vat",
      message: "Private Ausgaben werden ohne Vorsteuerabzug als Privatentnahme gebucht.",
    });
    // A goods line > 250 € would ask „Anlagegut?“ on a business voucher — not on a private one.
    expect(r.errors.map((e) => e.code)).not.toContain("asset_decision_required");
  });

  test("VOU-066 private vouchers are expenses only and blocked for corporations (EC-VOU-17)", () => {
    expect(
      validateVoucher(priv({ direction: "income", taxRule: "not_taxable" }), ctx).errors.map((e) => e.code),
    ).toContain("private_income");
    expect(validateVoucher(priv(), { ...ctx, corporation: true }).errors.map((e) => e.message)).toContain(
      "Kapitalgesellschaften haben kein Privatkonto. Bitte Verrechnungskonto Gesellschafter verwenden.",
    );
  });
});
