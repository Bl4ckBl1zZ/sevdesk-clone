/**
 * Storno mirror, Rechnungskorrektur delta and Rechnungsberichtigung detection for originals that use the optional
 * parts of a snapshot (F04 §4.8, INV-10…INV-13, UST-30/UST-31, RI-06/RI-07).
 */
import { describe, expect, test } from "vitest";
import { BUYERS, makeSnapshot } from "../../../test/factories/snapshot";
import { buildSnapshot, type SnapshotInput } from "./build-snapshot";
import {
  cancellationGuard,
  cancellationSnapshotInput,
  correctionTargetGuard,
  creditCapFindings,
  creditDeltaLines,
  detectRectifiedFields,
} from "./corrections";
import type { DraftLine } from "./draft";
import type { DocumentSnapshot } from "./snapshot";

const P = { number: "RE-2026-0100", documentDate: "2026-10-20", layoutVersionId: "layout-v1" };

const storno = (original: DocumentSnapshot, p: Partial<typeof P> & { reason?: string } = {}) => {
  const input = cancellationSnapshotInput(original, { ...P, ...p });
  const r = buildSnapshot(input);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return { input, snapshot: r.value };
};

/** RI-06: original + Storno = 0 per VAT group. */
const expectInverseGroups = (original: DocumentSnapshot, s: DocumentSnapshot) => {
  const byKey = (x: DocumentSnapshot) =>
    Object.fromEntries(x.totals.byGroup.map((g) => [`${g.category}/${g.rateBp}`, [g.baseCents, g.vatCents]]));
  const o = byKey(original);
  const c = byKey(s);
  expect(Object.keys(c).sort()).toEqual(Object.keys(o).sort());
  for (const [key, [net, vat]] of Object.entries(o)) expect(c[key]).toEqual([-(net ?? 0), -(vat ?? 0)]);
  expect(s.totals.grossCents).toBe(-original.totals.grossCents);
  expect(s.totals.payableCents).toBe(-original.totals.payableCents);
};

const richOverrides: Partial<SnapshotInput> = {
  supplyDate: { kind: "period", from: "2026-09-01", to: "2026-09-30" },
  flags: { constructionWork: true, propertyRelated: true },
  delivery: { partyName: "Baustelle Nord", address: { street: "Am Hafen 3", postalCode: "20457", city: "Hamburg", countryCode: "DE" } },
  references: {
    buyerReference: "04011000-12345-67",
    contractReference: "V-2026-7",
    orderReference: "PO-4711",
    salesOrderReference: "AB-2026-0003",
    deliveryNoteNumbers: ["LS-1", "LS-2"],
    projectReference: "P-Hafen",
  },
  lines: [
    { kind: "heading", text: "Leistungen September" },
    {
      kind: "item",
      name: "Montage",
      description: "Fassadenelemente",
      quantityMilli: 8_000,
      unitCode: "HUR",
      unitLabel: "Std.",
      unitPriceMicros: 650_000,
      discount: { kind: "percent", bp: 1000 },
      vatCategory: "S",
      vatRateBp: 1900,
      vatRuleRowId: "standard@2021-01-01",
      period: { from: "2026-09-01", to: "2026-09-15" },
      itemNumber: "ART-1",
      buyerItemNumber: "KD-77",
      isLaborCost: true,
    },
    { kind: "subtotal", text: "Zwischensumme" },
    {
      kind: "item",
      name: "Material",
      quantityMilli: 2_000,
      unitCode: "C62",
      unitPriceMicros: 1_000_000,
      discount: { kind: "amount", cents: 1_500 },
      vatCategory: "S",
      vatRateBp: 700,
    },
    {
      kind: "item",
      name: "Alternative: Premium-Glas",
      quantityMilli: 1_000,
      unitCode: "C62",
      unitPriceMicros: 500_000,
      vatCategory: "S",
      vatRateBp: 1900,
      optional: true,
    },
    { kind: "text", text: "Vielen Dank für Ihren Auftrag." },
  ],
  payment: {
    method: "transfer",
    methodText: "Überweisung binnen 14 Tagen",
    dueDays: 14,
    paymentReferencePrefix: "RE ",
    showEpcQr: false,
  },
};

