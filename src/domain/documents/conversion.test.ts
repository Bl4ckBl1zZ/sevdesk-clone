import { describe, expect, test } from "vitest";
import {
  CONVERSION_MATRIX,
  type CollectiveSource,
  checkAcceptance,
  checkCollective,
  checkConversion,
  checkRevision,
  collectiveInvoice,
  convertDocument,
  quoteDeadlines,
  reviseQuote,
  revisionNumber,
  type SourceLine,
} from "./conversion";
import { SALES_DOC_STATUSES } from "./lifecycle";
import type { SalesDocType } from "./snapshot";

const ALL_TYPES: SalesDocType[] = [
  "quote",
  "order_confirmation",
  "delivery_note",
  "proforma",
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
];

const header = {
  contactId: "c1",
  supplyDateMode: "explicit" as const,
  currency: "EUR",
  priceMode: "net" as const,
  paymentTerms: { dueDays: 14 },
  showEpcQr: true,
  language: "de" as const,
  orderReference: "PO-1",
  headText: "Gerne bieten wir an:",
  deliveryTerms: "frei Haus",
};

const lines: SourceLine[] = [
  { id: "h", kind: "heading", name: "Konzeption" },
  { id: "a", kind: "item", name: "Beratung", quantityMilli: 10_000, unitCode: "HUR", unitPriceMicros: 1_000_000 },
  {
    id: "o",
    kind: "item",
    name: "SEO",
    quantityMilli: 8_000,
    unitCode: "HUR",
    unitPriceMicros: 1_000_000,
    optional: true,
  },
];

