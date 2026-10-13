import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "./catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/**
 * F04 quotes, order confirmations, delivery notes, proforma and conversions (QUO-01…15, DOC-33/34): lifecycle,
 * numbering, acceptance, revisions, expiry, conversions with invoicing progress and the collective invoice.
 */

const NOW = new Date("2026-10-12T10:00:00Z");

// Every test finalises and renders several PDFs; under parallel load that takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const range = (key: string, name: string, prefix: string) => ({
  key,
  name,
  format: `${prefix}-{YYYY}-{####}`,
  resetPolicy: "yearly",
  next: 1,
});

const LETTER_RANGES = [
  range("quote", "Angebote", "AN"),
  range("order_confirmation", "Auftragsbestätigungen", "AB"),
  range("delivery_note", "Lieferscheine", "LS"),
  range("proforma", "Proforma", "PF"),
];

async function setup(t: TestT) {
  const s = await setupInvoicing(t);
  await s.owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE, ...LETTER_RANGES] },
  });
  const buyer = await b2bBuyer(s.owner);
  return { ...s, ...buyer };
}

type Owner = Awaited<ReturnType<typeof setup>>["owner"];

const item = (name: string, qty: number, priceEuro: number, over: Partial<DraftValues["lines"][number]> = {}) =>
  ({
    kind: "item",
    productType: "good",
    name,
    quantityMilli: qty * 1000,
    unitCode: "C62",
    unitPriceMicros: priceEuro * 10_000,
    vatRateKey: "standard",
    ...over,
  }) as DraftValues["lines"][number];

function values(type: DraftValues["type"], contactId: string, over: Partial<DraftValues> = {}): DraftValues {
  const base = invoiceValues(contactId, { lines: [item("Schreibtisch", 10, 500)] });
  const { supplyDate: _s, ...rest } = base;
  return {
    ...rest,
    type,
    ...(type === "delivery_note" || type === "invoice" || type === "order_confirmation"
      ? { supplyDate: { kind: "date", date: "2026-10-09" as CalendarDate } }
      : {}),
    ...over,
  };
}

const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });

const linesOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect()
    ).sort((a, b) => a.position - b.position),
  );

async function finalized(t: TestT, owner: Owner, v: DraftValues) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: v });
  const r = await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { id, number: r.number };
}

async function finalizeDraft(t: TestT, owner: Owner, id: Id<"salesDocuments">) {
  const d = await doc(t, id);
  const r = await owner.action(api.invoices.finalize, { id, version: d.version });
  await settle(t);
  return r.number;
}

async function draftValuesOf(owner: Owner, id: Id<"salesDocuments">): Promise<DraftValues> {
  const d = await owner.query(api.invoices.get, { id });
  if (!d || !("values" in d)) throw new Error("not a draft");
  return d.values as unknown as DraftValues;
}

const accept = (owner: Owner, id: Id<"salesDocuments">, over: Record<string, unknown> = {}) =>
  owner.mutation(api.documentFlows.accept, {
    id,
    values: { date: "2026-10-12", byName: "Max Beispiel", channel: "email", ...over },
  });

const fail = (p: Promise<unknown>) => p.then(() => null).catch((e: unknown) => e);
const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

const snapshotOf = async (t: TestT, id: Id<"salesDocuments">): Promise<DocumentSnapshot> => {
  const d = await doc(t, id);
  return t.run(async (ctx) => JSON.parse((await ctx.db.get(d.snapshotId as Id<"documentSnapshots">))?.json ?? "{}"));
};

const journalCount = (t: TestT) => t.run(async (ctx) => (await ctx.db.query("journalEntries").collect()).length);

// ── quotes ───────────────────────────────────────────────────────────────────────────────────────────────

