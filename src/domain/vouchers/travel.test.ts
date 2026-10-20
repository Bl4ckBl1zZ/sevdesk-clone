import { describe, expect, test } from "vitest";
import { ALL_RULE_TABLES } from "../rules/registry";
import { TRAVEL_RATES } from "../rules/travel-expenses";
import { computeTravelExpenses, TRAVEL_MESSAGES, type TripInput, travelVoucher } from "./travel";

/** Berlin local time on a CEST day (UTC+2). */
const at = (date: string, hh: number, mm = 0) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, hh - 2, mm);
};
const trip = (over: Partial<TripInput>): TripInput => ({
  startedAt: at("2026-09-07", 7),
  endedAt: at("2026-09-07", 18),
  destination: "Hamburg",
  purpose: "Workshop Website-Relaunch bei Müller GmbH",
  ...over,
});
const days = (t: TripInput) => {
  const r = computeTravelExpenses(t);
  return r.ok ? r.value.days.map((d) => d.payableCents) : r.error.code;
};

describe("MISC-06 travel expenses", () => {
  test("MISC-06 2-day trip → 14 + 14; 3-day trip → 14 + 28 + 14 (2026 rates, date-effective table)", () => {
    expect(days(trip({ endedAt: at("2026-09-08", 12) }))).toEqual([1400, 1400]);
    expect(days(trip({ endedAt: at("2026-09-09", 20) }))).toEqual([1400, 2800, 1400]);
    expect(ALL_RULE_TABLES).toContain(TRAVEL_RATES);
  });

  test("MISC-06 single-day trips need more than 8 hours; 2019 uses the old 12/24 € row", () => {
    expect(days(trip({}))).toEqual([1400]);
    expect(days(trip({ endedAt: at("2026-09-07", 15) }))).toEqual([0]);
    expect(days(trip({ endedAt: at("2026-09-07", 15, 1) }))).toEqual([1400]);
    expect(days(trip({ startedAt: at("2019-06-03", 7), endedAt: at("2019-06-05", 20) }))).toEqual([1200, 2400, 1200]);
  });

  test("MISC-06 provided meals reduce by 20 % / 40 % of the full-day rate, never below 0; mileage 0,30 €/km", () => {
    const r = computeTravelExpenses(
      trip({
        endedAt: at("2026-09-09", 20),
        mealsProvided: { "2026-09-08": { breakfast: true }, "2026-09-09": { breakfast: true, lunch: true } },
        kilometres: 250,
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.days.map((d) => [d.payableCents, d.reductionCents])).toEqual([
      [1400, 0],
      [2240, 560],
      [0, 1400], // 5,60 + 11,20 > 14,00 → 0
    ]);
    expect(r.value).toMatchObject({ mealAllowanceCents: 3640, mileageCents: 7500, totalCents: 11_140 });
    expect(r.value.ruleRowIds).toEqual(["travel_rates@2020-01-01"]);
    const other = computeTravelExpenses(trip({ kilometres: 100, vehicle: "other" }));
    expect(other.ok && other.value.mileageCents).toBe(2000);
  });

  test("MISC-06 invalid input and missing rule rows are refused, never guessed", () => {
    expect(days(trip({ endedAt: at("2026-09-06", 7) }))).toBe("travel_period");
    expect(days(trip({ purpose: " " }))).toBe("travel_text");
    expect(days(trip({ kilometres: -3 }))).toBe("travel_km");
    expect(days(trip({ startedAt: at("2013-06-03", 7), endedAt: at("2013-06-03", 20) }))).toBe("rule_missing");
    expect(TRAVEL_MESSAGES.period).toBe("Die Rückkehr liegt vor der Abreise.");
  });

  test("MISC-06 voucher lines on the Reisekosten accounts without VAT, plus the Eigenbeleg rows", () => {
    const t = trip({
      endedAt: at("2026-09-08", 12),
      kilometres: 200,
      mealsProvided: { "2026-09-08": { breakfast: true } },
    });
    const r = computeTravelExpenses(t);
    if (!r.ok) throw new Error(r.error.message);
    const v = travelVoucher(t, r.value, "SKR03");
    expect(v.lines).toEqual([
      {
        account: "4674",
        description: "Verpflegungsmehraufwand Hamburg 07.09.2026–08.09.2026",
        netCents: 2240,
        vatRateBp: 0,
        vatCents: 0,
        grossCents: 2240,
      },
      {
        account: "4673",
        description: "Fahrtkosten 200 km (Pkw)",
        netCents: 6000,
        vatRateBp: 0,
        vatCents: 0,
        grossCents: 6000,
      },
    ]);
    expect(v.title).toBe("Reisekostenabrechnung");
    expect(v.rows[0]).toEqual(["Reiseziel", "Hamburg"]);
    expect(v.rows.at(-1)?.[0]).toBe("Summe");
    expect(v.rows.some(([, val]) => val.includes("abzgl. Mahlzeiten"))).toBe(true);
    const skr04 = travelVoucher(t, r.value, "SKR04");
    expect(skr04.lines.map((l) => l.account)).toEqual(["6674", "6673"]);
    const short = trip({ endedAt: at("2026-09-07", 10), kilometres: 30, vehicle: "other" });
    const rs = computeTravelExpenses(short);
    if (!rs.ok) throw new Error(rs.error.message);
    const vs = travelVoucher(short, rs.value, "SKR03");
    expect(vs.lines.map((l) => l.description)).toEqual(["Fahrtkosten 30 km (sonstiges Fahrzeug)"]);
    expect(vs.rows).toContainEqual(["07.09.2026", "unter 8 Stunden: 0,00 €"]);
  });
});
