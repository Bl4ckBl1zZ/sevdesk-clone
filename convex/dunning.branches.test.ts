import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DunningOwner, dunningSetup, markSent } from "./dunning.fixtures";
import { invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { withdrawReminder } from "./model/dunning";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 dunning — the public reads (reminder detail, cockpit, invoice tab, list, interest calculator) and the guards of
 * the reminder, case, contact and policy writes. The invoice is 1.000,00 net + 19 % = 1.190,00, due on its document
 * date 2026-10-12 (dueDays 0) and marked sent by e-mail the same day (Zugang 2026-10-12).
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
const reasonOf = (e: unknown) => dataOf(e).reason;

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

const docOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"salesDocuments">);
const caseOf = (t: TestT, invoiceId: Id<"salesDocuments">) =>
  t.run((ctx) =>
    ctx.db
      .query("dunningCases")
      .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
      .first(),
  );
const auditOf = (t: TestT, action: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).filter((a) => a.action === action));

/** Moves the clock; the seeded session expires after 7 days, so a fresh owner session is returned. */
async function jump(t: TestT, owner: DunningOwner, iso: string): Promise<DunningOwner> {
  vi.setSystemTime(new Date(iso));
  return t.asUser("owner", { existingUserId: owner.userId });
}

/** A further finalised invoice to the same contact (1.190,00), optionally marked sent on its document date. */
async function anotherInvoice(
  t: TestT,
  owner: DunningOwner,
  contactId: string,
  opts: { dueDays?: number; mark?: boolean } = {},
) {
  const { id } = await owner.mutation(api.invoices.createDraft, {
    values: invoiceValues(contactId, { paymentTerms: { dueDays: opts.dueDays ?? 0 } }),
  });
  await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  const invoiceId = id as Id<"salesDocuments">;
  if (opts.mark) await markSent(owner, invoiceId, "2026-10-12", "email_manual");
  return invoiceId;
}

const SETTINGS = {
  autoFinalizeReminders: false,
  postalDeliveryDays: 3,
  bankDataMaxAgeDays: 7,
  defaultStartViaReminder: "after_printed_deadline",
  reopenGraceDays: 7,
  agingBucketEdgesDays: [30, 60, 90],
} as const;