describe("QUO-01…07 quotes", () => {
  test("QUO-01 DOC-25 DOC-40 T-QUO-001 a quote takes its own range, validUntil = date + 30 days, no receivable, no journal", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const before = await journalCount(t);
    const { id, number } = await finalized(t, owner, values("quote", personId));
    expect(number).toBe("AN-2026-0001");
    const d = await doc(t, id);
    expect(d).toMatchObject({ status: "finalized", validUntil: "2026-11-11", retentionClass: "letters6" });
    expect(d.paymentStatus).toBeUndefined();
    expect(d.openAmountCents).toBeUndefined();
    expect(d.dueDate).toBeUndefined();
    expect(d.einvoice.format).toBe("none");
    expect(await journalCount(t)).toBe(before);
    const snap = await snapshotOf(t, d._id);
    expect(snap.validUntil).toBe("2026-11-11");
  });

  test("QUO-01 an explicit validUntil before the document date blocks finalisation", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const r = await owner.query(api.invoices.check, {
      values: values("quote", personId, { validUntil: "2026-10-01" as CalendarDate }),
    });
    expect(r?.findings.map((f) => f.code)).toContain("valid_until_before_date");
  });

  test("QUO-02 DOC-04 T-DOC-003 optional lines are excluded from totals and chosen on conversion", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const v = values("quote", personId, {
      lines: [item("Schreibtisch", 2, 500), item("Montage", 1, 200, { optional: true, productType: "service" })],
    });
    const { id } = await finalized(t, owner, v);
    const d = await doc(t, id);
    expect(d.totals.netCents).toBe(100_000);
    const lines = await linesOf(t, id);
    expect(lines[1]).toMatchObject({ optional: true, lineNetCents: 20_000 });
    const without = await owner.mutation(api.documentFlows.convert, {
      id,
      values: { to: "order_confirmation", acceptSource: true },
    });
    expect((await doc(t, without.id)).totals.netCents).toBe(100_000);
    const order2 = await owner.mutation(api.documentFlows.convert, {
      id,
      values: { to: "proforma", optionalLineIds: [lines[1]?._id as string] },
    });
    const o2 = await doc(t, order2.id);
    expect(o2.totals.netCents).toBe(120_000);
    expect((await linesOf(t, order2.id)).every((l) => !l.optional)).toBe(true);
  });

  test("QUO-05 GOBD-06 T-QUO-003 acceptance stores who, when, channel and the snapshot hash", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await finalized(t, owner, values("quote", personId));
    await accept(owner, id, { note: "per Mail" });
    const d = await doc(t, id);
    const snap = await t.run((ctx) => ctx.db.get(d.snapshotId as never));
    expect(d.status).toBe("accepted");
    expect(d.acceptance).toMatchObject({
      date: "2026-10-12",
      byName: "Max Beispiel",
      channel: "email",
      note: "per Mail",
      snapshotHash: (snap as { snapshotHash: string }).snapshotHash,
    });
  });

  test("QUO-06 UST-06 T-QUO-004 a rejected quote gets a new version AN-…-V2; the old one becomes superseded", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id, number } = await finalized(t, owner, values("quote", personId));
    await owner.mutation(api.documentFlows.reject, { id, values: { date: "2026-10-12", reason: "zu teuer" } });
    const { id: v2 } = await owner.mutation(api.documentFlows.revise, { id, values: { reason: "Preis gesenkt" } });
    expect(await doc(t, v2)).toMatchObject({ status: "draft", revision: 2, originId: id, chainRootId: id });
    const again = await fail(owner.mutation(api.documentFlows.revise, { id, values: {} }));
    expect(reasonOf(again)).toBe("revision_draft_exists");
    const n2 = await finalizeDraft(t, owner, v2);
    expect(n2).toBe(`${number}-V2`);
    expect((await doc(t, id)).status).toBe("superseded");
    const register = await t.run(async (ctx) => (await ctx.db.query("numberRegister").collect()).map((r) => r.number));
    expect(register).toEqual(expect.arrayContaining([number, `${number}-V2`]));
    // The next quote still takes the next counter value (the suffix consumes none).
    const third = await finalized(t, owner, values("quote", personId));
    expect(third.number).toBe("AN-2026-0002");
    // V3 from V2 keeps the base number of version 1.
    const { id: v3 } = await owner.mutation(api.documentFlows.revise, { id: v2 });
    expect(await finalizeDraft(t, owner, v3)).toBe(`${number}-V3`);
  });

  test("QUO-07 EC-079 an accepted quote cannot be revised (quote_accepted_frozen)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await finalized(t, owner, values("quote", personId));
    await accept(owner, id);
    const e = await fail(owner.mutation(api.documentFlows.revise, { id }));
    expect(errorCode(e)).toBe("conflict");
    expect(reasonOf(e)).toBe("quote_accepted_frozen");
  });

  test("QUO-03 GOBD-06 T-QUO-012 late acceptance, rejection, reopening and withdrawal follow §4.2.1 with audit entries", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await finalized(t, owner, values("quote", personId, { validUntil: "2026-10-12" as CalendarDate }));
    const second = await finalized(t, owner, values("quote", personId, { validUntil: "2026-10-12" as CalendarDate }));
    vi.setSystemTime(new Date("2026-10-13T07:00:00Z"));
    await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    expect((await doc(t, id)).status).toBe("expired");
    const late = await fail(accept(owner, id, { date: "2026-10-13" }));
    expect(reasonOf(late)).toBe("quote_expired_notice");
    await owner.mutation(api.documentFlows.reject, { id, values: { date: "2026-10-13" } });
    expect((await doc(t, id)).status).toBe("rejected");
    await owner.mutation(api.documentFlows.reopen, { id, values: { reason: "Kunde meldet sich erneut" } });
    expect((await doc(t, id)).status).toBe("sent");
    await accept(owner, id, { date: "2026-10-13" });
    expect((await doc(t, id)).status).toBe("accepted");
    await owner.mutation(api.documentFlows.withdraw, { id, values: { reason: "Auftrag storniert" } });
    const d = await doc(t, id);
    expect(d.status).toBe("cancelled");
    expect(d.cancellation?.reason).toBe("Auftrag storniert");
    const actions = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("auditLog")
          .withIndex("by_entity", (q) => q.eq("entity.table", "salesDocuments").eq("entity.id", id))
          .collect()
      ).map((e) => e.action),
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        "document.expire",
        "document.reject",
        "document.reopen",
        "document.accept",
        "document.withdraw",
      ]),
    );
    // An expired quote accepts only with the explicit confirmation.
    expect((await doc(t, second.id)).status).toBe("expired");
    await accept(owner, second.id, { date: "2026-10-13", late: true });
    expect((await doc(t, second.id)).status).toBe("accepted");
  });

  test("QUO-04 T-QUO-002 deadlines.notify reminds 3 days before expiry and expires the day after validUntil", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await finalized(t, owner, values("quote", personId, { validUntil: "2026-10-15" as CalendarDate }));
    await owner.mutation(api.invoices.markSent, {
      id,
      values: {
        sentOn: "2026-10-12",
        channel: "email_manual",
        artifactIds: (await owner.query(api.invoices.get, { id }))?.artifacts.map((a) => a._id) ?? [],
      },
    });
    expect((await doc(t, id)).status).toBe("sent");
    await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    const todos = await owner.query(api.invoices.todos, {});
    expect(todos.map((n) => n.kind)).toContain("quote_expiring");
    vi.setSystemTime(new Date("2026-10-15T20:00:00Z"));
    await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    expect((await doc(t, id)).status).toBe("sent");
    vi.setSystemTime(new Date("2026-10-16T07:00:00Z"));
    await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    expect((await doc(t, id)).status).toBe("expired");
    const after = await owner.query(api.invoices.todos, {});
    expect(after.map((n) => n.kind)).toEqual(expect.arrayContaining(["quote_expired"]));
    expect(after.map((n) => n.kind)).not.toContain("quote_expiring");
  });
});

