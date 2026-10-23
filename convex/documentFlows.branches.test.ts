import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "../src/domain/schemas/documents";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "./catalog.fixtures";
import { b2bBuyer, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

/**
 * F04 §4.2/§4.3 guards of convex/model/documentFlows.ts: acceptance/rejection/reopening (QUO-03, QUO-05),
 * withdrawal (QUO-15), „Erhalten“ (QUO-09), conversions (DOC-33, QUO-10) and the collective invoice (QUO-11).
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

const range = (key: string, name: string, prefix: string) => ({
  key,
  name,
  format: `${prefix}-{YYYY}-{####}`,
  resetPolicy: "yearly",
  next: 1,
});

async function setup(t: TestT) {
  const s = await setupInvoicing(t);
  await s.owner.mutation(api.settings.saveNumberRanges, {
    values: {
      ranges: [
        CONTACT_RANGE,
        PRODUCT_RANGE,
        INVOICE_RANGE,
        range("quote", "Angebote", "AN"),
        range("order_confirmation", "Auftragsbestätigungen", "AB"),
        range("delivery_note", "Lieferscheine", "LS"),
        range("proforma", "Proforma", "PF"),
      ],
    },
  });
  return { ...s, ...(await b2bBuyer(s.owner)) };
}

type Owner = Awaited<ReturnType<typeof setup>>["owner"];

const item = (name: string, qty: number, priceEuro: number) =>
  ({
    kind: "item",
    productType: "good",
    name,
    quantityMilli: qty * 1000,
    unitCode: "C62",
    unitPriceMicros: priceEuro * 10_000,
    vatRateKey: "standard",
  }) as DraftValues["lines"][number];

function values(type: DraftValues["type"], contactId: string, over: Partial<DraftValues> = {}): DraftValues {
  const { supplyDate: _s, ...rest } = invoiceValues(contactId, { lines: [item("Schreibtisch", 10, 500)] });
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

async function draftOf(owner: Owner, v: DraftValues) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: v });
  return id as Id<"salesDocuments">;
}

async function finalized(t: TestT, owner: Owner, v: DraftValues) {
  const id = await draftOf(owner, v);
  const r = await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { id, number: r.number };
}

async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e), message: String(data.message ?? e), reason: data.reason };
  }
  throw new Error("expected an error");
}

const auditActions = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "salesDocuments").eq("entity.id", id))
        .collect()
    ).map((e) => ({ action: e.action, reason: e.reason })),
  );

describe("acceptance, rejection and reopening (QUO-03, QUO-05)", () => {
  test("QUO-05 acceptance is only for quotes; a future date or a draft quote is refused", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const inv = await finalized(t, owner, values("invoice", personId));
    const notQuote = await fail(
      owner.mutation(api.documentFlows.accept, {
        id: inv.id,
        values: { date: "2026-10-12", byName: "Max", channel: "email" },
      }),
    );
    expect(notQuote).toMatchObject({
      code: "illegal_transition",
      message: "Diese Aktion ist für Rechnung nicht möglich.",
      reason: "illegal_transition",
    });
    const quote = await finalized(t, owner, values("quote", personId));
    const future = await fail(
      owner.mutation(api.documentFlows.accept, {
        id: quote.id,
        values: { date: "2026-10-13", byName: "Max", channel: "email" },
      }),
    );
    expect(future).toMatchObject({
      code: "invalid_input",
      reason: "acceptance_date_future",
      message: "Das Datum darf nicht in der Zukunft liegen.",
    });
    const draft = await draftOf(owner, values("quote", personId));
    const fromDraft = await fail(
      owner.mutation(api.documentFlows.accept, {
        id: draft,
        values: { date: "2026-10-12", byName: "Max", channel: "phone" },
      }),
    );
    expect(fromDraft).toMatchObject({ code: "illegal_transition", reason: "illegal_transition" });
    expect(fromDraft.message).toContain("Entwurf");
    expect((await doc(t, quote.id)).status).toBe("finalized");
  });

  test("QUO-03 a rejection date in the future is refused; a second rejection after reopening keeps the first record", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await finalized(t, owner, values("quote", personId));
    const future = await fail(owner.mutation(api.documentFlows.reject, { id, values: { date: "2026-10-20" } }));
    expect(future).toMatchObject({ code: "invalid_input", reason: "date_future" });
    await owner.mutation(api.documentFlows.reject, { id, values: { date: "2026-10-11", reason: "Zu teuer" } });
    // Reopening a quote that is not rejected is not a transition of §4.2.1.
    await owner.mutation(api.documentFlows.reopen, { id, values: { reason: "Kunde verhandelt neu" } });
    const again = await fail(owner.mutation(api.documentFlows.reopen, { id, values: { reason: "noch einmal" } }));
    expect(again).toMatchObject({ code: "illegal_transition", reason: "illegal_transition" });
    await owner.mutation(api.documentFlows.reject, { id, values: { date: "2026-10-12", reason: "Endgültig" } });
    const d = await doc(t, id);
    expect(d.status).toBe("rejected");
    expect(d.rejection).toMatchObject({ date: "2026-10-11", reason: "Zu teuer", channel: "manual" });
    const actions = await auditActions(t, id);
    expect(actions.filter((a) => a.action === "document.reject").map((a) => a.reason)).toEqual([
      "Zu teuer",
      "Endgültig",
    ]);
  });
});

describe("withdrawal and „Erhalten“ (QUO-15, QUO-09)", () => {
  test("QUO-15 invoices are cancelled, not withdrawn; a draft quote cannot be withdrawn either", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const inv = await finalized(t, owner, values("invoice", personId));
    const e = await fail(owner.mutation(api.documentFlows.withdraw, { id: inv.id, values: { reason: "Fehler" } }));
    expect(e).toMatchObject({
      code: "illegal_transition",
      message: "Rechnungen werden storniert, nicht zurückgezogen.",
    });
    const draft = await draftOf(owner, values("quote", personId));
    const d = await fail(owner.mutation(api.documentFlows.withdraw, { id: draft, values: { reason: "Doch nicht" } }));
    expect(d).toMatchObject({ code: "illegal_transition", reason: "illegal_transition" });
    expect((await doc(t, draft)).status).toBe("draft");
  });

  test("QUO-15 PRD-092 withdrawing a finalised delivery note cancels it with the reason", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const note = await finalized(t, owner, values("delivery_note", personId));
    await owner.mutation(api.documentFlows.withdraw, { id: note.id, values: { reason: "  Falsche Ware  " } });
    const d = await doc(t, note.id);
    expect(d.status).toBe("cancelled");
    expect(d.cancellation?.reason).toBe("Falsche Ware");
    expect(await auditActions(t, note.id)).toContainEqual({ action: "document.withdraw", reason: "Falsche Ware" });
  });

  test("QUO-09 „Erhalten“ only for delivery notes and never with a future date", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const quote = await finalized(t, owner, values("quote", personId));
    const wrong = await fail(
      owner.mutation(api.documentFlows.markReceived, { id: quote.id, values: { date: "2026-10-12", byName: "Max" } }),
    );
    expect(wrong).toMatchObject({ code: "illegal_transition", message: "Diese Aktion ist für Angebot nicht möglich." });
    const note = await finalized(t, owner, values("delivery_note", personId));
    const future = await fail(
      owner.mutation(api.documentFlows.markReceived, { id: note.id, values: { date: "2026-10-13", byName: "Max" } }),
    );
    expect(future).toMatchObject({ code: "invalid_input", reason: "date_future" });
    await owner.mutation(api.documentFlows.markReceived, {
      id: note.id,
      values: { date: "2026-10-12", byName: " Max " },
    });
    expect(await doc(t, note.id)).toMatchObject({
      status: "accepted",
      received: { date: "2026-10-12", byName: "Max" },
    });
  });
});

describe("conversions (DOC-33, QUO-10)", () => {
  test("DOC-33 the proposal of a draft is not allowed and explains why; a draft cannot be converted", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const draft = await draftOf(owner, values("quote", personId));
    const p = await owner.query(api.documentFlows.proposal, { id: draft, to: "order_confirmation" });
    expect(p).toMatchObject({
      allowed: false,
      acceptRequired: false,
      expired: false,
      error: { code: "source_not_finalized", message: "Nur fertiggestellte Dokumente können umgewandelt werden." },
    });
    expect(p.lines).toEqual([
      expect.objectContaining({ name: "Schreibtisch", quantityMilli: 10_000, proposedMilli: 10_000 }),
    ]);
    const e = await fail(
      owner.mutation(api.documentFlows.convert, { id: draft, values: { to: "order_confirmation" } }),
    );
    expect(e).toMatchObject({ code: "conflict", reason: "source_not_finalized" });
  });

  test("DOC-33 §4.2.1 converting an open quote without „als angenommen markieren“ is refused (quote_not_accepted)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const { id } = await finalized(t, owner, values("quote", personId));
    const p = await owner.query(api.documentFlows.proposal, { id, to: "invoice" });
    expect(p).toMatchObject({ allowed: true, acceptRequired: true, expired: false });
    const e = await fail(owner.mutation(api.documentFlows.convert, { id, values: { to: "invoice" } }));
    expect(e).toMatchObject({ code: "conflict", reason: "quote_not_accepted" });
    expect(e.message).toContain("Angebot als angenommen markieren");
    expect((await doc(t, id)).status).toBe("finalized");
  });

  test("DOC-33 payment method, bank account and internal note are carried into the converted draft", async () => {
    const t = makeT();
    const { owner, personId, bankAccount } = await setup(t);
    const pm = await t.run(async (ctx) => (await ctx.db.query("paymentMethods").first())?._id);
    expect(pm).toBeDefined();
    const { id } = await finalized(
      t,
      owner,
      values("order_confirmation", personId, {
        paymentMethodId: pm as string,
        bankAccountId: bankAccount as string,
        internalNote: "Lieferung über Spedition",
      }),
    );
    const r = await owner.mutation(api.documentFlows.convert, { id, values: { to: "proforma" } });
    expect(r.notices).toEqual([]);
    expect(await doc(t, r.id)).toMatchObject({
      type: "proforma",
      status: "draft",
      originId: id,
      paymentMethodId: pm,
      bankAccountId: bankAccount,
      internalNote: "Lieferung über Spedition",
    });
  });

  test("QUO-10 when everything is delivered, a further delivery note is refused (nothing_remaining)", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const order = await finalized(t, owner, values("order_confirmation", personId));
    const first = await owner.mutation(api.documentFlows.convert, { id: order.id, values: { to: "delivery_note" } });
    const d = await doc(t, first.id);
    await owner.action(api.invoices.finalize, { id: first.id, version: d.version });
    await settle(t);
    const p = await owner.query(api.documentFlows.proposal, { id: order.id, to: "delivery_note" });
    expect(p.lines[0]?.proposedMilli).toBe(0);
    const e = await fail(owner.mutation(api.documentFlows.convert, { id: order.id, values: { to: "delivery_note" } }));
    expect(e).toMatchObject({ code: "invalid_input", reason: "nothing_remaining" });
    expect(e.message).toContain("ist nichts mehr offen");
  });
});

describe("collective invoice (QUO-11)", () => {
  test("QUO-11 a draft note blocks the collective invoice (source_not_finalized); a quote is no delivery note", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await finalized(
      t,
      owner,
      values("delivery_note", personId, {
        supplyDate: { kind: "period", from: "2026-10-01" as CalendarDate, to: "2026-10-05" as CalendarDate },
      }),
    );
    const { supplyDate: _s, ...noDate } = values("delivery_note", personId);
    const draft = await draftOf(owner, noDate as DraftValues);
    const e = await fail(
      owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: [a.id, draft] } }),
    );
    expect(e).toMatchObject({ code: "conflict", reason: "source_not_finalized" });
    const quote = await finalized(t, owner, values("quote", personId));
    const q = await fail(
      owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: [quote.id] } }),
    );
    expect(q).toMatchObject({ code: "conflict", reason: "conversion_not_allowed" });
    const bad = await fail(
      owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: ["nope"] } }),
    );
    expect(bad).toMatchObject({ code: "not_found", message: "Lieferschein nicht gefunden." });
  });

  test("QUO-11 a note with a supply period is billed with the end of the period as delivery date", async () => {
    const t = makeT();
    const { owner, personId } = await setup(t);
    const a = await finalized(
      t,
      owner,
      values("delivery_note", personId, {
        supplyDate: { kind: "period", from: "2026-10-01" as CalendarDate, to: "2026-10-05" as CalendarDate },
      }),
    );
    const r = await owner.mutation(api.documentFlows.collectiveInvoice, { values: { deliveryNoteIds: [a.id, a.id] } });
    const inv = await doc(t, r.id);
    expect(inv.sourceDocumentIds).toEqual([a.id]);
    expect(inv.supplyDate).toEqual({ kind: "date", date: "2026-10-05" });
  });
});