describe("DUN-005 DUN-010 reminder detail and invoice tab", () => {
  test("DUN-005 DUN-010 the reminder detail shows a draft's planned claim, then the finalised reminder with artifacts and send log", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    expect(await owner.query(api.dunning.reminder, { id: s.invoiceId })).toBeNull();
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    const rid = id as Id<"salesDocuments">;
    await owner.mutation(api.dunning.updateReminder, {
      id: rid,
      version: 1,
      values: { feeCents: 0, headText: "Kopf {{rechnungsnummer}}", footText: "Fuß" },
    });

    const draft = await owner.query(api.dunning.reminder, { id: rid });
    expect(draft?.reminder).toMatchObject({ status: "draft", level: 1, number: null, invoiceId: s.invoiceId });
    expect(draft?.texts).toMatchObject({ headText: "Kopf {{rechnungsnummer}}", footText: "Fuß" });
    expect(draft?.detail.manual).toEqual({ feeCents: 0 });
    expect(draft?.findings).toEqual([]);
    expect(draft?.claim).toMatchObject({ openAmountCents: 119_000, feeCents: 0, newDueDate: "2026-10-26" });
    expect(draft?.computed).toMatchObject({ feeCents: 0, interestCents: 0, flatFee40Cents: 0, inDefault: false });
    expect(draft?.case).toMatchObject({ status: "active", currentLevel: 0, flatFeeCharged: false });
    expect(draft?.invoice).toMatchObject({ id: s.invoiceId, openAmountCents: 119_000, payableCents: 119_000 });
    expect(draft?.isConsumer).toBe(false);
    expect([draft?.artifacts, draft?.sendLog, draft?.defaultMarkSelection, draft?.snapshot]).toEqual([
      [],
      [],
      [],
      null,
    ]);
    expect(draft?.effectiveMarkId).toBeNull();

    await owner.mutation(api.dunning.finalize, { id: rid, version: 2 });
    await settle(t);
    const toSend = await owner.query(api.dunning.reminder, { id: rid });
    expect(toSend?.reminder).toMatchObject({ status: "finalized", number: "MA-2026-0001", artifactStatus: "ready" });
    expect(toSend?.findings).toEqual([]);
    expect(toSend?.computed).toBeNull();
    expect(toSend?.claim).toBeNull();
    expect(toSend?.snapshot).not.toBeNull();
    expect(toSend?.artifacts.length).toBeGreaterThan(0);
    expect(toSend?.artifacts[0]).toMatchObject({ kind: "pdf", variant: "original" });
    expect(toSend?.sendLog).toEqual([]);
    expect(toSend?.defaultMarkSelection.length).toBeGreaterThan(0);

    await markSent(owner, rid, "2026-10-19", "post");
    const sent = await owner.query(api.dunning.reminder, { id: rid });
    expect(sent?.reminder).toMatchObject({ status: "sent", sentOn: "2026-10-19" });
    expect(sent?.reminder.zugang).toMatchObject({ date: "2026-10-22" });
    expect(sent?.sendLog).toHaveLength(1);
    expect(sent?.sendLog[0]).toMatchObject({ kind: "mark_sent", channel: "post", sentOn: "2026-10-19", note: null });
    expect(sent?.effectiveMarkId).toBe(sent?.sendLog[0]?._id);
    expect(sent?.case).toMatchObject({ currentLevel: 1 });
  });

  test("DUN-010 DUN-034 DUN-042 the invoice tab shows the case (pause, hand-over), the flags, the reminders and the next action", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const { id: draftId } = await s.owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(s.contactId, { paymentTerms: { dueDays: 0 } }),
    });
    const notIssued = await s.owner.query(api.dunning.forInvoice, { invoiceId: draftId as Id<"salesDocuments"> });
    expect(notIssued).toMatchObject({ dunnable: false, next: null, case: null, reminders: [], disputed: null });
    expect(notIssued?.zugang).toBeNull();

    const fresh = await s.owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(fresh).toMatchObject({
      dunnable: true,
      case: null,
      blocked: null,
      contactBlocked: false,
      isConsumer: false,
    });
    expect(fresh?.next).toMatchObject({ kind: "skip", claim: null, notes: [] });
    expect(fresh?.limitation).toMatchObject({ date: "2029-12-31", state: "ok", message: null });

    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "pause", reason: "Kunde ruft zurück", until: "2026-10-30" },
    });
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "block", reason: "Kulanz vereinbart" },
    });
    const paused = await s.owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(paused?.case).toMatchObject({
      status: "paused",
      currentLevel: 0,
      pausedUntil: "2026-10-30",
      pausedReason: "Kunde ruft zurück",
      handedOver: null,
      graceUntil: null,
    });
    expect(paused?.blocked).toEqual({ reason: "Kulanz vereinbart" });

    await s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "unblock" } });
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "dispute", reason: "Leistung mangelhaft" },
    });
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "hand_over", partner: "Inkasso Nord GmbH", acknowledgeWarnings: ["disputed_hand_over"] },
    });
    const handed = await s.owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(handed?.blocked).toBeNull();
    expect(handed?.disputed).toMatchObject({ reason: "Leistung mangelhaft" });
    expect(handed?.case).toMatchObject({ status: "handed_over", pausedReason: "Bestritten" });
    expect(handed?.case?.handedOver).toMatchObject({ partner: "Inkasso Nord GmbH" });
  });
});

describe("DUN-033 DUN-053 cockpit", () => {
  test("DUN-033 DUN-034 DUN-053 PAY-064 the cockpit lists due-soon, unmarked, paused/blocked/disputed invoices and the reminder tabs", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const unmarked = await anotherInvoice(t, s.owner, s.contactId);
    const soon = await anotherInvoice(t, s.owner, s.contactId, { dueDays: 2, mark: true });
    const disputed = await anotherInvoice(t, s.owner, s.contactId, { mark: true });

    const today = await s.owner.query(api.dunning.cockpit, {});
    expect(today.today).toBe("2026-10-12");
    expect(today.dueSoon.map((r) => r.id).sort()).toEqual([s.invoiceId, unmarked, disputed, soon].sort());
    const soonRow = today.dueSoon.find((r) => r.id === soon);
    expect(soonRow).toMatchObject({ dueDate: "2026-10-14", level: 0, caseStatus: null, disputed: null, blocked: null });
    expect(soonRow?.limitation).toMatchObject({ state: "ok" });
    expect(today.unmarked).toEqual([]);

    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "block", reason: "Kulanz vereinbart" },
    });
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: disputed,
      values: { action: "dispute", reason: "Menge strittig" },
    });
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: soon,
      values: { action: "pause", until: "2026-11-30" },
    });

    // Exported but never marked sent (F04 SND-16): listed as „nicht markiert“ with the export time.
    await s.owner.action(api.documentArtifacts.exportFiles, { id: unmarked, request: { entry: "default" } });

    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const later = await owner.query(api.dunning.cockpit, {});
    expect(later.dueSoon).toEqual([]);
    expect(later.unmarked.map((r) => r.id)).toEqual([unmarked]);
    expect(later.unmarked[0]).toMatchObject({ firstExportedAt: expect.any(Number), openAmountCents: 119_000 });
    const paused = new Map(later.paused.map((r) => [r.id, r]));
    expect([...paused.keys()].sort()).toEqual([s.invoiceId, disputed, soon].sort());
    expect(paused.get(s.invoiceId)?.blocked).toEqual({ reason: "Kulanz vereinbart" });
    expect(paused.get(disputed)?.disputed).toEqual({ reason: "Menge strittig" });
    expect(paused.get(soon)).toMatchObject({
      caseStatus: "paused",
      pausedUntil: "2026-11-30",
      pausedReason: "manuell",
    });
    expect(later.limitation).toEqual([]);
    expect(later.counts).toEqual({ drafts: 0, toSend: 0 });
    expect([later.drafts, later.toSend, later.sent, later.withdrawn]).toEqual([[], [], [], []]);
  });
});

