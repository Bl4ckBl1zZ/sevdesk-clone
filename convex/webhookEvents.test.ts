import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CONTACT_RANGE, PRODUCT_RANGE } from "./catalog.fixtures";
import { dunningSetup, markSent } from "./dunning.fixtures";
import { b2bBuyer, finalizedInvoice, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/**
 * 05 §5.3 event catalog: the model write paths write their events to the outbox in the same transaction (SND-15,
 * PAY-060, BNK-080, AUD-015, EC-186, F02/F03/F01/F08/F09/F11/F12 §7). Deliveries run against a stubbed fetch.
 */

vi.mock("./lib/webhookDns", () => ({ resolveHost: async () => ["93.184.216.34"] }));

const NOW = new Date("2026-10-12T10:00:00Z");
// Tests finalise and render PDFs; under parallel load that takes longer than the 5 s default.
vi.setConfig({ testTimeout: 60_000 });
const HOOK = "https://shop.example.com/hooks/rechnung";
let sent: { url: string; headers: Record<string, string>; body: string }[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url) === HOOK) {
        sent.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** The owner subscribes an endpoint (default: every event). */
async function subscribe(t: TestT, events: string[] = ["*"]) {
  const owner = await t.asUser("owner");
  return owner.action(api.webhooks.create, { values: { url: HOOK, events } });
}
const outbox = (t: TestT) => t.run((ctx) => ctx.db.query("webhookEvents").collect());
const types = async (t: TestT) => (await outbox(t)).map((e) => e.type);
const eventsOf = async (t: TestT, type: string) => (await outbox(t)).filter((e) => e.type === type);
type Obj = Record<string, unknown>;
const objectOf = (e: Doc<"webhookEvents"> | undefined) => (e?.object ?? {}) as Obj;

describe("F04 sales documents (SND-15)", () => {
  test("SND-15 T-SND-009 *.sent on the first effective mark, *.sent_retracted on the retraction, artifacts_blocked — signed; no event per export", async () => {
    const t = makeT();
    const { secret } = await subscribe(t, ["invoice.sent", "invoice.sent_retracted", "invoice.artifacts_blocked"]);
    const { owner, id, number, personId } = await finalizedInvoice(t);
    expect(await types(t)).toEqual([]); // created/finalized not subscribed
    const exp = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
    expect(await types(t)).toEqual([]); // SND-15: no event per export
    const artifactIds = exp.files.map((f) => f.artifactId);
    const m = await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "email_manual", artifactIds },
    });
    // a further mark is not the first effective one → no second invoice.sent
    await owner.mutation(api.invoices.markSent, { id, values: { sentOn: "2026-10-12", channel: "post", artifactIds } });
    expect(await types(t)).toEqual(["invoice.sent"]);
    const [sentEvent] = await eventsOf(t, "invoice.sent");
    expect(objectOf(sentEvent)).toMatchObject({
      id: `inv_${id}`,
      object: "invoice",
      status: "sent",
      number,
      payment_status: "open",
    });
    expect(sentEvent?.previous).toEqual({ status: "finalized" });

    await owner.mutation(api.invoices.retractMark, {
      id,
      values: { retractsId: m.sendLogId, reason: "Falsche Rechnung markiert" },
    });
    // the second mark is still effective → the document stays sent, no retraction event yet
    expect(await types(t)).toEqual(["invoice.sent"]);
    const log = await t.run((ctx) => ctx.db.query("sendLog").collect());
    const second = log.filter((r) => r.kind === "mark_sent")[1] as Doc<"sendLog">;
    await owner.mutation(api.invoices.retractMark, {
      id,
      values: { retractsId: second._id, reason: "Doch nicht versandt" },
    });
    expect(await types(t)).toEqual(["invoice.sent", "invoice.sent_retracted"]);

    // another invoice whose render fails five times ends blocked → invoice.artifacts_blocked
    const draft = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url) === HOOK) {
          sent.push({ url, headers: init?.headers as Record<string, string>, body: String(init?.body) });
          return new Response(null, { status: 204 });
        }
        return String(url).endsWith("/validate/xml")
          ? new Response(JSON.stringify({ acceptable: true, validatorVersion: "1.6.3", configVersion: "3.0.2" }))
          : new Response("down", { status: 503 });
      }),
    );
    await owner.action(api.invoices.finalize, { id: draft.id, version: 1 });
    await settle(t);
    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.invoices.artifactFailure, { id: draft.id as Id<"salesDocuments">, error: "down" });
    }
    expect(await types(t)).toEqual(["invoice.sent", "invoice.sent_retracted", "invoice.artifacts_blocked"]);
    await settle(t);
    expect(sent.map((s) => (JSON.parse(s.body) as { type: string }).type)).toEqual([
      "invoice.sent",
      "invoice.sent_retracted",
      "invoice.artifacts_blocked",
    ]);
    for (const s of sent) expect(new Webhook(secret).verify(s.body, s.headers)).toBeTruthy();
  });

  test("SND-15 invoice.created (draft), invoice.finalized and invoice.artifacts_ready follow the pipeline", async () => {
    const t = makeT();
    await subscribe(t);
    const { id } = await finalizedInvoice(t);
    const all = await types(t);
    expect(all.filter((x) => x.startsWith("invoice."))).toEqual([
      "invoice.created",
      "invoice.finalized",
      "invoice.artifacts_ready",
    ]);
    const [fin] = await eventsOf(t, "invoice.finalized");
    expect(objectOf(fin)).toMatchObject({ id: `inv_${id}`, status: "finalized", number: "RE-2026-0001" });
    expect(fin?.previous).toEqual({ status: "draft" });
    expect(objectOf(fin)).not.toHaveProperty("contact_name");
  });

  test("SND-15 quote events: created, finalized, sent, accepted", async () => {
    const t = makeT();
    await subscribe(t, ["quote.created", "quote.finalized", "quote.sent", "quote.accepted", "quote.rejected"]);
    const { owner } = await setupInvoicing(t);
    const quoteRange = { key: "quote", name: "Angebote", format: "AN-{YYYY}-{####}", resetPolicy: "yearly", next: 1 };
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE, quoteRange] },
    });
    const { personId } = await b2bBuyer(owner);
    const { supplyDate: _s, ...base } = invoiceValues(personId);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: { ...base, type: "quote" } });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    await markSent(owner, id as Id<"salesDocuments">, "2026-10-12", "email_manual");
    await owner.mutation(api.documentFlows.accept, {
      id,
      values: { date: "2026-10-12", byName: "Erika Muster", channel: "email" },
    });
    expect(await types(t)).toEqual(["quote.created", "quote.finalized", "quote.sent", "quote.accepted"]);
    const [accepted] = await eventsOf(t, "quote.accepted");
    expect(objectOf(accepted)).toMatchObject({ id: `quo_${id}`, object: "quote", status: "accepted" });
    expect(JSON.stringify(accepted)).not.toContain("Erika");
  });

  test("SND-15 a Storno emits invoice.cancelled for the original", async () => {
    const t = makeT();
    await subscribe(t, ["invoice.cancelled"]);
    const { owner, id } = await finalizedInvoice(t);
    await owner.mutation(api.corrections.cancel, { id, reason: "Doppelt erstellt" });
    await settle(t);
    const [ev] = await eventsOf(t, "invoice.cancelled");
    expect(objectOf(ev)).toMatchObject({ id: `inv_${id}`, status: "cancelled" });
    expect(ev?.previous).toEqual({ status: "finalized" });
  });
});

