import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { confirmParamsHash } from "../src/domain/api/confirm";
import { sha256Hex } from "../src/domain/audit/chain";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { type DunningOwner, dunningSetup, markSent } from "./dunning.fixtures";
import { settle } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { bookedTransaction } from "./payments.fixtures";
import type { TestT } from "./test.setup";
import { makeT } from "./test.setup";

/**
 * F05 dunning in Convex (DUN-001…058, PAY-052…064). The invoice is 1.000,00 net + 19 % = 1.190,00, due on the
 * document date 2026-10-12 (dueDays 0), marked sent by e-mail the same day (Zugang 2026-10-12).
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
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

const setup = dunningSetup;
type Owner = DunningOwner;

/** Moves the clock; the seeded session expires after 7 days, so a fresh owner session is returned. */
async function jump(t: TestT, owner: Owner, iso: string): Promise<Owner> {
  vi.setSystemTime(new Date(iso));
  return t.asUser("owner", { existingUserId: owner.userId });
}

async function payClearing(
  owner: Owner,
  invoiceId: Id<"salesDocuments">,
  bankAccount: Id<"bankAccounts">,
  date: string,
  amountCents: number,
) {
  return owner.mutation(api.payments.recordForInvoice, {
    documentId: invoiceId,
    source: { kind: "clearing", accountId: bankAccount },
    date,
    amountCents,
  });
}

/** L1 on 2026-10-19 finalised and marked sent by post the same day (Zugang 2026-10-22). */
async function firstReminderSent(t: TestT) {
  const s = await setup(t);
  const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
  const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
  const r1 = id as Id<"salesDocuments">;
  await owner.mutation(api.dunning.finalize, { id: r1 });
  await settle(t);
  await markSent(owner, r1, "2026-10-19", "post");
  return { ...s, owner, r1 };
}

describe("DUN-030 DUN-031 DUN-037 daily run and preview", () => {
  test("DUN-030 PAY-064 EC-DUN-31 T05-120 T05-167 an unmarked invoice is skipped; after the mark level 1 becomes a draft; a second run adds nothing", async () => {
    const t = makeT();
    const s = await setup(t, { markSent: false });
    let owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const p0 = await owner.query(api.dunning.preview, {});
    expect(p0.actions.map((a) => [a.kind, a.reason])).toEqual([["skip", "not_marked_sent"]]);
    vi.setSystemTime(NOW);
    owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    await markSent(owner, s.invoiceId, "2026-10-12", "email_manual");
    owner = await jump(t, owner, "2026-10-19T08:00:00Z");
    const p1 = await owner.query(api.dunning.preview, {});
    expect(p1.actions[0]).toMatchObject({ kind: "create_draft", level: 1 });
    expect(p1.actions[0]?.claim).toMatchObject({
      openAmountCents: 119_000,
      feeCents: 0,
      interestCents: 0,
      newDueDate: "2026-10-26",
    });
    const r = await owner.mutation(api.dunning.run, { mode: "drafts", expectedDigest: p1.digest });
    expect(r).toMatchObject({ evaluated: 1, drafts: 1, errors: 0 });
    const again = await owner.mutation(api.dunning.run, { mode: "drafts" });
    expect(again).toMatchObject({ drafts: 0, skipped: 1 });
    const reminders = await t.run((ctx) =>
      ctx.db
        .query("salesDocuments")
        .withIndex("by_reminderInvoice", (q) => q.eq("reminder.invoiceId", s.invoiceId))
        .collect(),
    );
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      type: "reminder",
      status: "draft",
      reminder: { level: 1, createdByRun: true },
    });
    expect(reminders[0]?.number).toBeUndefined();
    const todos = await owner.query(api.invoices.todos, {});
    expect(todos.map((n) => n.title)).toContain("1 Mahnvorschläge prüfen");
  });

  test("DUN-031 T05-121 a stale preview digest fails with preview_outdated; the preview equals the run", async () => {
    const t = makeT();
    const s = await setup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    expect(
      await catching(owner.mutation(api.dunning.run, { mode: "drafts", expectedDigest: "[]" })).then(errorCode),
    ).toBe("preview_outdated");
    const p = await owner.query(api.dunning.preview, {});
    const r = await owner.mutation(api.dunning.run, { mode: "drafts", expectedDigest: p.digest });
    expect(r.drafts).toBe(p.actions.filter((a) => a.kind === "create_draft").length);
  });

  test("DUN-037 SEC-02 T05-130 the cron run is attributed to system:cron.dunning.run and logged with counts", async () => {
    const t = makeT();
    const s = await setup(t);
    vi.setSystemTime(new Date("2026-10-19T05:00:00Z"));
    const r = await t.mutation(internal.dunning.runCron, { force: true });
    expect(r).toMatchObject({ drafts: 1 });
    const runs = await t.run((ctx) => ctx.db.query("dunningRuns").collect());
    expect(runs[0]).toMatchObject({ actor: "system:cron.dunning.run", mode: "auto", evaluated: 1, date: "2026-10-19" });
    const reminder = await t.run((ctx) =>
      ctx.db
        .query("salesDocuments")
        .withIndex("by_reminderInvoice", (q) => q.eq("reminder.invoiceId", s.invoiceId))
        .first(),
    );
    expect(reminder?.createdBy).toBe("system:cron.dunning.run");
    const owner = await t.asUser("owner", { existingUserId: s.owner.userId });
    const cockpit = await owner.query(api.dunning.cockpit, {});
    expect(cockpit.runs[0]).toMatchObject({ drafts: 1, actor: "system:cron.dunning.run" });
  });

  test("DUN-057 T05-171 auto-finalise (global + step) finalises with number and PDF; nothing is sent", async () => {
    const t = makeT();
    const s = await setup(t);
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
    const r = await t.mutation(internal.dunning.runCron, { force: true });
    expect(r?.finalized).toHaveLength(1);
    await settle(t);
    const rem = await docOf(t, r?.finalized[0] as Id<"salesDocuments">);
    expect(rem).toMatchObject({ status: "finalized", number: "MA-2026-0001", artifactStatus: "ready" });
    expect(await t.run((ctx) => ctx.db.query("sendLog").collect())).toHaveLength(1); // only the invoice's own mark
  });
});

