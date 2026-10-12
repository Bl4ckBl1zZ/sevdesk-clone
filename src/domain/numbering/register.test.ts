import { describe, expect, test } from "vitest";
import { normalizeNumber } from "./format";
import {
  assignNumber,
  COLLISION_SIMULATION_COUNT,
  checkDeactivateRange,
  checkDeleteRange,
  nextPeriodDate,
  simulateCollision,
  simulationBounds,
  validateNextValue,
} from "./register";

const OCT_2026 = { year: 2026, month: 10 };
const issued = (...numbers: string[]) => new Set(numbers.map(normalizeNumber));

describe("SET-060 collision simulation (EC-008)", () => {
  test("SET-060 simulates exactly 10,000 numbers of the current and the next period", () => {
    expect(COLLISION_SIMULATION_COUNT).toBe(10_000);
    // Counter 42 in 2026: RE-2026-10041 is the 10,000th number of the current period …
    expect(
      simulateCollision(
        { format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 42, startValue: 1 },
        OCT_2026,
        issued("RE-2026-10041"),
      ),
    ).toEqual({ number: "RE-2026-10041" });
    expect(
      simulateCollision(
        { format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 42, startValue: 1 },
        OCT_2026,
        issued("RE-2026-10042"),
      ),
    ).toBeNull();
    // … and the next period restarts at the start value (yearly reset).
    expect(
      simulateCollision(
        { format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 42, startValue: 1 },
        OCT_2026,
        issued("RE-2027-0001"),
      ),
    ).toEqual({ number: "RE-2027-0001" });
  });

  test("SET-060 T-SET-033 a prefix change that collides with issued RE-2026-0001…0040 is detected", () => {
    const done = issued(...Array.from({ length: 40 }, (_, i) => `RE-2026-${String(i + 1).padStart(4, "0")}`));
    expect(
      simulateCollision({ format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 1, startValue: 1 }, OCT_2026, done),
    ).toEqual({ number: "RE-2026-0001" });
    expect(
      simulateCollision({ format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 41, startValue: 1 }, OCT_2026, done),
    ).toBeNull();
  });

  test("SET-060 T-SET-037 normalisation: re-2026-0001 collides with RE-2026-0001", () => {
    expect(
      simulateCollision(
        { format: "re-{YYYY}-{####}", resetPolicy: "yearly", next: 1, startValue: 1 },
        OCT_2026,
        issued("RE-2026-0001"),
      ),
    ).toEqual({ number: "re-2026-0001" });
  });

  test("SET-060 T-SET-083 yearly → never: RE-{####} with next 1 collides with RE-0001…0040, next 41 is free", () => {
    const done = issued(...Array.from({ length: 40 }, (_, i) => `RE-${String(i + 1).padStart(4, "0")}`));
    expect(
      simulateCollision({ format: "RE-{####}", resetPolicy: "never", next: 1, startValue: 1 }, OCT_2026, done),
    ).toEqual({
      number: "RE-0001",
    });
    expect(
      simulateCollision({ format: "RE-{####}", resetPolicy: "never", next: 41, startValue: 1 }, OCT_2026, done),
    ).toBeNull();
  });

  test("SET-060 without a reset the year token still changes in the next period; the counter continues", () => {
    expect(nextPeriodDate("RE-{YYYY}-{####}", "never", OCT_2026)).toEqual({ year: 2027, month: 1 });
    expect(nextPeriodDate("RE-{YYYY}{MM}-{####}", "monthly", OCT_2026)).toEqual({ year: 2026, month: 11 });
    expect(nextPeriodDate("RE-{YYYY}{MM}-{####}", "monthly", { year: 2026, month: 12 })).toEqual({
      year: 2027,
      month: 1,
    });
    // never + year token: in 2027 the counter continues from wherever 2026 ends (unknown → simulated from `next`);
    // numbers below the current counter are unreachable.
    expect(
      simulateCollision(
        { format: "RE-{YYYY}-{####}", resetPolicy: "never", next: 42, startValue: 1 },
        OCT_2026,
        issued("RE-2027-0041"),
      ),
    ).toBeNull();
    expect(
      simulateCollision(
        { format: "RE-{YYYY}-{####}", resetPolicy: "never", next: 42, startValue: 1 },
        OCT_2026,
        issued("RE-2027-0050"),
      ),
    ).toEqual({ number: "RE-2027-0050" });
  });
});

test("SET-060 the simulation bounds enclose every simulated number (register range scan)", () => {
  const b = simulationBounds({ format: "RE-{YYYY}-{####}", resetPolicy: "yearly", next: 42, startValue: 1 }, OCT_2026);
  expect(b).toEqual({ lo: "RE-2026-0042", hi: "RE-2027-9999" });
  expect(simulationBounds({ format: "x{##}", resetPolicy: "never", next: 1, startValue: 1 }, OCT_2026, 3)).toEqual({
    lo: "X01",
    hi: "X03",
  });
});