// ── conversions and progress ─────────────────────────────────────────────────────────────────────────────

describe("DOC-33 QUO-08…13 conversions and invoicing progress", () => {
  test("DOC-33 T-DOC-022 drafts and pairs outside the matrix cannot be converted", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: values("quote", personId) });
    expect(
      reasonOf(await fail(owner.mutation(api.documentFlows.convert, { id: draft, values: { to: "invoice" } }))),
    ).toBe("source_not_finalized");
    const { id: note } = await finalized(t, owner, values("delivery_note", personId));
    const e = await fail(owner.mutation(api.documentFlows.convert, { id: note, values: { to: "order_confirmation" } }));
    expect(reasonOf(e)).toBe("conversion_not_allowed");
  });

  test("DOC-33 §4.2.1 converting an open quote into an invoice needs the acceptance; the invoice bills it fully", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id: quote, number } = await finalized(
      t,
      owner,
      values("quote", personId, { headText: "Gerne bieten wir an:", orderReference: "PO-77" }),
    );
    const e = await fail(owner.mutation(api.documentFlows.convert, { id: quote, values: { to: "invoice" } }));
    expect(reasonOf(e)).toBe("quote_not_accepted");
    const r = await owner.mutation(api.documentFlows.convert, {
      id: quote,
      values: { to: "invoice", acceptSource: true },
    });
    const q = await doc(t, quote);
    expect(q.status).toBe("accepted");
    expect(q.acceptance?.note).toContain("Rechnung");
    const inv = await doc(t, r.id);
    expect(inv).toMatchObject({
      type: "invoice",
      status: "draft",
      originId: quote,
      chainRootId: quote,
      headText: "Gerne bieten wir an:",
      orderReference: "PO-77",
    });
    expect(inv.validUntil).toBeUndefined();
    // The invoice needs a supply date (not copied from a quote without one).
    expect(inv.supplyDate).toBeUndefined();
    await owner.mutation(api.invoices.updateDraft, {
      id: r.id,
      version: inv.version,
      values: {
        ...(await draftValuesOf(owner, r.id)),
        supplyDate: { kind: "date", date: "2026-10-12" },
      },
    });
    const invNumber = await finalizeDraft(t, owner, r.id);
    expect(invNumber).toBe("RE-2026-0001");
    expect((await doc(t, quote)).status).toBe("invoiced");
    expect((await doc(t, quote)).coverage?.coveredBp).toBe(10_000);
    const chain = await owner.query(api.documentFlows.chain, { id: r.id });
    expect(chain.documents.map((d) => d.number)).toEqual([number, invNumber]);
  });

  test("QUO-08 QUO-10 T-QUO-005 an order of 10 units with a delivery note of 4 proposes 6 for the next note", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id: order, number } = await finalized(
      t,
      owner,
      values("order_confirmation", personId, { deliveryTerms: "frei Haus", orderReference: "B-123" }),
    );
    expect(number).toBe("AB-2026-0001");
    expect((await doc(t, order)).deliveryTerms).toBe("frei Haus");
    const p1 = await owner.query(api.documentFlows.proposal, { id: order, to: "delivery_note" });
    expect(p1.lines[0]?.proposedMilli).toBe(10_000);
    const lineId = p1.lines[0]?.id as string;
    const n1 = await owner.mutation(api.documentFlows.convert, {
      id: order,
      values: { to: "delivery_note", quantities: { [lineId]: 4_000 } },
    });
    const note = await doc(t, n1.id);
    expect(note.deliveryTerms).toBeUndefined();
    expect(note.supplyDate).toEqual({ kind: "date", date: "2026-10-09" });
    await finalizeDraft(t, owner, n1.id);
    const p2 = await owner.query(api.documentFlows.proposal, { id: order, to: "delivery_note" });
    expect(p2.lines[0]?.proposedMilli).toBe(6_000);
    expect((await linesOf(t, order))[0]?.deliveredQtyMilli).toBe(4_000);
  });

  test("QUO-13 INV-32 UST-34 partial invoicing moves the order to partially_invoiced, then invoiced; over-invoicing is blocked", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id: order } = await finalized(t, owner, values("order_confirmation", personId));
    const lineId = (await linesOf(t, order))[0]?._id as string;
    const half = await owner.mutation(api.documentFlows.convert, {
      id: order,
      values: { to: "invoice", mode: "quantities", quantities: { [lineId]: 5_000 } },
    });
    await finalizeDraft(t, owner, half.id);
    let o = await doc(t, order);
    expect(o.status).toBe("partially_invoiced");
    expect(o.coverage?.coveredBp).toBe(5_000);
    expect((await linesOf(t, order))[0]?.invoicedQtyMilli).toBe(5_000);
    // The next proposal is the rest; billing more than the rest is blocked.
    const rest = await owner.mutation(api.documentFlows.convert, { id: order, values: { to: "invoice" } });
    expect((await linesOf(t, rest.id))[0]?.quantityMilli).toBe(5_000);
    const restDoc = await doc(t, rest.id);
    const restValues = await draftValuesOf(owner, rest.id);
    await owner.mutation(api.invoices.updateDraft, {
      id: rest.id,
      version: restDoc.version,
      values: { ...restValues, lines: restValues.lines.map((l) => ({ ...l, quantityMilli: 6_000 })) },
    });
    const check = await owner.query(api.invoices.get, { id: rest.id });
    expect(check?.findings.map((f) => f.code)).toContain("quantity_exceeds_source");
    await owner.mutation(api.invoices.updateDraft, {
      id: rest.id,
      version: restDoc.version + 1,
      values: { ...restValues, lines: restValues.lines.map((l) => ({ ...l, quantityMilli: 5_000 })) },
    });
    await finalizeDraft(t, owner, rest.id);
    o = await doc(t, order);
    expect(o.status).toBe("invoiced");
    expect(o.coverage?.coveredBp).toBe(10_000);
    expect(
      reasonOf(await fail(owner.mutation(api.documentFlows.convert, { id: order, values: { to: "invoice" } }))),
    ).toBe("source_already_invoiced");
  });

  test("QUO-15 T-QUO-011 an order with a finalised invoice cannot be withdrawn (withdraw_has_invoices)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id: order } = await finalized(t, owner, values("order_confirmation", personId));
    const lineId = (await linesOf(t, order))[0]?._id as string;
    const inv = await owner.mutation(api.documentFlows.convert, {
      id: order,
      values: { to: "invoice", mode: "quantities", quantities: { [lineId]: 1_000 } },
    });
    // A draft does not block …
    const other = await finalized(t, owner, values("order_confirmation", personId));
    await owner.mutation(api.documentFlows.convert, { id: other.id, values: { to: "invoice" } });
    await owner.mutation(api.documentFlows.withdraw, { id: other.id, values: { reason: "Kunde abgesprungen" } });
    expect((await doc(t, other.id)).status).toBe("cancelled");
    // … a finalised invoice does.
    await finalizeDraft(t, owner, inv.id);
    const e = await fail(owner.mutation(api.documentFlows.withdraw, { id: order, values: { reason: "zu spät" } }));
    expect(reasonOf(e)).toBe("withdraw_has_invoices");
  });

  test("QUO-11 UST-08 T-QUO-006 three delivery notes become one collective invoice; all notes are invoiced once", {
    timeout: 60_000,
  }, async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const notes: Id<"salesDocuments">[] = [];
    const numbers: string[] = [];
    for (const [i, date] of ["2026-10-03", "2026-10-10", "2026-10-17"].entries()) {
      const n = await finalized(
        t,
        owner,
        values("delivery_note", personId, {
          supplyDate: { kind: "date", date: date as CalendarDate },
          lines: [item(`Lieferung ${i + 1}`, i + 1, 100)],
        }),
      );
      notes.push(n.id);
      numbers.push(n.number);
    }
    const open = await owner.query(api.documentFlows.openDeliveryNotes, { contactId: personId });
    expect(open.map((n) => n.number)).toEqual(numbers);
    const r = await owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: notes } });
    const inv = await doc(t, r.id);
    expect(inv.sourceDocumentIds).toEqual(notes);
    expect(inv.supplyDate).toEqual({ kind: "period", from: "2026-10-03", to: "2026-10-17" });
    const lines = await linesOf(t, r.id);
    expect(lines.filter((l) => l.kind === "heading").map((l) => l.name)).toEqual([
      `Lieferschein ${numbers[0]} vom 03.10.2026`,
      `Lieferschein ${numbers[1]} vom 10.10.2026`,
      `Lieferschein ${numbers[2]} vom 17.10.2026`,
    ]);
    expect(inv.totals.netCents).toBe(60_000);
    await finalizeDraft(t, owner, r.id);
    for (const n of notes) expect((await doc(t, n)).status).toBe("invoiced");
    const snap = await snapshotOf(t, r.id);
    expect(snap.references.deliveryNoteNumbers).toEqual(numbers);
    // EC-DOC-72: a note is billed only once.
    const e = await fail(
      owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: [notes[0]] } }),
    );
    expect(reasonOf(e)).toBe("delivery_note_already_invoiced");
    expect(await owner.query(api.documentFlows.openDeliveryNotes, { contactId: personId })).toEqual([]);
  });

  test("QUO-11 collective_mismatch for notes of different customers", async () => {
    const t = makeT();
    const { owner, personId, orgId } = await setup(t);
    const a = await finalized(t, owner, values("delivery_note", personId));
    const b = await finalized(t, owner, values("delivery_note", orgId));
    const e = await fail(
      owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: [a.id, b.id] } }),
    );
    expect(reasonOf(e)).toBe("collective_mismatch");
  });

  test("QUO-09 T-QUO-010 a delivery note without prices needs none; the invoice from it keeps the prices", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const noPrice = values("delivery_note", personId, {
      lines: [{ ...item("Palette", 3, 0), unitPriceMicros: undefined } as DraftValues["lines"][number]],
    });
    const check = await owner.query(api.invoices.check, { values: noPrice });
    expect(check?.findings.map((f) => f.code)).not.toContain("line_price_missing");
    const { id } = await finalized(t, owner, values("delivery_note", personId));
    const d = await doc(t, id);
    expect(d.showPrices).toBeUndefined();
    const snap = await snapshotOf(t, d._id);
    expect(snap.flags.showPrices).toBeUndefined();
    const inv = await owner.mutation(api.documentFlows.convert, { id, values: { to: "invoice" } });
    const invDoc = await doc(t, inv.id);
    expect(invDoc.supplyDate).toEqual({ kind: "date", date: "2026-10-09" });
    expect(invDoc.totals.netCents).toBe(500_000);
    await owner.mutation(api.documentFlows.markReceived, { id, values: { date: "2026-10-12", byName: "Lager Nord" } });
    expect(await doc(t, id)).toMatchObject({
      status: "accepted",
      received: { date: "2026-10-12", byName: "Lager Nord" },
    });
    await finalizeDraft(t, owner, inv.id);
    expect((await doc(t, id)).status).toBe("invoiced");
  });

  test("QUO-12 T-QUO-007 a proforma: own range, no XML, no journal, no receivable; invoiced once by its invoice", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const before = await journalCount(t);
    const { id, number } = await finalized(t, owner, values("proforma", personId));
    expect(number).toBe("PF-2026-0001");
    const d = await doc(t, id);
    expect(d.paymentStatus).toBeUndefined();
    expect(d.einvoice.format).toBe("none");
    expect(d.dueDate).toBe("2026-11-11");
    expect(await journalCount(t)).toBe(before);
    const artifacts = (await owner.query(api.invoices.get, { id }))?.artifacts ?? [];
    expect(artifacts.map((a) => a.kind)).toEqual(["pdf"]);
    const snap = await snapshotOf(t, d._id);
    expect(snap.notes.map((n) => n.de).join(" ")).toContain("keine Rechnung im Sinne des § 14 UStG");
    const inv = await owner.mutation(api.documentFlows.convert, { id, values: { to: "invoice" } });
    const invDoc = await doc(t, inv.id);
    await owner.mutation(api.invoices.updateDraft, {
      id: inv.id,
      version: invDoc.version,
      values: {
        ...(await draftValuesOf(owner, inv.id)),
        supplyDate: { kind: "date", date: "2026-10-12" },
      },
    });
    await finalizeDraft(t, owner, inv.id);
    expect((await doc(t, id)).status).toBe("invoiced");
    const again = await fail(owner.mutation(api.documentFlows.convert, { id, values: { to: "invoice" } }));
    expect(reasonOf(again)).toBe("source_already_invoiced");
  });

  test("DOC-34 GOBD-01 T-DOC-023 the chain of quote → order → 2 delivery notes → collective invoice is returned with progress", {
    timeout: 60_000,
  }, async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const quote = await finalized(t, owner, values("quote", personId));
    const order = await owner.mutation(api.documentFlows.convert, {
      id: quote.id,
      values: { to: "order_confirmation", acceptSource: true },
    });
    await finalizeDraft(t, owner, order.id);
    const lineId = (await linesOf(t, order.id))[0]?._id as string;
    const notes: Id<"salesDocuments">[] = [];
    for (const qty of [4_000, 6_000]) {
      const n = await owner.mutation(api.documentFlows.convert, {
        id: order.id,
        values: { to: "delivery_note", quantities: { [lineId]: qty } },
      });
      await finalizeDraft(t, owner, n.id);
      notes.push(n.id);
    }
    const inv = await owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: notes } });
    await finalizeDraft(t, owner, inv.id);
    const chain = await owner.query(api.documentFlows.chain, { id: order.id });
    expect(chain.documents.map((d) => d.type)).toEqual([
      "quote",
      "order_confirmation",
      "delivery_note",
      "delivery_note",
      "invoice",
    ]);
    expect(chain.coveredBp).toBe(10_000);
    expect((await doc(t, order.id)).status).toBe("invoiced");
    expect((await doc(t, quote.id)).status).toBe("invoiced");
    const invSnap = await snapshotOf(t, inv.id);
    expect(invSnap.references.salesOrderReference).toBe((await doc(t, order.id)).number);
  });

  test("DOC-37 the list query filters by type and the quote tabs", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const q = await finalized(t, owner, values("quote", personId));
    await finalized(t, owner, values("delivery_note", personId));
    await accept(owner, q.id);
    const quotes = await owner.query(api.invoices.list, {
      type: "quote",
      tab: "accepted",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(quotes.page.map((r) => r.number)).toEqual([q.number]);
    const notes = await owner.query(api.invoices.list, {
      type: "delivery_note",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(notes.page).toHaveLength(1);
    const invoices = await owner.query(api.invoices.list, { paginationOpts: { numItems: 10, cursor: null } });
    expect(invoices.page).toHaveLength(0);
  });
});
