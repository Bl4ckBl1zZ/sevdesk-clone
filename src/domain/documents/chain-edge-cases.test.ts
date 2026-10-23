/**
 * F04 §5.2 edge cases of conversions, chains and corrections (T-EC-019, 026, 045, 047, 050, 064, 107): draft →
 * validator → snapshot (→ XML) with the chain/original contexts the model layer reads.
 */
import { BUYERS, makeContact, makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { serializeEinvoice } from "../einvoice/serialize";
import { girocodeFor } from "../epc/girocode";
import type { ChainAdvance } from "./advances";
import { buildSnapshot } from "./build-snapshot";
import { convertDocument, type SourceLine } from "./conversion";
import { correctionTargetGuard } from "./corrections";
import type { DocumentContext, DraftDocument } from "./draft";
import { buildSnapshotInput } from "./finalize";
import type { ChainContext, OriginalContext } from "./relations";
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

const original = (patch: Partial<OriginalContext> = {}): OriginalContext => ({
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
  snapshot: makeSnapshot(),
  ...patch,
});

const findings = (draft: DraftDocument, ctx: DocumentContext) => validateDocument(draft, ctx).findings;
const errors = (draft: DraftDocument, ctx: DocumentContext) =>
  findings(draft, ctx)
    .filter((f) => f.severity === "E")
    .map((f) => f.code);

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

const consumer = makeContact({ isConsumer: true, buyer: BUYERS.consumer, vatId: undefined });

describe("conversions across a rate change or a changed contact (EC-DOC-19, EC-DOC-26)", () => {
  const quoteLines: SourceLine[] = [
    {
      id: "q1",
      kind: "item",
      productType: "service",
      name: "Catering Firmenfeier",
      quantityMilli: 1_000,
      unitCode: "LS",
      unitPriceMicros: 10_000_000,
      vatRateKey: "restaurant_food",
      vatCategory: "S",
      vatRateBp: 1900,
    },
  ];
  const quote = {
    ...makeDraft({ type: "quote", supplyDate: { kind: "date", date: "2025-12-10" } }),
    lines: quoteLines,
  };

  test("EC-DOC-19 T-EC-019 the invoice re-resolves the rate by its own supply date with a notice; the quote stays at 19 %", () => {
    const quoteCtx = makeContext({ today: "2025-11-20" as DocumentContext["today"] });
    const quoteSnap = snapshotOf({ ...quote, documentDate: "2025-11-20" }, quoteCtx, "AN-2025-0003");
    expect(quoteSnap.totals.byGroup.map((g) => g.rateBp)).toEqual([1900]);
    const before = JSON.stringify(quoteSnap);

    const converted = convertDocument(quote, "invoice");
    const invoice = { ...converted, supplyDate: { kind: "date" as const, date: "2026-01-20" } };
    const v = validateDocument(invoice, makeContext());
    expect(v.resolved.lines[0]?.vatRateBp).toBe(700);
    expect(v.findings.find((f) => f.code === "rate_changed_notice")?.message).toBe(
      "Steuersatz geändert: 19 % → 7 % (Leistungsdatum 20.01.2026).",
    );
    expect(snapshotOf(invoice, makeContext()).totals.byGroup.map((g) => g.rateBp)).toEqual([700]);
    expect(JSON.stringify(quoteSnap)).toBe(before);
  });

  test("EC-DOC-26 T-EC-026 business → consumer between quote and invoice: the invoice follows the current flag (notices, §286 note)", () => {
    const businessQuote = { ...makeDraft({ type: "quote" }), lines: [{ ...serviceLine(), id: "q1" }] };
    const converted = convertDocument(businessQuote, "invoice");
    const asBusiness = validateDocument(converted, makeContext());
    expect(asBusiness.findings.map((f) => f.code)).not.toContain("consumer_net_prices");

    const ctx = makeContext({ contact: consumer });
    const v = validateDocument(converted, ctx);
    expect(v.resolved.derivation.kind === "ok" && v.resolved.derivation.reasons).toEqual([
      "Privatkunde in Deutschland.",
    ]);
    expect(v.findings.find((f) => f.code === "consumer_net_prices")?.severity).toBe("W");
    const s = snapshotOf(converted, ctx);
    expect(s.buyer.isConsumer).toBe(true);
    expect(s.notes.map((n) => n.id)).toContain("b2c_286");
    expect(snapshotOf(converted, makeContext()).notes.map((n) => n.id)).not.toContain("b2c_286");
  });
});

describe("final invoices (EC-DOC-45, EC-DOC-47, EC-DOC-107)", () => {
  test("EC-DOC-45 T-EC-045 a final invoice fully covered by advances is allowed; payable 0, no EPC QR, BT-115 0.00", () => {
    const draft = makeDraft({ type: "final_invoice", einvoiceFormat: "zugferd_en16931" });
    const ctx = makeContext({
      relations: { chain: chain({ final: { advances: [advance({ groups: [S19(95_000)] })] } }) },
    });
    expect(errors(draft, ctx)).toEqual([]);
    const s = snapshotOf(draft, ctx);
    expect(s.totals.grossCents).toBe(113_050);
    expect(s.totals.advancesDeductedGrossCents).toBe(113_050);
    expect(s.totals.payableCents).toBe(0);
    expect(girocodeFor(s)).toBeNull();
    expect(s.notes.map((n) => n.id)).not.toContain("pay_ref");
    expect(serializeEinvoice(s, "zugferd_en16931").xml).toContain("<ram:DuePayableAmount>0.00</ram:DuePayableAmount>");
  });

  test("EC-DOC-47 T-EC-047 a final invoice keeps gross ≥ 0 but its payable may be negative (refund); corrections carry negative totals", () => {
    const draft = makeDraft({ type: "final_invoice" });
    const ctx = makeContext({
      relations: { chain: chain({ final: { advances: [advance({ groups: [S19(100_000)] })] } }) },
    });
    const f = findings(draft, ctx);
    expect(f.map((x) => x.code)).not.toContain("total_negative");
    expect(f.filter((x) => x.severity === "E")).toEqual([]);
    const s = snapshotOf(draft, ctx);
    expect(s.totals.grossCents).toBe(113_050);
    expect(s.totals.payableCents).toBe(113_050 - 119_000);
    // only cancellations/corrections carry negative totals
    const credit = makeDraft({
      type: "correction",
      correctionKind: "credit",
      lines: [serviceLine({ quantityMilli: -2_000 })],
    });
    const cctx = makeContext({ relations: { original: original() } });
    expect(errors(credit, cctx)).toEqual([]);
    expect(snapshotOf(credit, cctx).totals.grossCents).toBe(-22_610);
  });

  test("EC-DOC-107 T-EC-107 the final invoice of a KU company deducts the advance's gross (no VAT)", () => {
    const KU = {
      kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }],
      priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
    };
    const kuAdvance = advance({
      taxCase: "kleinunternehmer",
      groups: [{ category: "KU", rateBp: 0, netCents: 30_000, vatCents: 0 }],
    });
    const draft = makeDraft({ type: "final_invoice" });
    const ctx = makeContext({ relations: { chain: chain({ final: { advances: [kuAdvance] } }) } }, KU);
    expect(errors(draft, ctx)).toEqual([]);
    const s = snapshotOf(draft, ctx);
    expect(s.totals.byGroup.map((g) => [g.category, g.vatCents])).toEqual([["KU", 0]]);
    expect(s.deductions?.[0]).toMatchObject({ deductedGrossCents: 30_000 });
    expect(s.totals.payableCents).toBe(95_000 - 30_000);
  });
});

