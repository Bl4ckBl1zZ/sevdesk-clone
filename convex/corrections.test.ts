import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { orgForm } from "./catalog.fixtures";
import { finalizedInvoice, INVOICE_RANGE, invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { recordStandInPayment } from "./model/settlement";
import { makeT, type TestT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

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

const snapshot = (t: TestT, d: Doc<"salesDocuments">) =>
  t.run(async (ctx) => {
    const s = d.snapshotId ? await ctx.db.get(d.snapshotId) : null;
    return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
  });

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

/** Stand-in for the payments slice: an allocation sets open amount and payment status (03 §4, F05 §4.3). */
async function receive(t: TestT, owner: Owner, id: Id<"salesDocuments">, cents: number) {
  await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => recordStandInPayment(ctx, id, cents));
}

async function withCorrectionRange(owner: Owner) {
  await owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [{ ...INVOICE_RANGE, next: 2 }, CORRECTION_RANGE] },
  });
}

const journal = (t: TestT) => t.run((ctx) => ctx.db.query("journalEntries").collect());

// ── Storno ──────────────────────────────────────────────────────────────────────────────────────────────────────

describe("INV-10 INV-11 Storno", { timeout: 30_000 }, () => {
  test("INV-10 RI-06 the Storno of an unpaid invoice mirrors it, cancels the original and reverses the entry (S12)", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    const preview = await owner.query(api.corrections.cancelPreview, { id, reason: "Doppelt erstellt" });
    expect(preview.guard).toBeNull();
    expect(preview.mirror?.totals.grossCents).toBe(-119_000);
    expect(preview.notice).toContain("muss nicht versendet werden");
    const r = await owner.mutation(api.corrections.cancel, { id, reason: "Doppelt erstellt" });
    await settle(t);
    expect(r.number).toBe("RE-2026-0002");
    const storno = await doc(t, r.id);
    expect(storno).toMatchObject({
      type: "cancellation",
      status: "finalized",
      correctsId: id,
      artifactStatus: "ready",
    });
    const s = await snapshot(t, storno);
    expect(s?.totals.grossCents).toBe(-119_000);
    expect(s?.references.precedingInvoices).toContainEqual({ number, date: "2026-10-12", role: "original" });
    expect(s?.texts.headText).toBe("Grund der Stornierung: Doppelt erstellt");
    const original = await doc(t, id);
    expect(original).toMatchObject({ status: "cancelled", openAmountCents: 0 });
    expect(original.cancellation?.byDocumentId).toBe(r.id);
    const register = await t.run((ctx) =>
      ctx.db
        .query("numberRegister")
        .withIndex("by_normalized", (q) => q.eq("normalized", number))
        .first(),
    );
    expect(register?.status).toBe("cancelled_by_storno");
    const entries = await journal(t);
    expect(entries).toHaveLength(2);
    const reversal = entries.find((e) => e.reversalOfId);
    expect(reversal?.source).toMatchObject({ kind: "salesDocument", id: r.id });
  });

  test("INV-11 EC-074 a (partly) paid invoice cannot be cancelled (storno_paid_invoice)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await receive(t, owner, id, 10_000);
    const preview = await owner.query(api.corrections.cancelPreview, { id });
    expect(preview.guard?.code).toBe("storno_paid_invoice");
    const e = await owner.mutation(api.corrections.cancel, { id }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("conflict");
    expect(dataOf(e).reason).toBe("storno_paid_invoice");
    expect((await doc(t, id)).status).not.toBe("cancelled");
  });

  test("EC-075 a Storno cannot be cancelled and an invoice cannot be cancelled twice", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const r = await owner.mutation(api.corrections.cancel, { id });
    const again = await owner.mutation(api.corrections.cancel, { id }).catch((x: unknown) => x);
    expect(dataOf(again).reason).toBe("already_cancelled");
    const ofStorno = await owner.mutation(api.corrections.cancel, { id: r.id }).catch((x: unknown) => x);
    expect(dataOf(ofStorno).reason).toBe("storno_of_storno");
  });

  test("INV-10 the Storno date may not lie before the original or in the future", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const e = await owner.mutation(api.corrections.cancel, { id, documentDate: "2026-10-13" }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("invalid_input");
  });
});

// ── Rechnungskorrektur / Rechnungsberichtigung ──────────────────────────────────────────────────────────────────

