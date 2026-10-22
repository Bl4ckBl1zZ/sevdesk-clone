import { describe, expect, test } from "vitest";
import { groupCostCenter } from "./cost-centers";
import type { InvoiceFinalisedEvent } from "./events";
import { postEvent } from "./post";

const ids = { "100": "cc_a", "200": "cc_b" };

describe("ACC-019 cost centres on sales postings", () => {
  test("ACC-019 a VAT group gets the cost centre when all its item lines share one (line or document KST); mixed groups get none", () => {
    const items = [
      { vatCategory: "S" as const, vatRateBp: 1900, costCenter: "100" },
      { vatCategory: "S" as const, vatRateBp: 1900, costCenter: "100" },
      { vatCategory: "S" as const, vatRateBp: 700, costCenter: "100" },
      { vatCategory: "S" as const, vatRateBp: 700, costCenter: "200" },
      { vatCategory: "E" as const, vatRateBp: 0 },
    ];
    expect(groupCostCenter(items, ids, "S", 1900)).toBe("cc_a");
    expect(groupCostCenter(items, ids, "S", 700)).toBeUndefined();
    expect(groupCostCenter(items, ids, "E", 0)).toBeUndefined();
    // unknown number (archived/renamed centre): no guess
    expect(groupCostCenter([{ vatCategory: "S", vatRateBp: 1900, costCenter: "999" }], ids, "S", 1900)).toBeUndefined();
  });

  test("ACC-019 the revenue line of a group carries its cost centre; VAT and the receivable do not", () => {
    const e: InvoiceFinalisedEvent = {
      kind: "invoice_finalised",
      documentId: "d1",
      documentNumber: "RE-2026-0001",
      documentType: "invoice",
      date: "2026-03-10",
      supplyDate: { kind: "date", date: "2026-03-10" },
      taxCase: "domestic",
      contactId: "c1",
      vatGroups: [
        { category: "S", rateBp: 1900, netCents: 10_000, vatCents: 1900, costCenterId: "cc_a" },
        { category: "S", rateBp: 700, netCents: 5000, vatCents: 350 },
      ],
    };
    const r = postEvent(e, { taxationMethod: "soll", legalForm: "einzelunternehmen", ustvaPeriod: [] });
    if (!r.ok || r.value.kind !== "entry") throw new Error(JSON.stringify(r));
    const lines = r.value.posting.lines;
    const tagged = lines.filter((l) => l.costCenterId);
    expect(tagged).toHaveLength(1);
    expect(tagged[0]).toMatchObject({ creditCents: 10_000, costCenterId: "cc_a" });
  });
});