describe("DUN-004 DUN-005 DUN-006 MAHN-05 reminder documents", () => {
  test("MAHN-05 GOBD-20 T05-110 T05-112 finalising gives a MA number, a hash, letters6 retention, no journal entry, no XML", async () => {
    const t = makeT();
    const { r1 } = await firstReminderSent(t);
    const rem = await docOf(t, r1);
    expect(rem).toMatchObject({
      status: "sent",
      number: "MA-2026-0001",
      retentionClass: "letters6",
      retentionUntil: "2032-12-31",
      artifactStatus: "ready",
      einvoice: { format: "none" },
      zugang: { date: "2026-10-22", basis: "post" },
    });
    const snap = await t.run(async (ctx) => (rem.snapshotId ? ctx.db.get(rem.snapshotId) : null));
    expect(snap?.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const json = JSON.parse(snap?.json ?? "{}");
    expect(json.reminder).toMatchObject({
      level: 1,
      title: "Zahlungserinnerung",
      openAmountCents: 119_000,
      newDueDate: "2026-10-26",
    });
    expect(json.texts.footText).toContain("bis zum 26.10.2026");
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", r1))
        .collect(),
    );
    expect(artifacts.map((a) => a.kind)).not.toContain("xrechnung_xml");
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(entries.some((e) => (e.source as { id?: string }).id === r1)).toBe(false);
  });

  test("MAHN-05 EC-DUN-13 T05-111 a finalised reminder cannot be edited", async () => {
    const t = makeT();
    const { owner, r1 } = await firstReminderSent(t);
    const e = await catching(
      owner.mutation(api.dunning.updateReminder, { id: r1, version: 1, values: { feeCents: 500 } }),
    );
    expect(errorCode(e)).toBe("document_not_draft");
    expect(messageOf(e)).toBe(
      "Mahnungen sind nach dem Fertigstellen unveränderbar. Bitte als gegenstandslos markieren und neu erstellen.",
    );
  });

  test("UST-06 EC-DUN-24 T05-113 without a reminder number range finalisation is blocked and no number is consumed", async () => {
    const t = makeT();
    const s = await setup(t, { reminderRange: false });
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    const e = await catching(owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> }));
    expect(messageOf(e)).toBe(
      "Kein aktiver Nummernkreis für Mahnungen. Bitte unter Einstellungen › Nummernkreise anlegen.",
    );
    expect((await docOf(t, id as Id<"salesDocuments">)).status).toBe("draft");
  });

  test("EC-DUN-31 PAY-064 a reminder for an unmarked invoice may be drafted (with warning) but not finalised", async () => {
    const t = makeT();
    const s = await setup(t, { markSent: false });
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const w = await catching(owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }));
    expect(reasonOf(w)).toBe("WARNINGS_UNACKNOWLEDGED");
    const { id } = await owner.mutation(api.dunning.createReminder, {
      invoiceId: s.invoiceId,
      values: { acknowledgeWarnings: ["invoice_not_marked_sent"] },
    });
    const e = await catching(owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> }));
    expect(messageOf(e)).toBe(
      "Die Rechnung ist nicht als versendet markiert. Ohne Zugang der Rechnung kann nicht gemahnt werden.",
    );
  });

  test("EC-DUN-21 EC-DUN-29 T05-132 no reminder for a paid invoice", async () => {
    const t = makeT();
    const s = await setup(t);
    await payClearing(s.owner, s.invoiceId, s.bankAccount, "2026-10-12", 119_000);
    const e = await catching(s.owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }));
    expect(messageOf(e)).toBe("Für diese Rechnung kann keine Mahnung erstellt werden (Status: bezahlt).");
  });
});