describe("conversions (F04 §4.3)", () => {
  test("DOC-33 T-DOC-022 every (source, target) pair of the matrix is allowed, every other pair fails conversion_not_allowed", () => {
    for (const source of ALL_TYPES) {
      for (const target of ALL_TYPES) {
        const r = checkConversion({ type: source, status: "finalized", number: "X-1" }, target);
        const allowed = CONVERSION_MATRIX[source]?.includes(target) ?? false;
        if (allowed) expect(r.ok, `${source} → ${target}`).toBe(true);
        else expect(r.ok ? "ok" : r.error.code, `${source} → ${target}`).toBe("conversion_not_allowed");
      }
    }
    expect(CONVERSION_MATRIX.delivery_note).toEqual(["invoice"]);
    expect(CONVERSION_MATRIX.proforma).toEqual(["invoice"]);
    expect(CONVERSION_MATRIX.invoice).toEqual(["delivery_note"]);
  });

  test("DOC-33 drafts cannot be converted (source_not_finalized); withdrawn, replaced and rejected sources neither", () => {
    expect(checkConversion({ type: "quote", status: "draft" }, "invoice")).toMatchObject({
      ok: false,
      error: { code: "source_not_finalized" },
    });
    for (const status of ["cancelled", "superseded", "rejected"] as const) {
      const r = checkConversion({ type: "quote", status, number: "AN-1" }, "invoice");
      expect(r.ok ? "ok" : r.error.code).toBe("conversion_not_allowed");
    }
  });

  test("QUO-05 §4.2.1 converting an unaccepted quote into an order or invoice records the acceptance first", () => {
    expect(checkConversion({ type: "quote", status: "sent" }, "order_confirmation")).toEqual({
      ok: true,
      value: { acceptEvent: "accept" },
    });
    expect(checkConversion({ type: "quote", status: "expired" }, "invoice")).toEqual({
      ok: true,
      value: { acceptEvent: "accept_late" },
    });
    expect(checkConversion({ type: "quote", status: "accepted" }, "invoice")).toEqual({ ok: true, value: {} });
    expect(checkConversion({ type: "quote", status: "sent" }, "delivery_note")).toEqual({ ok: true, value: {} });
  });

  test("QUO-12 EC-DOC-102 T-EC-102 an invoiced proforma cannot be converted a second time", () => {
    const r = checkConversion({ type: "proforma", status: "invoiced", number: "PF-2026-0001" }, "invoice");
    expect(r).toMatchObject({ ok: false, error: { code: "source_already_invoiced" } });
  });

  test("QUO-02 §4.3.2 lines are copied with source references; optional lines only if chosen, without the flag", () => {
    const d = convertDocument({ type: "quote", ...header, lines }, "order_confirmation", { optionalLineIds: ["o"] });
    expect(d.type).toBe("order_confirmation");
    expect(d.lines).toEqual([
      { kind: "heading", name: "Konzeption" },
      {
        kind: "item",
        name: "Beratung",
        quantityMilli: 10_000,
        unitCode: "HUR",
        unitPriceMicros: 1_000_000,
        sourceLineId: "a",
      },
      {
        kind: "item",
        name: "SEO",
        quantityMilli: 8_000,
        unitCode: "HUR",
        unitPriceMicros: 1_000_000,
        sourceLineId: "o",
      },
    ]);
    const without = convertDocument({ type: "quote", ...header, lines }, "invoice");
    expect(without.lines.filter((l) => l.kind === "item").map((l) => l.sourceLineId)).toEqual(["a"]);
    expect(without.orderReference).toBe("PO-1");
    expect(without.deliveryTerms).toBeUndefined();
  });

  test("QUO-10 INV-05 the conversion proposes the remaining quantities; quantity mode takes only the given ones", () => {
    const d = convertDocument({ type: "order_confirmation", ...header, lines }, "delivery_note", {
      remaining: { a: 6_000 },
    });
    expect(d.lines.find((l) => l.kind === "item")?.quantityMilli).toBe(6_000);
    expect(d.supplyDateMode).toBe("document_date");
    const q = convertDocument({ type: "order_confirmation", ...header, lines }, "invoice", {
      mode: "quantities",
      quantities: { a: 4_000 },
    });
    expect(q.lines.filter((l) => l.kind === "item")).toEqual([expect.objectContaining({ quantityMilli: 4_000 })]);
    const done = convertDocument({ type: "order_confirmation", ...header, lines }, "invoice", { remaining: { a: 0 } });
    expect(done.lines.filter((l) => l.kind === "item")).toEqual([]);
  });

  test("§4.3.2 number, dates, FX rate and validity are never copied; the supply date is copied when set", () => {
    const d = convertDocument(
      {
        type: "quote",
        ...header,
        documentDate: "2026-10-01",
        validUntil: "2026-10-31",
        fxRateToEur: { rate: "1.1", source: "manual", date: "2026-10-01" },
        supplyDate: { kind: "date", date: "2026-10-09" },
        lines,
      },
      "invoice",
    );
    expect(d).not.toHaveProperty("documentDate");
    expect(d).not.toHaveProperty("validUntil");
    expect(d).not.toHaveProperty("fxRateToEur");
    expect(d.supplyDate).toEqual({ kind: "date", date: "2026-10-09" });
  });
});

describe("collective invoice (QUO-11)", () => {
  const note = (id: string, number: string, date: string, over: Partial<CollectiveSource> = {}): CollectiveSource => ({
    id,
    type: "delivery_note",
    status: "finalized",
    number,
    taxCase: "domestic",
    deliveryDate: date,
    ...header,
    lines: [
      {
        id: `${id}-1`,
        kind: "item",
        name: `Ware ${number}`,
        quantityMilli: 1_000,
        unitCode: "C62",
        unitPriceMicros: 50_000,
      },
    ],
    ...over,
  });

  test("QUO-11 UST-08 T-QUO-006 one heading per delivery note, dated lines and the supply period earliest–latest", () => {
    const d = collectiveInvoice([
      note("b", "LS-2026-0002", "2026-10-10"),
      note("a", "LS-2026-0001", "2026-10-03"),
      note("c", "LS-2026-0003", "2026-10-17"),
    ]);
    expect(d.type).toBe("invoice");
    expect(d.supplyDate).toEqual({ kind: "period", from: "2026-10-03", to: "2026-10-17" });
    expect(d.lines.filter((l) => l.kind === "heading").map((l) => l.name)).toEqual([
      "Lieferschein LS-2026-0001 vom 03.10.2026",
      "Lieferschein LS-2026-0002 vom 10.10.2026",
      "Lieferschein LS-2026-0003 vom 17.10.2026",
    ]);
    expect(d.lines[1]).toMatchObject({ sourceLineId: "a-1", linePeriod: { from: "2026-10-03", to: "2026-10-03" } });
  });

  test("QUO-11 collective_mismatch when contact, currency, tax case or price mode differ", () => {
    expect(checkCollective([note("a", "LS-1", "2026-10-03"), note("b", "LS-2", "2026-10-04")]).ok).toBe(true);
    const r = checkCollective([note("a", "LS-1", "2026-10-03"), note("b", "LS-2", "2026-10-04", { currency: "USD" })]);
    expect(r).toMatchObject({ ok: false, error: { code: "collective_mismatch" } });
    const t = checkCollective([note("a", "LS-1", "2026-10-03"), note("b", "LS-2", "2026-10-04", { contactId: "c2" })]);
    expect(t).toMatchObject({ ok: false, error: { code: "collective_mismatch", params: { field: "Kunde" } } });
  });
});