describe("Storno mirror of a full-featured original (INV-10, RI-06)", () => {
  test("RI-06 INV-10 lines are mirrored with negated quantity, kept discounts/flags/period/item numbers; amount discount negated", () => {
    const original = makeSnapshot(richOverrides);
    const { input, snapshot } = storno(original, { reason: "  Doppelt erstellt  " });
    expect(input.lines).toEqual([
      { kind: "heading", text: "Leistungen September" },
      {
        kind: "item",
        name: "Montage",
        description: "Fassadenelemente",
        quantityMilli: -8_000,
        unitCode: "HUR",
        unitLabel: "Std.",
        unitPriceMicros: 650_000,
        discount: { kind: "percent", bp: 1000 },
        vatCategory: "S",
        vatRateBp: 1900,
        vatRuleRowId: "standard@2021-01-01",
        period: { from: "2026-09-01", to: "2026-09-15" },
        itemNumber: "ART-1",
        buyerItemNumber: "KD-77",
        isLaborCost: true,
      },
      { kind: "subtotal", text: "Zwischensumme" },
      expect.objectContaining({ name: "Material", quantityMilli: -2_000, discount: { kind: "amount", cents: -1_500 } }),
      expect.objectContaining({ name: "Alternative: Premium-Glas", quantityMilli: -1_000, optional: true }),
      { kind: "text", text: "Vielen Dank für Ihren Auftrag." },
    ]);
    expect(input.texts).toEqual({ headText: "Grund der Stornierung: Doppelt erstellt" });
    expect(input.supplyDate).toEqual({ kind: "period", from: "2026-09-01", to: "2026-09-30" });
    expect(input.flags).toEqual({ propertyRelated: true, constructionWork: true });
    expect(input.delivery).toEqual(original.delivery);
    expect(input.references).toEqual({
      buyerReference: "04011000-12345-67",
      contractReference: "V-2026-7",
      orderReference: "PO-4711",
      salesOrderReference: "AB-2026-0003",
      deliveryNoteNumbers: ["LS-1", "LS-2"],
      projectReference: "P-Hafen",
    });
    expect(input.original).toEqual({ number: "RE-2026-0042", date: "2026-10-12" });
    // DOC-51: the prefix before the original number is reused for the Storno's own reference.
    expect(input.payment).toEqual({
      method: "transfer",
      methodText: "Überweisung binnen 14 Tagen",
      dueDays: 14,
      paymentReferencePrefix: "RE ",
      showEpcQr: false,
    });
    expect(snapshot.payment.paymentReference).toBe("RE RE-2026-0100");
    expectInverseGroups(original, snapshot);
  });

  test("RI-06 a blank reason prints no head text; no references, flags or prefix on a plain original", () => {
    const original = makeSnapshot({
      payment: { method: "transfer", dueDays: 30, showEpcQr: true },
      einvoice: { format: "none" },
    });
    const { input } = storno(original, { reason: "   " });
    expect(input.texts).toEqual({});
    expect(input.references).toEqual({});
    expect(input.flags).toEqual({});
    expect(input.payment.paymentReferencePrefix).toBeUndefined();
    expect(input.payment.bankAccount).toBeUndefined();
    // No XML on the original and no ER-03 decision → none, without a decision.
    expect(input.einvoice).toEqual({ format: "none" });
  });

  test("RI-06 a percentage allowance is mirrored as the same percentage on the negated lines", () => {
    const original = makeSnapshot({ adjustment: { type: "allowance", percentBp: 500, reason: "Treuerabatt", reasonCode: "95" } });
    expect(original.totals.allowanceTotalCents).toBe(5_000); // 5 % of 1.000,00 €
    const { input, snapshot } = storno(original);
    expect(input.adjustment).toEqual({ type: "allowance", reason: "Treuerabatt", reasonCode: "95", percentBp: 500 });
    expect(snapshot.totals.allowanceTotalCents).toBe(-5_000);
    expectInverseGroups(original, snapshot);
  });

  test("RI-06 a fixed allowance and a fixed charge are mirrored as negated amounts", () => {
    const allowance = makeSnapshot({ adjustment: { type: "allowance", amountCents: 1_000, reason: "Kulanz" } });
    const a = storno(allowance);
    expect(a.input.adjustment).toEqual({ type: "allowance", reason: "Kulanz", amountCents: -1_000 });
    expectInverseGroups(allowance, a.snapshot);

    const charge = makeSnapshot({ adjustment: { type: "charge", amountCents: 2_500, reason: "Expresszuschlag" } });
    const c = storno(charge);
    expect(c.input.adjustment).toEqual({ type: "charge", reason: "Expresszuschlag", amountCents: -2_500 });
    expect(c.snapshot.totals.chargeTotalCents).toBe(-2_500);
    expectInverseGroups(charge, c.snapshot);
  });
});

