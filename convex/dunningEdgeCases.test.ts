import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DunningOwner, dunningSetup, markSent } from "./dunning.fixtures";
import { invoiceValues, settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { bookedTransaction } from "./payments.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 §5.2/§5.3 dunning and Zugang edge cases (EC-DUN-*, EC-DUE-*) in Convex. The invoice is 1.000,00 net + 19 % =
 * 1.190,00, dated and due 2026-10-12, marked sent by e-mail the same day unless stated otherwise.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

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
const notificationsOf = (t: TestT, kind: string) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.kind === kind));
const remindersOf = (t: TestT, invoiceId: Id<"salesDocuments">) =>
  t.run((ctx) =>
    ctx.db
      .query("salesDocuments")
      .withIndex("by_reminderInvoice", (q) => q.eq("reminder.invoiceId", invoiceId))
      .collect(),
  );

async function jump(t: TestT, owner: DunningOwner, iso: string): Promise<DunningOwner> {
  vi.setSystemTime(new Date(iso));
  return t.asUser("owner", { existingUserId: owner.userId });
}

/** L1 created on 2026-10-19, finalised and marked sent by e-mail the same day. */
async function firstReminderSent(t: TestT) {
  const s = await dunningSetup(t);
  const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
  const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
  const r1 = id as Id<"salesDocuments">;
  await owner.mutation(api.dunning.finalize, { id: r1 });
  await settle(t);
  await markSent(owner, r1, "2026-10-19", "email_manual");
  return { ...s, owner, r1 };
}

describe("F05 §5.3 Zugang (EC-DUE)", () => {
  test("EC-DUE-07 an invoice finalised but never marked sent: warning, no default start, the run skips it", async () => {
    const t = makeT();
    const s = await dunningSetup(t, { markSent: false });
    const owner = await jump(t, s.owner, "2026-11-30T08:00:00Z");
    const view = await owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(view?.zugangNotice).toEqual({
      code: "invoice_not_marked_sent",
      severity: "W",
      message:
        "Die Rechnung ist nicht als versendet markiert – ohne Zugang beginnt kein Verzug und es wird nicht gemahnt.",
    });
    expect(view?.defaultStart).toBeNull(); // no 30-day route without Zugang, even 49 days after the due date
    const p = await owner.query(api.dunning.preview, {});
    expect(p.actions.map((a) => [a.invoiceId, a.kind, a.kind === "skip" ? a.reason : null])).toEqual([
      [s.invoiceId, "skip", "not_marked_sent"],
    ]);
  });

  test("EC-DUE-08 SND-23 a mark with channel „Sonstiges“ assumes the Zugang on sentOn + 3 days and says so", async () => {
    const t = makeT();
    const s = await dunningSetup(t, { markSent: false });
    const r = await s.owner.action(api.documentArtifacts.exportFiles, {
      id: s.invoiceId,
      request: { entry: "default" },
    });
    await s.owner.mutation(api.invoices.markSent, {
      id: s.invoiceId,
      values: {
        sentOn: "2026-10-12",
        channel: "other",
        note: "Über das Kundenportal des Auftraggebers hochgeladen",
        electronicConfirmed: true,
        artifactIds: r.files.map((f) => f.artifactId),
      },
    });
    expect((await docOf(t, s.invoiceId)).zugang).toMatchObject({ date: "2026-10-15", basis: "other" });
    const view = await s.owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(view?.zugangNotice).toEqual({
      code: "zugang_other_channel",
      severity: "I",
      message: "Zugang angenommen am 15.10.2026 (Versandweg ‚Sonstiges‘: + 3 Tage).",
    });
  });

  test("EC-DUE-09 a manual Zugang before sentOn or in the future is rejected; a valid one with reason is stored", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-16T08:00:00Z");
    const msg = "Das Zugangsdatum muss zwischen Versanddatum (12.10.2026) und heute liegen und begründet werden.";
    for (const date of ["2026-10-11", "2026-10-17"]) {
      const e = await catching(
        owner.mutation(api.dunning.overrideZugang, {
          id: s.invoiceId,
          values: { date, reason: "Rückschein liegt vor" },
        }),
      );
      expect(errorCode(e), date).toBe("invalid_input");
      expect(messageOf(e), date).toBe(msg);
    }
    const noReason = await catching(
      owner.mutation(api.dunning.overrideZugang, { id: s.invoiceId, values: { date: "2026-10-14", reason: "" } }),
    );
    expect(errorCode(noReason)).toBe("invalid_input");
    expect((await docOf(t, s.invoiceId)).zugang).toMatchObject({ date: "2026-10-12", basis: "email_manual" });
    await owner.mutation(api.dunning.overrideZugang, {
      id: s.invoiceId,
      values: { date: "2026-10-14", reason: "Rückschein vom 14.10." },
    });
    expect((await docOf(t, s.invoiceId)).zugang).toEqual({
      date: "2026-10-14",
      basis: "manual",
      reason: "Rückschein vom 14.10.",
    });
  });

  test("EC-DUE-10 retracting the invoice mark (no reminder references it) removes the Zugang and resets the default start", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    let owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    // a run-created draft opens the case; deleting it leaves the case without a reminder
    await owner.mutation(api.dunning.run, { mode: "drafts" });
    const [draft] = await remindersOf(t, s.invoiceId);
    await owner.mutation(api.dunning.deleteReminder, { id: draft?._id as Id<"salesDocuments"> });
    // a Rückschein confirms the Zugang on 14.10. → the case stores the 30-day default start
    await owner.mutation(api.dunning.overrideZugang, {
      id: s.invoiceId,
      values: { date: "2026-10-14", reason: "Rückschein vom 14.10." },
    });
    const before = await caseOf(t, s.invoiceId);
    expect(before?.defaultStartDate).toBe("2026-11-14");
    const [mark] = await t.run((ctx) =>
      ctx.db
        .query("sendLog")
        .withIndex("by_document_at", (q) => q.eq("documentId", s.invoiceId))
        .collect(),
    );
    owner = await jump(t, owner, "2026-10-19T09:00:00Z");
    await owner.mutation(api.invoices.retractMark, {
      id: s.invoiceId,
      values: { retractsId: mark?._id as string, reason: "Versehentlich als versendet markiert" },
    });
    const inv = await docOf(t, s.invoiceId);
    expect(inv.zugang).toBeUndefined();
    expect(inv.status).toBe("finalized");
    const after = await caseOf(t, s.invoiceId);
    expect(after?.defaultStartDate).toBeUndefined();
    expect(after?.defaultRoute).toBeUndefined();
    expect((await notificationsOf(t, "dunning_reset")).map((n) => n.title)).toEqual([
      `${inv.number}: Versandmarkierung zurückgenommen – Verzugsbeginn und Mahnplanung wurden zurückgesetzt.`,
    ]);
    const p = await owner.query(api.dunning.preview, {});
    expect(p.actions[0]).toMatchObject({ kind: "skip", reason: "not_marked_sent" });
  });
});

