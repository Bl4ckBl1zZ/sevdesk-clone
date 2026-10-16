import { describe, expect, test } from "vitest";
import { recurringTemplateSchema } from "@/domain/schemas/recurring";
import { emptyRecurringForm, recurringFormFrom, toTemplateValues } from "./recurring-model";

describe("REC-01 template editor state (F04 §6.5)", () => {
  test("REC-01 REC-02 REC-03 the form produces valid template values without document/supply dates", () => {
    const f = emptyRecurringForm("2026-11-01", "c1");
    const form = {
      ...f,
      name: "Wartung",
      endMode: "count" as const,
      maxCount: "12",
      finalize: true,
      editor: { ...f.editor, lines: [{ ...f.editor.lines[0], name: "Pauschale", price: "50,00" } as never] },
    };
    const { values, errors } = toTemplateValues(form);
    expect(errors).toEqual([]);
    expect(recurringTemplateSchema.safeParse(values).success).toBe(true);
    expect(values.schedule).toEqual({
      interval: "P1M",
      firstDate: "2026-11-01",
      maxCount: 12,
      billing: "in_advance",
      periodTextEnabled: true,
    });
    expect(values.automation).toEqual({ finalize: true });
    expect("supplyDate" in values.draft).toBe(false);
    expect(values.draft.lines[0]).toMatchObject({ name: "Pauschale", unitPriceMicros: 500_000 });
    // round trip
    expect(toTemplateValues(recurringFormFrom(values)).values).toEqual(values);
  });

  test("REC-03 missing name and invalid end count are input errors", () => {
    const f = { ...emptyRecurringForm("2026-11-01"), endMode: "count" as const, maxCount: "0" };
    expect(toTemplateValues(f).errors.map((e) => e.field)).toEqual(["name", "maxCount"]);
  });
});
