/**
 * Generic edge cases of 10-edge-cases §3.2–§3.5 (place of supply, mixed documents, totals, conversions, KU periods)
 * exercised end-to-end on the document domain: draft → validateDocument → snapshot → EN 16931 XML.
 */
import { BUYERS, goodLine, makeContact, makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { makeSnapshot, SELLERS } from "@test/factories/snapshot";
import { describe, expect, test } from "vitest";
import { serializeEinvoice } from "../einvoice/serialize";
import { girocodeFor } from "../epc/girocode";
import { buildSnapshot, type SnapshotInputItem } from "./build-snapshot";
import { convertDocument, type SourceLine } from "./conversion";
import type { DocumentContext, DraftDocument } from "./draft";
import { buildSnapshotInput } from "./finalize";
import { validateDocument } from "./validate";

const codes = (draft: DraftDocument, ctx: DocumentContext = makeContext(), opts = {}) =>
  validateDocument(draft, ctx, opts).findings.map((f) => f.code);
const errorsOf = (draft: DraftDocument, ctx: DocumentContext = makeContext()) =>
  validateDocument(draft, ctx)
    .findings.filter((f) => f.severity === "E")
    .map((f) => f.code);

function finalSnapshot(draft: DraftDocument, ctx: DocumentContext, documentDate = "2026-10-12") {
  const v = validateDocument(draft, ctx);
  expect(v.findings.filter((f) => f.severity === "E")).toEqual([]);
  const s = buildSnapshot(
    buildSnapshotInput(draft, ctx, v.resolved, {
      number: "RE-2026-0042",
      documentDate,
      layoutVersionId: "layout-v1",
      plan: v.einvoice,
    }),
  );
  if (!s.ok) throw new Error(s.error.code);
  return s.value;
}

const KU_FROM_2025 = {
  kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }],
  priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
};

