import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { createValues, orgForm, PARIS } from "./catalog.fixtures";
import { finalizedInvoice, INVOICE_RANGE, invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { defaultInvoiceAccount } from "./model/bankAccounts";
import { makeT, type TestT } from "./test.setup";

/**
 * Branch coverage of the Storno / Rechnungskorrektur / chain flows (F04 §4.7/§4.8, convex/model/invoiceCorrections.ts
 * and invoiceChains.ts): guards, optional header fields carried into corrections, chain overviews with a quote root,
 * repeated credits and the live check of unsaved chain/correction drafts.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const CORRECTION_RANGE = {
  key: "correction",
  name: "Rechnungskorrekturen",
  format: "RK-{YYYY}-{####}",
  resetPolicy: "yearly",
  next: 1,
};

type Owner = Awaited<ReturnType<typeof finalizedInvoice>>["owner"];

const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });

const snapshotOf = (t: TestT, d: Doc<"salesDocuments">) =>
  t.run(async (ctx) => {
    const s = d.snapshotId ? await ctx.db.get(d.snapshotId) : null;
    return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
  });

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const fail = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);

async function receive(t: TestT, owner: Owner, id: Id<"salesDocuments">, cents: number) {
  const account = await t.run(async (ctx) => defaultInvoiceAccount(ctx));
  if (!account) throw new Error("no invoice bank account");
  await owner.mutation(api.payments.recordForInvoice, {
    documentId: id,
    source: { kind: "clearing", accountId: account._id },
    date: "2026-10-12",
    amountCents: cents,
  });
}

async function withRanges(owner: Owner, next = 2) {
  await owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [{ ...INVOICE_RANGE, next }, CORRECTION_RANGE] },
  });
}

async function draftValuesOf(owner: Owner, id: Id<"salesDocuments">): Promise<DraftValues> {
  const d = await owner.query(api.invoices.get, { id });
  if (!d || !("values" in d)) throw new Error("not a draft");
  return d.values as unknown as DraftValues;
}

async function finalizeDraft(t: TestT, owner: Owner, id: Id<"salesDocuments">) {
  const r = await owner.action(api.invoices.finalize, { id, version: (await doc(t, id)).version });
  await settle(t);
  return r.number;
}

function advanceValues(contactId: string, net: number, over: Partial<DraftValues> = {}): DraftValues {
  return invoiceValues(contactId, {
    type: "advance_invoice",
    supplyDate: { kind: "date", date: "2026-12-15" as CalendarDate },
    chainOrder: { number: "B-4711", date: "2026-09-01" as CalendarDate },
    paymentTerms: { dueDays: 14 },
    lines: [
      {
        kind: "item",
        productType: "service",
        name: "1. Abschlag Website-Relaunch",
        quantityMilli: 1_000,
        unitCode: "C62",
        unitPriceMicros: net * 100,
        vatRateKey: "standard",
      },
    ],
    ...over,
  });
}

async function finalizedAdvance(t: TestT) {
  const setup = await finalizedInvoice(t);
  await withRanges(setup.owner);
  const { id: advanceId } = await setup.owner.mutation(api.invoices.createDraft, {
    values: advanceValues(setup.personId, 300_000),
  });
  const number = await finalizeDraft(t, setup.owner, advanceId as Id<"salesDocuments">);
  return { ...setup, advanceId: advanceId as Id<"salesDocuments">, advanceNumber: number };
}

async function finalDraft(t: TestT, owner: Owner, fromId: Id<"salesDocuments">, net: number) {
  const { id } = await owner.mutation(api.corrections.createChainDraft, { fromId, type: "final_invoice" });
  const values = await draftValuesOf(owner, id);
  await owner.mutation(api.invoices.updateDraft, {
    id,
    version: (await doc(t, id)).version,
    values: {
      ...values,
      supplyDate: { kind: "date", date: "2026-10-12" },
      lines: values.lines.map((l) => ({ ...l, unitPriceMicros: net * 100 })),
    },
  });
  return id;
}

// ── Storno guards and preview ─────────────────────────────────────────────────────────────────────────────────────

describe("INV-10 Storno preview and guards", () => {
  test("INV-10 the preview of a draft is guarded and shows empty number/date; a draft cannot be cancelled", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const p = await owner.query(api.corrections.cancelPreview, { id });
    expect(p.guard).not.toBeNull();
    expect(p.mirror).toBeNull();
    expect(p.original).toMatchObject({ number: "", documentDate: "", type: "invoice" });
    const e = await fail(owner.mutation(api.corrections.cancel, { id }));
    expect(errorCode(e)).toBe("conflict");
    expect(dataOf(e).reason).toBe(p.guard?.code);
    await settle(t);
  });

  test("EC-DOC-116 a sent invoice: the preview asks to send the Storno as well and suggests the export", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const artifacts = await t.run(async (ctx) =>
      (await ctx.db.query("documentArtifacts").collect()).filter((a) => a.documentId === id),
    );
    await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds: artifacts.map((a) => a._id) },
    });
    const p = await owner.query(api.corrections.cancelPreview, { id });
    expect(p.notice).toBe(
      "Die Rechnung wurde als versendet markiert. Bitte die Stornorechnung ebenfalls versenden und als versendet markieren.",
    );
    expect(p.exportSuggested).toBe(true);
    expect(p.artifactsBlocked).toBe(false);
    // EC-DOC-110: the XML fallback is refused for a sent original.
    const e = await fail(owner.mutation(api.corrections.cancel, { id, einvoiceFallback: true }));
    expect(errorCode(e)).toBe("conflict");
    expect(dataOf(e).reason).toBe("einvoice_fallback_not_allowed");
    await settle(t);
  });

  test("INV-16 an objection to a document that is not a self-billing Gutschrift is refused (OBJECTION_INVALID)", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e = await fail(
      owner.mutation(api.corrections.recordObjection, { id, date: "2026-10-12", text: "Widerspruch des Lieferanten" }),
    );
    expect(errorCode(e)).toBe("invalid_input");
    expect(dataOf(e).reason).toBe("OBJECTION_INVALID");
    expect((await doc(t, id)).status).toBe("draft");
    await settle(t);
  });
});

// ── correction drafts ─────────────────────────────────────────────────────────────────────────────────────────────

describe("INV-12 INV-13 correction drafts", () => {
  test("UST-30 a cancelled invoice and a draft cannot be corrected (correction_target_invalid)", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    await withRanges(owner);
    await owner.mutation(api.corrections.cancel, { id, reason: "Falscher Kunde" });
    const e = await fail(owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "credit" }));
    expect(errorCode(e)).toBe("conflict");
    expect(String(dataOf(e).message)).toContain("RE-2026");
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e2 = await fail(
      owner.mutation(api.corrections.createCorrection, { originalId: draft, kind: "rectification" }),
    );
    expect(errorCode(e2)).toBe("conflict");
    await settle(t);
  });

  test("INV-12 a credit whose changes reduce nothing is refused (correction_not_reducing)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const e = await fail(
      owner.mutation(api.corrections.createCorrection, {
        originalId: id,
        kind: "credit",
        changes: [{ position: 1, quantityMilli: 10_000 }],
      }),
    );
    expect(errorCode(e)).toBe("invalid_input");
    expect(dataOf(e).reason).toBe("correction_not_reducing");
    expect(dataOf(e).message).toBe("Keine Position wurde gemindert. Bitte Menge oder Preis verringern.");
    await settle(t);
  });

  test("INV-13 a Berichtigung copies the header fields, texts and discount; a credit keeps only a percent discount", async () => {
    const t = makeT();
    const setup = await finalizedInvoice(t);
    const { owner, personId } = setup;
    await withRanges(owner);
    const pm = await t.run(async (ctx) => (await ctx.db.query("paymentMethods").collect())[0]);
    const over: Partial<DraftValues> = {
      deliveryAddress: {
        name: "Lager Nord",
        street: "Hafenstraße 5",
        postalCode: "20457",
        city: "Hamburg",
        countryCode: "DE",
      },
      buyerReference: "LEITWEG-991",
      orderReference: "PO-77",
      contractReference: "V-2026-1",
      subject: "Webdesign Oktober",
      headText: "Vielen Dank für Ihren Auftrag.",
      footText: "Mit freundlichen Grüßen",
      documentDiscount: { kind: "percent", valueBp: 1_000, isSurcharge: false, reason: "Treuerabatt" },
      ...(pm ? { paymentMethodId: pm._id } : {}),
      bankAccountId: setup.bankAccount,
    };
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId, over) });
    await finalizeDraft(t, owner, id as Id<"salesDocuments">);

    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    const rv = await draftValuesOf(owner, rect.id);
    expect(rv).toMatchObject({
      type: "correction",
      buyerReference: "LEITWEG-991",
      orderReference: "PO-77",
      contractReference: "V-2026-1",
      subject: "Webdesign Oktober",
      headText: "Vielen Dank für Ihren Auftrag.",
      footText: "Mit freundlichen Grüßen",
      documentDiscount: { kind: "percent", valueBp: 1_000 },
    });
    expect(rv.deliveryAddress?.city).toBe("Hamburg");
    expect((await doc(t, rect.id)).correctionKind).toBe("rectification");

    const credit = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "credit" });
    const cv = await draftValuesOf(owner, credit.id);
    expect(cv.showEpcQr).toBe(false);
    expect(cv.documentDiscount).toMatchObject({ kind: "percent", valueBp: 1_000 });
    expect(cv.subject ?? undefined).toBeUndefined();
    expect(cv.headText ?? undefined).toBeUndefined();
    await settle(t);
  });

  test("INV-12 an amount discount is not carried into a credit (it would not shrink proportionally)", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await withRanges(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        documentDiscount: { kind: "amount", amountCents: 5_000, isSurcharge: false },
        kleinbetrag: false,
      }),
    });
    await finalizeDraft(t, owner, id as Id<"salesDocuments">);
    const credit = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "credit" });
    expect((await draftValuesOf(owner, credit.id)).documentDiscount).toBeUndefined();
    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    expect((await draftValuesOf(owner, rect.id)).documentDiscount).toMatchObject({
      kind: "amount",
      amountCents: 5_000,
    });
    await settle(t);
  });

  test("RI-07 a second credit sees the first in its original context; both reduce the open amount", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await withRanges(owner);
    const c1 = await owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "credit",
      changes: [{ position: 1, quantityMilli: 8_000 }],
    });
    await finalizeDraft(t, owner, c1.id);
    const c2 = await owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "credit",
      changes: [{ position: 1, quantityMilli: 9_000 }],
    });
    // the live check of the second draft runs with the earlier correction in its original context
    const check = await owner.query(api.invoices.check, { id: c2.id, values: await draftValuesOf(owner, c2.id) });
    expect(check?.totals?.grossCents).toBe(-11_900);
    await finalizeDraft(t, owner, c2.id);
    const s = await snapshotOf(t, await doc(t, c2.id));
    expect(JSON.stringify(s)).toContain("RK-2026-0001");
    const original = await doc(t, id);
    expect(original.openAmountCents).toBe(119_000 - 23_800 - 11_900);
    await settle(t);
  });
});

// ── chains ────────────────────────────────────────────────────────────────────────────────────────────────────────

describe("INV-03 INV-06 INV-07 chain actions", () => {
  test("EC-071 reduceAdvance: only for issued advances, not when unpaid (use Storno) or already settled", async () => {
    const t = makeT();
    const { owner, id, advanceId, personId } = await finalizedAdvance(t);
    const plain = await fail(owner.mutation(api.corrections.reduceAdvance, { advanceId: id as Id<"salesDocuments"> }));
    expect(errorCode(plain)).toBe("conflict");
    expect(dataOf(plain).reason).toBe("illegal_transition");
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: advanceValues(personId, 1_000) });
    expect(dataOf(await fail(owner.mutation(api.corrections.reduceAdvance, { advanceId: draft }))).reason).toBe(
      "illegal_transition",
    );
    const unpaid = await fail(owner.mutation(api.corrections.reduceAdvance, { advanceId }));
    expect(dataOf(unpaid).reason).toBe("advance_unpaid_use_storno");
    expect(String(dataOf(unpaid).message)).toContain("Bitte stornieren statt mindern.");
    await receive(t, owner, advanceId, 357_000);
    const settled = await fail(owner.mutation(api.corrections.reduceAdvance, { advanceId }));
    expect(dataOf(settled).reason).toBe("settled");
    expect(String(dataOf(settled).message)).toContain("ist bereits ausgeglichen");
    await settle(t);
  });

  test("INV-06 createChainDraft only from an issued chain document; a plain invoice or draft is refused", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedAdvance(t);
    const e = await fail(owner.mutation(api.corrections.createChainDraft, { fromId: id, type: "advance_invoice" }));
    expect(errorCode(e)).toBe("conflict");
    expect(dataOf(e).message).toBe("Nur aus einer fertiggestellten Abschlagsrechnung möglich.");
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: advanceValues(personId, 1_000) });
    const e2 = await fail(owner.mutation(api.corrections.createChainDraft, { fromId: draft, type: "final_invoice" }));
    expect(dataOf(e2).reason).toBe("illegal_transition");
    // a plain invoice has no chain overview
    expect((await owner.query(api.corrections.relations, { id }))?.chain).toBeNull();
    await settle(t);
  });

  test("INV-09 after the final invoice the advance is listed as deducted; a further advance sees the final", async () => {
    const t = makeT();
    const { owner, advanceId } = await finalizedAdvance(t);
    await receive(t, owner, advanceId, 357_000);
    const finalId = await finalDraft(t, owner, advanceId, 1_000_000);
    const finalNumber = await finalizeDraft(t, owner, finalId);
    const rel = await owner.query(api.corrections.relations, { id: advanceId });
    expect(rel?.chain?.advances[0]).toMatchObject({ resolution: "deducted", deductedInNumber: finalNumber });
    expect(rel?.chain?.canCreateFinal).toBe(false);
    expect(rel?.chain?.finals).toEqual([expect.objectContaining({ id: finalId, number: finalNumber })]);
    // a further advance draft of the chain: its check runs with the deducted advance and the other final
    const { id: more } = await owner.mutation(api.corrections.createChainDraft, {
      fromId: advanceId,
      type: "advance_invoice",
    });
    const mv = await draftValuesOf(owner, more);
    expect(mv.lines[0]?.name).toBe("Abschlag laut Auftrag B-4711");
    const check = await owner.query(api.invoices.check, {
      id: more,
      values: { ...mv, lines: mv.lines.map((l) => ({ ...l, unitPriceMicros: 100_000_000 })) },
    });
    expect(check?.totals?.grossCents).toBe(1_190_000);
    const relMore = await owner.query(api.corrections.relations, { id: more });
    expect(relMore?.chain?.drafts).toEqual([]);
    expect(relMore?.chain?.advances[0]?.resolution).toBe("deducted");
    // the Storno of the final releases the advance; the register keeps the cancelled final
    await owner.mutation(api.corrections.cancel, { id: finalId });
    const relAfter = await owner.query(api.corrections.relations, { id: advanceId });
    expect(relAfter?.chain?.advances[0]?.resolution).toBe("settled");
    expect(relAfter?.chain?.finals).toEqual([]);
    expect(relAfter?.chain?.drafts.map((d) => d.id)).toEqual([more]);
    await settle(t);
  });

  test("INV-03 the live check of an unsaved advance without chain order or id has no chain context", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedAdvance(t);
    const unsaved = await owner.query(api.invoices.check, {
      values: advanceValues(personId, 100_000, { chainOrder: undefined }),
    });
    expect(unsaved).not.toBeNull();
    const withOrder = await owner.query(api.invoices.check, { values: advanceValues(personId, 100_000) });
    expect(withOrder?.totals?.grossCents).toBe(119_000);
    // an unsaved correction has no original
    const corr = await owner.query(api.invoices.check, {
      values: { ...invoiceValues(personId), type: "correction" },
    });
    expect(corr).not.toBeNull();
    await settle(t);
  });
});

// ── header variants carried into Storno and corrections ──────────────────────────────────────────────────────────

describe("INV-10 INV-13 header variants", () => {
  test("INV-10 MISC-08 the Storno and the Berichtigung of a USD invoice keep the currency and the manual rate", async () => {
    const t = makeT();
    const { owner, personId, bankAccount } = await finalizedInvoice(t);
    await withRanges(owner);
    const fx = {
      rate: "1.19",
      source: "manual" as const,
      sourceText: "Kurs laut Auftrag",
      date: "2026-10-12" as CalendarDate,
    };
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        currency: "USD",
        fxRateToEur: fx,
        paymentTerms: { dueDays: 30 },
        bankAccountId: bankAccount,
        showEpcQr: false,
      }),
    });
    await finalizeDraft(t, owner, id as Id<"salesDocuments">);
    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    const rv = await draftValuesOf(owner, rect.id);
    expect(rv.currency).toBe("USD");
    expect(rv.fxRateToEur).toMatchObject({ rate: "1.19", source: "manual" });
    await owner.mutation(api.invoices.deleteDraft, { id: rect.id });
    const r = await owner.mutation(api.corrections.cancel, { id, reason: "Doppelt erstellt" });
    const storno = await doc(t, r.id);
    expect(storno).toMatchObject({ type: "cancellation", currency: "USD", correctsId: id });
    expect(storno.fxRateToEur).toMatchObject({ rate: "1.19", source: "manual" });
    await settle(t);
  });

  test("INV-10 UST-08 an invoice dated by its document date (no explicit supply date) can be cancelled and rectified", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await withRanges(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { supplyDateMode: "document_date", supplyDate: undefined }),
    });
    await finalizeDraft(t, owner, id as Id<"salesDocuments">);
    const original = await doc(t, id as Id<"salesDocuments">);
    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    const rv = await draftValuesOf(owner, rect.id);
    // the correction always states the supply date explicitly (UST-08), taken over from the original
    expect(rv.supplyDateMode).toBe("explicit");
    expect(rv.supplyDate).toEqual(original.supplyDate);
    await owner.mutation(api.invoices.deleteDraft, { id: rect.id });
    const r = await owner.mutation(api.corrections.cancel, { id });
    expect((await doc(t, r.id)).supplyDate).toEqual(original.supplyDate);
    expect((await doc(t, id as Id<"salesDocuments">)).status).toBe("cancelled");
    await settle(t);
  });

  test("UST-21 INV-13 a Berichtigung of an intra-Community supply keeps the tax-case override with its reason", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    await withRanges(owner);
    const fr = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Société Exemple SARL", { vatId: "FR40303265045" }), {
        address: { ...PARIS },
        email: "factures@exemple.fr",
      }),
    });
    const base = invoiceValues(fr.id);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: {
        ...base,
        lines: base.lines.map((l) => (l.kind === "item" ? { ...l, productType: "good" as const, unitCode: "H87" } : l)),
        taxCaseOverride: { taxCase: "intra_community_supply" as const, reason: "Lieferung nach Frankreich" },
        deliveryAddress: { name: "Société Exemple SARL", ...PARIS },
      },
    });
    await owner.action(api.invoices.finalize, {
      id,
      version: 1,
      overrides: { vatCheck: { reason: "Prüfung wird nachgeholt" } },
    });
    await settle(t);
    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    expect((await draftValuesOf(owner, rect.id)).taxCaseOverride).toEqual({
      taxCase: "intra_community_supply",
      reason: "Lieferung nach Frankreich",
    });
    await settle(t);
  });

  test("UST-14 INV-13 the Kleinbetrag, property and construction flags are carried into the Berichtigung", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await withRanges(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        kleinbetrag: true,
        propertyRelated: true,
        constructionWork: true,
        lines: [
          {
            kind: "item",
            productType: "service",
            name: "Kleinreparatur",
            quantityMilli: 1_000,
            unitCode: "C62",
            unitPriceMicros: 1_000_000,
            vatRateKey: "standard",
          },
        ],
      }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    expect(await draftValuesOf(owner, rect.id)).toMatchObject({
      kleinbetrag: true,
      propertyRelated: true,
      constructionWork: true,
    });
    await settle(t);
  });

  test("RI-07 a third credit lists both earlier corrections in its original context (oldest first)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await withRanges(owner);
    for (const q of [9_000, 8_000, 7_000]) {
      const c = await owner.mutation(api.corrections.createCorrection, {
        originalId: id,
        kind: "credit",
        changes: [{ position: 1, quantityMilli: q }],
      });
      await finalizeDraft(t, owner, c.id);
    }
    const credits = await t.run(async (ctx) =>
      (await ctx.db.query("salesDocuments").collect()).filter((d) => d.correctsId === id && d.type === "correction"),
    );
    expect(credits.map((c) => c.number).sort()).toEqual(["RK-2026-0001", "RK-2026-0002", "RK-2026-0003"]);
    const third = credits.find((c) => c.number === "RK-2026-0003") as Doc<"salesDocuments">;
    const s = JSON.stringify(await snapshotOf(t, third));
    expect(s).toContain("RK-2026-0001");
    expect(s).toContain("RK-2026-0002");
    expect((await doc(t, id)).openAmountCents).toBe(119_000 - 11_900 - 23_800 - 35_700);
    await settle(t);
  });

  test("UST-41 an advance needs an order reference and a final invoice needs an advance; the draft has no order", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await withRanges(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: advanceValues(personId, 100_000, { chainOrder: undefined }),
    });
    const e = await fail(owner.action(api.invoices.finalize, { id, version: 1 }));
    expect(errorCode(e)).toBe("validation_failed");
    expect((dataOf(e).findings as { code: string }[]).map((f) => f.code)).toContain("chain_reference_missing");
    const rel = await owner.query(api.corrections.relations, { id });
    expect(rel?.chain).toMatchObject({ rootId: id, order: null, advances: [], finals: [], canCreateFinal: false });
    const { id: fin } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        type: "final_invoice",
        chainOrder: { number: "B-1", date: "2026-09-01" as CalendarDate },
      }),
    });
    const e2 = await fail(owner.action(api.invoices.finalize, { id: fin, version: 1 }));
    expect((dataOf(e2).findings as { code: string }[]).map((f) => f.code)).toContain("final_without_advances");
    expect((await doc(t, fin as Id<"salesDocuments">)).status).toBe("draft");
    await settle(t);
  });
});

// ── chains rooted in a quote / order confirmation ────────────────────────────────────────────────────────────────

const OWNER_CTX = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const letterRange = (key: string, name: string, prefix: string) => ({
  key,
  name,
  format: `${prefix}-{YYYY}-{####}`,
  resetPolicy: "yearly",
  next: 1,
});

/** The advance → order link the conversion slice sets (`chainRootId`), written through the model layer. */
const linkToRoot = (t: TestT, id: Id<"salesDocuments">, rootId: Id<"salesDocuments">) =>
  t.model(OWNER_CTX, (ctx) =>
    auditedPatch(ctx, "salesDocuments", id, { chainRootId: rootId }, { action: "document.create_chain_draft" }),
  );

describe("INV-03 chains rooted in a quote or order confirmation", () => {
  test("INV-03 an advance of an accepted quote refers to the quote; the overview shows the quote as the order", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: {
        ranges: [
          { ...INVOICE_RANGE, next: 2 },
          CORRECTION_RANGE,
          letterRange("quote", "Angebote", "AN"),
          letterRange("order_confirmation", "Auftragsbestätigungen", "AB"),
        ],
      },
    });
    const { id: quoteId } = await owner.mutation(api.invoices.createDraft, {
      values: { ...invoiceValues(personId), type: "quote", supplyDate: undefined },
    });
    const quoteNumber = await finalizeDraft(t, owner, quoteId as Id<"salesDocuments">);
    const { id: advId } = await owner.mutation(api.invoices.createDraft, {
      values: advanceValues(personId, 300_000, { chainOrder: undefined }),
    });
    await linkToRoot(t, advId as Id<"salesDocuments">, quoteId as Id<"salesDocuments">);
    const draftRel = await owner.query(api.corrections.relations, { id: advId });
    expect(draftRel?.chain).toMatchObject({ rootId: quoteId, order: { number: quoteNumber, date: "2026-10-12" } });
    // UST-40: 3.000,00 € net exceed the quote's 1.000,00 € (the quote's groups are the order value)
    const over = await owner.query(api.invoices.check, { id: advId, values: await draftValuesOf(owner, advId) });
    expect(JSON.stringify(over?.findings)).toContain("partial_exceeds_order");
    const v = await draftValuesOf(owner, advId);
    await owner.mutation(api.invoices.updateDraft, {
      id: advId,
      version: (await doc(t, advId as Id<"salesDocuments">)).version,
      values: { ...v, lines: v.lines.map((l) => ({ ...l, unitPriceMicros: 5_000_000 })) },
    });
    await finalizeDraft(t, owner, advId as Id<"salesDocuments">);
    const s = await snapshotOf(t, await doc(t, advId as Id<"salesDocuments">));
    expect(s?.notes.find((n) => n.id === "advance_info")?.de).toContain(quoteNumber);
    const { id: fin } = await owner.mutation(api.corrections.createChainDraft, {
      fromId: advId,
      type: "final_invoice",
    });
    expect((await draftValuesOf(owner, fin)).lines[0]?.name).toBe(`Gesamtleistung laut Auftrag ${quoteNumber}`);
    await settle(t);
  });

  test("INV-03 a chain whose order confirmation is still a draft has no order reference", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    await withRanges(owner);
    const { id: ocId } = await owner.mutation(api.invoices.createDraft, {
      values: { ...invoiceValues(personId), type: "order_confirmation" },
    });
    const { id: advId } = await owner.mutation(api.invoices.createDraft, {
      values: advanceValues(personId, 300_000, { chainOrder: undefined }),
    });
    await linkToRoot(t, advId as Id<"salesDocuments">, ocId as Id<"salesDocuments">);
    const rel = await owner.query(api.corrections.relations, { id: advId });
    expect(rel?.chain).toMatchObject({ rootId: ocId, order: null, advances: [], canCreateFinal: false });
    const check = await owner.query(api.invoices.check, { id: advId, values: await draftValuesOf(owner, advId) });
    expect(check).not.toBeNull();
    await settle(t);
  });
});
