import { describe, expect, test } from "vitest";
import { displayStatus } from "./display-status";
import { derivePaymentStatus, type StatusRow, settledOf } from "./payment-status";

const cash = (amountCents: number, extra: Partial<StatusRow> = {}): StatusRow => ({
  amountCents,
  differences: [],
  cash: true,
  ...extra,
});

describe("payment status derivation (PAY-043, §4.3)", () => {
  test("T05-072 PAY-043 table: open → partially_paid → paid; open amount = payable − net settled", () => {
    expect(derivePaymentStatus({ payableCents: 119000, rows: [] })).toEqual({
      paymentStatus: "open",
      openAmountCents: 119000,
      settledCents: 0,
      writeOffCents: 0,
    });
    expect(derivePaymentStatus({ payableCents: 119000, rows: [cash(50000)] })).toMatchObject({
      paymentStatus: "partially_paid",
      openAmountCents: 69000,
    });
    expect(derivePaymentStatus({ payableCents: 119000, rows: [cash(50000), cash(69000)] })).toMatchObject({
      paymentStatus: "paid",
      openAmountCents: 0,
    });
  });

  test("T05-072 RI-09 differences count as settled (Skonto, fees); reversal rows (negative) reopen", () => {
    const skonto = cash(116620, { differences: [{ reason: "skonto", amountCents: 2380 }] });
    expect(derivePaymentStatus({ payableCents: 119000, rows: [skonto] }).paymentStatus).toBe("paid");
    const reversal = cash(-116620, { differences: [{ reason: "skonto", amountCents: -2380 }], reversal: true });
    expect(
      derivePaymentStatus({ payableCents: 119000, rows: [{ ...skonto, reversed: true }, reversal] }),
    ).toMatchObject({ paymentStatus: "open", openAmountCents: 119000, settledCents: 0 });
    expect(settledOf(skonto)).toBe(119000);
  });

  test("T05-072 stored precedence written_off > credited > paid > partially_paid > open", () => {
    const writeOff = (n: number): StatusRow => ({
      amountCents: 0,
      differences: [{ reason: "write_off", amountCents: n }],
      cash: false,
    });
    // S3: 595,00 paid, remainder written off → written_off
    expect(derivePaymentStatus({ payableCents: 119000, rows: [cash(59500), writeOff(59500)] })).toMatchObject({
      paymentStatus: "written_off",
      writeOffCents: 59500,
    });
    // write-off first, then the rest paid in cash → paid (the last settling act is a payment)
    expect(derivePaymentStatus({ payableCents: 119000, rows: [writeOff(59500), cash(59500)] }).paymentStatus).toBe(
      "paid",
    );
    // only price reductions, no money → credited
    const credit: StatusRow = { amountCents: 0, differences: [{ reason: "other", amountCents: 119000 }], cash: false };
    expect(derivePaymentStatus({ payableCents: 119000, rows: [credit] }).paymentStatus).toBe("credited");
    // a reversed write-off does not count (the reversal row negates it)
    expect(
      derivePaymentStatus({
        payableCents: 119000,
        rows: [cash(59500), { ...writeOff(59500), reversed: true }, { ...writeOff(-59500), reversal: true }],
      }),
    ).toMatchObject({ paymentStatus: "partially_paid", writeOffCents: 0 });
  });

  test("PAY-043 INV-12 credit corrections count towards the settlement (open = payable − credited − settled)", () => {
    // a 400,00 credit on a 1.190,00 invoice, nothing paid yet: still open (F04 §4.2.5 keeps the status)
    expect(derivePaymentStatus({ payableCents: 119000, creditedCents: 40000, rows: [] })).toMatchObject({
      paymentStatus: "open",
      openAmountCents: 79000,
    });
    // the rest paid → paid, not partially_paid
    expect(derivePaymentStatus({ payableCents: 119000, creditedCents: 40000, rows: [cash(79000)] })).toMatchObject({
      paymentStatus: "paid",
      openAmountCents: 0,
    });
    // fully credited without money → credited
    expect(derivePaymentStatus({ payableCents: 119000, creditedCents: 119000, rows: [] }).paymentStatus).toBe(
      "credited",
    );
    // paying more than the credited rest is still an overpayment
    expect(() => derivePaymentStatus({ payableCents: 119000, creditedCents: 40000, rows: [cash(79001)] })).toThrow(
      /negativer offener Betrag/,
    );
  });

  test("T05-071 EC-PAY-45 open < 0 is impossible: the derivation refuses instead of storing it", () => {
    expect(() => derivePaymentStatus({ payableCents: 1000, rows: [cash(1001)] })).toThrow(/negativer offener Betrag/);
  });

  test("PAY-043 payable ≤ 0 (final invoice fully covered by advances) is paid; cancelled documents have no status", () => {
    expect(derivePaymentStatus({ payableCents: 0, rows: [] }).paymentStatus).toBe("paid");
    expect(derivePaymentStatus({ payableCents: 119000, rows: [], cancelled: true }).paymentStatus).toBeUndefined();
  });

  test("T05-072 PAY-043 overdue is derived only in the display status, never a stored payment status", () => {
    const stored = derivePaymentStatus({ payableCents: 119000, rows: [cash(1000)] });
    expect(["open", "partially_paid", "paid", "credited", "written_off"]).toContain(stored.paymentStatus);
    const d = displayStatus(
      {
        type: "invoice",
        status: "sent",
        paymentStatus: stored.paymentStatus as "partially_paid",
        openAmountCents: stored.openAmountCents,
        dueDate: "2026-10-01",
      },
      "2026-10-13",
    );
    expect(d).toEqual({ token: "overdue", label: "Überfällig", partiallyPaid: true });
  });

  test("PAY-033 T05-053 a credit correction (negative payable) mirrors the logic: Erstattung offen → teilweise → erstattet", () => {
    // Credit −238,00 of which 100,00 were absorbed by the corrected invoice (credited = −applied): 138,00 to refund.
    const base = { payableCents: -23_800, creditedCents: -10_000 };
    expect(derivePaymentStatus({ ...base, rows: [] })).toMatchObject({
      paymentStatus: "open",
      openAmountCents: -13_800,
    });
    expect(derivePaymentStatus({ ...base, rows: [cash(-5_000)] })).toMatchObject({
      paymentStatus: "partially_paid",
      openAmountCents: -8_800,
      settledCents: -5_000,
    });
    expect(derivePaymentStatus({ ...base, rows: [cash(-5_000), cash(-8_800)] })).toMatchObject({
      paymentStatus: "paid",
      openAmountCents: 0,
    });
    // A reversed refund puts the open refund back.
    expect(
      derivePaymentStatus({ ...base, rows: [cash(-13_800, { reversed: true }), cash(13_800, { reversal: true })] }),
    ).toMatchObject({ paymentStatus: "open", openAmountCents: -13_800 });
    // Fully absorbed by the invoice, nothing to refund: settled by offset only.
    expect(derivePaymentStatus({ payableCents: -23_800, creditedCents: -23_800, rows: [] }).paymentStatus).toBe(
      "credited",
    );
    const d = displayStatus(
      { type: "correction", status: "finalized", paymentStatus: "partially_paid", openAmountCents: -8_800 },
      "2026-10-13",
    );
    expect(d).toMatchObject({ token: "refund_open", label: "Erstattung offen" });
    const done = displayStatus(
      { type: "correction", status: "finalized", paymentStatus: "paid", openAmountCents: 0 },
      "2026-10-13",
    );
    expect(done.label).toBe("Erstattet");
  });

  test("EC-PAY-33 a refund beyond the open refund of a correction is corrupt state (guard)", () => {
    expect(() => derivePaymentStatus({ payableCents: -23_800, rows: [cash(-30_000)] })).toThrow(RangeError);
  });
});