describe("F05 payments and dunning (PAY-060)", () => {
  const pay = (
    owner: Awaited<ReturnType<typeof finalizedInvoice>>["owner"],
    documentId: Id<"salesDocuments">,
    accountId: Id<"bankAccounts">,
    amountCents: number,
  ) =>
    owner.mutation(api.payments.recordForInvoice, {
      documentId,
      source: { kind: "clearing", accountId },
      date: "2026-10-12",
      amountCents,
    });

  test("PAY-060 T05-154 payment.recorded, invoice.partially_paid, invoice.paid and payment.reversed are written in the payment transaction", async () => {
    const t = makeT();
    await subscribe(t, ["payment.recorded", "payment.reversed", "invoice.paid", "invoice.partially_paid"]);
    const { owner, id, bankAccount } = await finalizedInvoice(t);
    const docId = id as Id<"salesDocuments">;
    const first = await pay(owner, docId, bankAccount, 50_000);
    expect(await types(t)).toEqual(["invoice.partially_paid", "payment.recorded"]);
    const [partial] = await eventsOf(t, "invoice.partially_paid");
    expect(objectOf(partial)).toMatchObject({ payment_status: "partially_paid", open_amount_cents: 69_000 });
    expect(partial?.previous).toEqual({ payment_status: "open", open_amount_cents: 119_000 });
    const [rec] = await eventsOf(t, "payment.recorded");
    expect(objectOf(rec)).toMatchObject({
      id: `pay_${first.paymentIds[0]}`,
      object: "payment",
      amount_cents: 50_000,
      date: "2026-10-12",
      source: "clearing",
      target: { kind: "salesDocument", id: `inv_${id}` },
    });
    await pay(owner, docId, bankAccount, 69_000);
    expect((await types(t)).slice(2)).toEqual(["invoice.paid", "payment.recorded"]);
    await owner.mutation(api.payments.reverse, {
      paymentId: first.paymentIds[0] as Id<"payments">,
      reason: "Falsch zugeordnet",
    });
    // the reversal re-opens part of the invoice: paid → partially_paid
    expect((await types(t)).slice(4)).toEqual(["invoice.partially_paid", "payment.reversed"]);
    const [rev] = await eventsOf(t, "payment.reversed");
    expect(objectOf(rev)).toMatchObject({ amount_cents: -50_000, reversal_of: `pay_${first.paymentIds[0]}` });
  });

  test("PAY-060 invoice.overdue is emitted once per document by receivables.refreshOverdue", async () => {
    const t = makeT();
    await subscribe(t, ["invoice.overdue"]);
    const s = await dunningSetup(t);
    vi.setSystemTime(new Date("2026-10-14T00:15:00Z"));
    await t.mutation(internal.dunning.refreshOverdueCron, { force: true });
    await t.mutation(internal.dunning.refreshOverdueCron, { force: true });
    const evs = await eventsOf(t, "invoice.overdue");
    expect(evs).toHaveLength(1);
    expect(objectOf(evs[0])).toMatchObject({ id: `inv_${s.invoiceId}`, due_date: "2026-10-12" });
  });

  test("PAY-060 reminder.finalized and reminder.sent (first sent mark); dunning_case.paused and dunning_case.handed_over", async () => {
    const t = makeT();
    await subscribe(t, ["reminder.finalized", "reminder.sent", "dunning_case.paused", "dunning_case.handed_over"]);
    const s = await dunningSetup(t);
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id });
    await settle(t);
    await markSent(owner, id as Id<"salesDocuments">, "2026-10-19", "post");
    expect(await types(t)).toEqual(["reminder.finalized", "reminder.sent"]);
    const [fin] = await eventsOf(t, "reminder.finalized");
    expect(objectOf(fin)).toMatchObject({ id: `rem_${id}`, object: "reminder", number: "MA-2026-0001" });

    await owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "pause", reason: "Telefonat" },
    });
    await owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "resume" } });
    await owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "hand_over", partner: "Inkasso Nord" },
    });
    expect((await types(t)).slice(2)).toEqual(["dunning_case.paused", "dunning_case.handed_over"]);
    const [handed] = await eventsOf(t, "dunning_case.handed_over");
    expect(objectOf(handed)).toMatchObject({
      object: "dunning_case",
      invoice_id: `inv_${s.invoiceId}`,
      status: "handed_over",
    });
    expect(JSON.stringify(handed)).not.toContain("Inkasso Nord");
  });

  test("PAY-060 an overpayment changes the customer credit: contact.credit_changed with the balance, no personal values", async () => {
    const t = makeT();
    await subscribe(t, ["contact.credit_changed"]);
    const { owner, id, bankAccount, personId } = await finalizedInvoice(t);
    await owner.mutation(api.payments.record, {
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      allocations: [
        { target: { kind: "salesDocument", id }, amountCents: 119_000 },
        { target: { kind: "contactCredit", id: personId }, amountCents: 1_000 },
      ],
    });
    const [ev] = await eventsOf(t, "contact.credit_changed");
    expect(objectOf(ev)).toMatchObject({ id: `con_${personId}`, object: "contact", credit_balance_cents: 1_000 });
    expect(ev?.previous).toEqual({ credit_balance_cents: 0 });
  });
});
