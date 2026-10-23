import { describe, expect, test } from "vitest";
import { parseBankDateTime } from "./dates";
import { inStatementPeriod } from "./reconcile";

const OCT = { periodFrom: "2026-10-01", periodTo: "2026-10-31", currency: "EUR" };
const SEP = { periodFrom: "2026-09-01", periodTo: "2026-09-30", currency: "EUR" };

describe("EC-BNK-19 booking dates around midnight and DST (BNK-112, EC-155)", () => {
  test("EC-BNK-19 BNK-112 E-ACC-29 a UTC instant just after/before midnight lands on the Europe/Berlin date, also across months", () => {
    // Last day of the month in UTC, already the next month in Berlin (CET, +1).
    expect(parseBankDateTime("2026-10-31T23:30:00Z")).toEqual({ date: "2026-11-01", instant: "2026-10-31T23:30:00Z" });
    // E-ACC-29: 30.09. 22:30 UTC = 01.10. 00:30 Berlin (CEST, +2) → October / Q4.
    expect(parseBankDateTime("2026-09-30T22:30:00Z")?.date).toBe("2026-10-01");
    // Vice versa: just before Berlin midnight stays in the old month.
    expect(parseBankDateTime("2026-09-30T21:59:59Z")?.date).toBe("2026-09-30");
    expect(parseBankDateTime("2026-12-31T22:59:00Z")?.date).toBe("2026-12-31");
    expect(parseBankDateTime("2026-12-31T23:00:00Z")?.date).toBe("2027-01-01");
    // Date-only values (CAMT BookgDt/Dt, MT940 :61:, feed booking_date) are taken as delivered.
    expect(parseBankDateTime("2026-10-31")?.date).toBe("2026-10-31");
  });

  test("EC-BNK-19 DST switch days: the offset of that very day is used (spring +1→+2, autumn +2→+1)", () => {
    // 29.03.2026 02:00 CET → 03:00 CEST
    expect(parseBankDateTime("2026-03-28T23:30:00Z")?.date).toBe("2026-03-29");
    expect(parseBankDateTime("2026-03-29T21:59:00Z")?.date).toBe("2026-03-29");
    expect(parseBankDateTime("2026-03-29T22:00:00Z")?.date).toBe("2026-03-30");
    // 25.10.2026 03:00 CEST → 02:00 CET
    expect(parseBankDateTime("2026-10-24T21:59:00Z")?.date).toBe("2026-10-24");
    expect(parseBankDateTime("2026-10-24T22:00:00Z")?.date).toBe("2026-10-25");
    expect(parseBankDateTime("2026-10-25T22:59:00Z")?.date).toBe("2026-10-25");
    expect(parseBankDateTime("2026-10-25T23:00:00Z")?.date).toBe("2026-10-26");
    // A local wall time in the repeated autumn hour still yields one instant and the same Berlin date.
    expect(parseBankDateTime("2026-10-25 02:30:00", "Europe/Berlin")?.date).toBe("2026-10-25");
  });

  test("EC-BNK-19 statements are compared on UTC instants, so the Berlin booking date and the statement month may differ", () => {
    const lateOct = { id: "a", amountCents: -100, bookingDate: "2026-11-01", bookedAtRaw: "2026-10-31T23:30:00Z" };
    expect(inStatementPeriod(lateOct, OCT)).toBe(true);
    const earlyOct = { id: "b", amountCents: -100, bookingDate: "2026-10-01", bookedAtRaw: "2026-09-30T22:30:00Z" };
    expect(inStatementPeriod(earlyOct, SEP)).toBe(true);
    expect(inStatementPeriod(earlyOct, OCT)).toBe(false);
  });
});
