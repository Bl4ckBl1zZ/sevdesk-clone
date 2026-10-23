import { describe, expect, test } from "vitest";
import { lockedPeriodNotices } from "./locked-periods";

describe("EC-BNK-51 statement rows in a locked period (EC-170)", () => {
  test("EC-BNK-51 rows of a locked month are announced with the first open month their bookings go to", () => {
    const closed = new Set(["2026-09", "2026-10"]);
    const notices = lockedPeriodNotices(["2026-09-30", "2026-10-02", "2026-10-15", "2026-11-03"], closed, "2026-11-20");
    expect(notices).toEqual([
      {
        period: "2026-09",
        openPeriod: "2026-11",
        rows: 1,
        message: "Umsätze aus festgeschriebenem Zeitraum 09/2026 werden im Zeitraum 11/2026 gebucht.",
      },
      {
        period: "2026-10",
        openPeriod: "2026-11",
        rows: 2,
        message: "Umsätze aus festgeschriebenem Zeitraum 10/2026 werden im Zeitraum 11/2026 gebucht.",
      },
    ]);
  });

  test("EC-BNK-51 nothing to announce when all rows lie in open periods", () => {
    expect(lockedPeriodNotices(["2026-11-03"], new Set(["2026-10"]), "2026-11-20")).toEqual([]);
    expect(lockedPeriodNotices([], new Set(["2026-10"]), "2026-11-20")).toEqual([]);
  });
});
