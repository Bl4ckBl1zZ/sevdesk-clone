import { describe, expect, test } from "vitest";
import { BUYERS, makeSnapshot } from "../../../test/factories/snapshot";
import { buildSnapshot } from "./build-snapshot";
import {
  applyCredit,
  cancellationGuard,
  cancellationSnapshotInput,
  correctionTargetGuard,
  creditCapFindings,
  creditDeltaLines,
  detectRectifiedFields,
  RECTIFIED_FIELD_LABELS,
  rectificationFindings,
  revertCredit,
} from "./corrections";
import type { DraftLine } from "./draft";

const g = (rateBp: number, netCents: number, vatCents: number) => ({
  category: "S" as const,
  rateBp,
  netCents,
  vatCents,
});

const invoice = {
  type: "invoice" as const,
  status: "finalized",
  number: "RE-2026-0042",
  payableCents: 119_000,
  hasPayments: false,
};

describe("Storno guards (F04 INV-10/INV-11, §5.1.6)", () => {
  test("INV-10 an unpaid finalised or sent invoice may be cancelled", () => {
    expect(cancellationGuard(invoice)).toBeNull();
    expect(cancellationGuard({ ...invoice, status: "sent" })).toBeNull();
  });

  test("UST-30 EC-074 T-EC-062 a (partially) paid invoice → storno_paid_invoice with both legal paths", () => {
    const e = cancellationGuard({ ...invoice, hasPayments: true });
    expect(e?.code).toBe("storno_paid_invoice");
    expect(e?.message).toBe(
      "Rechnung RE-2026-0042 ist (teil)bezahlt. Stornieren ist nur bei unbezahlten Rechnungen möglich. Erstellen Sie eine Rechnungskorrektur und erfassen Sie die Erstattung – oder lösen Sie zuerst die Zahlungszuordnung, falls sie falsch ist.",
    );
  });

  test("UST-30 EC-075 T-EC-063 a Storno cannot be cancelled; already cancelled → already_cancelled", () => {
    expect(cancellationGuard({ ...invoice, type: "cancellation" })?.code).toBe("storno_of_storno");
    expect(cancellationGuard({ ...invoice, status: "cancelled", cancelledBy: "RE-2026-0050" })?.message).toBe(
      "Rechnung RE-2026-0042 wurde bereits durch RE-2026-0050 storniert.",
    );
  });

  test("UST-41 EC-072 T-EC-058 an advance deducted in a non-cancelled final → storno_advance_deducted", () => {
    const e = cancellationGuard({ ...invoice, type: "advance_invoice", deductedIn: "RE-2026-0060" });
    expect(e?.code).toBe("storno_advance_deducted");
    expect(e?.message).toContain("Schlussrechnung RE-2026-0060");
  });

  test("UST-30 RI-07 an invoice with Rechnungskorrekturen → storno_has_corrections; drafts are not cancelled", () => {
    expect(cancellationGuard({ ...invoice, activeCorrections: ["RK-2026-0001"] })?.code).toBe("storno_has_corrections");
    expect(cancellationGuard({ ...invoice, status: "draft" })?.code).toBe("illegal_transition");
  });

  test("INV-15 a credit correction may be cancelled while no refund/offset is allocated", () => {
    const corr = { ...invoice, type: "correction" as const, correctionKind: "credit" as const, payableCents: -23_800 };
    expect(cancellationGuard(corr)).toBeNull();
    expect(cancellationGuard({ ...corr, hasPayments: true })?.code).toBe("correction_refund_allocated");
    expect(cancellationGuard({ ...corr, correctionKind: "rectification" })?.code).toBe("illegal_transition");
  });

  test("UST-30 T-EC-064 T-EC-066 correction targets: invoice family only, never a correction, cancelled → already_cancelled", () => {
    expect(correctionTargetGuard(invoice)).toBeNull();
    expect(correctionTargetGuard({ ...invoice, type: "final_invoice" })).toBeNull();
    expect(correctionTargetGuard({ ...invoice, type: "correction" })?.code).toBe("correction_target_invalid");
    expect(correctionTargetGuard({ ...invoice, type: "cancellation" })?.code).toBe("correction_target_invalid");
    expect(correctionTargetGuard({ ...invoice, status: "draft" })?.code).toBe("correction_target_invalid");
    expect(correctionTargetGuard({ ...invoice, status: "cancelled", cancelledBy: "RE-2026-0050" })?.code).toBe(
      "already_cancelled",
    );
  });
});

