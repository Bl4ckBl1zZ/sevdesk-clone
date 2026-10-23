import { describe, expect, test } from "vitest";
import type { VoucherBookedEvent, VoucherPaidEvent } from "./events";
import type { RoleLine } from "./post";
import { postVoucherBooked, postVoucherPaid, voucherInputVatDeducted } from "./post-vouchers";

const SOLL = { corporation: false, taxationMethod: "soll" as const };
const IST = { corporation: false, taxationMethod: "ist" as const };
const GMBH = { corporation: true, taxationMethod: "soll" as const };

const booked = (over: Partial<VoucherBookedEvent> = {}): VoucherBookedEvent => ({
  kind: "voucher_booked",
  voucherId: "v1",
  number: "BE-2026-00001",
  direction: "expense",
  voucherKind: "standard",
  taxRule: "input_vat_deductible",
  companyIsKu: false,
  date: "2026-03-10",
  supplyDate: { kind: "date", date: "2026-03-05" },
  receivedDate: "2026-03-10",
  lines: [{ account: "6815", netCents: 10_000, vatCents: 1900, vatRateBp: 1900 }],
  ...over,
});
const paid = (over: Partial<VoucherPaidEvent> = {}): VoucherPaidEvent => ({
  kind: "voucher_paid",
  paymentId: "p1",
  date: "2026-03-20",
  direction: "expense",
  means: { kind: "bank_account", bankAccountId: "b1" },
  amountCents: 11_900,
  voucher: { id: "v1", number: "BE-2026-00001" },
  inputVatDeducted: true,
  ...over,
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const errorOf = (r: { ok: boolean; error?: { code: string; message: string } }) => (r.ok ? null : r.error);
const brief = (ls: RoleLine[]) =>
  ls.map((l) => [l.role ?? l.account, l.debitCents > 0 ? "S" : "H", l.debitCents || l.creditCents]);

describe("voucher booking — refusals (VOU-007, TAX-018, VOU-066)", () => {
  test("VOU-007 a voucher without lines or with fractional cents is refused", () => {
    expect(errorOf(postVoucherBooked(booked({ lines: [] }), SOLL))?.message).toBe("Der Beleg hat keine Positionen.");
    expect(
      errorOf(
        postVoucherBooked(booked({ lines: [{ account: "6815", netCents: 10.5, vatCents: 0, vatRateBp: 0 }] }), SOLL),
      )?.message,
    ).toBe("Beträge müssen ganze Cent sein.");
    expect(
      errorOf(
        postVoucherBooked(
          booked({
            taxRule: "reverse_charge_eu",
            lines: [{ account: "3123", netCents: 100, vatCents: 0, vatRateBp: 1900, selfAssessedVatCents: 19.5 }],
          }),
          SOLL,
        ),
      )?.message,
    ).toBe("Beträge müssen ganze Cent sein.");
  });

  test("TAX-018 a tax payment needs its subtype; a corporation pays no income tax", () => {
    expect(errorOf(postVoucherBooked(booked({ voucherKind: "tax_payment" }), SOLL))?.message).toBe(
      "Bitte die Art der Steuerzahlung angeben.",
    );
    expect(
      errorOf(postVoucherBooked(booked({ voucherKind: "tax_payment", taxPaymentSubtype: "est_private" }), GMBH)),
    ).toMatchObject({ code: "private_withdrawal_corporation" });
    const kst = ok(postVoucherBooked(booked({ voucherKind: "tax_payment", taxPaymentSubtype: "kst" }), GMBH));
    expect(kst.explanation).toBe("X7");
    expect(brief(kst.lines)).toEqual([
      ["expense.corp_tax", "S", 11_900],
      ["payable", "H", 11_900],
    ]);
  });

  test("VOU-066 a private voucher can only be an expense", () => {
    expect(errorOf(postVoucherBooked(booked({ voucherKind: "private", direction: "income" }), SOLL))?.message).toBe(
      "Private Belege sind nur als Ausgabe möglich.",
    );
  });

  test("ACC-001 the booking text is cut to 60 characters", () => {
    const r = ok(
      postVoucherBooked(booked({ counterpartyName: "Lieferant mit einem sehr langen Namen ".repeat(3) }), SOLL),
    );
    expect(r.text).toHaveLength(60);
    expect(r.text.endsWith("…")).toBe(true);
  });
});

describe("income vouchers (VOU-010)", () => {
  const income = (over: Partial<VoucherBookedEvent> = {}) =>
    booked({ direction: "income", taxRule: "output_vat", contactId: "c1", ...over });

  test("VOU-010 output VAT under Ist is parked as not yet due; a 0 % line has no tax key", () => {
    const r = ok(
      postVoucherBooked(
        income({
          lines: [
            { account: "8400", netCents: 10_000, vatCents: 1900, vatRateBp: 1900 },
            { account: "8200", netCents: 500, vatCents: 0, vatRateBp: 0 },
          ],
        }),
        IST,
      ),
    );
    expect(brief(r.lines)).toEqual([
      ["8400", "H", 10_000],
      ["vat.output.notdue.19", "H", 1900],
      ["8200", "H", 500],
      ["receivable", "S", 12_400],
    ]);
    expect(r.lines[2]?.taxKey).toBeUndefined();
    expect(r.lines[0]?.taxKey).toBe("USt19");
  });

  test("VOU-010 an unsupported output VAT rate and VAT on a tax-free income are refused", () => {
    expect(
      errorOf(
        postVoucherBooked(income({ lines: [{ account: "8400", netCents: 100, vatCents: 16, vatRateBp: 1600 }] }), SOLL),
      )?.code,
    ).toBe("rate_not_supported");
    expect(
      errorOf(
        postVoucherBooked(
          income({ taxRule: "tax_free", lines: [{ account: "2650", netCents: 100, vatCents: 19, vatRateBp: 1900 }] }),
          SOLL,
        ),
      )?.message,
    ).toBe("Steuerfreie oder nicht steuerbare Einnahmen haben keine Umsatzsteuer.");
    const interest = ok(
      postVoucherBooked(
        income({ taxRule: "tax_free", lines: [{ account: "2650", netCents: 300, vatCents: 0, vatRateBp: 0 }] }),
        SOLL,
      ),
    );
    expect(brief(interest.lines)).toEqual([
      ["2650", "H", 300],
      ["receivable", "S", 300],
    ]);
  });
});

describe("expense vouchers — special lines (VOU-022, VOU-024, VOU-026, VOU-027)", () => {
  test("VOU-024 VOU-026 a KU company cannot deduct import VAT", () => {
    const r = postVoucherBooked(
      booked({
        taxRule: "import_vat",
        companyIsKu: true,
        lines: [{ account: "1588", role: "vat.import", netCents: 1900, vatCents: 0, vatRateBp: 0 }],
      }),
      SOLL,
    );
    expect(errorOf(r)?.message).toBe("Als Kleinunternehmer ist die Einfuhrumsatzsteuer nicht abziehbar.");
  });

  test("VOU-027 Bewirtung by a KU company: 30 % of the gross is non-deductible, no VAT line and no tax key", () => {
    const r = ok(postVoucherBooked(booked({ voucherKind: "bewirtung", companyIsKu: true }), SOLL));
    expect(brief(r.lines)).toEqual([
      ["expense.entertainment", "S", 8330],
      ["expense.entertainment.nd", "S", 3570],
      ["payable", "H", 11_900],
    ]);
    expect(r.lines[0]?.taxKey).toBeUndefined();
    // Employee events by a KU company: 100 % staff expense, gross.
    const staff = ok(
      postVoucherBooked(
        booked({ voucherKind: "bewirtung", bewirtungOccasion: "arbeitnehmer", companyIsKu: true }),
        SOLL,
      ),
    );
    expect(brief(staff.lines)).toEqual([
      ["expense.staff_events", "S", 11_900],
      ["payable", "H", 11_900],
    ]);
  });

  test("VOU-022 VOU-027 a self-assessed line with a private share: the share goes to the clearing account (GmbH)", () => {
    const r = ok(
      postVoucherBooked(
        booked({
          taxRule: "reverse_charge_non_eu",
          lines: [
            {
              account: "6600",
              netCents: 10_000,
              vatCents: 0,
              vatRateBp: 1900,
              selfAssessedVatCents: 1900,
              nonDeductibleShareBp: 2000,
            },
          ],
        }),
        GMBH,
      ),
    );
    expect(brief(r.lines)).toEqual([
      ["6600", "S", 8000],
      ["shareholder.clearing", "S", 2000],
      ["vat.output.13b.19", "H", 1900],
      ["vat.input.13b.19", "S", 1900],
      ["payable", "H", 10_000],
    ]);
    // Without a self-assessed amount the VAT lines are empty (0 €), the base is still net.
    const none = ok(
      postVoucherBooked(
        booked({
          taxRule: "reverse_charge_non_eu",
          lines: [{ account: "6600", netCents: 5000, vatCents: 0, vatRateBp: 1900 }],
        }),
        SOLL,
      ),
    );
    expect(brief(none.lines)).toEqual([
      ["6600", "S", 5000],
      ["payable", "H", 5000],
    ]);
  });

  test("VOU-027 a negative private share (credit voucher) is rounded half away from zero", () => {
    const r = ok(
      postVoucherBooked(
        booked({
          taxRule: "no_input_vat",
          lines: [{ account: "6815", netCents: -1005, vatCents: 0, vatRateBp: 0, nonDeductibleShareBp: 5000 }],
        }),
        SOLL,
      ),
    );
    // −10,05 € × 50 % = −5,025 → −5,03 € private, −5,02 € business.
    expect(brief(r.lines)).toEqual([
      ["6815", "H", 502],
      ["private.withdrawal", "H", 503],
      ["payable", "S", 1005],
    ]);
  });

  test("VOU-020 VOU-026 input VAT counts as deducted only for a non-KU company with a deductible or self-assessed rule", () => {
    expect(voucherInputVatDeducted("input_vat_deductible", false)).toBe(true);
    expect(voucherInputVatDeducted("reverse_charge_eu", false)).toBe(true);
    expect(voucherInputVatDeducted("no_input_vat", false)).toBe(false);
    expect(voucherInputVatDeducted("input_vat_deductible", true)).toBe(false);
  });
});

describe("voucher payments (VOU-131, VOU-132, EC-BNK-76)", () => {
  test("VOU-131 a payment amount must be whole cents ≠ 0; differences too", () => {
    expect(errorOf(postVoucherPaid(paid({ amountCents: 0 })))?.message).toBe("Der Zahlbetrag muss ungleich 0 sein.");
    expect(errorOf(postVoucherPaid(paid({ amountCents: 1.5 })))?.message).toBe("Der Zahlbetrag muss ungleich 0 sein.");
    expect(errorOf(postVoucherPaid(paid({ differences: [{ reason: "bank_fees", amountCents: 0 }] })))?.message).toBe(
      "Differenzbeträge müssen ganze Cent ≠ 0 sein.",
    );
  });

  test("VOU-132 income: a bank fee kept by the bank is an expense; „other“ needs an account and debits it", () => {
    const income = paid({ direction: "income", amountCents: 11_850, voucher: { id: "v1" } });
    const fees = ok(postVoucherPaid({ ...income, differences: [{ reason: "bank_fees", amountCents: 50 }] }));
    expect(brief(fees.lines)).toEqual([
      ["bank.b1", "S", 11_850],
      ["expense.bank_fees", "S", 50],
      ["receivable", "H", 11_900],
    ]);
    expect(fees.text).toBe("Eingang");
    expect(errorOf(postVoucherPaid({ ...income, differences: [{ reason: "other", amountCents: 50 }] }))?.message).toBe(
      "Für „Sonstige Differenz“ ist ein Konto anzugeben.",
    );
    const other = ok(
      postVoucherPaid({ ...income, differences: [{ reason: "other", amountCents: 50, account: "4970" }] }),
    );
    expect(brief(other.lines)[1]).toEqual(["4970", "S", 50]);
    const expenseOther = ok(
      postVoucherPaid(
        paid({ amountCents: 11_850, differences: [{ reason: "other", amountCents: 50, account: "2700" }] }),
      ),
    );
    expect(brief(expenseOther.lines)).toEqual([
      ["payable", "S", 11_900],
      ["2700", "H", 50],
      ["bank.b1", "H", 11_850],
    ]);
  });

  test("VOU-132 Skonto on income vouchers is not supported; without a VAT split it is a 0 % Skonto; unsupported rates are refused", () => {
    expect(
      errorOf(postVoucherPaid(paid({ direction: "income", differences: [{ reason: "skonto", amountCents: 100 }] })))
        ?.message,
    ).toBe("Skonto auf Einnahmebelege wird nicht unterstützt.");
    const plain = ok(
      postVoucherPaid(paid({ amountCents: 11_800, differences: [{ reason: "skonto", amountCents: 100 }] })),
    );
    expect(brief(plain.lines)).toEqual([
      ["payable", "S", 11_900],
      ["skonto.received.19", "H", 100],
      ["bank.b1", "H", 11_800],
    ]);
    expect(plain.explanation).toBe("V2+V3");
    expect(
      errorOf(
        postVoucherPaid(
          paid({
            amountCents: 11_784,
            differences: [
              { reason: "skonto", amountCents: 116, vatCorrection: [{ rateBp: 1600, netCents: 100, vatCents: 16 }] },
            ],
          }),
        ),
      )?.code,
    ).toBe("rate_not_supported");
  });

  test("VOU-132 income with an Ist basis: the settled VAT share becomes due; an unsupported rate is refused", () => {
    const income = paid({
      direction: "income",
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 1900 }], payableCents: 11_900, settledBeforeCents: 0 },
    });
    const r = ok(postVoucherPaid(income));
    expect(brief(r.lines)).toEqual([
      ["bank.b1", "S", 11_900],
      ["receivable", "H", 11_900],
      ["vat.output.notdue.19", "S", 1900],
      ["vat.output.19", "H", 1900],
    ]);
    expect(r.explanation).toBe("VE-pay");
    expect(
      errorOf(
        postVoucherPaid({
          ...income,
          ist: { notDueVat: [{ rateBp: 1600, vatCents: 1600 }], payableCents: 11_600, settledBeforeCents: 0 },
        }),
      )?.code,
    ).toBe("rate_not_supported");
  });
});
