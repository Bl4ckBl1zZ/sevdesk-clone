import { describe, expect, test } from "vitest";
import type { DuplicateSource } from "./duplicate";
import { lastDocumentContent, pickLastDocument } from "./last-document";

const src = {
  type: "invoice",
  contactId: "c1",
  supplyDate: { kind: "date", date: "2026-09-30" },
  supplyDateMode: "explicit",
  documentDate: "2026-10-01",
  currency: "EUR",
  priceMode: "net",
  subject: "Wartung Oktober",
  headText: "Vielen Dank für Ihren Auftrag.",
  footText: "Zahlbar ohne Abzug.",
  paymentTerms: { dueDays: 14 },
  showEpcQr: true,
  language: "de",
  orderReference: "PO-4711",
  lines: [
    {
      kind: "item",
      productId: "p1",
      productSyncedVersion: 3,
      sourceLineId: "x1",
      linePeriod: { from: "2026-09-01", to: "2026-09-30" },
      name: "Wartung",
      quantityMilli: 2000,
      unitCode: "HUR",
      unitPriceMicros: 1_000_000,
      vatRateKey: "standard",
    },
    { kind: "text", name: "Hinweis" },
  ],
} as unknown as DuplicateSource;

describe("DOC-36 „Letztes Dokument übernehmen“", () => {
  test("DOC-36 T-DOC-041 copies the lines and texts only (no dates, references or line periods)", () => {
    const c = lastDocumentContent(src);
    expect(c).toEqual({
      lines: [
        {
          kind: "item",
          productId: "p1",
          name: "Wartung",
          quantityMilli: 2000,
          unitCode: "HUR",
          unitPriceMicros: 1_000_000,
          vatRateKey: "standard",
        },
        { kind: "text", name: "Hinweis" },
      ],
      subject: "Wartung Oktober",
      headText: "Vielen Dank für Ihren Auftrag.",
      footText: "Zahlbar ohne Abzug.",
    });
    expect(JSON.stringify(c)).not.toContain("PO-4711");
    expect(JSON.stringify(c)).not.toContain("2026-09");
  });

  test("DOC-36 Storno and corrections are never offered as the source", () => {
    expect(lastDocumentContent({ ...src, type: "cancellation" })).toBeNull();
    expect(lastDocumentContent({ ...src, type: "correction" })).toBeNull();
  });

  test("DOC-36 the last document is the newest finalised one; drafts, cancelled and withdrawn ones are skipped", () => {
    const d = (id: string, status: string, documentDate: string, createdAt: number) => ({
      id,
      status,
      documentDate,
      createdAt,
    });
    const docs = [
      d("a", "sent", "2026-09-01", 1),
      d("b", "accepted", "2026-10-01", 2),
      d("c", "draft", "2026-10-11", 5),
      d("d", "cancelled", "2026-10-05", 3),
      d("e", "withdrawn", "2026-10-06", 4),
      d("f", "finalized", "2026-10-01", 6),
    ];
    expect(pickLastDocument(docs)?.id).toBe("f");
    expect(pickLastDocument(docs.filter((x) => x.id !== "f"))?.id).toBe("b");
    expect(pickLastDocument([d("c", "draft", "2026-10-11", 5)])).toBeNull();
  });
});