describe("DUN-010 reminder list (05 §4.4 GET /reminders)", () => {
  test("DUN-010 the reminder list filters by status, invoice and contact, newest first, with a limit", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const second = await anotherInvoice(t, s.owner, s.contactId, { mark: true });
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const a = (await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} })).id;
    const b = (await owner.mutation(api.dunning.createReminder, { invoiceId: second, values: {} })).id;
    await owner.mutation(api.dunning.finalize, { id: a as Id<"salesDocuments"> });
    await settle(t);

    const all = await owner.query(api.dunning.list, {});
    expect(all.map((r) => r.id)).toEqual([b, a]);
    expect(all[1]).toMatchObject({ status: "finalized", number: "MA-2026-0001", invoiceNumber: expect.any(String) });
    expect((await owner.query(api.dunning.list, { status: "draft" })).map((r) => r.id)).toEqual([b]);
    expect((await owner.query(api.dunning.list, { status: "finalized" })).map((r) => r.id)).toEqual([a]);
    expect((await owner.query(api.dunning.list, { limit: 1 })).map((r) => r.id)).toEqual([b]);
    expect(await owner.query(api.dunning.list, { contactId: s.contactId as Id<"contacts"> })).toHaveLength(2);
    const { orgId } = await t.run(async (ctx) => ({
      orgId: (await ctx.db.get(s.contactId as Id<"contacts">))?.parentId as Id<"contacts">,
    }));
    expect(await owner.query(api.dunning.list, { contactId: orgId })).toEqual([]);
    expect((await owner.query(api.dunning.list, { invoiceId: s.invoiceId, status: "draft" })).map((r) => r.id)).toEqual(
      [],
    );
    expect((await owner.query(api.dunning.list, { invoiceId: second })).map((r) => r.id)).toEqual([b]);
  });
});

describe("DUN-020 DUN-022 interest calculator", () => {
  test("DUN-022 DUN-020 EC-DUN-10 the calculator rejects an inverted period and a period without Basiszinssatz; custom margins and payments work", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const inverted = await catching(
      owner.query(api.dunning.interest, {
        values: { amountCents: 100_000, from: "2026-03-01", to: "2026-02-01", margin: "b2b" },
      }),
    );
    expect(errorCode(inverted)).toBe("invalid_input");
    expect(messageOf(inverted)).toBe("Das Enddatum liegt vor dem Beginn.");

    const missing = await catching(
      owner.query(api.dunning.interest, {
        values: { amountCents: 100_000, from: "2026-12-01", to: "2027-02-01", margin: "b2c" },
      }),
    );
    expect(errorCode(missing)).toBe("invalid_input");
    expect(messageOf(missing)).toBe(
      "Der Basiszinssatz ab 01.01.2027 ist nicht hinterlegt. Bitte unter Einstellungen › Regeln ergänzen.",
    );

    const custom = await owner.query(api.dunning.interest, {
      values: {
        amountCents: 100_000,
        from: "2026-07-01",
        to: "2026-07-31",
        margin: 500,
        payments: [{ date: "2026-07-16", amountCents: 50_000 }],
      },
    });
    expect(custom.segments.map((x) => [x.from, x.to, x.principalCents])).toEqual([
      ["2026-07-01", "2026-07-15", 100_000],
      ["2026-07-16", "2026-07-31", 50_000],
    ]);
    expect(custom.segments[0]?.rateBp).toBe(custom.segments[1]?.rateBp);
  });

  test("PAY-054 EC-DUE-05 payment terms above 60 days (B2B) or 30 days (public) return the § 271a warning", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(
      await owner.query(api.dunning.termsWarning, { dueDays: 30, isConsumer: false, isPublicAuthority: false }),
    ).toBeNull();
    const b2b = await owner.query(api.dunning.termsWarning, {
      dueDays: 75,
      isConsumer: false,
      isPublicAuthority: false,
    });
    expect(b2b).toMatch(/60 Tage/);
    const pub = await owner.query(api.dunning.termsWarning, {
      dueDays: 45,
      isConsumer: false,
      isPublicAuthority: true,
    });
    expect(pub).toMatch(/30 Tage/);
  });
});