describe("Storno and correction guards without number / Storno reference (INV-10, UST-30)", () => {
  const base = { type: "invoice" as const, status: "cancelled", payableCents: 11_900, hasPayments: false };

  test("INV-10 already cancelled without a known Storno number names „eine Stornorechnung“", () => {
    const e = cancellationGuard({ ...base, number: "RE-2026-0001" });
    expect(e?.code).toBe("already_cancelled");
    expect(e?.message).toBe("Rechnung RE-2026-0001 wurde bereits durch eine Stornorechnung storniert.");
    expect(e?.params).toEqual({ number: "RE-2026-0001", storno: "" });
  });

  test("UST-30 correction target already cancelled without a known Storno number", () => {
    const e = correctionTargetGuard({ type: "partial_invoice", status: "cancelled", number: "RE-2026-0002" });
    expect(e?.code).toBe("already_cancelled");
    expect(e?.message).toBe("Rechnung RE-2026-0002 wurde bereits durch eine Stornorechnung storniert.");
  });

  test("INV-10 a self-billing Gutschrift is cancelled only on the supplier's objection (F04 §4.2.8)", () => {
    const sb = { type: "self_billing" as const, status: "finalized", number: "GS-2026-0001", payableCents: 5_000, hasPayments: false };
    expect(cancellationGuard(sb)?.code).toBe("illegal_transition");
    expect(cancellationGuard(sb, { selfBillingObjection: true })).toBeNull();
  });
});

describe("Rechnungskorrektur delta lines (INV-12)", () => {
  const item = (o: Partial<DraftLine> = {}): DraftLine => ({
    kind: "item",
    name: "Beratung",
    quantityMilli: 10_000,
    unitCode: "HUR",
    unitPriceMicros: 1_000_000,
    vatCategory: "S",
    vatRateBp: 1900,
    ...o,
  });

  test("INV-12 a line with an amount discount is reversed in full and re-added with the new quantity", () => {
    const line = item({ discount: { kind: "amount", amountCents: 5_000 } });
    expect(creditDeltaLines([line], [{ position: 1, quantityMilli: 6_000 }])).toEqual([
      { ...line, quantityMilli: -10_000 },
      { ...line, quantityMilli: 6_000, unitPriceMicros: 1_000_000 },
    ]);
  });

  test("INV-12 quantity and price cut on the same line → quantity delta plus „Preisminderung“ on the new quantity", () => {
    const out = creditDeltaLines([item()], [{ position: 1, quantityMilli: 8_000, unitPriceMicros: 900_000 }]);
    expect(out).toEqual([
      item({ quantityMilli: -2_000 }),
      item({ name: "Preisminderung: Beratung", quantityMilli: -8_000, unitPriceMicros: 100_000 }),
    ]);
  });

  test("INV-12 an unchanged position yields no line; untouched positions are skipped", () => {
    const lines = [item(), item({ name: "Reisekosten", quantityMilli: 1_000, unitPriceMicros: 120_000_000 })];
    expect(creditDeltaLines(lines, [{ position: 1, quantityMilli: 10_000 }])).toEqual([]);
    expect(creditDeltaLines(lines, [{ position: 2, unitPriceMicros: 100_000_000 }])).toEqual([
      { ...lines[1], name: "Preisminderung: Reisekosten", quantityMilli: -1_000, unitPriceMicros: 20_000_000 },
    ]);
  });
});

