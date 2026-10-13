import { describe, expect, test } from "vitest";
import { type ChainDoc, chainProgress, progressEvent, remainingQuantities } from "./progress";

const order: ChainDoc = {
  id: "ord",
  type: "order_confirmation",
  status: "sent",
  number: "AB-2026-0001",
  sent: true,
  lines: [
    { id: "o1", kind: "item", quantityMilli: 10_000, lineNetCents: 800_000 },
    { id: "o2", kind: "item", quantityMilli: 1_000, lineNetCents: 200_000 },
  ],
};

const invoice = (id: string, qty: number, over: Partial<ChainDoc> = {}): ChainDoc => ({
  id,
  type: "invoice",
  status: "finalized",
  number: `RE-${id}`,
  originId: "ord",
  lines: [{ id: `${id}-1`, kind: "item", quantityMilli: qty, sourceLineId: "o1" }],
  ...over,
});

describe("invoicing progress (F04 §4.3.3)", () => {
  test("QUO-13 INV-32 T-QUO-008 half the quantities → partially_invoiced; after the Storno back to the base status", () => {
    const p = chainProgress([order, invoice("i1", 5_000)]);
    expect(p.get("ord")?.progress).toBe("partial");
    expect(p.get("ord")?.lines.get("o1")?.invoicedQtyMilli).toBe(5_000);
    expect(p.get("ord")?.coveredBp).toBe(4_000);
    expect(progressEvent(order, "partial")).toBe("invoiced_partially");
    const cancelled = chainProgress([
      { ...order, status: "partially_invoiced" },
      invoice("i1", 5_000, { status: "cancelled" }),
    ]);
    expect(cancelled.get("ord")?.progress).toBe("none");
    expect(progressEvent({ ...order, status: "partially_invoiced" }, "none")).toBe("invoice_reverted");
    expect(progressEvent({ ...order, status: "partially_invoiced", sent: false }, "none")).toBe(
      "invoice_reverted_unsent",
    );
  });

  test("QUO-13 coverage is 100 % when every line is billed, or when a final invoice exists", () => {
    const full = chainProgress([
      order,
      invoice("i1", 10_000),
      { ...invoice("i2", 1_000), lines: [{ id: "i2-1", kind: "item", quantityMilli: 1_000, sourceLineId: "o2" }] },
    ]);
    expect(full.get("ord")).toMatchObject({ progress: "full", coveredBp: 10_000 });
    const final = chainProgress([order, { ...invoice("f", 0), type: "final_invoice", lines: [] }]);
    expect(final.get("ord")?.progress).toBe("full");
    expect(progressEvent(order, "full")).toBe("invoiced_fully");
    expect(progressEvent({ ...order, status: "invoiced" }, "full")).toBeNull();
  });

  test("QUO-10 T-QUO-005 INV-05 T-INV-027 after delivering/billing 4 of 10 units the next conversion proposes 6", () => {
    const delivery: ChainDoc = {
      id: "dn",
      type: "delivery_note",
      status: "finalized",
      originId: "ord",
      lines: [{ id: "dn-1", kind: "item", quantityMilli: 4_000, sourceLineId: "o1" }],
    };
    const p = chainProgress([order, delivery]);
    expect(remainingQuantities(p, order, "delivered")).toEqual({ o1: 6_000, o2: 1_000 });
    expect(remainingQuantities(p, order, "invoiced")).toEqual({ o1: 10_000, o2: 1_000 });
    const billed = chainProgress([order, invoice("i1", 4_000)]);
    expect(remainingQuantities(billed, order, "invoiced").o1).toBe(6_000);
  });

  test("QUO-11 quantities of a collective invoice climb delivery note → order → quote and mark the notes invoiced", () => {
    const quote: ChainDoc = {
      id: "quo",
      type: "quote",
      status: "accepted",
      lines: [{ id: "q1", kind: "item", quantityMilli: 10_000, lineNetCents: 1_000 }],
    };
    const ord: ChainDoc = {
      ...order,
      originId: "quo",
      lines: [{ id: "o1", kind: "item", quantityMilli: 10_000, sourceLineId: "q1" }],
    };
    const dn = (id: string, qty: number): ChainDoc => ({
      id,
      type: "delivery_note",
      status: "sent",
      sent: true,
      number: id,
      originId: "ord",
      lines: [{ id: `${id}-1`, kind: "item", quantityMilli: qty, sourceLineId: "o1" }],
    });
    const collective: ChainDoc = {
      id: "inv",
      type: "invoice",
      status: "finalized",
      number: "RE-2026-0001",
      sourceDocumentIds: ["dn1", "dn2"],
      lines: [
        { id: "inv-1", kind: "item", quantityMilli: 4_000, sourceLineId: "dn1-1" },
        { id: "inv-2", kind: "item", quantityMilli: 6_000, sourceLineId: "dn2-1" },
      ],
    };
    const p = chainProgress([quote, ord, dn("dn1", 4_000), dn("dn2", 6_000), collective]);
    expect(p.get("quo")?.progress).toBe("full");
    expect(p.get("ord")?.lines.get("o1")).toEqual({ invoicedQtyMilli: 10_000, deliveredQtyMilli: 10_000 });
    expect(p.get("dn1")).toMatchObject({ progress: "full", invoicedBy: ["RE-2026-0001"] });
    expect(progressEvent(dn("dn1", 4_000), "full")).toBe("invoiced_fully");
    expect(progressEvent({ ...dn("dn1", 4_000), status: "invoiced", received: true }, "none")).toBe("invoice_reverted");
    expect(progressEvent({ ...dn("dn1", 4_000), status: "invoiced" }, "none")).toBe("invoice_reverted_sent");
  });

  test("QUO-12 a finalised invoice converted from a proforma marks the proforma invoiced", () => {
    const pf: ChainDoc = {
      id: "pf",
      type: "proforma",
      status: "sent",
      lines: [{ id: "p1", kind: "item", quantityMilli: 1 }],
    };
    const inv: ChainDoc = { id: "i", type: "invoice", status: "finalized", originId: "pf", lines: [] };
    const p = chainProgress([pf, inv]);
    expect(progressEvent(pf, p.get("pf")?.progress ?? "none")).toBe("invoiced_fully");
    expect(chainProgress([pf, { ...inv, status: "draft" }]).get("pf")?.progress).toBe("none");
  });
});