describe("place of supply and buyer status (10 §3.3)", () => {
  test("EC-042 goods to a customer with an EU VAT ID but delivered within Germany are domestic 19 %, not an igL", () => {
    const fr = makeContact({
      buyer: BUYERS.fr,
      countryCode: "FR",
      vatId: BUYERS.fr.vatId,
      vatIdStatus: { status: "valid", qualified: true },
    });
    const delivery = {
      name: "Lager Köln",
      street: "Hafenstraße 1",
      postalCode: "50668",
      city: "Köln",
      countryCode: "DE",
    };
    const r = validateDocument(
      makeDraft({ lines: [goodLine()], deliveryAddress: delivery }),
      makeContext({ contact: fr }),
    );
    expect(r.resolved.taxCase).toBe("domestic");
    expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    // the same customer with the goods leaving Germany is an intra-Community supply (the destination decides)
    const leaving = validateDocument(
      makeDraft({
        lines: [goodLine()],
        deliveryAddress: { ...delivery, city: "Paris", postalCode: "75002", countryCode: "FR" },
      }),
      makeContext({ contact: fr }),
    );
    expect(leaving.resolved.taxCase).toBe("intra_community_supply");
  });

  test("EC-043 an EU business without (valid) VAT ID buying a service is treated as B2C: German VAT and a VAT-ID check warning", () => {
    for (const contact of [
      makeContact({ buyer: { ...BUYERS.at, vatId: undefined }, countryCode: "AT", vatId: undefined }),
      makeContact({
        buyer: BUYERS.at,
        countryCode: "AT",
        vatId: BUYERS.at.vatId,
        vatIdStatus: { status: "invalid", qualified: false },
      }),
    ]) {
      const r = validateDocument(makeDraft(), makeContext({ contact }));
      expect(r.resolved.taxCase).toBe("domestic");
      expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
      const d = r.resolved.derivation;
      expect(d.kind === "ok" && d.warnings.join(" ")).toMatch(/USt-IdNr prüfen/);
    }
  });

  test("EC-046 a Swiss customer with a service located in Germany (property, admission, restaurant, vehicle rental) pays German VAT", () => {
    const ch = makeContact({ buyer: BUYERS.ch, countryCode: "CH", vatId: undefined });
    // general rule § 3a Abs. 2: not taxable in Germany
    expect(validateDocument(makeDraft(), makeContext({ contact: ch })).resolved.taxCase).toBe("not_taxable_domestic");
    for (const rule of ["property", "event_admission", "restaurant", "short_term_vehicle_rental"]) {
      const r = validateDocument(
        makeDraft({ lines: [serviceLine({ placeOfSupplyRule: rule })] }),
        makeContext({ contact: ch }),
      );
      expect(r.resolved.taxCase, rule).toBe("domestic");
      expect(r.resolved.lines[0], rule).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
    }
  });

  test("EC-047 §13b construction work for a customer whose USt 1 TG expired: warning until the owner confirms (or VAT is charged)", () => {
    const construction = makeContact({
      buyer: BUYERS.construction,
      vatId: undefined,
      certificates13b: [{ validUntil: "2026-06-30", addedAt: 1 }],
    });
    const draft = makeDraft({ lines: [serviceLine({ name: "Estricharbeiten", reverseCharge13b: "construction" })] });
    const ctx = makeContext({ contact: construction });
    const v = validateDocument(draft, ctx);
    expect(v.resolved.taxCase).toBe("reverse_charge_13b");
    const warning = v.findings.find((f) => f.code === "rc13b_certificate_missing");
    expect(warning?.severity).toBe("W");
    expect(warning?.message).toContain("nur bis 30.06.2026 gültig");
    // the audited confirmation „Kunde erbringt selbst Bauleistungen“ releases it
    expect(codes(draft, ctx, { rc13bConfirmed: true })).not.toContain("rc13b_certificate_missing");
    // a certificate valid on the supply date needs no confirmation
    const valid = makeContact({
      buyer: BUYERS.construction,
      vatId: undefined,
      certificates13b: [{ validUntil: "2027-06-30", addedAt: 1 }],
    });
    expect(codes(draft, makeContext({ contact: valid }))).not.toContain("rc13b_certificate_missing");
  });
});