describe("quote revisions, expiry and acceptance", () => {
  test("QUO-06 T-QUO-004 the suffix numbering appends -V{n} to the base number", () => {
    expect(revisionNumber("AN-2026-0007", 2)).toBe("AN-2026-0007-V2");
  });

  test("QUO-06 the revision copies the full content incl. optional lines but no validity or dates", () => {
    const d = reviseQuote({ ...header, validUntil: "2026-11-01", lines });
    expect(d.type).toBe("quote");
    expect(d).not.toHaveProperty("validUntil");
    expect(d.lines.map((l) => l.optional ?? false)).toEqual([false, false, true]);
  });

  test("QUO-07 EC-079 EC-DOC-71 T-EC-071 an accepted quote cannot be revised (quote_accepted_frozen)", () => {
    for (const status of ["accepted", "partially_invoiced", "invoiced"] as const) {
      expect(checkRevision({ type: "quote", status })).toMatchObject({
        ok: false,
        error: { code: "quote_accepted_frozen" },
      });
    }
    for (const status of ["finalized", "sent", "rejected", "expired"] as const) {
      expect(checkRevision({ type: "quote", status }).ok).toBe(true);
    }
    for (const status of SALES_DOC_STATUSES.filter((s) => s === "superseded" || s === "cancelled")) {
      expect(checkRevision({ type: "quote", status }).ok).toBe(false);
    }
  });

  test("QUO-04 T-QUO-002 quotes past validUntil expire; 3 days before expiry a reminder is due", () => {
    const r = quoteDeadlines(
      [
        { id: "past", status: "sent", validUntil: "2026-10-11" },
        { id: "soon", status: "finalized", validUntil: "2026-10-15" },
        { id: "later", status: "sent", validUntil: "2026-10-16" },
        { id: "accepted", status: "accepted", validUntil: "2026-10-01" },
        { id: "today", status: "sent", validUntil: "2026-10-12" },
      ],
      "2026-10-12",
    );
    expect(r).toEqual({ expire: ["past"], remind: ["soon", "today"] });
  });

  test("QUO-05 an expired quote is accepted only with the explicit late confirmation", () => {
    const input = { date: "2026-10-12", byName: "Max Beispiel", channel: "phone" as const };
    expect(checkAcceptance({ status: "sent" }, input, "2026-10-12")).toEqual({ ok: true, value: "accept" });
    expect(checkAcceptance({ status: "expired", validUntil: "2026-10-01" }, input, "2026-10-12")).toMatchObject({
      ok: false,
      error: { code: "quote_expired_notice" },
    });
    expect(checkAcceptance({ status: "expired" }, { ...input, late: true }, "2026-10-12")).toEqual({
      ok: true,
      value: "accept_late",
    });
    expect(checkAcceptance({ status: "sent" }, { ...input, date: "2026-10-13" }, "2026-10-12").ok).toBe(false);
  });
});
