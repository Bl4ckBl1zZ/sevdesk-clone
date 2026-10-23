import { describe, expect, test } from "vitest";
import { type SupplierVoucher, supplierStats } from "./supplier-stats";

const v = (over: Partial<SupplierVoucher>): SupplierVoucher => ({
  direction: "expense",
  status: "paid",
  documentDate: "2026-03-01",
  netEurCents: 10_000,
  openEurCents: 0,
  ...over,
});

describe("CON-152 supplier view", () => {
  test("CON-152 spend this year / all time from booked expense vouchers and open payables; drafts and cancelled excluded", () => {
    expect(
      supplierStats(
        [
          v({}),
          v({ documentDate: "2025-11-30", netEurCents: 5_000 }),
          v({ status: "open", netEurCents: 20_000, openEurCents: 23_800 }),
          v({ status: "partially_paid", netEurCents: 1_000, openEurCents: 500 }),
          v({ netEurCents: -2_000 }), // credit note
          v({ status: "draft", netEurCents: 99_999, openEurCents: 99_999 }),
          v({ status: "cancelled", netEurCents: 77_777 }),
          v({ direction: "income", netEurCents: 55_555 }),
        ],
        "2026-10-12",
      ),
    ).toEqual({ spendThisYearCents: 29_000, spendAllTimeCents: 34_000, openPayablesCents: 24_300, voucherCount: 5 });
  });
});