describe("Storno mirror (INV-10, RI-06, golden G-17)", () => {
  test("UST-03 EC-DOC-70 T-EC-070 the Storno copies seller and buyer of the original; the reason is printed", () => {
    const original = makeSnapshot();
    const input = cancellationSnapshotInput(original, {
      number: "RE-2026-0047",
      documentDate: "2026-10-20",
      layoutVersionId: "layout-v1",
      reason: "Doppelt erstellt",
    });
    expect(input.seller).toEqual(original.seller);
    expect(input.buyer).toEqual(original.buyer);
    expect(input.texts?.headText).toBe("Grund der Stornierung: Doppelt erstellt");
  });

  test("UST-41 EC-DOC-60 the Storno of a final invoice mirrors its deductions", () => {
    const original = makeSnapshot({
      type: "final_invoice",
      chain: { orderLabel: { de: "Auftrag", en: "order" }, orderNumber: "AB-1", orderDate: "2026-01-01" },
      deductions: [
        {
          advanceNumber: "RE-2026-0001",
          advanceDate: "2026-02-01",
          byGroup: [{ category: "S", rateBp: 1900, netCents: 30_000, vatCents: 5700, grossCents: 35_700 }],
          deductedGrossCents: 35_700,
          partiallyPaid: false,
        },
      ],
    });
    const r = buildSnapshot(
      cancellationSnapshotInput(original, { number: "RE-9", documentDate: "2026-10-20", layoutVersionId: "x" }),
    );
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.totals.payableCents).toBe(-original.totals.payableCents);
    expect(r.value.totals.advancesDeductedGrossCents).toBe(-35_700);
  });
});

