import { describe, expect, test } from "vitest";
import { DUPLICATE_REFUSED, type DuplicateSource, duplicateValues } from "./duplicate";

const src = {
  type: "advance_invoice",
  contactId: "c1",
  billingAddress: { name: "Alt GmbH", street: "Alte Str. 1", postalCode: "52062", city: "Aachen", countryCode: "DE" },
  supplyDate: { kind: "date", date: "2026-09-30" },
  supplyDateMode: "explicit",
  documentDate: "2026-10-01",
  backdateReason: "Nachtrag",
  currency: "EUR",
  priceMode: "net",
  taxCaseOverride: { taxCase: "domestic", reason: "geprüft" },
  subject: "Beratung",
  paymentTerms: { dueDays: 14 },
  showEpcQr: true,
  language: "de",
  validUntil: "2026-11-01",
  chainOrder: { number: "B-1", date: "2026-09-01" },
  lines: [
    {
      kind: "item",
      productId: "p1",
      productSyncedVersion: 3,
      name: "Beratung",
      quantityMilli: 2000,
      unitCode: "HUR",
      unitPriceMicros: 1_000_000,
      vatRateKey: "standard",
      linePeriod: { from: "2026-09-01", to: "2026-09-30" },
      sourceLineId: "l0",
    },
  ],
} as unknown as DuplicateSource;

describe("Duplizieren (DOC-35)", () => {
  test("DOC-35 advance/partial/final become an invoice draft without dates, chain links, frozen addresses or overrides", () => {
    const r = duplicateValues(src);
    if (!r.ok) throw new Error(r.message);
    expect(r.values.type).toBe("invoice");
    for (const k of [
      "documentDate",
      "supplyDate",
      "backdateReason",
      "validUntil",
      "chainOrder",
      "taxCaseOverride",
      "billingAddress",
    ]) {
      expect(r.values).not.toHaveProperty(k);
    }
    expect(r.values).toMatchObject({ contactId: "c1", subject: "Beratung", paymentTerms: { dueDays: 14 } });
    expect(r.values.lines[0]).toEqual({
      kind: "item",
      productId: "p1",
      name: "Beratung",
      quantityMilli: 2000,
      unitCode: "HUR",
      unitPriceMicros: 1_000_000,
      vatRateKey: "standard",
    });
  });

  test("DOC-35 quotes stay quotes; cancellations, corrections and reminders are refused", () => {
    const q = duplicateValues({ ...src, type: "quote" });
    expect(q.ok && q.values.type).toBe("quote");
    for (const type of ["cancellation", "correction", "reminder"]) {
      expect(duplicateValues({ ...src, type })).toEqual({ ok: false, message: DUPLICATE_REFUSED });
    }
  });
});
