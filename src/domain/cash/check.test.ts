import { describe, expect, test } from "vitest";
import { cashNegativeIssue, firstNegativeBalance } from "./check";

const m = (date: string, seq: number, amountCents: number) => ({ date, seq, amountCents });

describe("CSH-026 cash never negative (AO-05, RI-11)", () => {
  test("CSH-026 golden C1: opening 100,00 then an outflow of 150,00 is blocked (shortfall 50,00)", () => {
    const dip = firstNegativeBalance([m("2026-10-01", 1, 10000), m("2026-10-01", 2, -15000)]);
    expect(dip).toEqual({ date: "2026-10-01", seq: 2, balanceCents: -5000 });
    expect(dip && cashNegativeIssue(dip, "2026-10-01", false).message).toBe(
      "Der Kassenbestand würde negativ werden (−50,00\u00a0€ am 01.10.2026). Bitte zuerst fehlende Bareinnahmen erfassen oder ‚privat bezahlt‘ wählen.",
    );
  });

  test("EC-149 golden C2/C3: a backdated outflow that dips a later date is blocked even if a later inflow cures it", () => {
    const moves = [
      m("2026-10-01", 1, 10000),
      m("2026-10-05", 2, -8000),
      m("2026-10-06", 4, 10000),
      m("2026-10-03", 3, -5000), // backdated, recorded last
    ];
    const dip = firstNegativeBalance(moves);
    expect(dip).toEqual({ date: "2026-10-05", seq: 2, balanceCents: -3000 });
    expect(dip && cashNegativeIssue(dip, "2026-10-03", false).message).toBe(
      "Nicht möglich: Durch die Buchung zum 03.10.2026 wäre der Kassenbestand am 05.10.2026 negativ (−30,00\u00a0€).",
    );
  });

  test("CSH-026 golden C4: same-day receipt before the deposit keeps the balance ≥ 0", () => {
    expect(
      firstNegativeBalance([m("2026-10-01", 1, 1500), m("2026-10-02", 2, 2000), m("2026-10-02", 3, -3000)]),
    ).toBeNull();
  });

  test("CSH-027 a reversal that dips the balance gets the Storno message (EC-CSH-04)", () => {
    const dip = { date: "2026-10-12", seq: 9, balanceCents: -8000 };
    expect(cashNegativeIssue(dip, "2026-10-12", true).message).toBe(
      "Storno nicht möglich: Der Kassenbestand würde am 12.10.2026 negativ werden.",
    );
  });
});