/** L1 on 2026-10-19 finalised and marked sent by post the same day (Zugang 2026-10-22). */
async function firstReminderSent(t: TestT) {
  const s = await dunningSetup(t);
  const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
  const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
  const r1 = id as Id<"salesDocuments">;
  await owner.mutation(api.dunning.finalize, { id: r1 });
  await settle(t);
  await markSent(owner, r1, "2026-10-19", "post");
  return { ...s, owner, r1 };
}

describe("DUN-008 DUN-009 EC-DUN-13 EC-DUN-21 EC-DUN-22 reminder write guards", () => {
  test("EC-DUN-21 DUN-008 EC-DUN-13 drafts only for issued invoices, one draft at a time, version-checked; finalised reminders are immutable", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id: invoiceDraft } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(s.contactId, { paymentTerms: { dueDays: 0 } }),
    });
    const onDraft = await catching(
      owner.mutation(api.dunning.createReminder, { invoiceId: invoiceDraft as Id<"salesDocuments">, values: {} }),
    );
    expect(errorCode(onDraft)).toBe("invalid_input");
    expect(reasonOf(onDraft)).toBe("reminder_not_allowed");
    expect(messageOf(onDraft)).toBe("Für diese Rechnung kann keine Mahnung erstellt werden (Status: Entwurf).");

    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    const rid = id as Id<"salesDocuments">;
    const twice = await catching(owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }));
    expect(reasonOf(twice)).toBe("draft_exists");
    expect(messageOf(twice)).toBe("Für diese Rechnung gibt es bereits einen Mahnentwurf.");

    const notAReminder = await catching(
      owner.mutation(api.dunning.updateReminder, { id: s.invoiceId, version: 1, values: {} }),
    );
    expect(errorCode(notAReminder)).toBe("not_found");
    expect(messageOf(notAReminder)).toBe("Die Mahnung existiert nicht.");
    const stale = await catching(owner.mutation(api.dunning.updateReminder, { id: rid, version: 7, values: {} }));
    expect(errorCode(stale)).toBe("version_conflict");
    expect(messageOf(stale)).toBe("Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
    const staleFinalize = await catching(owner.mutation(api.dunning.finalize, { id: rid, version: 7 }));
    expect(errorCode(staleFinalize)).toBe("version_conflict");

    expect(await owner.mutation(api.dunning.finalize, { id: rid, version: 1 })).toEqual({ number: "MA-2026-0001" });
    await settle(t);
    const edit = await catching(owner.mutation(api.dunning.updateReminder, { id: rid, version: 1, values: {} }));
    expect(errorCode(edit)).toBe("document_not_draft");
    expect(messageOf(edit)).toBe(
      "Mahnungen sind nach dem Fertigstellen unveränderbar. Bitte als gegenstandslos markieren und neu erstellen.",
    );
    expect(errorCode(await catching(owner.mutation(api.dunning.deleteReminder, { id: rid })))).toBe(
      "document_not_draft",
    );
    expect(errorCode(await catching(owner.mutation(api.dunning.finalize, { id: rid })))).toBe("document_not_draft");

    // A reminder is no invoice-family document: it cannot itself be dunned (EC-DUN-21).
    const onReminder = await catching(owner.mutation(api.dunning.createReminder, { invoiceId: rid, values: {} }));
    expect(reasonOf(onReminder)).toBe("reminder_not_allowed");
    expect(messageOf(onReminder)).toMatch(/^Für diese Rechnung kann keine Mahnung erstellt werden \(Status: /);
    // DUN-055: the next level waits for the sent mark of the finalised reminder; the same level exists already.
    const same = await catching(
      owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: { level: 1 } }),
    );
    expect(messageOf(same)).toBe("Mahnstufe 1 wurde bereits erstellt. Nächste Stufe: 2.");
    const next = await catching(owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }));
    expect(reasonOf(next)).toBe("previous_reminder_not_marked_sent");
    expect(messageOf(next)).toBe(
      "Die Mahnung MA-2026-0001 ist noch nicht als versendet markiert. Bitte zuerst exportieren und den Versand markieren.",
    );

    // DUN-009: withdrawing the finalised reminder cancels it once; a second withdrawal is refused.
    await owner.mutation(api.dunning.withdraw, { id: rid, values: { reason: "Kunde hat bereits gezahlt" } });
    expect(await docOf(t, rid)).toMatchObject({
      status: "cancelled",
      cancellation: { reason: "Kunde hat bereits gezahlt" },
    });
    const again = await catching(owner.mutation(api.dunning.withdraw, { id: rid, values: { reason: "noch einmal" } }));
    expect(errorCode(again)).toBe("illegal_transition");
    expect(messageOf(again)).toBe("Die Mahnung ist bereits gegenstandslos.");
    const listed = await owner.query(api.dunning.cockpit, {});
    expect(listed.withdrawn.map((r) => [r.id, r.cancellation?.reason])).toEqual([[rid, "Kunde hat bereits gezahlt"]]);
  });

  test("DUN-009 withdrawing a draft deletes it with the reason; EC-DUN-22 a manual draft is flagged after payment and cannot be finalised", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const first = (await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }))
      .id as Id<"salesDocuments">;
    const short = await catching(
      t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => withdrawReminder(ctx, first, "  ab  ")),
    );
    expect(messageOf(short)).toBe("Bitte einen Grund angeben (mindestens 5 Zeichen).");
    await owner.mutation(api.dunning.withdraw, { id: first, values: { reason: "Versehentlich angelegt" } });
    expect(await t.run((ctx) => ctx.db.get(first))).toBeNull();
    const deleted = await auditOf(t, "dunning.reminder.delete_draft");
    expect(deleted.at(-1)).toMatchObject({ reason: "Versehentlich angelegt" });
    expect((await caseOf(t, s.invoiceId))?.reminders).toEqual([]);

    const manual = (await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }))
      .id as Id<"salesDocuments">;
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: s.invoiceId,
      source: { kind: "clearing", accountId: s.bankAccount },
      date: "2026-10-19",
      amountCents: 119_000,
    });
    // A manual draft stays (the owner decides) but gets the to-do; the case is closed.
    expect(await docOf(t, manual)).toMatchObject({ status: "draft" });
    const todos = await owner.query(api.invoices.todos, {});
    expect(todos.map((n) => n.title)).toContain(
      `Mahnentwurf zu ${(await docOf(t, s.invoiceId)).number}: Rechnung inzwischen bezahlt – Entwurf löschen`,
    );
    expect((await caseOf(t, s.invoiceId))?.status).toBe("closed");
    const detail = await owner.query(api.dunning.reminder, { id: manual });
    expect(detail?.findings.find((f) => f.code === "reminder_not_allowed")?.message).toBe(
      "Für diese Rechnung kann keine Mahnung erstellt werden (Status: bezahlt).",
    );
    const settled = await catching(owner.mutation(api.dunning.finalize, { id: manual }));
    expect(errorCode(settled)).toBe("conflict");
    expect(reasonOf(settled)).toBe("invoice_settled");
    expect(messageOf(settled)).toBe("Die Rechnung ist inzwischen bezahlt. Die Mahnung wurde nicht fertiggestellt.");
    expect((await docOf(t, manual)).number).toBeUndefined();
  });

  test("PAY-025 DUN-035 a write-off closes the case with reason „abgeschrieben“", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.payments.writeOff, {
      documentId: s.invoiceId,
      date: "2026-10-19",
      amountCents: 119_000,
      subReason: "insolvency",
    });
    expect((await caseOf(t, s.invoiceId))?.status).toBe("closed");
    expect((await auditOf(t, "dunning.case.close")).at(-1)).toMatchObject({ reason: "abgeschrieben" });
  });

  test("DUN-009 EC-DUN-35 PAY-052 a reminder a later level builds on cannot be withdrawn, retracted or get a new Zugang", async () => {
    const t = makeT();
    const { owner: o1, invoiceId, r1 } = await firstReminderSent(t);
    const owner = await jump(t, o1, "2026-11-05T08:00:00Z");
    const r2 = (await owner.mutation(api.dunning.createReminder, { invoiceId, values: {} })).id as Id<"salesDocuments">;
    const log = await t.run((ctx) =>
      ctx.db
        .query("sendLog")
        .withIndex("by_document_at", (q) => q.eq("documentId", r1))
        .collect(),
    );
    const retractArgs = { id: r1, values: { retractsId: log[0]?._id ?? "", reason: "Falsch markiert" } };
    // A pending draft of the next level already blocks the retraction of the L1 mark.
    const retractWithDraft = await catching(owner.mutation(api.invoices.retractMark, retractArgs));
    expect(errorCode(retractWithDraft)).toBe("retraction_invalid");
    expect(messageOf(retractWithDraft)).toBe(
      "Die Versandmarkierung kann nicht zurückgenommen werden, weil ein Mahnentwurf darauf aufbaut.",
    );
    await owner.mutation(api.dunning.finalize, { id: r2 });
    await settle(t);
    const withdraw = await catching(
      owner.mutation(api.dunning.withdraw, { id: r1, values: { reason: "Doch nicht nötig" } }),
    );
    expect(errorCode(withdraw)).toBe("conflict");
    expect(reasonOf(withdraw)).toBe("later_reminder_exists");
    expect(messageOf(withdraw)).toBe(
      "Die Mahnung kann nicht gegenstandslos gesetzt werden, weil MA-2026-0002 darauf aufbaut.",
    );
    const retract = await catching(owner.mutation(api.invoices.retractMark, retractArgs));
    expect(messageOf(retract)).toBe(
      "Die Versandmarkierung kann nicht zurückgenommen werden, weil MA-2026-0002 darauf aufbaut.",
    );
    const zugang = await catching(
      owner.mutation(api.dunning.overrideZugang, {
        id: r1,
        values: { date: "2026-10-21", reason: "Rückschein liegt vor" },
      }),
    );
    expect(errorCode(zugang)).toBe("conflict");
    expect(reasonOf(zugang)).toBe("dependent_reminder");
    expect(messageOf(zugang)).toBe(
      "Der Zugang kann nicht mehr geändert werden, weil eine spätere Mahnung darauf aufbaut.",
    );
    // DUN-024: L2 claimed the 40 € and was never marked sent → withdrawing it resets the flat fee.
    expect(await caseOf(t, invoiceId)).toMatchObject({ flatFeeCharged: true, flatFeeReminderId: r2, currentLevel: 2 });
    await owner.mutation(api.dunning.withdraw, { id: r2, values: { reason: "Frist zu kurz berechnet" } });
    expect(await caseOf(t, invoiceId)).toMatchObject({ flatFeeCharged: false, currentLevel: 2 });
    expect((await auditOf(t, "dunning.case.flat_fee_reset")).at(-1)).toMatchObject({
      reason: "Frist zu kurz berechnet",
    });
  });
});

