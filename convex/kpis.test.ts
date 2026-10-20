import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { invoiceEvent, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("dashboard KPIs (RPT-002)", () => {
  test("RPT-002 month vs year: net revenue, result and the USt-Zahllast of the current filing period", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04", period: "monthly" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-03-10", 50000));
    await post(t, invoiceEvent(b.customer, "d2", "2026-10-05", 100000));
    const u = await t.asUser("bookkeeper");
    const month = await u.query(api.reports.kpis, { period: "month" });
    expect(month).toMatchObject({
      from: "2026-10-01",
      to: "2026-10-20",
      revenueCents: 100000,
      expensesCents: 0,
      resultCents: 100000,
      ust: { period: "2026-10", cents: 19000 },
      afaYtdCents: 0,
    });
    expect(month.liquidity.weeks).toHaveLength(13);
    const year = await u.query(api.reports.kpis, { period: "year" });
    expect(year.revenueCents).toBe(150000);
    const custom = await u.query(api.reports.kpis, { period: "custom", from: "2026-03-01", to: "2026-03-31" });
    expect(custom.revenueCents).toBe(50000);
    const err = await u.query(api.reports.kpis, { period: "custom" }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
  });
});
