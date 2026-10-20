import { describe, expect, test } from "vitest";
import { checkStockCaches, checkTimeEntryLocks } from "./invariants";

describe("P4 invariants", () => {
  test("RI-30 PRD-090 the stock cache equals Σ movements; corrections reverse exactly", () => {
    const movements = [
      { id: "m1", productId: "p1", quantityMilli: 5000 },
      { id: "m2", productId: "p1", quantityMilli: -2000 },
      { id: "m3", productId: "p1", quantityMilli: 2000, reversesId: "m2" },
    ];
    expect(checkStockCaches([{ id: "p1", label: "ART-1", quantityMilli: 5000 }], movements)).toEqual([]);
    expect(checkStockCaches([{ id: "p1", label: "ART-1", quantityMilli: 4000 }], movements)[0]?.message).toBe(
      "Bestand von ART-1 (4000) weicht von der Summe der Buchungen (5000) ab.",
    );
    expect(
      checkStockCaches(
        [{ id: "p1", label: "ART-1", quantityMilli: 5000 }],
        [...movements.slice(0, 2), { id: "m3", productId: "p1", quantityMilli: 1000, reversesId: "m2" }],
      ).map((f) => f.id),
    ).toEqual(["RI-30", "RI-30"]);
    expect(checkStockCaches([{ id: "p2", label: "ART-2" }], [])).toEqual([]);
  });

  test("RI-31 PRJ-012 PRJ-019 invoiced entries sit on a line of a finalised invoice with its retention; in_draft ones in a draft", () => {
    const lines = new Map([
      ["l1", { documentId: "d1", timeEntryIds: ["e1"] }],
      ["l2", { documentId: "d2", timeEntryIds: ["e2"] }],
    ]);
    const docs = new Map([
      ["d1", { status: "finalized", retentionUntil: "2034-12-31", lineEntryIds: new Set(["e1"]) }],
      ["d2", { status: "draft", lineEntryIds: new Set(["e2"]) }],
    ]);
    const ok = [
      {
        id: "e1",
        status: "invoiced" as const,
        invoicedLineId: "l1",
        invoicedDocumentId: "d1",
        lockedAt: 1,
        retentionUntil: "2034-12-31",
      },
      { id: "e2", status: "in_draft" as const, draftDocumentId: "d2" },
      { id: "e3", status: "open" as const },
    ];
    expect(checkTimeEntryLocks(ok, lines, docs)).toEqual([]);
    const broken = checkTimeEntryLocks(
      [
        { id: "e4", status: "invoiced", invoicedLineId: "l9" },
        { id: "e5", status: "invoiced", invoicedLineId: "l2", invoicedDocumentId: "d2" },
        { id: "e1", status: "invoiced", invoicedLineId: "l1", invoicedDocumentId: "d1" },
        { id: "e6", status: "in_draft", draftDocumentId: "d1" },
      ],
      lines,
      docs,
    );
    expect(broken.map((f) => f.message)).toEqual([
      "Zeiteintrag e4: abgerechnet ohne passende Rechnungsposition.",
      "Zeiteintrag e5: abgerechnet ohne passende Rechnungsposition.",
      "Zeiteintrag e1: abgerechnet ohne Sperre oder Aufbewahrungsfrist der Rechnung.",
      "Zeiteintrag e6: als „Im Entwurf“ markiert, aber in keinem Rechnungsentwurf enthalten.",
    ]);
    expect(
      checkTimeEntryLocks(
        [{ id: "e2", status: "invoiced", invoicedLineId: "l2", invoicedDocumentId: "d2", lockedAt: 1 }],
        new Map([["l2", { documentId: "d2", timeEntryIds: ["e2"] }]]),
        docs,
      )[0]?.message,
    ).toBe("Zeiteintrag e2: abgerechnet, aber die Rechnung ist nicht fertiggestellt.");
  });
});