describe("DUN-034 DUN-042 DUN-043 case action guards", () => {
  test("DUN-034 DUN-042 case actions need an issued invoice, a reason, a future date and a partner; a closed case cannot be paused or handed over", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const { id: invoiceDraft } = await s.owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(s.contactId, { paymentTerms: { dueDays: 0 } }),
    });
    const onDraft = await catching(
      s.owner.mutation(api.dunning.caseAction, {
        invoiceId: invoiceDraft as Id<"salesDocuments">,
        values: { action: "block", reason: "egal" },
      }),
    );
    expect(messageOf(onDraft)).toBe("Nur fertiggestellte Rechnungen haben ein Mahnverfahren.");
    const noReason = await catching(
      s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "block", reason: "ab" } }),
    );
    expect(errorCode(noReason)).toBe("invalid_input");
    expect(messageOf(noReason)).toBe("Bitte einen Grund angeben.");
    expect(dataOf(noReason).field).toBe("reason");
    const disputeNoReason = await catching(
      s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "dispute" } }),
    );
    expect(messageOf(disputeNoReason)).toBe("Bitte einen Grund angeben.");
    const past = await catching(
      s.owner.mutation(api.dunning.caseAction, {
        invoiceId: s.invoiceId,
        values: { action: "pause", until: "2026-10-12" },
      }),
    );
    expect(messageOf(past)).toBe("Das Datum muss in der Zukunft liegen.");
    const noPartner = await catching(
      s.owner.mutation(api.dunning.caseAction, {
        invoiceId: s.invoiceId,
        values: { action: "hand_over", partner: "X" },
      }),
    );
    expect(messageOf(noPartner)).toBe("Bitte das Inkassobüro angeben.");
    // „Fortsetzen“ without a case or dispute changes nothing.
    await s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "resume" } });
    expect(await caseOf(t, s.invoiceId)).toBeNull();
    // A dispute without a case only flags the invoice.
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "dispute", reason: "Rechnung unklar" },
    });
    expect(await caseOf(t, s.invoiceId)).toBeNull();
    expect((await docOf(t, s.invoiceId)).disputed).toMatchObject({ reason: "Rechnung unklar" });

    await s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "pause" } });
    expect(await caseOf(t, s.invoiceId)).toMatchObject({ status: "paused", pausedReason: "manuell" });
    await s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "resume" } });
    expect(await caseOf(t, s.invoiceId)).toMatchObject({ status: "active" });
    expect((await docOf(t, s.invoiceId)).disputed).toBeUndefined();

    await s.owner.mutation(api.payments.recordForInvoice, {
      documentId: s.invoiceId,
      source: { kind: "clearing", accountId: s.bankAccount },
      date: "2026-10-12",
      amountCents: 119_000,
    });
    expect((await caseOf(t, s.invoiceId))?.status).toBe("closed");
    const pauseClosed = await catching(
      s.owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "pause" } }),
    );
    expect(errorCode(pauseClosed)).toBe("conflict");
    expect(messageOf(pauseClosed)).toBe("Der Mahnfall kann nicht pausiert werden.");
    const handClosed = await catching(
      s.owner.mutation(api.dunning.caseAction, {
        invoiceId: s.invoiceId,
        values: { action: "hand_over", partner: "Inkasso Nord GmbH" },
      }),
    );
    expect(messageOf(handClosed)).toBe("Der Mahnfall ist abgeschlossen.");
    // A dispute on a closed case flags the invoice but does not reopen or pause the case.
    await s.owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "dispute", reason: "Nachträglich bestritten" },
    });
    expect((await caseOf(t, s.invoiceId))?.status).toBe("closed");
  });
});

