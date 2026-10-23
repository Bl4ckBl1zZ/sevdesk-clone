import { describe, expect, test } from "vitest";
import { productUsage, type UsageLine } from "./usage";

const l = (over: Partial<UsageLine>): UsageLine => ({
  documentId: "d1",
  number: "RE-2026-0001",
  type: "invoice",
  status: "open",
  documentDate: "2026-03-01",
  contactName: "Muster GmbH",
  currency: "EUR",
  quantityMilli: 2_000,
  netCents: 20_000,
  ...over,
});

describe("PRD-074 product usage", () => {
  test("PRD-074 lists every document with the product; units and revenue this/last year from finalised invoice lines only", () => {
    const u = productUsage(
      [
        l({}),
        l({ documentId: "d1", quantityMilli: 1_000, netCents: 10_000 }), // second line of the same document
        l({
          documentId: "d2",
          number: "RE-2025-0009",
          documentDate: "2025-12-01",
          quantityMilli: 5_000,
          netCents: 50_000,
        }),
        l({
          documentId: "d3",
          number: "ST-2026-0001",
          type: "cancellation",
          documentDate: "2026-04-01",
          quantityMilli: -1_000,
          netCents: -10_000,
        }),
        l({ documentId: "d4", number: "AN-2026-0001", type: "quote", quantityMilli: 9_000, netCents: 90_000 }),
        l({
          documentId: "d5",
          number: undefined,
          status: "draft",
          documentDate: undefined,
          quantityMilli: 7_000,
          netCents: 70_000,
        }),
        // USD invoice, 1 EUR = 1.25 USD → 100,00 USD = 80,00 EUR
        l({
          documentId: "d6",
          number: "RE-2026-0002",
          currency: "USD",
          fxRateToEur: "1.25",
          quantityMilli: 1_000,
          netCents: 10_000,
        }),
        l({ documentId: "d7", number: "RE-2024-0001", documentDate: "2024-05-05" }), // older years: listed, not counted
      ],
      "2026-10-12",
    );
    expect(u.thisYear).toEqual({ unitsMilli: 3_000, revenueCents: 28_000 });
    expect(u.lastYear).toEqual({ unitsMilli: 5_000, revenueCents: 50_000 });
    expect(u.documents.map((d) => [d.documentId, d.quantityMilli])).toEqual([
      ["d5", 7_000], // the draft (no date) first
      ["d3", -1_000],
      ["d1", 3_000],
      ["d4", 9_000],
      ["d6", 1_000],
      ["d2", 5_000],
      ["d7", 2_000],
    ]);
  });
});