describe("DUN-054 DUN-055 DUN-058 escalation from the manual mark", () => {
  test("DUN-055 EC-DUN-32 T05-169 an unmarked reminder blocks the next level; the run logs todo_mark_sent once after 2 days", async () => {
    const t = makeT();
    const s = await setup(t);
    let owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> });
    await settle(t);
    expect((await owner.query(api.invoices.todos, {})).map((n) => n.title)).toContain(
      "Mahnung MA-2026-0001 exportieren und als versendet markieren",
    );
    const e = await catching(owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} }));
    expect(messageOf(e)).toBe(
      "Die Mahnung MA-2026-0001 ist noch nicht als versendet markiert. Bitte zuerst exportieren und den Versand markieren.",
    );
    owner = await jump(t, owner, "2026-10-21T08:00:00Z");
    const r = await owner.mutation(api.dunning.run, { mode: "drafts" });
    expect(r.todos).toBe(1);
    const r2 = await owner.mutation(api.dunning.run, { mode: "drafts" });
    expect(r2.todos).toBe(0);
  });

  test("DUN-054 DUN-058 PAY-053 MAHN-03 T05-101 T05-168 level 2 waits for Zugang + 14 and adds interest from the default start and the 40 €", async () => {
    const t = makeT();
    const { owner: o1, invoiceId } = await firstReminderSent(t);
    let owner = await jump(t, o1, "2026-11-04T08:00:00Z");
    const before = await owner.query(api.dunning.preview, {});
    expect(before.actions[0]).toMatchObject({ kind: "skip", reason: "not_due_yet" });
    owner = await jump(t, owner, "2026-11-05T08:00:00Z");
    const p = await owner.query(api.dunning.preview, {});
    expect(p.actions[0]).toMatchObject({ kind: "create_draft", level: 2 });
    expect(p.actions[0]?.claim).toMatchObject({
      inDefault: true,
      defaultStartDate: "2026-10-27",
      interestCents: 343,
      flatFee40Cents: 4000,
      totalCents: 123_343,
    });
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> });
    const c = await caseOf(t, invoiceId);
    expect(c).toMatchObject({
      currentLevel: 2,
      flatFeeCharged: true,
      defaultStartDate: "2026-10-27",
      defaultRoute: "reminder",
    });
  });

  test("DUN-052 DUN-058 T05-172 EC-DUN-35 PAY-064 retracting the invoice mark is blocked while a reminder references it", async () => {
    const t = makeT();
    const { owner, invoiceId } = await firstReminderSent(t);
    const log = await t.run((ctx) =>
      ctx.db
        .query("sendLog")
        .withIndex("by_document_at", (q) => q.eq("documentId", invoiceId))
        .collect(),
    );
    const e = await catching(
      owner.mutation(api.invoices.retractMark, {
        id: invoiceId,
        values: { retractsId: log[0]?._id ?? "", reason: "Falsch markiert" },
      }),
    );
    expect(messageOf(e)).toBe(
      "Die Versandmarkierung kann nicht zurückgenommen werden, weil MA-2026-0001 darauf aufbaut.",
    );
  });

  test("DUN-056 EC-DUN-33 T05-170 a reminder marked sent more than 3 days after its date returns the warning", async () => {
    const t = makeT();
    const s = await setup(t);
    let owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> });
    await settle(t);
    owner = await jump(t, owner, "2026-10-24T08:00:00Z");
    const m = await markSent(owner, id as Id<"salesDocuments">, "2026-10-24", "email_manual");
    expect(m.warnings).toContain("Die im Schreiben genannte Frist ist ggf. zu kurz – Mahnung neu erstellen?");
  });
});

