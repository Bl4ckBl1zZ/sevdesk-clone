import { makeContact, makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import type { ChainAdvance } from "./advances";
import { buildSnapshot } from "./build-snapshot";
import type { DocumentContext, DraftDocument } from "./draft";
import { buildSnapshotInput } from "./finalize";
import { type ChainContext, groupsOfSnapshot, type OriginalContext } from "./relations";
import { validateDocument } from "./validate";

const S19 = (net: number) => ({
  category: "S" as const,
  rateBp: 1900,
  netCents: net,
  vatCents: Math.round(net * 0.19),
});

const chain = (patch: Partial<ChainContext> = {}): ChainContext => ({
  rootId: "ab1",
  orderLabel: { de: "Auftrag", en: "order" },
  orderNumber: "AB-2026-0007",
  orderDate: "2026-08-03",
  index: 1,
  earlierAdvances: [],
  final: { advances: [] },
  ...patch,
});

const advance = (patch: Partial<ChainAdvance> = {}): ChainAdvance => ({
  id: "ar1",
  type: "advance_invoice",
  number: "RE-2026-0031",
  date: "2026-08-10",
  status: "sent",
  currency: "EUR",
  taxCase: "domestic",
  openCents: 0,
  groups: [S19(30_000)],
  corrections: [],
  differences: [],
  paidOn: "2026-08-20",
  ...patch,
});

const original = (patch: Partial<OriginalContext> = {}): OriginalContext => {
  const snap = makeSnapshot();
  return {
    id: "re1",
    type: "invoice",
    status: "sent",
    number: "RE-2026-0042",
    documentDate: "2026-10-01",
    currency: "EUR",
    groups: [S19(95_000)],
    hadXml: false,
    format: "none",
    er03RefDate: "2026-10-01",
    earlierCredits: [],
    earlierCorrections: [],
    snapshot: snap,
    ...patch,
  };
};

const ctxWith = (relations: DocumentContext["relations"], patch: Partial<DocumentContext> = {}) =>
  makeContext({ relations, ...patch });

const codes = (draft: DraftDocument, ctx: DocumentContext) => validateDocument(draft, ctx).findings.map((f) => f.code);

function snapshotOf(draft: DraftDocument, ctx: DocumentContext, number = "RE-2026-0050") {
  const v = validateDocument(draft, ctx);
  const s = buildSnapshot(
    buildSnapshotInput(draft, ctx, v.resolved, {
      number,
      documentDate: v.resolved.documentDate,
      layoutVersionId: "layout-v1",
      plan: v.einvoice,
    }),
  );
  if (!s.ok) throw new Error(s.error.code);
  return s.value;
}

describe("advance and final invoices in the validator and snapshot (F04 §5.1.6)", () => {
  test("INV-03 an advance without an order reference is blocked (chain_reference_missing)", () => {
    expect(codes(makeDraft({ type: "advance_invoice" }), makeContext())).toContain("chain_reference_missing");
  });

  test("INV-03 T-INV-003 the advance snapshot states the chain index and the order (advance_info)", () => {
    const s = snapshotOf(makeDraft({ type: "advance_invoice" }), ctxWith({ chain: chain({ index: 2 }) }));
    expect(s.flags.chainIndex).toBe(2);
    expect(s.notes.map((n) => n.id)).toContain("advance_info");
    expect(s.notes.find((n) => n.id === "advance_info")?.de).toContain("2. Abschlagsrechnung zu Auftrag AB-2026-0007");
  });

  test("UST-41 §4.7 advances take the rate at their document date and warn about the expected supply date (advance_rate_differs)", () => {
    const draft = makeDraft({
      type: "advance_invoice",
      documentDate: "2025-12-20",
      backdateReason: "Nachtrag",
      supplyDate: { kind: "date", date: "2026-02-01" },
      lines: [serviceLine({ vatRateKey: "restaurant_food" })],
    });
    const v = validateDocument(draft, ctxWith({ chain: chain() }));
    expect(v.resolved.lines[0]?.vatRateBp).toBe(1900);
    expect(v.findings.map((f) => f.code)).toContain("advance_rate_differs");
  });

  test("INV-04 EC-078 a partial invoice above the order per group is blocked", () => {
    const draft = makeDraft({ type: "partial_invoice" });
    const ctx = ctxWith({ chain: chain({ orderGroups: [S19(100_000)], earlierAdvances: [[S19(50_000)]] }) });
    expect(codes(draft, ctx)).toContain("partial_exceeds_order");
  });

  test("INV-07 EC-071 the final invoice is blocked while an advance has an open amount", () => {
    const draft = makeDraft({ type: "final_invoice" });
    const ctx = ctxWith({ chain: chain({ final: { advances: [advance({ openCents: 10_000 })] } }) });
    expect(codes(draft, ctx)).toContain("advance_not_settled");
  });

  test("INV-06 INV-09 the final snapshot deducts each settled advance with BG-3 references and BT-113", () => {
    const draft = makeDraft({ type: "final_invoice" });
    const ctx = ctxWith({ chain: chain({ index: 2, final: { advances: [advance()] } }) });
    expect(validateDocument(draft, ctx).findings.filter((f) => f.severity === "E")).toEqual([]);
    const s = snapshotOf(draft, ctx);
    expect(s.deductions?.[0]).toMatchObject({ advanceNumber: "RE-2026-0031", deductedGrossCents: 35_700 });
    expect(s.totals.advancesDeductedGrossCents).toBe(35_700);
    expect(s.totals.payableCents).toBe(113_050 - 35_700);
    expect(s.references.precedingInvoices).toContainEqual({
      number: "RE-2026-0031",
      date: "2026-08-10",
      role: "advance",
    });
  });
});

describe("corrections in the validator and snapshot (INV-12/13, RI-07)", () => {
  const credit = (patch: Partial<DraftDocument> = {}) =>
    makeDraft({
      type: "correction",
      correctionKind: "credit",
      lines: [serviceLine({ quantityMilli: -2_000 })],
      ...patch,
    });

  test("UST-30 a correction without original is blocked (original_reference_missing)", () => {
    expect(codes(credit(), makeContext())).toContain("original_reference_missing");
  });

  test("INV-12 T-EC-065 a credit beyond the original is blocked (RI-07)", () => {
    const ctx = ctxWith({ original: original({ earlierCredits: [[S19(-90_000)]] }) });
    expect(codes(credit(), ctx)).toContain("correction_exceeds_original");
  });

  test("INV-12 the credit snapshot references the original and is TypeCode-381 material (credit_info)", () => {
    const s = snapshotOf(credit(), ctxWith({ original: original() }), "RE-2026-0051");
    expect(s.type).toBe("correction");
    expect(s.correctionKind).toBe("credit");
    expect(s.totals.grossCents).toBe(-22_610);
    expect(s.references.precedingInvoices).toContainEqual({
      number: "RE-2026-0042",
      date: "2026-10-01",
      role: "original",
    });
    expect(s.notes.map((n) => n.id)).toContain("credit_info");
  });

  test("UST-30 a correction may not be dated before the original (date_before_original)", () => {
    const ctx = ctxWith({ original: original({ documentDate: "2026-10-12" }) });
    expect(codes(credit({ documentDate: "2026-10-11", backdateReason: "x" }), ctx)).toContain("date_before_original");
  });

  test("ER-03 R1 the correction of an E-Rechnung is an E-Rechnung in the original's format", () => {
    const ctx = ctxWith({ original: original({ hadXml: true, format: "xrechnung_cii" }) });
    const v = validateDocument(credit(), ctx);
    expect(v.einvoice.er03.decision).toBe("MUST_E");
    expect(v.einvoice.format).toBe("xrechnung_cii");
  });

  test("INV-13 a Berichtigung without a changed item is blocked; a changed VAT ID is listed in German", () => {
    const base = snapshotOf(makeDraft(), makeContext(), "RE-2026-0042");
    const orig = original({ snapshot: base, groups: groupsOfSnapshot(base) });
    const rect = makeDraft({ type: "correction", correctionKind: "rectification" });
    expect(codes(rect, ctxWith({ original: orig }))).toContain("rectification_no_change");
    const changed = ctxWith(
      { original: orig },
      { contact: makeContact({ buyer: { ...base.buyer, vatId: "DE136695976" }, vatId: "DE136695976" }) },
    );
    expect(validateDocument(rect, changed).findings.filter((f) => f.severity === "E")).toEqual([]);
    const s = snapshotOf(rect, changed, "RE-2026-0052");
    expect(s.correctionKind).toBe("rectification");
    expect(s.rectifiedFields).toEqual(["USt-IdNr. des Leistungsempfängers"]);
  });

  test("UST-31 a Berichtigung may not change amounts (rectification_amount_changed)", () => {
    const rect = makeDraft({ type: "correction", correctionKind: "rectification" });
    const ctx = ctxWith({ original: original({ groups: [S19(50_000)] }) });
    expect(codes(rect, ctx)).toContain("rectification_amount_changed");
  });
});