describe("INV-12 INV-13 INV-15 corrections", { timeout: 30_000 }, () => {
  test("INV-12 a credit of a paid invoice: negative delta, RK number, refund owed, S13 posting", async () => {
    const t = makeT();
    const { owner, id, number } = await finalizedInvoice(t);
    await withCorrectionRange(owner);
    await receive(t, owner, id, 119_000);
    const { id: cid } = await owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "credit",
      changes: [{ position: 1, quantityMilli: 8_000 }],
    });
    const draft = await doc(t, cid);
    expect(draft).toMatchObject({ type: "correction", correctionKind: "credit", correctsId: id, status: "draft" });
    expect(draft.totals.grossCents).toBe(-23_800);
    const r = await owner.action(api.invoices.finalize, { id: cid, version: draft.version });
    await settle(t);
    expect(r.number).toBe("RK-2026-0001");
    const c = await doc(t, cid);
    expect(c).toMatchObject({ openAmountCents: -23_800, paymentStatus: "open", creditAppliedCents: 0 });
    const s = await snapshot(t, c);
    expect(s?.correctionKind).toBe("credit");
    expect(s?.references.precedingInvoices).toContainEqual({ number, date: "2026-10-12", role: "original" });
    const entries = await journal(t);
    expect(entries.find((e) => e.source.id === cid)?.explanation).toBe("S13");
    // INV-11 → INV-15: the paid original still cannot be cancelled; the unrefunded credit can.
    const preview = await owner.query(api.corrections.cancelPreview, { id: cid });
    expect(preview.guard).toBeNull();
  });

  test("INV-12 §4.2.5 a credit of an unpaid invoice reduces its open amount; its Storno gives it back (INV-15)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await withCorrectionRange(owner);
    const { id: cid } = await owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "credit",
      changes: [{ position: 1, unitPriceMicros: 900_000 }],
    });
    await owner.action(api.invoices.finalize, { id: cid, version: (await doc(t, cid)).version });
    expect((await doc(t, id)).openAmountCents).toBe(119_000 - 11_900);
    expect((await doc(t, cid)).paymentStatus).toBeUndefined();
    const blocked = await owner.query(api.corrections.cancelPreview, { id });
    expect(blocked.guard?.code).toBe("storno_has_corrections");
    await owner.mutation(api.corrections.cancel, { id: cid, reason: "Irrtum" });
    expect((await doc(t, id)).openAmountCents).toBe(119_000);
    await settle(t);
  });

  test("INV-12 RI-07 T-EC-065 credits beyond the invoice are blocked (correction_exceeds_original)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    await withCorrectionRange(owner);
    const full = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "credit" });
    await owner.action(api.invoices.finalize, { id: full.id, version: (await doc(t, full.id)).version });
    const more = await owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "credit",
      changes: [{ position: 1, quantityMilli: 9_000 }],
    });
    const e = await owner
      .action(api.invoices.finalize, { id: more.id, version: (await doc(t, more.id)).version })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("validation_failed");
    expect((dataOf(e).findings as { code: string }[]).map((f) => f.code)).toContain("correction_exceeds_original");
    await settle(t);
  });

  test("INV-13 a Berichtigung of the buyer's VAT ID: same amounts, TypeCode-384 data, no journal entry", async () => {
    const t = makeT();
    const { owner, id, orgId, number } = await finalizedInvoice(t);
    await withCorrectionRange(owner);
    const c = await owner.query(api.contacts.get, { id: orgId });
    await owner.mutation(api.contacts.update, {
      id: orgId,
      version: c?.contact.version ?? 1,
      values: orgForm("Beispiel Kunde GmbH", { number: "K-10023", vatId: "DE136695976" }),
    });
    const { id: rid } = await owner.mutation(api.corrections.createCorrection, {
      originalId: id,
      kind: "rectification",
    });
    const before = (await journal(t)).length;
    const r = await owner.action(api.invoices.finalize, { id: rid, version: (await doc(t, rid)).version });
    await settle(t);
    expect(r.number).toBe("RK-2026-0001");
    const rect = await doc(t, rid);
    expect(rect.rectifiedFields).toEqual(["buyer.vatId"]);
    expect(rect.paymentStatus).toBeUndefined();
    const s = await snapshot(t, rect);
    expect(s?.totals.grossCents).toBe(119_000);
    expect(s?.rectifiedFields).toEqual(["USt-IdNr. des Leistungsempfängers"]);
    expect((await journal(t)).length).toBe(before);
    const register = await t.run((ctx) =>
      ctx.db
        .query("numberRegister")
        .withIndex("by_normalized", (q) => q.eq("normalized", number))
        .first(),
    );
    expect(register?.status).toBe("corrected");
    expect((await doc(t, id)).openAmountCents).toBe(119_000);
  });

  test("UST-30 a correction of a correction or of a Storno is refused (correction_target_invalid)", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const s = await owner.mutation(api.corrections.cancel, { id });
    const e = await owner
      .mutation(api.corrections.createCorrection, { originalId: s.id, kind: "credit" })
      .catch((x: unknown) => x);
    expect(dataOf(e).reason).toBe("correction_target_invalid");
    await settle(t);
  });
});