describe("Credit cap per VAT group (UST-30, RI-07)", () => {
  test("RI-07 a credit in a VAT group the original never had exceeds it with 0,00 € left", () => {
    const original = [{ category: "S" as const, rateBp: 1900, netCents: 10_000, vatCents: 1_900 }];
    const next = [{ category: "S" as const, rateBp: 700, netCents: -1_000, vatCents: -70 }];
    const f = creditCapFindings(original, [], next);
    expect(f.map((x) => [x.code, x.message])).toEqual([
      ["correction_exceeds_original", "Die Korrekturen übersteigen den Rechnungsbetrag (7 %: noch 0,00 € korrigierbar)."],
    ]);
    expect(f[0]?.params).toEqual({ group: "7 %", remaining: 0 });
  });

  test("RI-07 non-standard groups are labelled by category; crediting a group to exactly zero is fine", () => {
    const original = [
      { category: "S" as const, rateBp: 1900, netCents: 10_000, vatCents: 1_900 },
      { category: "E" as const, rateBp: 0, netCents: 5_000, vatCents: 0 },
    ];
    expect(creditCapFindings(original, [], [{ category: "E", rateBp: 0, netCents: -5_000, vatCents: 0 }])).toEqual([]);
    const f = creditCapFindings(original, [], [{ category: "E", rateBp: 0, netCents: -6_000, vatCents: 0 }]);
    expect(f[0]?.message).toBe("Die Korrekturen übersteigen den Rechnungsbetrag (E: noch 50,00 € korrigierbar).");
  });
});

describe("Rechnungsberichtigung field detection (INV-13, UST-31)", () => {
  test("INV-13 changed buyer/seller tax ids, buyer name, supply date, lines, references and delivery are all listed", () => {
    const original = makeSnapshot({ references: { buyerReference: "LW-1", contractReference: "V-1" } });
    const next = makeSnapshot({
      buyer: { ...BUYERS.b2b, name: "Beispiel Kunde GmbH & Co. KG", vatId: "DE999999999", taxNumber: "123/456/78901" },
      seller: { ...original.seller, vatId: "DE111111111", taxNumber: "999/999/99999" },
      supplyDate: { kind: "date", date: "2026-10-10" },
      references: { buyerReference: "LW-2", contractReference: "V-2" },
      delivery: { partyName: "Lager Süd" },
      lines: [
        {
          kind: "item",
          name: "Beratung Webdesign",
          description: "Konzeption der Startseite und Unterseiten",
          quantityMilli: 10_000,
          unitCode: "HUR",
          unitPriceMicros: 1_000_000,
          vatCategory: "S",
          vatRateBp: 1900,
        },
      ],
    });
    expect(detectRectifiedFields(original, next)).toEqual([
      "buyer.name",
      "buyer.vatId",
      "buyer.taxNumber",
      "seller.taxNumber",
      "seller.vatId",
      "supplyDate",
      "lines",
      "buyerReference",
      "contractReference",
      "delivery",
    ]);
  });

  test("INV-13 a changed contact person counts as an address correction", () => {
    const original = makeSnapshot();
    const next = makeSnapshot({ buyer: { ...BUYERS.b2b, contactPerson: { name: "Erika Neu" } } });
    expect(detectRectifiedFields(original, next)).toEqual(["buyer.address"]);
  });
});
