import { describe, expect, test } from "vitest";
import { draftSchema, markSentSchema, retractMarkSchema } from "./documents";

const draft = {
  type: "invoice",
  supplyDateMode: "explicit",
  supplyDate: { kind: "date", date: "2026-10-09" },
  currency: "EUR",
  priceMode: "net",
  paymentTerms: { dueDays: 14 },
  showEpcQr: true,
  language: "de",
  lines: [{ kind: "item", name: "Beratung Website", quantityMilli: 1000, unitCode: "HUR", unitPriceMicros: 950_000 }],
};

describe("document schemas (F04 §5, 02 §5)", () => {
  test("DOC-09 money fields are integers: cents, micros, milli and basis points", () => {
    expect(draftSchema.safeParse(draft).success).toBe(true);
    const float = { ...draft, lines: [{ ...draft.lines[0], unitPriceMicros: 95.5 }] };
    expect(draftSchema.safeParse(float).success).toBe(false);
  });

  test("DOC-21 supply date kinds date, period and month", () => {
    for (const supplyDate of [
      { kind: "period", from: "2026-10-01", to: "2026-10-31" },
      { kind: "month", month: "2026-10" },
    ]) {
      expect(draftSchema.safeParse({ ...draft, supplyDate }).success).toBe(true);
    }
    expect(draftSchema.safeParse({ ...draft, supplyDate: { kind: "month", month: "2026-13" } }).success).toBe(false);
  });

  test("SND-07 mark-sent body: channel from the closed list, date as YYYY-MM-DD", () => {
    expect(markSentSchema.safeParse({ sentOn: "2026-10-12", channel: "post", artifactIds: ["a"] }).success).toBe(true);
    expect(markSentSchema.safeParse({ sentOn: "2026-10-12", channel: "smtp", artifactIds: ["a"] }).success).toBe(false);
    expect(retractMarkSchema.safeParse({ retractsId: "s1", reason: "Falsches Datum" }).success).toBe(true);
  });
});
