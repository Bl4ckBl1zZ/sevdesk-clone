import { describe, expect, test } from "vitest";
import { checkKuStart } from "./kleinunternehmer";

const codes = (r: { code: string }[]) => r.map((i) => i.code);

describe("Kleinunternehmer start (KU-01, F01 SET-033)", () => {
  test("SET-033 prior-year turnover 25.000,01 € blocks the KU entry, 25.000,00 € is allowed (T-SET-013)", () => {
    const exceeded = checkKuStart({ validFrom: "2026-01-01", priorYearTurnoverCents: 2_500_001 });
    expect(codes(exceeded.errors)).toEqual(["ku_prior_year_exceeded"]);
    expect(exceeded.errors[0]?.message).toContain("25.000,01");
    expect(checkKuStart({ validFrom: "2026-01-01", priorYearTurnoverCents: 2_500_000 })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  test("SET-033 in the founding year the KU may start on the founding date without a prior-year figure (T-SET-018)", () => {
    expect(checkKuStart({ validFrom: "2026-03-01", foundedOn: "2026-03-01" })).toEqual({ errors: [], warnings: [] });
  });

  test("SET-033 otherwise only from 1 January; a missing prior-year figure is a warning", () => {
    expect(codes(checkKuStart({ validFrom: "2026-03-01", priorYearTurnoverCents: 0 }).errors)).toEqual([
      "ku_start_invalid",
    ]);
    expect(codes(checkKuStart({ validFrom: "2027-01-01" }).warnings)).toEqual(["ku_prior_year_missing"]);
    expect(codes(checkKuStart({ validFrom: "01.01.2027" }).errors)).toEqual(["ku_start_invalid"]);
  });
});