describe("mixed documents and totals (10 §3.4)", () => {
  test("EC-048 taxable plus exempt lines: separate VAT groups, an exemption text for the exempt group, both in the XML", () => {
    const draft = makeDraft({
      lines: [
        serviceLine(),
        serviceLine({
          name: "Vermittlung einer Versicherung",
          vatRateKey: "exempt",
          exemptionReasonCode: "VATEX-EU-135-1A",
          unitPriceMicros: 500_000,
        }),
      ],
    });
    const s = finalSnapshot(draft, makeContext());
    expect(s.totals.byGroup.map((g) => [g.category, g.rateBp, g.baseCents, g.vatCents])).toEqual([
      ["S", 1900, 95_000, 18_050],
      ["E", 0, 50_000, 0],
    ]);
    expect(s.notes.map((n) => n.id)).toContain("exempt_4");
    const xml = serializeEinvoice(s, "zugferd_en16931");
    expect(xml.model.vatBreakdown.map((b) => b.category)).toEqual(["S", "E"]);
    expect(xml.model.vatBreakdown.find((b) => b.category === "E")).toMatchObject({
      exemptionReasonCode: "VATEX-EU-135-1A",
    });
    expect(xml.model.vatBreakdown.find((b) => b.category === "E")?.exemptionReason).toBeTruthy();
  });

  test("EC-049 §13b lines plus domestic taxable lines for one customer: line-specific AE and S groups, both texts printed", () => {
    const draft = makeDraft({
      lines: [
        goodLine({ name: "Kupferschrott", reverseCharge13b: "metals", unitPriceMicros: 2_000_000 }),
        goodLine({ name: "Transportkiste" }),
      ],
    });
    const v = validateDocument(draft, makeContext());
    expect(v.resolved.taxCase).toBe("domestic");
    expect(v.resolved.lines.map((l) => l.vatCategory)).toEqual(["AE", "S"]);
    const s = finalSnapshot(draft, makeContext());
    expect(s.totals.byGroup.map((g) => [g.category, g.rateBp])).toEqual([
      ["S", 1900],
      ["AE", 0],
    ]);
    expect(s.notes.map((n) => n.id)).toContain("rc_13b");
    const model = serializeEinvoice(s, "zugferd_en16931").model;
    expect(model.vatBreakdown.map((b) => b.category)).toEqual(["S", "AE"]);
    expect(model.lines.map((l) => l.category)).toEqual(["AE", "S"]);
  });

  test("EC-051 a final invoice fully covered by advances: payable 0 is allowed, the XML carries 0.00 and there is no EPC QR", () => {
    const s = makeSnapshot({
      type: "final_invoice",
      chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2026-08-03" },
      lines: [
        {
          kind: "item",
          name: "Leistung",
          quantityMilli: 1_000,
          unitCode: "LS",
          unitPriceMicros: 10_000_000,
          vatCategory: "S",
          vatRateBp: 1900,
        } satisfies SnapshotInputItem,
      ],
      deductions: [
        {
          advanceNumber: "RE-2026-0010",
          advanceDate: "2026-08-20",
          byGroup: [{ category: "S", rateBp: 1900, netCents: 100_000, vatCents: 19_000, grossCents: 119_000 }],
          deductedGrossCents: 119_000,
          partiallyPaid: false,
        },
      ],
    });
    expect(s.totals.payableCents).toBe(0);
    expect(girocodeFor(s)).toBeNull();
    const xml = serializeEinvoice(s, "zugferd_en16931");
    expect(xml.model.totals).toMatchObject({ taxInclusiveCents: 119_000, prepaidCents: 119_000, payableCents: 0 });
    expect(xml.xml).toContain("<ram:DuePayableAmount>0.00</ram:DuePayableAmount>");
    // an invoice with a total of 0 € is a hint, never a block
    const zero = validateDocument(makeDraft({ lines: [serviceLine({ unitPriceMicros: 0 })] }), makeContext());
    expect(zero.findings.find((f) => f.code === "total_zero")?.severity).toBe("W");
  });

  test("EC-052 a negative total is blocked for invoices; only Storno/Rechnungskorrektur may be negative", () => {
    const negative = [serviceLine(), serviceLine({ name: "Gutschrift Altauftrag", quantityMilli: -20_000 })];
    for (const type of ["invoice", "advance_invoice", "partial_invoice", "final_invoice"] as const) {
      expect(errorsOf(makeDraft({ type, lines: negative })), type).toContain("total_negative");
    }
    expect(codes(makeDraft({ type: "correction", correctionKind: "credit", lines: negative }))).not.toContain(
      "total_negative",
    );
    expect(codes(makeDraft({ type: "cancellation", lines: negative }))).not.toContain("total_negative");
  });
});

