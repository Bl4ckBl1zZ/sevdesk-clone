import { describe, expect, test } from "vitest";
import { paperDestructible, scanningProcedureReleased } from "./scanning";

describe("„Papier vernichtbar“ (VOU-123, GOBD-08, GOBD-10)", () => {
  const checked = { at: 1, actor: "user:owner" };

  test("VOU-123 the filter needs a released Verfahrensdokumentation with the scanning procedure", () => {
    const released = JSON.stringify({ inputs: { scanProcedure: "Täglich, Inhaber, Sichtprüfung" } });
    expect(scanningProcedureReleased(released)).toBe(true);
    expect(scanningProcedureReleased(JSON.stringify({ inputs: { scanProcedure: "  " } }))).toBe(false);
    expect(scanningProcedureReleased(JSON.stringify({ inputs: {} }))).toBe(false);
    expect(scanningProcedureReleased(undefined)).toBe(false);
    expect(scanningProcedureReleased("{kaputt")).toBe(false);
  });

  test("VOU-123 only booked vouchers marked „Vollständig geprüft“ are paper-destructible", () => {
    expect(paperDestructible({ status: "paid", checkedComplete: checked }, true)).toBe(true);
    expect(paperDestructible({ status: "cancelled", checkedComplete: checked }, true)).toBe(true);
    expect(paperDestructible({ status: "draft", checkedComplete: checked }, true)).toBe(false);
    expect(paperDestructible({ status: "open" }, true)).toBe(false);
    expect(paperDestructible({ status: "open", checkedComplete: checked }, false)).toBe(false);
  });
});
