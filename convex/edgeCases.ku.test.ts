import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { TAX_CASE_LABELS } from "../src/domain/tax/tax-case";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, createValues, PRODUCT_RANGE, personForm } from "./catalog.fixtures";
import {
  consumerBuyer,
  finalizedInvoice,
  INVOICE_RANGE,
  invoiceValues,
  settle,
  setupInvoicing,
} from "./invoices.fixtures";
import { turnoverTotals } from "./model/turnover";
import { makeT, type TestT } from "./test.setup";

/**
 * 10-edge-cases §3.5 / §3.7 in Convex: the KU limit crossing (EC-060), fixed-asset sales and the Gesamtumsatz
 * (EC-065) and the conversion notice after a contact's status changed (EC-080).
 */

vi.setConfig({ testTimeout: 60_000 });
const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

const line = (netEuro: number) => ({
  kind: "item" as const,
  productType: "service" as const,
  name: "Fotoshooting Hochzeit",
  quantityMilli: 1_000,
  unitCode: "C62",
  unitPriceMicros: netEuro * 10_000,
  vatRateKey: "standard" as const,
});
const on = (date: string) => ({ kind: "date" as const, date: date as CalendarDate });
const doc = (t: TestT, id: Id<"salesDocuments">) => t.run((ctx) => ctx.db.get(id));

async function finalized(t: TestT, owner: Owner, contactId: string, netEuro: number, supply: string) {
  const { id } = await owner.mutation(api.invoices.createDraft, {
    values: invoiceValues(contactId, { lines: [line(netEuro)], supplyDate: on(supply) }),
  });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return id as Id<"salesDocuments">;
}

describe("KU limit crossing (KU-01)", () => {
  test("EC-060 the crossing invoice switches to VAT on confirmation; KU ends from its supply; later drafts are re-evaluated, earlier invoices stay KU", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    const earlier = await finalized(t, owner, contactId, 60_000, "2026-08-01");
    await finalized(t, owner, contactId, 39_500, "2026-09-01"); // 99.500 € in 2026
    const crossingValues = invoiceValues(contactId, { lines: [line(1_000)], supplyDate: on("2026-10-05") });
    const laterValues = invoiceValues(contactId, { lines: [line(200)], supplyDate: on("2026-10-10") });
    const { id: crossing } = await owner.mutation(api.invoices.createDraft, { values: crossingValues });
    const { id: later } = await owner.mutation(api.invoices.createDraft, { values: laterValues });

    const before = await owner.query(api.invoices.check, { id: crossing, values: crossingValues });
    expect(before?.taxCase).toBe("kleinunternehmer");
    expect(before?.findings.find((f) => f.code === "ku_threshold_crossed")?.severity).toBe("E");
    // the blocking dialog's confirmation: a new `kleinunternehmer` row from the supply date of this invoice
    expect(await owner.mutation(api.settings.confirmKuLimitCrossed, { documentId: crossing })).toEqual({
      validFrom: "2026-10-05",
    });
    const profile = await t.run((ctx) => ctx.db.query("companyProfile").first());
    expect(profile?.kleinunternehmer).toEqual([
      { validFrom: "2020-01-01", isKU: true },
      { validFrom: "2026-10-05", isKU: false },
    ]);

    // this invoice now carries VAT …
    const now = await owner.query(api.invoices.check, { id: crossing, values: crossingValues });
    expect(now?.taxCase).toBe("domestic");
    expect(now?.findings.map((f) => f.code)).not.toContain("ku_threshold_crossed");
    // … and so does the draft of the later supply (re-evaluated, no KU findings)
    const laterCheck = await owner.query(api.invoices.check, { id: later, values: laterValues });
    expect(laterCheck?.taxCase).toBe("domestic");
    expect(laterCheck?.findings.filter((f) => f.code.startsWith("ku_"))).toEqual([]);
    await owner.action(api.invoices.finalize, { id: crossing, version: 1 });
    await owner.action(api.invoices.finalize, { id: later, version: 1 });
    await settle(t);
    expect(await doc(t, crossing)).toMatchObject({ taxCase: "domestic", totals: { vatCents: 19_000 } });
    expect(await doc(t, later)).toMatchObject({ taxCase: "domestic", totals: { vatCents: 3_800 } });
    // the invoices before the crossing stay KU invoices (no correction)
    expect(await doc(t, earlier)).toMatchObject({ taxCase: "kleinunternehmer", totals: { vatCents: 0 } });
  });
});