describe("Rechnungskorrektur (INV-12, RI-07)", () => {
  const lines: DraftLine[] = [
    { kind: "heading", name: "Leistungen" },
    {
      kind: "item",
      name: "Beratung Webdesign",
      quantityMilli: 10_000,
      unitCode: "HUR",
      unitPriceMicros: 1_000_000,
      vatRateKey: "standard",
      productType: "service",
    },
    { kind: "item", name: "Hosting", quantityMilli: 1000, unitCode: "C62", unitPriceMicros: 500_000 },
  ];

  test("INV-12 T-INV-010 reduced quantity → one negative delta line (−2 h); removed line → full negation", () => {
    const delta = creditDeltaLines(lines, [
      { position: 1, quantityMilli: 8000 },
      { position: 2, quantityMilli: 0 },
    ]);
    expect(delta).toEqual([
      expect.objectContaining({
        kind: "item",
        name: "Beratung Webdesign",
        quantityMilli: -2000,
        unitPriceMicros: 1_000_000,
      }),
      expect.objectContaining({ kind: "item", name: "Hosting", quantityMilli: -1000, unitPriceMicros: 500_000 }),
    ]);
    expect(delta[0]).toMatchObject({ vatRateKey: "standard", productType: "service" });
  });

  test("INV-12 a price reduction → negative quantity × price difference; both changed → two lines", () => {
    expect(creditDeltaLines(lines, [{ position: 1, unitPriceMicros: 800_000 }])).toEqual([
      expect.objectContaining({
        name: "Preisminderung: Beratung Webdesign",
        quantityMilli: -10_000,
        unitPriceMicros: 200_000,
      }),
    ]);
    const both = creditDeltaLines(lines, [{ position: 1, quantityMilli: 5000, unitPriceMicros: 800_000 }]);
    expect(both.map((l) => [l.quantityMilli, l.unitPriceMicros])).toEqual([
      [-5000, 1_000_000],
      [-5000, 200_000],
    ]);
  });

  test("INV-12 without changes the whole invoice is credited (full Rechnungskorrektur)", () => {
    expect(creditDeltaLines(lines, []).map((l) => l.quantityMilli)).toEqual([-10_000, -1000]);
  });

  test("UST-30 RI-07 T-EC-065 remaining 238,00 and a credit of 300,00 → correction_exceeds_original", () => {
    const original = [g(1900, 100_000, 19_000)];
    const earlier = [g(1900, -80_000, -15_200)];
    expect(creditCapFindings(original, [earlier], [g(1900, -20_000, -3800)])).toEqual([]);
    const f = creditCapFindings(original, [earlier], [g(1900, -25_210, -4790)]);
    expect(f.map((x) => x.code)).toEqual(["correction_exceeds_original"]);
    expect(f[0]?.message).toBe("Die Korrekturen übersteigen den Rechnungsbetrag (19 %: noch 238,00 € korrigierbar).");
  });

  test("UST-30 INV-14 a correction that does not reduce → correction_not_reducing (Nachberechnung = new invoice)", () => {
    expect(creditCapFindings([g(1900, 100_000, 19_000)], [], [g(1900, 1000, 190)]).map((x) => x.code)).toEqual([
      "correction_not_reducing",
    ]);
    expect(creditCapFindings([g(1900, 100_000, 19_000)], [], [g(700, -1000, -70)]).map((x) => x.code)).toEqual([
      "correction_exceeds_original",
    ]);
  });

  test("INV-12 §4.2.5 a credit reduces the open amount; the excess becomes a refund owed on the correction", () => {
    expect(applyCredit({ openCents: 119_000, status: "open", creditGrossCents: -23_800 })).toEqual({
      originalOpenCents: 95_200,
      originalStatus: "open",
      correctionOpenCents: 0,
      appliedCents: 23_800,
    });
    expect(applyCredit({ openCents: 0, status: "paid", creditGrossCents: -23_800 })).toEqual({
      originalOpenCents: 0,
      originalStatus: "paid",
      correctionOpenCents: -23_800,
      appliedCents: 0,
    });
    // EC-071: partially paid advance reduced to the received amount → settled (paid)
    expect(applyCredit({ openCents: 178_500, status: "partially_paid", creditGrossCents: -178_500 })).toMatchObject({
      originalOpenCents: 0,
      originalStatus: "paid",
      correctionOpenCents: 0,
    });
    // fully credited without any cash → credited
    expect(applyCredit({ openCents: 119_000, status: "open", creditGrossCents: -119_000 }).originalStatus).toBe(
      "credited",
    );
  });

  test("INV-15 cancelling a credit restores the absorbed amount on the original", () => {
    expect(revertCredit({ openCents: 95_200, status: "open", appliedCents: 23_800 })).toEqual({
      openCents: 119_000,
      status: "open",
    });
    expect(revertCredit({ openCents: 0, status: "credited", appliedCents: 119_000 })).toEqual({
      openCents: 119_000,
      status: "open",
    });
    expect(revertCredit({ openCents: 0, status: "paid", appliedCents: 178_500 })).toEqual({
      openCents: 178_500,
      status: "partially_paid",
    });
  });
});

describe("Rechnungsberichtigung (INV-13, UST-31)", () => {
  test("UST-31 EC-081 T-EC-067 changed amounts → rectification_amount_changed; nothing changed → rectification_no_change", () => {
    const groups = [g(1900, 100_000, 19_000)];
    expect(rectificationFindings(groups, groups, ["buyer.address"])).toEqual([]);
    expect(rectificationFindings(groups, [g(1900, 100_100, 19_019)], ["buyer.address"]).map((f) => f.code)).toEqual([
      "rectification_amount_changed",
    ]);
    expect(rectificationFindings(groups, groups, []).map((f) => f.code)).toEqual(["rectification_no_change"]);
  });

  test("INV-13 the corrected items are detected from the two snapshots and printed in German", () => {
    const original = makeSnapshot();
    const next = makeSnapshot({
      buyer: { ...BUYERS.b2b, address: { ...BUYERS.b2b.address, street: "Neuer Weg 9" } },
      references: { orderReference: "PO-77" },
    });
    expect(detectRectifiedFields(original, next)).toEqual(["buyer.address", "orderReference"]);
    expect(RECTIFIED_FIELD_LABELS["buyer.address"]).toBe("Anschrift des Leistungsempfängers");
    expect(detectRectifiedFields(original, makeSnapshot({ number: "RE-2026-0099" }))).toEqual([]);
  });
});