// ── advance → final ─────────────────────────────────────────────────────────────────────────────────────────────

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
  const { owner, personId } = setup;
  await withCorrectionRange(owner);
  const { id: advanceId } = await owner.mutation(api.invoices.createDraft, {
    values: advanceValues(personId, 300_000),
  });
  const r = await owner.action(api.invoices.finalize, { id: advanceId, version: 1 });
  return { ...setup, advanceId, advanceNumber: r.number };
}

async function finalDraft(t: TestT, owner: Owner, fromId: Id<"salesDocuments">, net: number) {
  const { id } = await owner.mutation(api.corrections.createChainDraft, { fromId, type: "final_invoice" });
  const d = await doc(t, id);
  const values = ((await owner.query(api.invoices.get, { id })) as unknown as { values: DraftValues }).values;
  const lines = values.lines.map((l) => ({ ...l, unitPriceMicros: net * 100 }));
  await owner.mutation(api.invoices.updateDraft, {
    id,
    version: d.version,
    values: { ...values, supplyDate: { kind: "date", date: "2026-10-12" }, lines },
  });
  return id;
}

describe("INV-03 INV-06 INV-07 advance and final invoices", { timeout: 30_000 }, () => {
  test("INV-03 UST-40 S9 a standalone advance: chain order note, no journal entry, open receivable", async () => {
    const t = makeT();
    const { advanceId, advanceNumber } = await finalizedAdvance(t);
    await settle(t);
    const a = await doc(t, advanceId);
    expect(advanceNumber).toBe("RE-2026-0002");
    expect(a).toMatchObject({ status: "finalized", paymentStatus: "open", openAmountCents: 357_000 });
    const s = await snapshot(t, a);
    expect(s?.notes.find((n) => n.id === "advance_info")?.de).toContain("1. Abschlagsrechnung zu Auftrag B-4711");
    expect((await journal(t)).some((e) => e.source.id === advanceId)).toBe(false);
  });

  test("INV-06 INV-09 RI-08 a paid advance is deducted in the final invoice with the received amounts (S11)", async () => {
    const t = makeT();
    const { owner, advanceId, advanceNumber } = await finalizedAdvance(t);
    await receive(t, owner, advanceId, 357_000);
    const finalId = await finalDraft(t, owner, advanceId, 1_000_000);
    const r = await owner.action(api.invoices.finalize, { id: finalId, version: (await doc(t, finalId)).version });
    await settle(t);
    const f = await doc(t, finalId);
    expect(f.deductions).toEqual([
      expect.objectContaining({ advanceId, advanceNumber, deductedGrossCents: 357_000, partiallyPaid: false }),
    ]);
    expect(f.totals).toMatchObject({
      grossCents: 1_190_000,
      advancesDeductedGrossCents: 357_000,
      payableCents: 833_000,
    });
    expect(f.openAmountCents).toBe(833_000);
    expect((await doc(t, advanceId)).deductedInId).toBe(finalId);
    const s = await snapshot(t, f);
    expect(s?.references.precedingInvoices).toContainEqual({
      number: advanceNumber,
      date: "2026-10-12",
      role: "advance",
    });
    expect((await journal(t)).find((e) => e.source.id === finalId)?.explanation).toBe("S11");
    expect(r.number).toMatch(/^RE-2026-/);
    // INV-10 storno_advance_deducted: the deducted advance cannot be cancelled while the final stands.
    const g = await owner.query(api.corrections.cancelPreview, { id: advanceId });
    expect(g.guard?.code).toBe("storno_advance_deducted");
    // The Storno of the final releases the advance again.
    await owner.mutation(api.corrections.cancel, { id: finalId });
    expect((await doc(t, advanceId)).deductedInId).toBeUndefined();
    await settle(t);
  });

  test("INV-07 EC-071 an unpaid advance blocks the final (advance_not_settled); its Storno resolves it", async () => {
    const t = makeT();
    const { owner, advanceId, personId } = await finalizedAdvance(t);
    const { id: second } = await owner.mutation(api.corrections.createChainDraft, {
      fromId: advanceId,
      type: "advance_invoice",
    });
    const values = ((await owner.query(api.invoices.get, { id: second })) as unknown as { values: DraftValues }).values;
    await owner.mutation(api.invoices.updateDraft, {
      id: second,
      version: (await doc(t, second)).version,
      values: {
        ...advanceValues(personId, 200_000),
        chainOrder: undefined,
        lines: values.lines.map((l) => ({ ...l, unitPriceMicros: 200_000 * 100 })),
      },
    });
    await owner.action(api.invoices.finalize, { id: second, version: (await doc(t, second)).version });
    const s2 = await snapshot(t, await doc(t, second));
    expect(s2?.notes.find((n) => n.id === "advance_info")?.de).toContain("2. Abschlagsrechnung zu Auftrag B-4711");
    await receive(t, owner, second, 238_000);
    const finalId = await finalDraft(t, owner, advanceId, 1_000_000);
    const e = await owner
      .action(api.invoices.finalize, { id: finalId, version: (await doc(t, finalId)).version })
      .catch((x: unknown) => x);
    expect((dataOf(e).findings as { code: string }[]).map((f) => f.code)).toContain("advance_not_settled");
    const overview = await owner.query(api.corrections.relations, { id: finalId });
    expect(overview?.chain?.advances.map((a) => a.resolution)).toEqual(["storno", "settled"]);
    await owner.mutation(api.corrections.cancel, { id: advanceId, reason: "Nicht gezahlt" });
    await owner.action(api.invoices.finalize, { id: finalId, version: (await doc(t, finalId)).version });
    const f = await doc(t, finalId);
    expect(f.deductions?.map((d) => d.advanceId)).toEqual([second]);
    expect(f.totals.payableCents).toBe(1_190_000 - 238_000);
    await settle(t);
  });

  test("INV-07 EC-071 a partially paid advance is reduced to the received amount and then deducted", async () => {
    const t = makeT();
    const { owner, advanceId } = await finalizedAdvance(t);
    await receive(t, owner, advanceId, 238_000);
    const overview = await owner.query(api.corrections.relations, { id: advanceId });
    expect(overview?.chain?.advances[0]).toMatchObject({
      resolution: "reduce",
      receivedCents: 238_000,
      openCents: 119_000,
    });
    const { id: cid } = await owner.mutation(api.corrections.reduceAdvance, { advanceId });
    const c = await doc(t, cid);
    expect(c.totals.grossCents).toBe(-119_000);
    await owner.action(api.invoices.finalize, { id: cid, version: c.version });
    const a = await doc(t, advanceId);
    expect(a).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    // A credit of an advance posts nothing (the advance itself was never posted, S9).
    expect((await journal(t)).some((e) => e.source.id === cid)).toBe(false);
    const finalId = await finalDraft(t, owner, advanceId, 1_000_000);
    await owner.action(api.invoices.finalize, { id: finalId, version: (await doc(t, finalId)).version });
    const f = await doc(t, finalId);
    expect(f.deductions?.[0]).toMatchObject({ deductedGrossCents: 238_000, partiallyPaid: true });
    expect(f.totals.payableCents).toBe(1_190_000 - 238_000);
    await settle(t);
  });

  test("INV-07 final_exists: a chain has at most one final invoice", async () => {
    const t = makeT();
    const { owner, advanceId } = await finalizedAdvance(t);
    await receive(t, owner, advanceId, 357_000);
    await finalDraft(t, owner, advanceId, 1_000_000);
    const e = await owner
      .mutation(api.corrections.createChainDraft, { fromId: advanceId, type: "final_invoice" })
      .catch((x: unknown) => x);
    expect(dataOf(e).reason).toBe("final_exists");
    await settle(t);
  });
});

