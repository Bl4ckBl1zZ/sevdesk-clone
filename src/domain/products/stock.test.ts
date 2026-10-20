import { describe, expect, test } from "vitest";
import {
  baseQuantityMilli,
  checkStockAllowed,
  deliveryNoteMovements,
  manualMovement,
  reorderTransition,
  reversingMovements,
  STOCK_MESSAGES,
  STOCK_REASON_LABELS,
  stockSum,
  withRunningBalance,
} from "./stock";

const cable = { unitCode: "MTR", extraUnits: [{ unitCode: "XRO", factorMilli: 100_000 }], stockEnabled: true };

describe("PRD-090…097 stock", () => {
  test("PRD-090 T-PRD-046 stock.enabled on a service → STOCK_SERVICE; the cache is the sum of movements", () => {
    expect(checkStockAllowed("service", true)).toEqual({ code: "STOCK_SERVICE", message: STOCK_MESSAGES.service });
    expect(checkStockAllowed("service", false)).toBeNull();
    expect(checkStockAllowed("good", true)).toBeNull();
    expect(stockSum([{ quantityMilli: 5000 }, { quantityMilli: -2000 }])).toBe(3000);
  });

  test("PRD-091 T-PRD-044 extra unit XRO × 2 with factor 100 → −200 base units; other lines are skipped", () => {
    expect(baseQuantityMilli(2000, "XRO", cable)).toBe(200_000);
    expect(baseQuantityMilli(2000, "MTR", cable)).toBe(2000);
    expect(baseQuantityMilli(2000, undefined, cable)).toBe(2000);
    expect(baseQuantityMilli(2000, "ZZZ", cable)).toBe(2000);
    const products = new Map([
      ["p1", cable],
      ["p2", { unitCode: "C62", extraUnits: [], stockEnabled: false }],
    ]);
    expect(
      deliveryNoteMovements(
        [
          { id: "l1", kind: "item", productId: "p1", quantityMilli: 2000, unitCode: "XRO" },
          { id: "l2", kind: "item", productId: "p2", quantityMilli: 1000 },
          { id: "l3", kind: "text" },
          { id: "l4", kind: "item", productId: "p9", quantityMilli: 1000 },
          { id: "l5", kind: "item", productId: "p1", quantityMilli: 0 },
        ],
        products,
      ),
    ).toEqual([{ productId: "p1", quantityMilli: -200_000, reason: "delivery_note" }]);
  });

  test("PRD-092 GOBD-06 cancelling books reversing correction movements (opposite sign)", () => {
    expect(reversingMovements([{ productId: "p1", quantityMilli: -5000 }])).toEqual([
      { productId: "p1", quantityMilli: 5000, reason: "correction" },
    ]);
    expect(STOCK_REASON_LABELS.correction).toBe("Korrektur");
  });

  test("PRD-094 manual Zugang/Abgang/Korrektur need a quantity and a text", () => {
    expect(manualMovement({ kind: "manual_in", quantityMilli: 5000, text: " Lieferung Großhandel " })).toEqual({
      ok: true,
      quantityMilli: 5000,
      text: "Lieferung Großhandel",
    });
    expect(manualMovement({ kind: "manual_out", quantityMilli: 2000, text: "Bruch" })).toMatchObject({
      quantityMilli: -2000,
    });
    expect(manualMovement({ kind: "correction", quantityMilli: -1000, text: "Inventur" })).toMatchObject({
      quantityMilli: -1000,
    });
    expect(manualMovement({ kind: "manual_in", quantityMilli: 5000, text: "  " })).toMatchObject({
      ok: false,
      field: "text",
      issue: { message: "Bitte einen Text zur Bestandsbuchung angeben." },
    });
    expect(manualMovement({ kind: "manual_out", quantityMilli: -1, text: "x" })).toMatchObject({ field: "quantity" });
    expect(manualMovement({ kind: "correction", quantityMilli: 0, text: "x" })).toMatchObject({
      issue: { message: STOCK_MESSAGES.correction },
    });
    expect(manualMovement({ kind: "manual_in", quantityMilli: 1.5, text: "x" })).toMatchObject({ field: "quantity" });
  });

  test("PRD-096 crossing below the reorder level once; recovered at or above the level", () => {
    expect(reorderTransition(12_000, 9_000, 10_000)).toBe("crossed_below");
    expect(reorderTransition(9_000, 8_000, 10_000)).toBeNull();
    expect(reorderTransition(8_000, 10_000, 10_000)).toBe("recovered");
    expect(reorderTransition(10_000, 10_000, 10_000)).toBeNull();
    expect(reorderTransition(10_000, 5_000, undefined)).toBeNull();
  });

  test("PRD-097 running balance in booking order", () => {
    expect(
      withRunningBalance([
        { id: "b", at: 2, quantityMilli: -2000 },
        { id: "a", at: 1, quantityMilli: 10_000 },
        { id: "c", at: 2, quantityMilli: 500 },
      ]).map((m) => [m.id, m.balanceMilli]),
    ).toEqual([
      ["a", 10_000],
      ["b", 8_000],
      ["c", 8_500],
    ]);
  });
});