describe("conversions, rate and KU changes (10 §3.2, §3.5, §3.7)", () => {
  const quoteLine = (patch: Partial<SourceLine> = {}): SourceLine => ({
    ...serviceLine({ name: "Catering Firmenfeier", vatRateKey: "restaurant_food", vatCategory: "S", vatRateBp: 1900 }),
    id: "ql1",
    ...patch,
  });

  test("EC-040 a 2025 quote at 19 % (restaurant food) converted into a 2026 invoice re-resolves the rate by the new supply date", () => {
    const quote = {
      ...makeDraft({ type: "quote", supplyDate: { kind: "date", date: "2025-12-15" } }),
      lines: [quoteLine()],
    };
    const converted = convertDocument(quote, "invoice");
    const invoice: DraftDocument = { ...converted, supplyDate: { kind: "date", date: "2026-01-15" } };
    const r = validateDocument(invoice, makeContext({ today: "2026-01-20" as DocumentContext["today"] }));
    expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 700 });
    expect(r.findings.find((f) => f.code === "rate_changed_notice")).toMatchObject({
      severity: "I",
      message: "Steuersatz geändert: 19 % → 7 % (Leistungsdatum 15.01.2026).",
    });
  });

  test("EC-080 converting a consumer quote after the contact became a business uses the current flags and re-derives the tax case", () => {
    const at = { ...BUYERS.at, isConsumer: true, vatId: undefined };
    const quote = {
      ...makeDraft({ type: "quote", supplyDate: { kind: "date", date: "2026-10-09" } }),
      lines: [quoteLine({ vatRateKey: "standard", vatRateBp: 1900, name: "Beratung" })],
    };
    const asConsumer = makeContact({ buyer: at, countryCode: "AT", isConsumer: true, vatId: undefined });
    expect(validateDocument(quote, makeContext({ contact: asConsumer })).resolved.taxCase).toBe("domestic");
    const nowBusiness = makeContact({
      buyer: BUYERS.at,
      countryCode: "AT",
      isConsumer: false,
      vatId: BUYERS.at.vatId,
      vatIdStatus: { status: "valid", qualified: true },
    });
    const invoice = convertDocument(quote, "invoice");
    const r = validateDocument(invoice, makeContext({ contact: nowBusiness }));
    expect(r.resolved.taxCase).toBe("eu_b2b_service");
    expect(r.resolved.lines[0]).toMatchObject({ vatCategory: "AE", vatRateBp: 0 });
    // … and vice versa: a business quote converted after the contact became a consumer
    const back = validateDocument(convertDocument(quote, "invoice"), makeContext({ contact: asConsumer }));
    expect(back.resolved.taxCase).toBe("domestic");
    expect(back.resolved.lines[0]).toMatchObject({ vatCategory: "S", vatRateBp: 1900 });
  });

  test("EC-025 a supply period spanning a KU status change is blocked with the split hint, both directions", () => {
    const period = (from: string, to: string) =>
      makeDraft({ supplyDate: { kind: "period", from, to }, documentDate: "2026-10-12" });
    // KU ends on 2026-07-01 (limit crossed) → a June–July period straddles the boundary
    const ending = makeContext(
      {},
      { kleinunternehmer: [...KU_FROM_2025.kleinunternehmer, { validFrom: "2026-07-01", isKU: false }] },
    );
    const f = validateDocument(period("2026-06-15", "2026-07-15"), ending).findings.find(
      (x) => x.code === "supply_period_crosses_ku_change",
    );
    expect(f?.severity).toBe("E");
    expect(f?.message).toBe(
      "Leistungszeitraum überschreitet den Wechsel der Kleinunternehmerregelung am 01.07.2026 — bitte Rechnung aufteilen.",
    );
    // the two halves are fine
    expect(codes(period("2026-06-15", "2026-06-30"), ending)).not.toContain("supply_period_crosses_ku_change");
    expect(codes(period("2026-07-01", "2026-07-15"), ending)).not.toContain("supply_period_crosses_ku_change");
    // KU starting on 1 January (regular → KU)
    const starting = makeContext(
      {},
      {
        kleinunternehmer: [
          { validFrom: "2020-01-01", isKU: false },
          { validFrom: "2026-01-01", isKU: true },
        ],
        priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
      },
    );
    expect(errorsOf(period("2025-12-15", "2026-01-15"), starting)).toContain("supply_period_crosses_ku_change");
  });

  test("EC-028 the Ist-taxation note: invoice dated 31.12.2027 without it, 01.01.2028 with it", () => {
    const ids = (documentDate: string) =>
      makeSnapshot({ seller: SELLERS.ek, documentDate, supplyDate: { kind: "date", date: "2027-12-20" } }).notes.map(
        (n) => n.id,
      );
    expect(SELLERS.ek.vatAccounting).toBe("ist");
    expect(ids("2027-12-31")).not.toContain("ist_2028");
    expect(ids("2028-01-01")).toContain("ist_2028");
  });
});