describe("discounts and Skonto (EC-DOC-50)", () => {
  test("EC-DOC-50 T-EC-050 line discount → document discount → VAT; Skonto only in the terms and BT-20, never in the totals", () => {
    const draft = makeDraft({
      lines: [
        serviceLine({
          quantityMilli: 1_000,
          unitPriceMicros: 10_000_000,
          discount: { kind: "percent", valueBp: 1000 },
        }),
      ],
      documentDiscount: { kind: "percent", valueBp: 1000, isSurcharge: false },
      paymentTerms: { dueDays: 30, skontoPercentBp: 200, skontoDays: 14 },
      einvoiceFormat: "zugferd_en16931",
    });
    const plain = makeDraft({ ...draft, paymentTerms: { dueDays: 30 } });
    const v = validateDocument(draft, makeContext());
    expect(v.findings.filter((f) => f.severity === "E")).toEqual([]);
    expect(v.resolved.totals?.groups[0]).toMatchObject({
      lineNetSumCents: 90_000,
      allowanceCents: 9_000,
      baseCents: 81_000,
      vatCents: 15_390,
    });
    expect(v.resolved.totals?.grossCents).toBe(96_390);
    expect(validateDocument(plain, makeContext()).resolved.totals).toEqual(v.resolved.totals);
    const s = snapshotOf(draft, makeContext());
    expect(s.payment.skonto).toMatchObject({ percentBp: 200, days: 14, amountCents: 1_928, payableCents: 94_462 });
    expect(s.totals.payableCents).toBe(96_390);
    const xml = serializeEinvoice(s, "zugferd_en16931").xml;
    expect(xml).toContain("#SKONTO#TAGE=14#PROZENT=2.00#BASISBETRAG=963.90#");
    expect(xml).toContain("<ram:DuePayableAmount>963.90</ram:DuePayableAmount>");
  });
});

describe("correcting a correction (EC-DOC-64)", () => {
  test("EC-DOC-64 T-EC-064 a correction is never the target; a further credit targets the original, lists earlier corrections and stops at Σ ≥ 0", () => {
    const base = {
      type: "invoice" as const,
      status: "sent",
      number: "RE-2026-0042",
      hasPayments: false,
      payableCents: 113_050,
    };
    expect(correctionTargetGuard({ ...base, type: "correction" })?.code).toBe("correction_target_invalid");
    const second = makeDraft({
      type: "correction",
      correctionKind: "credit",
      lines: [serviceLine({ quantityMilli: -2_000 })],
    });
    const orig = original({
      earlierCredits: [[S19(-19_000)]],
      earlierCorrections: [{ number: "RE-2026-0045", date: "2026-10-05" }],
    });
    const ctx = makeContext({ relations: { original: orig } });
    expect(errors(second, ctx)).toEqual([]);
    const s = snapshotOf(second, ctx, "RE-2026-0051");
    expect(s.references.precedingInvoices).toEqual(
      expect.arrayContaining([
        { number: "RE-2026-0042", date: "2026-10-01", role: "original" },
        expect.objectContaining({ number: "RE-2026-0045", date: "2026-10-05" }),
      ]),
    );
    // Σ(original + all corrections) would drop below 0 → blocked
    const tooMuch = makeContext({ relations: { original: original({ earlierCredits: [[S19(-80_000)]] }) } });
    expect(errors(second, tooMuch)).toContain("correction_exceeds_original");
  });
});