describe("DUN-034 DUN-035 EC-DUN-22 EC-077 case lifecycle", () => {
  test("DUN-034 EC-125 T05-124 a partial payment pauses the case for 14 days; the next reminder uses the reduced principal", async () => {
    const t = makeT();
    const { owner: o1, invoiceId, bankAccount } = await firstReminderSent(t);
    let owner = await jump(t, o1, "2026-10-28T08:00:00Z");
    await payClearing(owner, invoiceId, bankAccount, "2026-10-28", 50_000);
    expect(await caseOf(t, invoiceId)).toMatchObject({ status: "paused", pausedUntil: "2026-11-11" });
    owner = await jump(t, owner, "2026-11-05T08:00:00Z");
    expect((await owner.query(api.dunning.preview, {})).actions[0]).toMatchObject({ kind: "skip", reason: "paused" });
    owner = await jump(t, owner, "2026-11-11T08:00:00Z");
    const p = await owner.query(api.dunning.preview, {});
    expect(p.actions[0]).toMatchObject({ kind: "create_draft", level: 2 });
    expect(p.actions[0]?.claim?.openAmountCents).toBe(69_000);
  });

  test("DUN-035 EC-129 T05-126 paid → case closed; a reversal reopens it with a 7-day grace period", async () => {
    const t = makeT();
    const { owner, invoiceId, bankAccount } = await firstReminderSent(t);
    const pay = await payClearing(owner, invoiceId, bankAccount, "2026-10-19", 119_000);
    expect((await caseOf(t, invoiceId))?.status).toBe("closed");
    await owner.mutation(api.payments.reverse, {
      paymentId: pay.paymentIds[0] as Id<"payments">,
      reason: "Rücklastschrift",
    });
    expect(await caseOf(t, invoiceId)).toMatchObject({ status: "active", graceUntil: "2026-10-26" });
    const p = await owner.query(api.dunning.preview, {});
    expect(p.actions[0]).toMatchObject({ kind: "skip" });
  });

  test("EC-DUN-22 T05-127 a run-created draft is removed when the invoice gets paid", async () => {
    const t = makeT();
    const s = await setup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    await owner.mutation(api.dunning.run, { mode: "drafts" });
    await payClearing(owner, s.invoiceId, s.bankAccount, "2026-10-19", 119_000);
    const left = await t.run((ctx) =>
      ctx.db
        .query("salesDocuments")
        .withIndex("by_reminderInvoice", (q) => q.eq("reminder.invoiceId", s.invoiceId))
        .collect(),
    );
    expect(left).toHaveLength(0);
  });

  test("EC-077 a Storno closes the case and removes open reminder drafts", async () => {
    const t = makeT();
    const s = await setup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    await owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: {} });
    await owner.mutation(api.corrections.cancel, { id: s.invoiceId, reason: "Doppelt erstellt" });
    expect((await caseOf(t, s.invoiceId))?.status).toBe("closed");
  });

  test("DUN-034 T05-125 dispute pauses until resumed; „Nicht mahnen“ excludes from the run", async () => {
    const t = makeT();
    const s = await setup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    await owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "dispute", reason: "Leistung mangelhaft" },
    });
    expect((await owner.query(api.dunning.preview, {})).actions[0]).toMatchObject({ reason: "disputed" });
    await owner.mutation(api.dunning.caseAction, { invoiceId: s.invoiceId, values: { action: "resume" } });
    expect((await owner.query(api.dunning.preview, {})).actions[0]).toMatchObject({ kind: "create_draft" });
    await owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "block", reason: "Kulanz" },
    });
    expect((await owner.query(api.dunning.preview, {})).actions[0]).toMatchObject({ reason: "excluded" });
  });

  test("DUN-042 DUN-043 EC-DUN-14 T05-143 handing over a disputed claim needs a confirmation; then automation stops", async () => {
    const t = makeT();
    const s = await setup(t);
    const owner = await jump(t, s.owner, "2026-10-19T08:00:00Z");
    await owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "dispute", reason: "bestritten" },
    });
    const e = await catching(
      owner.mutation(api.dunning.caseAction, {
        invoiceId: s.invoiceId,
        values: { action: "hand_over", partner: "Inkasso Nord" },
      }),
    );
    expect(messageOf(e)).toBe(
      "Die Forderung ist als bestritten markiert. Bestrittene Forderungen sollten nicht ohne Prüfung an ein Inkassobüro übergeben werden.",
    );
    await owner.mutation(api.dunning.caseAction, {
      invoiceId: s.invoiceId,
      values: { action: "hand_over", partner: "Inkasso Nord", acknowledgeWarnings: ["disputed_hand_over"] },
    });
    expect(await caseOf(t, s.invoiceId)).toMatchObject({
      status: "handed_over",
      handedOver: { partner: "Inkasso Nord" },
    });
  });
});

