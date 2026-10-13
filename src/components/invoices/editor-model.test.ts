import { describe, expect, test } from "vitest";
import { draftSchema } from "@/domain/schemas/documents";
import { editorFromValues, emptyEditor, emptyLine, toDraftValues } from "./editor-model";

describe("DOC-19 invoice editor model", () => {
  test("DOC-19 German inputs become the integer draft body of the shared schema", () => {
    const s = emptyEditor("2026-10-12", {
      contactId: "c1",
      skontoPercent: "2",
      skontoDays: "14",
      dueDays: "30",
      lines: [
        {
          ...emptyLine(),
          name: "Beratung",
          quantity: "1,5",
          unitCode: "HUR",
          price: "1.234,5678",
          discount: "10",
        },
        { ...emptyLine("text"), name: "Vielen Dank." },
      ],
    });
    const { values, errors } = toDraftValues(s);
    expect(errors).toEqual([]);
    expect(draftSchema.safeParse(values).success).toBe(true);
    expect(values.paymentTerms).toEqual({ dueDays: 30, skontoPercentBp: 200, skontoDays: 14 });
    expect(values.supplyDate).toEqual({ kind: "date", date: "2026-10-12" });
    expect(values.lines[0]).toMatchObject({
      kind: "item",
      name: "Beratung",
      quantityMilli: 1_500,
      unitPriceMicros: 12_345_678,
      discount: { kind: "percent", valueBp: 1_000 },
      vatRateKey: "standard",
    });
    expect(values.lines[1]).toEqual({ kind: "text", name: "Vielen Dank." });
  });

  test("DOC-19 invalid inputs are reported per line, never sent as floats", () => {
    const s = emptyEditor("2026-10-12", { lines: [{ ...emptyLine(), name: "X", quantity: "1,2345", price: "abc" }] });
    const { values, errors } = toDraftValues(s);
    expect(errors.map((e) => e.field)).toEqual(["lines.0.quantity", "lines.0.price"]);
    expect(values.lines[0]).not.toHaveProperty("unitPriceMicros");
  });

  test("DOC-03 a stored draft round-trips through the editor (product fields kept)", () => {
    const { values } = toDraftValues(
      emptyEditor("2026-10-12", {
        contactId: "c1",
        supplyKind: "period",
        supplyFrom: "2026-09-01",
        supplyTo: "2026-09-30",
        lines: [
          {
            ...emptyLine(),
            name: "Wartung",
            price: "95,00",
            unitCode: "HUR",
            extra: { productId: "p1", productSyncedVersion: 3, itemNumber: "ART-1" },
          },
        ],
      }),
    );
    const again = toDraftValues(editorFromValues(values)).values;
    expect(again).toEqual(values);
    expect(again.lines[0]).toMatchObject({ productId: "p1", productSyncedVersion: 3, itemNumber: "ART-1" });
    expect(again.supplyDate).toEqual({ kind: "period", from: "2026-09-01", to: "2026-09-30" });
  });
});