describe("F05 §5.2 dunning edge cases (EC-DUN)", { timeout: 30_000 }, () => {
  test("EC-DUN-18 GOBD-02 an unconfirmed incoming payment with the invoice number makes the run skip the invoice", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const inv = await docOf(t, s.invoiceId);
    await bookedTransaction(t, s.bankAccount, {
      bookingDate: "2026-10-18",
      amountCents: 119_000,
      purpose: `Rechnung ${inv.number}`,
    });
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const p = await owner.query(api.dunning.preview, {});
    expect(p.actions[0]).toMatchObject({ kind: "skip", reason: "payment_signal" });
    const view = await owner.query(api.dunning.forInvoice, { invoiceId: s.invoiceId });
    expect(view?.next).toMatchObject({
      reason: "payment_signal",
      reasonLabel: "Zahlung möglicherweise eingegangen – Zuordnung prüfen.",
    });
    const r = await owner.mutation(api.dunning.run, { mode: "drafts" });
    expect(r).toMatchObject({ drafts: 0, skipped: 1 });
    expect(await remindersOf(t, s.invoiceId)).toEqual([]);
  });

  test("EC-DUN-23 MAHN-05 a payment after a reminder was marked sent: the reminder stays, „gegenstandslos“ is suggested", async () => {
    const t = makeT();
    const s = await firstReminderSent(t);
    const owner = await jump(t, s.owner, "2026-10-22T08:00:00Z");
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: s.invoiceId,
      source: { kind: "clearing", accountId: s.bankAccount },
      date: "2026-10-22",
      amountCents: 119_000,
    });
    const r1 = await docOf(t, s.r1);
    expect(r1.status).toBe("sent"); // immutable, not withdrawn automatically
    expect((await notificationsOf(t, "reminder_withdraw_suggested")).map((n) => [n.title, n.resolvedAt])).toEqual([
      [`Mahnung ${r1.number}: Zahlung nach Mahnung eingegangen – Mahnung als gegenstandslos markieren?`, undefined],
    ]);
    await owner.mutation(api.dunning.withdraw, { id: s.r1, values: { reason: "Zahlung am 22.10. eingegangen" } });
    expect((await docOf(t, s.r1)).status).toBe("cancelled");
    expect((await notificationsOf(t, "reminder_withdraw_suggested"))[0]?.resolvedAt).toBeDefined();
  });

  test("EC-DUN-23 a payment after an unmarked finalised reminder turns its to-do into „Nicht versenden – gegenstandslos setzen“", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> });
    await settle(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: s.invoiceId,
      source: { kind: "clearing", accountId: s.bankAccount },
      date: "2026-10-19",
      amountCents: 119_000,
    });
    const r = await docOf(t, id as Id<"salesDocuments">);
    expect(r.status).toBe("finalized");
    expect((await notificationsOf(t, "reminder_mark_sent")).map((n) => n.title)).toContain(
      `Mahnung ${r.number}: Nicht versenden – gegenstandslos setzen`,
    );
  });

  test("EC-DUN-25 MAIL-03 incomplete Geschäftsbrief data blocks the reminder finalisation", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { representatives: [] }, { action: "settings.company.update" }),
    );
    const e = await catching(owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> }));
    expect(messageOf(e)).toMatch(/^Pflichtangaben im Geschäftsbrief fehlen: /);
    expect((await docOf(t, id as Id<"salesDocuments">)).status).toBe("draft");
  });

  test("EC-DUN-26 GOBD-06 a run whose finalisation fails for an invoice records the error, keeps the draft and a rerun adds nothing", async () => {
    const t = makeT();
    const s = await dunningSetup(t, { reminderRange: false });
    const settings = await s.owner.query(api.dunning.settings, {});
    await s.owner.mutation(api.dunning.saveSettings, {
      values: {
        autoFinalizeReminders: true,
        postalDeliveryDays: 3,
        bankDataMaxAgeDays: 7,
        defaultStartViaReminder: "after_printed_deadline",
        reopenGraceDays: 7,
        agingBucketEdgesDays: [30, 60, 90],
      },
    });
    const b2b = settings.policies.find((p) => p.appliesTo.business) as (typeof settings.policies)[number];
    await s.owner.mutation(api.dunning.createPolicy, {
      values: {
        name: "Automatisch",
        isDefault: true,
        appliesTo: { consumer: false, business: true },
        steps: b2b.steps.map((x) => ({ ...x, autoFinalize: true })),
        dueSoonDays: 3,
        dueSoonTodo: false,
        minOpenAmountCents: 500,
        pauseOnPartialPaymentDays: 14,
        stopAfterLastLevel: true,
      },
    });
    await bookedTransaction(t, s.bankAccount, { bookingDate: "2026-10-18", amountCents: 1500, purpose: "Zinsen" });
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    const first = await t.mutation(internal.dunning.runCron, { force: true });
    expect(first).toMatchObject({ errors: 1, finalized: [] });
    const run = await t.run(async (ctx) => (await ctx.db.query("dunningRuns").collect())[0]);
    expect(run?.actions[0]?.error).toMatch(/Nummernkreis für Mahnungen/);
    const second = await t.mutation(internal.dunning.runCron, { force: true });
    expect(second).toMatchObject({ errors: 0, drafts: 0, skipped: 1 });
    const reminders = await remindersOf(t, s.invoiceId);
    expect(reminders.map((r) => [r.status, r.reminder?.level])).toEqual([["draft", 1]]);
  });

  test("EC-DUN-28 UST-40 an overdue advance invoice is dunnable like an invoice", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const { id } = await s.owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(s.contactId, {
        type: "advance_invoice",
        supplyDate: { kind: "date", date: "2026-12-15" as CalendarDate },
        chainOrder: { number: "B-4711", date: "2026-09-01" as CalendarDate },
        paymentTerms: { dueDays: 0 },
      }),
    });
    await s.owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const advanceId = id as Id<"salesDocuments">;
    await markSent(s.owner, advanceId, "2026-10-12", "email_manual");
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const p = await owner.query(api.dunning.preview, { invoiceIds: [advanceId] });
    expect(p.actions).toEqual([expect.objectContaining({ invoiceId: advanceId, kind: "create_draft", level: 1 })]);
    const { id: rid } = await owner.mutation(api.dunning.createReminder, { invoiceId: advanceId, values: {} });
    expect((await docOf(t, rid as Id<"salesDocuments">)).reminder).toMatchObject({ invoiceId: advanceId, level: 1 });
  });

  test("EC-DUN-34 MAIL-02 a reminder sentOn before its finalisation date or in the future is rejected", async () => {
    const t = makeT();
    const s = await dunningSetup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    const r1 = id as Id<"salesDocuments">;
    await owner.mutation(api.dunning.finalize, { id: r1 });
    await settle(t);
    const before = await catching(markSent(owner, r1, "2026-10-18", "email_manual"));
    expect(messageOf(before)).toBe("Das Versanddatum darf nicht vor der Fertigstellung (19.10.2026) liegen.");
    const future = await catching(markSent(owner, r1, "2026-10-20", "email_manual"));
    expect(messageOf(future)).toBe("Das Versanddatum darf nicht in der Zukunft liegen.");
    expect((await docOf(t, r1)).status).toBe("finalized");
    await markSent(owner, r1, "2026-10-19", "email_manual");
    expect((await docOf(t, r1)).status).toBe("sent");
  });
});