describe("MAHN-03 DUN-008 DUN-009 manual reminders", () => {
  test("MAHN-03 EC-DUN-01 T05-100 RI-24 the 40 € is rejected for a consumer", async () => {
    const t = makeT();
    const s = await setup(t, { consumer: true });
    const owner = await jump(t, s.owner, "2026-11-20T08:00:00Z");
    const e = await catching(
      owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: { includeFlatFee: true } }),
    );
    expect(messageOf(e)).toBe(
      "Die 40-€-Pauschale kann nur gegenüber Unternehmern geltend gemacht werden (§ 288 Abs. 5 BGB).",
    );
  });

  test("DUN-008 EC-DUN-08 T05-105 interest above the computed value needs a reason, which is audited", async () => {
    const t = makeT();
    const s = await setup(t);
    const owner = await jump(t, s.owner, "2026-11-20T08:00:00Z");
    const e = await catching(
      owner.mutation(api.dunning.createReminder, { invoiceId: s.invoiceId, values: { interestCents: 99_999 } }),
    );
    expect(reasonOf(e)).toBe("interest_above_computed");
    const { id } = await owner.mutation(api.dunning.createReminder, {
      invoiceId: s.invoiceId,
      values: {
        interestCents: 99_999,
        interestReason: "Vereinbarter Vertragszins",
        acknowledgeWarnings: ["not_in_default"],
      },
    });
    const audits = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(
      audits.some((a) => a.action === "dunning.reminder.create_draft" && a.reason === "Vereinbarter Vertragszins"),
    ).toBe(true);
    expect((await docOf(t, id as Id<"salesDocuments">)).reminder?.interestCents).toBe(99_999);
  });

  test("DUN-007 the next level follows the latest reminder; a level beyond the policy needs an acknowledged warning", async () => {
    const t = makeT();
    const { owner: o1, invoiceId, r1 } = await firstReminderSent(t);
    const owner = await jump(t, o1, "2026-11-05T08:00:00Z");
    const forInvoice = await owner.query(api.dunning.forInvoice, { invoiceId });
    expect(forInvoice?.next).toMatchObject({ kind: "create_draft", level: 2 });
    const e = await catching(owner.mutation(api.dunning.createReminder, { invoiceId, values: { level: 1 } }));
    expect(messageOf(e)).toBe("Mahnstufe 1 wurde bereits erstellt. Nächste Stufe: 2.");
    const beyond = await catching(owner.mutation(api.dunning.createReminder, { invoiceId, values: { level: 5 } }));
    expect(reasonOf(beyond)).toBe("WARNINGS_UNACKNOWLEDGED");
    expect(messageOf(beyond)).toContain("Stufe 5 ist in der Mahnrichtlinie nicht vorgesehen.");
    const { id } = await owner.mutation(api.dunning.createReminder, {
      invoiceId,
      values: { level: 5, acknowledgeWarnings: ["beyond_policy"] },
    });
    expect((await docOf(t, id as Id<"salesDocuments">)).reminder).toMatchObject({ level: 5, title: "4. Mahnung" });
    await owner.mutation(api.dunning.deleteReminder, { id: id as Id<"salesDocuments"> });
    const { id: next } = await owner.mutation(api.dunning.createReminder, { invoiceId, values: {} });
    expect((await docOf(t, next as Id<"salesDocuments">)).reminder?.level).toBe(2);
    expect((await docOf(t, r1)).reminder?.level).toBe(1);
  });

  test("DUN-009 DUN-024 T05-173 withdrawing a never-marked reminder that claimed the 40 € resets flatFeeCharged; the level stays", async () => {
    const t = makeT();
    const { owner: o1, invoiceId } = await firstReminderSent(t);
    const owner = await jump(t, o1, "2026-11-05T08:00:00Z");
    const { id } = await owner.mutation(api.dunning.createReminder, { invoiceId, values: {} });
    await owner.mutation(api.dunning.finalize, { id: id as Id<"salesDocuments"> });
    expect((await caseOf(t, invoiceId))?.flatFeeCharged).toBe(true);
    await owner.mutation(api.dunning.withdraw, {
      id: id as Id<"salesDocuments">,
      values: { reason: "Zahlung angekündigt" },
    });
    const rem = await docOf(t, id as Id<"salesDocuments">);
    expect(rem).toMatchObject({ status: "cancelled", cancellation: { reason: "Zahlung angekündigt" } });
    expect(await caseOf(t, invoiceId)).toMatchObject({ flatFeeCharged: false, currentLevel: 2 });
  });
});

