import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { goldenSnapshot, loadGoldenCases } from "../test/golden/cases";
import { api } from "./_generated/api";
import { consumerBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DOC-24 finalisation pipeline", () => {
  test("DOC-24 SET-059 draft → finalise assigns RE-2026-0001, freezes the snapshot and archives the artifacts", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    expect(number).toBe("RE-2026-0001");
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.doc.status).toBe("finalized");
    expect(detail?.doc.artifactStatus).toBe("ready");
    expect(detail?.artifacts.map((a) => `${a.kind}:${a.variant}`).sort()).toEqual([
      "xrechnung_xml:original",
      "zugferd_pdf:original",
    ]);
    const snapshot = detail?.snapshot as DocumentSnapshot;
    expect(snapshot.number).toBe("RE-2026-0001");
    expect(snapshot.totals.grossCents).toBe(119_000);
  });
});

/**
 * The finalised snapshot equals the golden snapshot of the same input (07 §4): only the number (and the texts that
 * quote it), the layout version, the payment-method text (seeded lookup) and the unit label printed from the unit
 * table differ by environment.
 */
function goldenFor(dir: string, actual: DocumentSnapshot): DocumentSnapshot {
  const c = loadGoldenCases().find((g) => g.dir === dir);
  if (!c) throw new Error(dir);
  const methodText = actual.payment.methodText;
  return goldenSnapshot({
    ...c,
    input: {
      ...c.input,
      number: actual.number,
      layoutVersionId: actual.layoutVersionId,
      payment: { ...c.input.payment, ...(methodText ? { methodText } : {}) },
    },
  });
}
const withoutUnitLabels = (s: DocumentSnapshot): DocumentSnapshot => ({
  ...s,
  lines: s.lines.map((l) => {
    if (l.kind !== "item") return l;
    const { unitLabel: _u, ...rest } = l;
    return rest;
  }),
});

describe("golden match (07 §4, T-GLD)", () => {
  test("T-GLD-01 de-19-standard: Convex finalisation produces the golden snapshot", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const actual = (await owner.query(api.invoices.get, { id }))?.snapshot as DocumentSnapshot;
    expect(withoutUnitLabels(actual)).toEqual(goldenFor("de-19-standard", actual));
  });

  test("T-GLD-10 ku-invoice: KU B2C invoice without VAT, KU note, PDF only", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(contactId, {
        paymentTerms: { dueDays: 14 },
        lines: [
          {
            kind: "item",
            productType: "service",
            name: "Fotoshooting Familie (halber Tag)",
            quantityMilli: 2_000,
            unitCode: "E48",
            unitPriceMicros: 5_000_000,
            vatRateKey: "standard",
          },
        ],
      }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const detail = await owner.query(api.invoices.get, { id });
    const actual = detail?.snapshot as DocumentSnapshot;
    expect(withoutUnitLabels(actual)).toEqual(goldenFor("ku-invoice", actual));
    expect(detail?.artifacts.map((a) => `${a.kind}:${a.variant}`)).toEqual(["pdf:original"]);
  });

  test("T-GLD-22 kleinbetrag-250: Kleinbetragsrechnung 250,00 € gross", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const contactId = await consumerBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(contactId, {
        kleinbetrag: true,
        einvoiceFormat: "none",
        paymentTerms: { dueDays: 30 },
        lines: [
          {
            kind: "item",
            productType: "good",
            name: "Druckerpapier A4, 20 Pakete",
            quantityMilli: 1_000,
            unitCode: "LS",
            unitPriceMicros: 2_100_800,
            vatRateKey: "standard",
          },
        ],
      }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const actual = (await owner.query(api.invoices.get, { id }))?.snapshot as DocumentSnapshot;
    // The golden fixture sets the ER-03 decision by hand (MAY_PAPER_OR_PDF); for a consumer ER-03 derives R3
    // NOT_REQUIRED. The decision is not printed, so PDF and XML goldens are unaffected.
    expect(actual.einvoice).toEqual({ format: "none", decision: "NOT_REQUIRED" });
    const golden = goldenFor("kleinbetrag-250", actual);
    expect(withoutUnitLabels(actual)).toEqual({ ...golden, einvoice: actual.einvoice });
  });
});