describe("DUN-002 PAY-053 contact dunning settings", () => {
  test("DUN-002 PAY-053 „Nicht mahnen“ needs a reason, the policy must exist; the stored settings are returned and can be cleared", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const contactId = s.contactId as Id<"contacts">;
    expect(await s.owner.query(api.dunning.contactDunning, { contactId })).toMatchObject({ dunning: null });
    const noReason = await catching(
      s.owner.mutation(api.dunning.saveContact, { contactId, blocked: true, blockedReason: " x " }),
    );
    expect(errorCode(noReason)).toBe("invalid_input");
    expect(messageOf(noReason)).toBe("Bitte einen Grund für „Nicht mahnen“ angeben.");
    const unknown = await catching(s.owner.mutation(api.dunning.saveContact, { contactId, policyId: "seed:7" }));
    expect(messageOf(unknown)).toBe("Die Mahnrichtlinie existiert nicht.");
    expect(dataOf(unknown).field).toBe("policyId");

    await s.owner.mutation(api.dunning.saveContact, {
      contactId,
      policyId: "seed:1",
      blocked: true,
      blockedReason: "  Insolvenzverfahren  ",
      calendarDueDateAgreed: true,
    });
    const stored = await s.owner.query(api.dunning.contactDunning, { contactId });
    const b2c = stored.policies.find((p) => p.name === "Standard B2C");
    expect(stored.policies.every((p) => p.seeded === false)).toBe(true);
    expect(stored.dunning).toEqual({
      policyId: b2c?.id,
      blocked: true,
      blockedReason: "Insolvenzverfahren",
      calendarDueDateAgreed: true,
    });
    const tab = await s.owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(tab?.contactBlocked).toBe(true);

    await s.owner.mutation(api.dunning.saveContact, { contactId });
    expect((await s.owner.query(api.dunning.contactDunning, { contactId })).dunning).toBeNull();
  });
});