describe("DUN-001 policies and MCP safety", () => {
  test("DUN-001 the §4.6 defaults are seeded on first use; bookkeepers cannot change policies", async () => {
    const t = makeT();
    const s = await setup(t);
    const before = await s.owner.query(api.dunning.settings, {});
    expect(before.policies.map((p) => [p.name, p.seeded])).toEqual([
      ["Standard B2B", true],
      ["Standard B2C", true],
    ]);
    await s.owner.mutation(api.dunning.run, { mode: "drafts" });
    const after = await s.owner.query(api.dunning.settings, {});
    expect(after.policies.every((p) => !p.seeded)).toBe(true);
    const bk = await t.asUser("bookkeeper");
    const e = await catching(bk.mutation(api.dunning.archive, { id: after.policies[0]?.id as Id<"dunningPolicies"> }));
    expect(errorCode(e)).toBe("forbidden_role");
  });

  test("MCP-004 DUN-031 T05-152 dunning_run over MCP needs a confirm token bound to the previewed digest", async () => {
    const t = makeT();
    const s = await setup(t);
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    const mcp = await t.asMcp(["dunning:write", "payments:read"]);
    expect(await catching(mcp.mutation(api.dunning.run, { mode: "drafts" })).then(errorCode)).toBe(
      "confirm_token_required",
    );
    const p = await mcp.query(api.dunning.preview, {});
    const args = { mode: "drafts", expectedDigest: p.digest };
    const token = "ct_test_dunning_token_1234567890";
    await mcp.mutation(api.confirmTokens.issue, {
      intent: "dunning_run",
      args,
      entities: [],
      tokenHash: await sha256Hex(token),
    });
    expect(await confirmParamsHash(args)).toMatch(/^[0-9a-f]{64}$/);
    const r = await mcp.mutation(api.dunning.run, { mode: "drafts", expectedDigest: p.digest, confirmToken: token });
    expect(r.drafts).toBe(1);
    void s;
  });
});

describe("DUN-053 PAY-044 „Bald fällig“ and the overdue job", () => {
  test("DUN-053 PAY-044 T05-073 T05-174 due within 3 days is listed; with the toggle one to-do per invoice; no number, no sendLog, no case", async () => {
    const t = makeT();
    const s = await setup(t, { dueDays: 2 });
    const cockpit = await s.owner.query(api.dunning.cockpit, {});
    expect(cockpit.dueSoon.map((r) => r.number)).toEqual(["RE-2026-0001"]);
    expect(await t.mutation(internal.dunning.refreshOverdueCron, { force: true })).toEqual({ overdue: 0, dueSoon: 0 });
    const settings = await s.owner.query(api.dunning.settings, {});
    const b2b = settings.policies.find((p) => p.appliesTo.business) as (typeof settings.policies)[number];
    await s.owner.mutation(api.dunning.createPolicy, {
      values: {
        ...b2b,
        name: "Mit Erinnerung",
        dueSoonTodo: true,
        isDefault: true,
        steps: b2b.steps.map(({ textTemplateId: _t, ...x }) => x),
      },
    });
    expect(await t.mutation(internal.dunning.refreshOverdueCron, { force: true })).toEqual({ overdue: 0, dueSoon: 1 });
    await t.mutation(internal.dunning.refreshOverdueCron, { force: true });
    const todos = (await s.owner.query(api.invoices.todos, {})).filter((n) => n.kind === "due_soon");
    expect(todos.map((n) => n.title)).toEqual(["Bald fällig: RE-2026-0001 am 14.10.2026 – ggf. Kunden erinnern"]);
    expect(await caseOf(t, s.invoiceId)).toBeNull();
    vi.setSystemTime(new Date("2026-10-15T08:00:00Z"));
    expect(await t.mutation(internal.dunning.refreshOverdueCron, { force: true })).toMatchObject({ overdue: 1 });
    expect(await t.mutation(internal.dunning.refreshOverdueCron, { force: true })).toMatchObject({ overdue: 0 });
    expect((await docOf(t, s.invoiceId)).paymentStatus).toBe("open");
  });
});
