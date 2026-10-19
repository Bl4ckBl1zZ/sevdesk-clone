import { describe, expect, test } from "vitest";
import { averageDaysToPay } from "./customer";

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