describe("SET-059 „Nächste Nummer“ can only be raised (GOBD-02)", () => {
  test("SET-059 T-SET-034 lowering below max(issued)+1 → COUNTER_DECREASE with the minimum in the message", () => {
    const r = validateNextValue({ counterNext: 42, maxIssuedCounter: 41 }, 40, "");
    expect(r).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "counter_decrease",
        message:
          "Die nächste Nummer kann nicht unter 42 gesetzt werden, weil Nummern nie doppelt vergeben werden dürfen.",
      }),
    });
  });

  test("SET-059 the register wins over a stale counter (imported numbers)", () => {
    const r = validateNextValue({ counterNext: 1, maxIssuedCounter: 120 }, 100, "x");
    expect(r.ok ? null : r.error.code).toBe("counter_decrease");
  });

  test("SET-059 T-SET-034 raising 42 → 50 needs a reason; with a reason the gap 42–49 is documented", () => {
    const noReason = validateNextValue({ counterNext: 42, maxIssuedCounter: 41 }, 50, " ");
    expect(noReason.ok ? null : noReason.error).toMatchObject({
      code: "reason_required",
      message: "Bitte begründen, warum Nummern übersprungen werden (Lückenprotokoll).",
    });
    expect(validateNextValue({ counterNext: 42, maxIssuedCounter: 41 }, 50, "Neustart nach Umstellung")).toEqual({
      ok: true,
      value: { gap: { from: 42, to: 49 } },
    });
  });

  test("SET-059 an unchanged value or the first value of an unused range needs no reason", () => {
    expect(validateNextValue({ counterNext: 42, maxIssuedCounter: 41 }, 42, "")).toEqual({ ok: true, value: {} });
    expect(validateNextValue({}, 1000, "")).toEqual({ ok: true, value: {} });
  });
});

describe("SET-062 used ranges are deactivated, never deleted", () => {
  const range = (over: Partial<{ id: string; docTypes: string[]; active: boolean; isDefault: boolean }>) => ({
    id: "r1",
    docTypes: ["invoice"],
    active: true,
    isDefault: false,
    ...over,
  });

  test("SET-062 T-SET-038 deleting a range with issued numbers → RANGE_IN_USE", () => {
    expect(checkDeleteRange(range({}), 3, [range({})])).toMatchObject({
      code: "range_in_use",
      message: "Aus diesem Nummernkreis wurden bereits Nummern vergeben. Er kann nur deaktiviert werden.",
    });
    expect(checkDeleteRange(range({}), 0, [range({}), range({ id: "r2", isDefault: true })])).toBeNull();
  });

  test("SET-062 T-SET-038 deactivating the only active default of a type → RANGE_DEFAULT_REQUIRED", () => {
    const def = range({ isDefault: true });
    expect(checkDeactivateRange(def, [def, range({ id: "r2" })])).toMatchObject({
      code: "range_default_required",
      message: "Für Rechnung muss ein aktiver Standard-Nummernkreis existieren.",
    });
    expect(checkDeactivateRange(range({ id: "r2" }), [def, range({ id: "r2" })])).toBeNull();
    // An unused default may not be deleted either while it is the only one.
    expect(checkDeleteRange(def, 0, [def])).toMatchObject({ code: "range_default_required" });
  });
});

describe("SET-064 contact, product, asset and internal-voucher numbers use the same mechanism (GOBD-05)", () => {
  test("SET-064 contacts start at 10000 without reset; the counter advances; numbers are normalised", () => {
    const a = assignNumber(
      { format: "{#####}", resetPolicy: "never", startValue: 10_000 },
      undefined,
      OCT_2026,
      issued(),
    );
    expect(a).toEqual({
      ok: true,
      value: { number: "10000", normalized: "10000", periodKey: "", counter: 10_000, next: 10_001 },
    });
    const b = assignNumber(
      { format: "{#####}", resetPolicy: "never", startValue: 10_000 },
      10_001,
      OCT_2026,
      issued("10000"),
    );
    expect(b.ok && b.value.number).toBe("10001");
  });

  test("SET-064 internal voucher numbers reset yearly (BE-2026-00001) and products use ART-{#####}", () => {
    const v = assignNumber(
      { format: "BE-{YYYY}-{#####}", resetPolicy: "yearly", startValue: 1 },
      undefined,
      OCT_2026,
      issued(),
    );
    expect(v.ok && v.value).toMatchObject({ number: "BE-2026-00001", periodKey: "2026" });
    const p = assignNumber({ format: "ART-{#####}", resetPolicy: "never", startValue: 1 }, 7, OCT_2026, issued());
    expect(p.ok && p.value.number).toBe("ART-00007");
  });

  test("SET-064 UST-06 an assignment that would duplicate a registered number aborts with NUMBER_COLLISION", () => {
    const r = assignNumber(
      { format: "ART-{#####}", resetPolicy: "never", startValue: 1 },
      7,
      OCT_2026,
      issued("art-00007"),
    );
    expect(r.ok ? null : r.error.code).toBe("number_collision");
  });
});
