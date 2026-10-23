import { describe, expect, test } from "vitest";
import { negativeStockCheck } from "./stock";

const current = new Map([
  ["p1", { name: "Kabel", quantityMilli: 50_000, unitCode: "MTR" }],
  ["p2", { name: "Stecker", quantityMilli: 5_000, unitCode: "C62" }],
]);

describe("PRD-095 negative stock check", () => {
  test("PRD-095 below zero is a warning by default and a block (STOCK_NEGATIVE) with the option; lines of one product add up", () => {
    const moves = [
      { productId: "p1", quantityMilli: -30_000 },
      { productId: "p1", quantityMilli: -30_000 },
      { productId: "p2", quantityMilli: -5_000 },
    ];
    expect(negativeStockCheck(moves, current, false)).toEqual({
      block: null,
      warning: "Der Bestand wird negativ. Kabel (-10 MTR)",
    });
    const blocked = negativeStockCheck(moves, current, true);
    expect(blocked.block?.code).toBe("STOCK_NEGATIVE");
    expect(blocked.block?.message).toBe(
      "Der Lieferschein würde den Bestand ins Minus bringen: Kabel (-10 MTR). „Negativen Bestand verhindern“ ist aktiviert.",
    );
    expect(negativeStockCheck([{ productId: "p2", quantityMilli: -5_000 }], current, true)).toEqual({
      block: null,
      warning: null,
    });
  });
});
