import { describe, expect, test } from "vitest";
import { averageDaysToPay, paymentBehaviour } from "./customer";

describe("per-customer receivables (PAY-004)", () => {
  test("PAY-004 average days to pay is the rounded mean of paidOn − documentDate", () => {
    expect(averageDaysToPay([])).toBeNull();
    expect(
      averageDaysToPay([
        { documentDate: "2026-09-01", paidOn: "2026-09-11" },
        { documentDate: "2026-09-01", paidOn: "2026-09-22" },
      ]),
    ).toBe(16); // (10 + 21) / 2 = 15.5 → 16 (half-up)
    expect(averageDaysToPay([{ documentDate: "2026-09-10", paidOn: "2026-09-01" }])).toBe(0); // prepaid
  });
});

describe("payment behaviour per customer (PAY-008)", () => {
  test("PAY-008 average days to pay weighted by amount, share of late payments, last 12 months by payment date", () => {
    const r = paymentBehaviour(
      [
        // 1.000,00 paid after 10 days (in time), 3.000,00 after 30 days (due after 14 → late)
        { documentDate: "2026-09-01", dueDate: "2026-09-15", paidOn: "2026-09-11", amountCents: 100_000 },
        { documentDate: "2026-09-01", dueDate: "2026-09-15", paidOn: "2026-10-01", amountCents: 300_000 },
        // prepaid: counts as 0 days, not late
        { documentDate: "2026-10-10", dueDate: "2026-10-24", paidOn: "2026-10-05", amountCents: 100_000 },
        // outside the window (paid 2025-10-23, today 2026-10-23 → window from 2025-10-24)
        { documentDate: "2025-09-01", dueDate: "2025-09-15", paidOn: "2025-10-23", amountCents: 900_000 },
      ],
      "2026-10-23",
    );
    // (100 000 × 10 + 300 000 × 30 + 100 000 × 0) / 500 000 = 20
    expect(r).toEqual({ averageDaysToPay: 20, lateShareBp: 3333, invoices: 3, from: "2025-10-24" });
    expect(paymentBehaviour([], "2026-10-23")).toBeNull();
    // half-up: (1 × 1 + 1 × 2) / 2 = 1,5 → 2
    expect(
      paymentBehaviour(
        [
          { documentDate: "2026-10-01", paidOn: "2026-10-02", amountCents: 1 },
          { documentDate: "2026-10-01", paidOn: "2026-10-03", amountCents: 1 },
        ],
        "2026-10-23",
      )?.averageDaysToPay,
    ).toBe(2);
    expect(
      paymentBehaviour([{ documentDate: "2024-01-01", paidOn: "2024-02-01", amountCents: 1 }], "2026-10-23"),
    ).toBeNull();
  });
});
