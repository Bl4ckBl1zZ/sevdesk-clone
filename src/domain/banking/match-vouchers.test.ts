import { describe, expect, test } from "vitest";
import { type OpenVoucher, scoreTransaction } from "./match";
import type { UnmatchedTransaction } from "./match-types";

const out = (over: Partial<UnmatchedTransaction> = {}): UnmatchedTransaction => ({
  id: "tx1",
  accountId: "acc",
  accountName: "Revolut EUR",
  bookingDate: "2026-10-12",
  amountCents: -4990,
  currency: "EUR",
  openCents: 4990,
  direction: "out",
  purpose: "",
  ...over,
});
const voucher = (over: Partial<OpenVoucher> = {}): OpenVoucher => ({
  id: "v1",
  supplierName: "Adobe Systems Software Ireland",
  ibans: [],
  documentDate: "2026-10-11",
  openCents: 4990,
  currency: "EUR",
  ...over,
});

describe("matching vouchers (BNK-049)", () => {
  test("BNK-049 M7 card payment −12,05 € with original 13,00 USD, merchant = supplier, USD voucher → 0.60 with bill_amount", () => {
    const [c] = scoreTransaction(
      out({
        amountCents: -1205,
        openCents: 1205,
        merchantName: "Acme Corp.",
        counterpartyName: "Acme Corp.",
        instructedAmount: { amountMinor: 1300, currency: "USD" },
      }),
      {
        documents: [],
        vouchers: [voucher({ supplierName: "Acme Corp.", currency: "USD", billOpenMinor: 1300, openCents: 1205 })],
      },
    );
    expect(c?.score).toBe(0.6);
    expect(c?.reasons).toEqual(["bill_amount", "name_similarity", "date_window"]);
    expect(c?.allocations).toEqual([{ target: { kind: "voucher", id: "v1" }, amountCents: 1205 }]);
  });

  test("BNK-049 card payment by merchant name + exact amount within ±3 days", () => {
    const tx = out({
      merchantName: "ADOBE SYSTEMS SOFTWARE IRELAND",
      counterpartyName: "ADOBE SYSTEMS SOFTWARE IRELAND",
    });
    const [c] = scoreTransaction(tx, { documents: [], vouchers: [voucher()] });
    expect(c?.reasons).toEqual(["exact_amount", "name_similarity", "date_window"]);
    expect(c?.score).toBe(0.6);
    // 5 days off → no date signal for card payments
    const [late] = scoreTransaction({ ...tx, bookingDate: "2026-10-16" }, { documents: [], vouchers: [voucher()] });
    expect(late?.reasons).not.toContain("date_window");
  });

  test("BNK-049 the supplier's document number in the reference is the primary rule", () => {
    const [c] = scoreTransaction(out({ purpose: "Rechnung INV-77812" }), {
      documents: [],
      vouchers: [voucher({ documentNumber: "INV-77812", supplierName: "Hetzner Online GmbH" })],
    });
    expect(c?.reasons).toEqual(["number_in_purpose", "exact_amount", "date_window"]);
    expect(c?.score).toBe(0.95);
  });

  test("BNK-049 recurring vouchers: expected amount ±5 %, date ±5 days, known IBAN", () => {
    const v = voucher({
      recurring: true,
      openCents: 10_000,
      ibans: ["DE02120300000000202051"],
      supplierName: "Vermieter Schmidt",
    });
    const [c] = scoreTransaction(
      out({
        amountCents: -10_400,
        openCents: 10_400,
        bookingDate: "2026-10-15",
        counterpartyIban: "DE02120300000000202051",
      }),
      { documents: [], vouchers: [v] },
    );
    expect(c?.reasons).toEqual(["recurring_expected", "known_iban", "date_window"]);
    expect(c?.score).toBe(0.5);
    expect(
      scoreTransaction(out({ amountCents: -10_600, openCents: 10_600, bookingDate: "2026-10-15" }), {
        documents: [],
        vouchers: [{ ...v, ibans: [] }],
      }),
    ).toEqual([]);
  });

  test("BNK-049 hard filters: incoming money, other currency, rejected pairs and paid vouchers never match", () => {
    expect(
      scoreTransaction(out({ direction: "in", amountCents: 4990 }), { documents: [], vouchers: [voucher()] }),
    ).toEqual([]);
    expect(scoreTransaction(out({ currency: "USD" }), { documents: [], vouchers: [voucher()] })).toEqual([]);
    expect(
      scoreTransaction(out({ purpose: "Adobe" }), {
        documents: [],
        vouchers: [voucher()],
        rejected: new Set(["voucher:v1"]),
      }),
    ).toEqual([]);
    expect(scoreTransaction(out(), { documents: [], vouchers: [voucher({ openCents: 0 })] })).toEqual([]);
  });

  test("BNK-049 two vouchers with the same amount and no other signal → ambiguous, never auto", () => {
    const r = scoreTransaction(out({ purpose: "Kartenzahlung" }), {
      documents: [],
      vouchers: [voucher({ id: "a", supplierName: "X GmbH" }), voucher({ id: "b", supplierName: "Y GmbH" })],
    });
    expect(r.every((c) => c.reasons.includes("ambiguous"))).toBe(true);
  });
});