describe("DUN-001 DUN-050 policies, settings and templates", () => {
  test("DUN-001 policy validation errors, warnings, version conflicts, unknown references and the default rules on archive", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const seeded = await s.owner.query(api.dunning.settings, {});
    const b2b = seeded.policies.find((p) => p.name === "Standard B2B") as (typeof seeded.policies)[number];
    const steps = b2b.steps.map(({ textTemplateId: _t, ...x }) => x);
    const step1 = steps[0] as (typeof steps)[number];
    const base = {
      name: "Sonder",
      isDefault: false,
      appliesTo: { consumer: false, business: true },
      steps,
      dueSoonTodo: false,
      minOpenAmountCents: 500,
      pauseOnPartialPaymentDays: 14,
      stopAfterLastLevel: true,
    };
    const gap = await catching(
      s.owner.mutation(api.dunning.createPolicy, { values: { ...base, steps: [{ ...step1, level: 2 }] } }),
    );
    expect(errorCode(gap)).toBe("invalid_input");
    expect(reasonOf(gap)).toBe("levels_sequence");
    expect(dataOf(gap).field).toBe("steps");
    expect(messageOf(gap)).toBe("Die Mahnstufen müssen fortlaufend ab 1 nummeriert sein.");

    const consumer = await s.owner.mutation(api.dunning.createPolicy, {
      values: {
        ...base,
        name: "Verbraucher teuer",
        appliesTo: { consumer: true, business: false },
        steps: [{ ...step1, feeCents: 800, addFlatFee40: false, addInterest: false }],
      },
    });
    expect(consumer.warnings.map((w) => w.code)).toEqual(["b2c_fee_high"]);
    const listed = await s.owner.query(api.dunning.settings, {});
    const row = listed.policies.find((p) => p.id === consumer.id);
    expect(row?.dueSoonDays).toBeUndefined();
    expect(row?.warnings).toEqual([expect.objectContaining({ code: "b2c_fee_high", field: "steps.0.feeCents" })]);

    const conflict = await catching(
      s.owner.mutation(api.dunning.updatePolicy, { id: consumer.id, version: 7, values: base }),
    );
    expect(errorCode(conflict)).toBe("version_conflict");
    for (const ref of ["seed:9", "kein-gueltiger-schluessel"]) {
      const missing = await catching(s.owner.mutation(api.dunning.updatePolicy, { id: ref, version: 1, values: base }));
      expect(errorCode(missing)).toBe("not_found");
      expect(messageOf(missing)).toBe("Die Mahnrichtlinie existiert nicht.");
    }

    const isDefault = await catching(s.owner.mutation(api.dunning.archive, { id: b2b.id }));
    expect(errorCode(isDefault)).toBe("conflict");
    expect(reasonOf(isDefault)).toBe("policy_default");
    await s.owner.mutation(api.dunning.archive, { id: consumer.id });
    expect((await s.owner.query(api.dunning.settings, {})).policies.map((p) => p.id)).not.toContain(consumer.id);
    expect(errorCode(await catching(s.owner.mutation(api.dunning.archive, { id: consumer.id })))).toBe("not_found");

    // A new B2B default replaces the seeded one (only one default per audience); the B2C default stays.
    const newDefault = await s.owner.mutation(api.dunning.createPolicy, {
      values: { ...base, name: "Neu B2B", isDefault: true, dueSoonDays: 5 },
    });
    const after = await s.owner.query(api.dunning.settings, {});
    expect(
      after.policies
        .filter((p) => p.isDefault)
        .map((p) => p.name)
        .sort(),
    ).toEqual(["Neu B2B", "Standard B2C"]);
    expect(after.policies.find((p) => p.id === newDefault.id)?.dueSoonDays).toBe(5);
    const updated = await s.owner.mutation(api.dunning.updatePolicy, {
      id: newDefault.id,
      version: 1,
      values: { ...base, name: "Neu B2B", isDefault: true },
    });
    expect(updated).toMatchObject({ version: 2, warnings: [] });
  });

  test("DUN-050 a reminder template set on the policy step is used for the draft; the settings list reminder templates", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const head = (await s.owner.mutation(api.lookups.saveTextTemplate, {
      values: {
        kind: "document_head",
        docTypes: ["reminder"],
        language: "de",
        name: "Mahnung freundlich",
        body: "<p>Bitte prüfen Sie den offenen Betrag.</p>",
        isDefault: false,
      },
    })) as string;
    const settings = await s.owner.query(api.dunning.settings, {});
    expect(settings.textTemplates).toEqual([
      { id: head, name: "Mahnung freundlich", kind: "document_head", level: null, language: "de" },
    ]);
    const b2b = settings.policies.find((p) => p.name === "Standard B2B") as (typeof settings.policies)[number];
    await s.owner.mutation(api.dunning.updatePolicy, {
      id: b2b.id,
      version: b2b.version,
      values: {
        name: b2b.name,
        isDefault: true,
        appliesTo: b2b.appliesTo,
        steps: b2b.steps.map(({ textTemplateId: _t, ...x }, i) => ({
          ...x,
          ...(i === 0 ? { textTemplateId: head } : {}),
        })),
        dueSoonDays: 3,
        dueSoonTodo: false,
        minOpenAmountCents: b2b.minOpenAmountCents,
        pauseOnPartialPaymentDays: b2b.pauseOnPartialPaymentDays,
        stopAfterLastLevel: b2b.stopAfterLastLevel,
      },
    });
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    const draft = await docOf(t, id as Id<"salesDocuments">);
    expect(draft.headText).toBe("<p>Bitte prüfen Sie den offenen Betrag.</p>");
    expect(draft.footText).toBeTruthy();
  });

  test("DUN-030 Einstellungen › Mahnwesen needs a finished company setup", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect((await owner.query(api.dunning.settings, {})).receivables).toBeNull();
    const e = await catching(owner.mutation(api.dunning.saveSettings, { values: SETTINGS }));
    expect(errorCode(e)).toBe("setup_incomplete");
  });
});

describe("DUN-030 DUN-037 DUN-057 run guards and the daily job", () => {
  test("DUN-057 a finalising run needs invoices:finalize in addition to dunning:write (05 §4.4)", async () => {
    const t = makeT();
    await dunningSetup(t);
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const draftsOnly = await t.asApiKey(["dunning:write"]);
    const e = await catching(draftsOnly.mutation(api.dunning.run, { mode: "finalize" }));
    expect(errorCode(e)).toBe("forbidden_scope");
    expect(dataOf(e).permission).toBe("invoices.finalize");
    const full = await t.asApiKey(["dunning:write", "invoices:finalize"]);
    const r = await full.mutation(api.dunning.run, { mode: "finalize" });
    expect(r).toMatchObject({ evaluated: 1, drafts: 1, finalized: [], errors: 0 });
    const runs = await t.run((ctx) => ctx.db.query("dunningRuns").collect());
    expect(runs[0]).toMatchObject({ mode: "manual", actor: full.actor });
  });
});