// ── artifacts (INV-09, A.2 TypeCodes) ───────────────────────────────────────────────────────────────────────────

const xmlOf = async (t: TestT, id: Id<"salesDocuments">) => {
  const xml = await t.run(async (ctx) => {
    const a = (
      await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect()
    ).find((x) => x.kind === "xrechnung_xml");
    const blob = a ? await ctx.storage.get(a.storageId) : null;
    return blob ? await blob.text() : null;
  });
  if (!xml) throw new Error("xml missing");
  return xml;
};
const typeCode = (xml: string) => /<rsm:ExchangedDocument>[\s\S]*?<ram:TypeCode>(\d+)<\/ram:TypeCode>/.exec(xml)?.[1];

describe("A.2 INV-09 artifacts carry the TypeCode and the references", { timeout: 30_000 }, () => {
  test("ER-01 Storno 381 with BT-25, Berichtigung 384, advance 326, final 380 with BG-3 and BT-113", async () => {
    const t = makeT();
    const { owner, id, number, advanceId, advanceNumber } = await finalizedAdvance(t);
    const rect = await owner.mutation(api.corrections.createCorrection, { originalId: id, kind: "rectification" });
    const rectDoc = await doc(t, rect.id);
    await owner.mutation(api.invoices.updateDraft, {
      id: rect.id,
      version: rectDoc.version,
      values: {
        ...((await owner.query(api.invoices.get, { id: rect.id })) as unknown as { values: DraftValues }).values,
        orderReference: "PO-2026-118",
      },
    });
    await owner.action(api.invoices.finalize, { id: rect.id, version: (await doc(t, rect.id)).version });
    await receive(t, owner, advanceId, 357_000);
    const finalId = await finalDraft(t, owner, advanceId, 1_000_000);
    await owner.action(api.invoices.finalize, { id: finalId, version: (await doc(t, finalId)).version });
    await settle(t);
    const advXml = await xmlOf(t, advanceId);
    expect(typeCode(advXml)).toBe("326");
    const rectXml = await xmlOf(t, rect.id);
    expect(typeCode(rectXml)).toBe("384");
    expect(rectXml).toContain(`<ram:IssuerAssignedID>${number}</ram:IssuerAssignedID>`);
    expect((await doc(t, rect.id)).rectifiedFields).toEqual(["orderReference"]);
    const finalXml = await xmlOf(t, finalId);
    expect(typeCode(finalXml)).toBe("380");
    expect(finalXml).toContain(`<ram:IssuerAssignedID>${advanceNumber}</ram:IssuerAssignedID>`);
    expect(finalXml).toMatch(/<ram:TotalPrepaidAmount>3570\.00<\/ram:TotalPrepaidAmount>/);
    expect(finalXml).toMatch(/<ram:DuePayableAmount>8330\.00<\/ram:DuePayableAmount>/);
    // A Storno of an unpaid, undeducted invoice: 381 referencing the original.
    const blocked = await owner.query(api.corrections.cancelPreview, { id });
    expect(blocked.guard).toBeNull();
    const s2 = await owner.mutation(api.corrections.cancel, { id });
    await settle(t);
    const stornoXml = await xmlOf(t, s2.id);
    expect(typeCode(stornoXml)).toBe("381");
    expect(stornoXml).toContain(`<ram:IssuerAssignedID>${number}</ram:IssuerAssignedID>`);
  });
});

describe("E2E payment stand-in (IS_TEST only)", { timeout: 30_000 }, () => {
  test("INV-11 testFixtures.recordPayment moves the open amount only on a test deployment", async () => {
    const t = makeT();
    const { number, id } = await finalizedInvoice(t);
    process.env.IS_TEST = "";
    try {
      expect(await t.mutation(internal.testFixtures.recordPayment, { number, amountCents: 100 })).toBeNull();
    } finally {
      process.env.IS_TEST = "true";
    }
    expect((await doc(t, id)).paymentStatus).not.toBe("partially_paid");
    expect(await t.mutation(internal.testFixtures.recordPayment, { number, amountCents: 19_000 })).toEqual({
      openCents: 100_000,
      receivedCents: 19_000,
    });
    expect((await doc(t, id)).paymentStatus).toBe("partially_paid");
    await settle(t);
  });
});
