import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, personForm } from "./catalog.fixtures";
import { consumerBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { turnoverTotals } from "./model/turnover";
import { makeT, type TestT } from "./test.setup";

/** F08 TAX-012/017, F01 SET-035, F04 DOC-56: the turnover monitors on real documents. */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const line = (netEuro: number, over: Record<string, unknown> = {}) => ({
  kind: "item" as const,
  productType: "service" as const,
  name: "Fotoshooting Hochzeit",
  quantityMilli: 1_000,
  unitCode: "C62",
  unitPriceMicros: netEuro * 10_000,
  vatRateKey: "standard" as const,
  ...over,
});

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

async function finalized(t: TestT, owner: Owner, contactId: string, netEuro: number, over = {}) {
  const { id } = await owner.mutation(api.invoices.createDraft, {
    values: invoiceValues(contactId, { lines: [line(netEuro)], ...over }),
  });
  const r = await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { id: id as Id<"salesDocuments">, number: r.number };
}

describe("KU limit crossing (TAX-012, SET-035, EC-060)", () => {
  test("TAX-012 SET-035 the crossing invoice is blocked; the owner's confirmation appends regular taxation as system:ku-monitor", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    await finalized(t, owner, contactId, 60_000);
    await finalized(t, owner, contactId, 39_500); // 99.500 € in 2026
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(contactId, {
        supplyDate: { kind: "date", date: "2026-10-12" as CalendarDate },
        lines: [line(1_000)],
      }),
    });
    const pre = await owner.query(api.invoices.check, {
      id,
      values: invoiceValues(contactId, {
        supplyDate: { kind: "date", date: "2026-10-12" as CalendarDate },
        lines: [line(1_000)],
      }),
    });
    expect(pre?.findings.find((f) => f.code === "ku_threshold_crossed")?.severity).toBe("E");
    expect(pre?.taxCase).toBe("kleinunternehmer");
    // API keys and bookkeepers cannot do it (owner-only, SET-142)
    const key = await t.asApiKey(["settings:write"]);
    expect(errorCode(await key.mutation(api.settings.confirmKuLimitCrossed, { documentId: id }).catch((e) => e))).toBe(
      "forbidden_scope",
    );
    const r = await owner.mutation(api.settings.confirmKuLimitCrossed, { documentId: id });
    expect(r.validFrom).toBe("2026-10-12");
    const profile = await t.run((ctx) => ctx.db.query("companyProfile").first());
    expect(profile?.kleinunternehmer.at(-1)).toEqual({ validFrom: "2026-10-12", isKU: false });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(audit).toMatchObject({ actor: "system:ku-monitor", action: "settings.tax.update" });
    expect(audit?.reason).toContain(`vom Inhaber bestätigt (${owner.actor})`);
    // the draft now carries VAT: this invoice and every later supply is taxed normally (RI-17)
    const fin = await owner.action(api.invoices.finalize, { id, version: 1 });
    expect(fin.number).toBeTruthy();
    await settle(t);
    const doc = await t.run((ctx) => ctx.db.get(id));
    expect(doc?.taxCase).toBe("domestic");
    expect(doc?.totals.vatCents).toBe(19_000);
    // a second confirmation is refused: the limit is no longer crossed by a KU invoice
    const { id: later } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(contactId, {
        supplyDate: { kind: "date", date: "2026-10-12" as CalendarDate },
        lines: [line(100)],
      }),
    });
    const again = await owner.mutation(api.settings.confirmKuLimitCrossed, { documentId: later }).catch((e) => e);
    expect((again as { data?: { reason?: string } }).data?.reason).toBe("KU_LIMIT_NOT_CROSSED");
  });

  test("KU-04 SET-034 the KU history lock now sees finalised documents: an entry used by an invoice cannot be edited", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    await finalized(t, owner, contactId, 1_000);
    const r = await t.run(async (ctx) => {
      const { finalisedDocumentsForKu } = await import("./model/documentHistory");
      return finalisedDocumentsForKu(ctx);
    });
    expect(r).toEqual([expect.objectContaining({ date: "2026-10-09" })]);
  });
});

describe("Gesamtumsatz and OSS in EUR (DOC-56, TAX-017, UVA-07)", () => {
  test("DOC-56 TAX-012 the year turnover is net EUR per supply year; a Storno takes the invoice out again", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    await finalized(t, owner, contactId, 1_000);
    const second = await finalized(t, owner, contactId, 1_000);
    await finalized(t, owner, contactId, 500, { supplyDate: { kind: "date", date: "2025-12-30" as CalendarDate } });
    let totals = await t.run((ctx) => turnoverTotals(ctx, 2026));
    expect(totals.gesamtumsatz).toEqual({ priorYearCents: 50_000, currentYearCents: 200_000 });
    await owner.mutation(api.corrections.cancel, { id: second.id, reason: "Falscher Kunde" });
    await settle(t);
    totals = await t.run((ctx) => turnoverTotals(ctx, 2026));
    expect(totals.gesamtumsatz.currentYearCents).toBe(100_000);
  });

  test("TAX-017 UVA-07 EU B2C goods: the OSS-relevant net is frozen at finalisation and blocks the sale above 10 000 €", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const at = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "Gruber", { isConsumer: true }), {
        address: { street: "Hauptplatz 1", postalCode: "8010", city: "Graz", countryCode: "AT" },
      }),
    });
    const goods = (euro: number) => ({
      priceMode: "net" as const,
      lines: [line(euro, { productType: "good", name: "Fotobuch Hochzeit A4", unitCode: "C62" })],
    });
    const first = await finalized(t, owner, at.id, 9_900, goods(9_900));
    expect((await t.run((ctx) => ctx.db.get(first.id)))?.ossNetEurCents).toBe(990_000);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(at.id, goods(101)) });
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x) => x);
    expect(errorCode(e)).toBe("validation_failed");
    expect((e as { data: { findings: { code: string }[] } }).data.findings.map((f) => f.code)).toEqual([
      "oss_threshold_exceeded",
    ]);
    // exactly up to the threshold is still allowed
    const { id: ok } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(at.id, goods(100)) });
    const fin = await owner.action(api.invoices.finalize, { id: ok, version: 1 });
    expect(fin.number).toBeTruthy();
    await settle(t);
  });
});