describe("Gesamtumsatz (KU-01)", () => {
  test("EC-065 the proceeds of a fixed-asset sale are not counted towards the KU thresholds", async () => {
    const t = makeT();
    const { owner, id: invoiceId } = await finalizedInvoice(t); // 1.000,00 € net, supply 2026-10-09
    expect((await t.run((ctx) => turnoverTotals(ctx, 2026))).gesamtumsatz.currentYearCents).toBe(100_000);
    const asset = await owner.mutation(api.assets.create, {
      name: "Notebook",
      account: "0420",
      acquisitionDate: "2026-01-10",
      costCents: 360_000,
      method: "linear",
      usefulLifeMonths: 36,
      inputVatDeducted: true,
    });
    await owner.mutation(api.assets.dispose, {
      id: asset,
      date: "2026-10-09",
      kind: "sale",
      documentId: invoiceId,
      proceedsCents: 100_000,
    });
    // the invoice is the asset sale → excluded from the Gesamtumsatz
    expect((await t.run((ctx) => turnoverTotals(ctx, 2026))).gesamtumsatz.currentYearCents).toBe(0);
    // its Storno does not take it out a second time
    await owner.mutation(api.corrections.cancel, { id: invoiceId, reason: "Käufer ist zurückgetreten" });
    await settle(t);
    expect((await t.run((ctx) => turnoverTotals(ctx, 2026))).gesamtumsatz.currentYearCents).toBe(0);
  });
});

describe("conversions after contact changes (MISC-03)", () => {
  test("EC-080 a quote to a consumer converted after the contact became a business: current flags, new tax case, notice", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: {
        ranges: [
          CONTACT_RANGE,
          PRODUCT_RANGE,
          INVOICE_RANGE,
          { key: "quote", name: "Angebote", format: "AN-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
        ],
      },
    });
    const person = personForm("Lukas", "Meier", { isConsumer: true });
    const created = await owner.mutation(api.contacts.create, {
      values: createValues(person, {
        address: { street: "Bahnhofstrasse 1", postalCode: "8001", city: "Zürich", countryCode: "CH" },
        email: "lukas.meier@example.ch",
      }),
    });
    const contactId = created.id as Id<"contacts">;
    const { supplyDate: _s, ...noSupply } = invoiceValues(contactId);
    const { id: quote } = await owner.mutation(api.invoices.createDraft, { values: { ...noSupply, type: "quote" } });
    await owner.action(api.invoices.finalize, { id: quote, version: 1 });
    await settle(t);
    // a consumer in Switzerland: place of supply Germany (§ 3a Abs. 1 UStG)
    expect((await doc(t, quote))?.taxCase).toBe("domestic");

    // the contact turns out to be a business
    const contact = await t.run((ctx) => ctx.db.get(contactId));
    await owner.mutation(api.contacts.update, {
      id: contactId,
      version: contact?.version ?? 1,
      values: { ...person, isConsumer: false },
    });
    const r = await owner.mutation(api.documentFlows.convert, {
      id: quote,
      values: { to: "invoice", acceptSource: true },
    });
    const invoice = await doc(t, r.id);
    expect(invoice?.taxCase).toBe("not_taxable_domestic");
    expect(r.notices).toContain(
      `Steuerfall geändert: ${TAX_CASE_LABELS.domestic} → ${TAX_CASE_LABELS.not_taxable_domestic} (Kundendaten geändert)`,
    );
  });
});
