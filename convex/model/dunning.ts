import { sha256Hex } from "../../src/domain/audit/chain";
import { buildSnapshot } from "../../src/domain/documents/build-snapshot";
import { resolveDraft } from "../../src/domain/documents/draft";
import {
  buildSnapshotInput,
  placeholderValues,
  resolveText,
  retentionUntil,
} from "../../src/domain/documents/finalize";
import { INVOICE_FAMILY_TYPES } from "../../src/domain/documents/lifecycle";
import { canonicalSnapshotJson, type SnapshotReminder, snapshotHash } from "../../src/domain/documents/snapshot";
import { planEinvoice } from "../../src/domain/documents/validate/einvoice-plan";
import { applyManualAmounts, type Claim, computeClaim, type ManualAmounts } from "../../src/domain/dunning/claim";
import { type DefaultStart, defaultStartOf } from "../../src/domain/dunning/default-start";
import {
  type DunningAction,
  type EvaluationContext,
  evaluateInvoice,
  type InvoiceState,
  issuedReminders,
  nextLevelEarliest,
  planDigest,
  type ReminderState,
  SKIP_REASON_LABEL_DE,
} from "../../src/domain/dunning/evaluate";
import { lateMarkWarning as domainLateMarkWarning } from "../../src/domain/dunning/late-mark";
import { limitationDateOf, limitationStatus } from "../../src/domain/dunning/limitation";
import {
  DEFAULT_POLICIES,
  type DunningPolicy,
  type PolicyStep,
  resolvePolicyId,
  validatePolicy,
} from "../../src/domain/dunning/policy";
import { defaultReminderTexts, reminderPlaceholderValues } from "../../src/domain/dunning/templates";
import { validateZugangOverride, ZUGANG_MESSAGES } from "../../src/domain/dunning/zugang";
import { basiszinsRuleVersions } from "../../src/domain/rules/overrides";
import type { DunningSettingsValues, PolicyValues, ReminderCreateValues } from "../../src/domain/schemas/dunning";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import { assignCounterNumber } from "./numberRanges";
import { paymentsOfTarget, settlesOf } from "./payments";
import { loadRuleOverrides } from "./ruleOverrides";
import {
  draftFromDoc,
  getDocument,
  loadDocumentContext,
  nextStatus,
  noteOverridesOf,
  resolveNotifications,
  snapshotOf,
  upsertNotification,
} from "./salesDocuments";
import { activeCredits } from "./settlement";
import type { ModelCtx, ReadCtx } from "./types";
import { emitDocumentEvent, emitDunningCaseEvent } from "./webhooks";

/**
 * Dunning (F05 §3.7–§3.10, §4.4–§4.6) — the only writer of `dunningPolicies`, `dunningCases`, `dunningRuns` and of
 * reminder documents (`salesDocuments.type = "reminder"`). The pure rules live in src/domain/dunning; this module
 * reads the facts, calls them and writes the result. Reminders are created as drafts or finalised like a Storno
 * (single transaction: number, snapshot + hash, `artifactStatus = pending`; the caller schedules the render). The app
 * never sends anything (B2): finalised reminders are exported and marked sent by the owner (F04 §3.5).
 *
 * Hooks called by other slices inside their transactions:
 *   onSettlementChanged(ctx, change)   payments: pause on partial payment, close on paid, reopen on reversal (DUN-034/035)
 *   onDispatchChanged(ctx, documentId) sent mark / retraction: Zugang → default start, to-dos (PAY-053, DUN-055/058)
 *   assertRetractionAllowed(ctx, doc)  EC-DUN-35 / PAY-064
 *   onDocumentCancelled(ctx, id)       Storno closes the case (EC-077)
 */

type SalesDoc = Doc<"salesDocuments">;
type CaseDoc = Doc<"dunningCases">;
type PolicyDoc = Doc<"dunningPolicies">;

const DUNNABLE = new Set<string>(INVOICE_FAMILY_TYPES);
const PAYMENT_SIGNAL_DAYS = 5;

const label = (d: Pick<SalesDoc, "number" | "type">) => d.number ?? "Mahnentwurf";

export const todayOf = (ctx: { now: () => number }): CalendarDate => berlinCalendarDate(ctx.now());

// ── policies (DUN-001) ──────────────────────────────────────────────────────────────────────────────────────────

export type PolicyRow = DunningPolicy & { id: string; version: number; seeded: boolean };

function policyRow(p: PolicyDoc): PolicyRow {
  return {
    id: p._id,
    name: p.name,
    isDefault: p.isDefault,
    appliesTo: p.appliesTo,
    steps: p.steps.map((s) => ({ ...s, textTemplateId: s.textTemplateId })),
    ...(p.dueSoonDays !== undefined ? { dueSoonDays: p.dueSoonDays } : {}),
    dueSoonTodo: p.dueSoonTodo,
    minOpenAmountCents: p.minOpenAmountCents,
    pauseOnPartialPaymentDays: p.pauseOnPartialPaymentDays,
    stopAfterLastLevel: p.stopAfterLastLevel,
    version: p.version,
    seeded: false,
  };
}

/** Stored policies; before the first save the §4.6 defaults act as virtual policies (`seed:0`, `seed:1`). */
export async function listPolicies(ctx: ReadCtx): Promise<PolicyRow[]> {
  const rows = (await ctx.db.query("dunningPolicies").collect()).filter((p) => p.archivedAt === undefined);
  if (rows.length > 0) return rows.map(policyRow);
  return DEFAULT_POLICIES.map((p, i) => ({ ...p, id: `seed:${i}`, version: 0, seeded: true }));
}

/** DUN-001: seeds the §4.6 defaults once (setup, first run, first manual reminder). */
export async function ensureDefaultPolicies(ctx: ModelCtx): Promise<void> {
  if ((await ctx.db.query("dunningPolicies").first()) !== null) return;
  for (const p of DEFAULT_POLICIES) {
    await auditedInsert(
      ctx,
      "dunningPolicies",
      { ...p, steps: p.steps.map(({ textTemplateId: _t, ...s }) => s), version: 1 },
      { action: "dunning.policy.seed", label: p.name },
    );
  }
}

function policyErrors(ctx: { now: () => number }, values: PolicyValues) {
  const findings = validatePolicy(values, todayOf(ctx));
  const errors = findings.filter((f) => f.severity === "E");
  if (errors.length > 0) {
    throw appError("invalid_input", errors[0]?.message, {
      reason: errors[0]?.code ?? "invalid",
      ...(errors[0]?.field ? { field: errors[0].field } : {}),
    });
  }
  return findings.filter((f) => f.severity === "W");
}

const policyFields = (v: PolicyValues) => ({
  name: v.name.trim(),
  isDefault: v.isDefault,
  appliesTo: v.appliesTo,
  steps: v.steps.map((s) => ({
    level: s.level,
    daysAfter: s.daysAfter,
    title: s.title.trim(),
    feeCents: s.feeCents,
    addInterest: s.addInterest,
    addFlatFee40: s.addFlatFee40,
    newDueDays: s.newDueDays,
    ...(s.textTemplateId ? { textTemplateId: s.textTemplateId as Id<"textTemplates"> } : {}),
    autoFinalize: s.autoFinalize,
  })),
  ...(v.dueSoonDays !== undefined ? { dueSoonDays: v.dueSoonDays } : {}),
  dueSoonTodo: v.dueSoonTodo,
  minOpenAmountCents: v.minOpenAmountCents,
  pauseOnPartialPaymentDays: v.pauseOnPartialPaymentDays,
  stopAfterLastLevel: v.stopAfterLastLevel,
});

/** Only one default per audience (B2C / B2B): a new default replaces the previous one. */
async function clearOtherDefaults(ctx: ModelCtx, keep: Id<"dunningPolicies">, appliesTo: PolicyValues["appliesTo"]) {
  for (const p of await ctx.db.query("dunningPolicies").collect()) {
    if (p._id === keep || !p.isDefault || p.archivedAt !== undefined) continue;
    if ((appliesTo.consumer && p.appliesTo.consumer) || (appliesTo.business && p.appliesTo.business)) {
      await auditedPatch(
        ctx,
        "dunningPolicies",
        p._id,
        { isDefault: false, version: p.version + 1 },
        {
          action: "dunning.policy.update",
          label: p.name,
        },
      );
    }
  }
}

export async function createPolicy(ctx: ModelCtx, values: PolicyValues) {
  await ensureDefaultPolicies(ctx);
  const warnings = policyErrors(ctx, values);
  const id = await auditedInsert(
    ctx,
    "dunningPolicies",
    { ...policyFields(values), version: 1 },
    { action: "dunning.policy.create", label: values.name },
  );
  if (values.isDefault) await clearOtherDefaults(ctx, id, values.appliesTo);
  return { id, warnings: warnings.map((w) => ({ code: w.code, message: w.message })) };
}

const SEED_REF = /^seed:(\d+)$/;

/**
 * DUN-001: a policy reference from the UI/API — a stored id or a virtual default (`seed:<n>`, listPolicies before the
 * first save). A seed reference stores the §4.6 defaults first and resolves to the stored row of that default; its
 * expected version 0 means „the untouched seed“ (stored version 1).
 */
export async function resolvePolicyRef(
  ctx: ModelCtx,
  ref: string,
  version?: number,
): Promise<{ policy: PolicyDoc; expectedVersion: number | undefined }> {
  const seed = SEED_REF.exec(ref);
  if (seed) {
    const def = DEFAULT_POLICIES[Number(seed[1])];
    if (!def) throw appError("not_found", "Die Mahnrichtlinie existiert nicht.");
    await ensureDefaultPolicies(ctx);
    const rows = (await ctx.db.query("dunningPolicies").collect()).sort((a, b) => a._creationTime - b._creationTime);
    const policy = rows.find((p) => p.name === def.name && p.archivedAt === undefined);
    if (!policy) throw appError("not_found", "Die Mahnrichtlinie existiert nicht.");
    return { policy, expectedVersion: version === 0 ? 1 : version };
  }
  const id = ctx.db.normalizeId("dunningPolicies", ref);
  const policy = id ? await ctx.db.get(id) : null;
  if (!policy || policy.archivedAt !== undefined) throw appError("not_found", "Die Mahnrichtlinie existiert nicht.");
  return { policy, expectedVersion: version };
}

/** DUN-001: stores the §4.6 defaults (Einstellungen › Mahnwesen „Standardrichtlinien übernehmen“). */
export async function ensureDefaults(ctx: ModelCtx): Promise<PolicyRow[]> {
  await ensureDefaultPolicies(ctx);
  return listPolicies(ctx);
}

export async function updatePolicy(ctx: ModelCtx, ref: string, version: number, values: PolicyValues) {
  const { policy: p, expectedVersion } = await resolvePolicyRef(ctx, ref, version);
  const id = p._id;
  if (p.version !== expectedVersion) throw appError("version_conflict");
  const warnings = policyErrors(ctx, values);
  await auditedPatch(
    ctx,
    "dunningPolicies",
    id,
    { ...policyFields(values), dueSoonDays: values.dueSoonDays, version: p.version + 1 },
    { action: "dunning.policy.update", label: values.name },
  );
  if (values.isDefault) await clearOtherDefaults(ctx, id, values.appliesTo);
  return { id, version: p.version + 1, warnings: warnings.map((w) => ({ code: w.code, message: w.message })) };
}

export async function archivePolicy(ctx: ModelCtx, ref: string) {
  const { policy: p } = await resolvePolicyRef(ctx, ref);
  const id = p._id;
  if (p.isDefault) {
    throw appError(
      "conflict",
      "Die Standardrichtlinie kann nicht archiviert werden. Bitte zuerst eine andere als Standard festlegen.",
      {
        reason: "policy_default",
      },
    );
  }
  await auditedPatch(
    ctx,
    "dunningPolicies",
    id,
    { archivedAt: ctx.now(), version: p.version + 1 },
    {
      action: "dunning.policy.archive",
      label: p.name,
    },
  );
}

/** Einstellungen › Mahnwesen global switches (companyProfile.receivables). */
export async function saveSettings(ctx: ModelCtx, values: DunningSettingsValues) {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  await patchCompanyProfile(
    ctx,
    { receivables: { ...profile.receivables, ...values } },
    { action: "settings.dunning.update" },
  );
}

// ── facts ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function remindersOf(ctx: ReadCtx, invoiceId: Id<"salesDocuments">): Promise<SalesDoc[]> {
  return (
    await ctx.db
      .query("salesDocuments")
      .withIndex("by_reminderInvoice", (q) => q.eq("reminder.invoiceId", invoiceId))
      .collect()
  ).sort((a, b) => (a.reminder?.level ?? 0) - (b.reminder?.level ?? 0) || a._creationTime - b._creationTime);
}

export async function caseOf(ctx: ReadCtx, invoiceId: Id<"salesDocuments">): Promise<CaseDoc | null> {
  return ctx.db
    .query("dunningCases")
    .withIndex("by_invoice", (q) => q.eq("invoiceId", invoiceId))
    .first();
}

function reminderState(r: SalesDoc, c: CaseDoc | null): ReminderState {
  const rem = r.reminder;
  return {
    id: r._id,
    level: rem?.level ?? 0,
    ...(r.number ? { number: r.number } : {}),
    documentDate: (r.documentDate ?? berlinCalendarDate(Math.floor(r._creationTime))) as CalendarDate,
    ...(r.finalizedAt ? { finalizedOn: berlinCalendarDate(r.finalizedAt) } : {}),
    newDueDate: (rem?.newDueDate ?? "") as CalendarDate,
    newDueDays: rem?.newDueDays ?? 0,
    ...(r.zugang ? { zugang: r.zugang.date as CalendarDate } : {}),
    status: r.status === "draft" || r.status === "finalized" || r.status === "sent" ? r.status : "cancelled",
    todoLogged: c?.todoLogged?.includes(r._id) ?? false,
  };
}

/** Open principal history for § 288 interest: payable, then every settlement change on its date (DUN-020/023). */
export async function principalHistory(ctx: ReadCtx, inv: SalesDoc) {
  const changes: { date: CalendarDate; deltaCents: number }[] = [];
  for (const p of await paymentsOfTarget(ctx, { kind: "salesDocument", id: inv._id })) {
    const s = settlesOf(p);
    if (s !== 0) changes.push({ date: p.date as CalendarDate, deltaCents: -s });
  }
  for (const c of await activeCredits(ctx, inv)) {
    if (c.creditAppliedCents && c.documentDate) {
      changes.push({ date: c.documentDate as CalendarDate, deltaCents: -c.creditAppliedCents });
    }
  }
  return { principalCents: inv.totals.payableCents, changes };
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]/g, "");

/** DUN-033 / EC-DUN-18 / EC-152: an unallocated incoming transaction of the last 5 days that may pay this invoice. */
async function paymentSignal(ctx: ReadCtx, inv: SalesDoc, contactName: string, today: CalendarDate) {
  const since = addDays(today, -PAYMENT_SIGNAL_DAYS);
  const name = norm(contactName);
  const number = norm(inv.number ?? "");
  for (const status of ["open", "partially_matched"] as const) {
    for (const tx of await ctx.db
      .query("bankTransactions")
      .withIndex("by_status", (q) => q.eq("status", status).gte("bookingDate", since))
      .collect()) {
      if (tx.amountCents <= 0) continue;
      const text = norm(`${tx.purpose} ${tx.reference ?? ""}`);
      const cp = norm(tx.counterpartyName ?? "");
      if ((number && text.includes(number)) || (name.length >= 4 && cp && (cp.includes(name) || name.includes(cp)))) {
        return true;
      }
    }
  }
  return false;
}

/** DUN-033 / EC-DUN-19 (P1): bank data is current if no bank account exists or the latest statement is recent. */
export async function bankDataFreshness(ctx: ReadCtx, today: CalendarDate, maxAgeDays: number) {
  const accounts = (await ctx.db.query("bankAccounts").collect()).filter((a) => a.kind === "bank");
  if (accounts.length === 0) return { current: true as const };
  let latest: string | undefined;
  for (const a of accounts) {
    const s = await ctx.db
      .query("bankStatements")
      .withIndex("by_account_period", (q) => q.eq("accountId", a._id))
      .order("desc")
      .first();
    const tx = await ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (q) => q.eq("accountId", a._id))
      .order("desc")
      .first();
    for (const d of [s && !s.rolledBack ? s.periodTo : undefined, tx?.bookingDate]) {
      if (d && (!latest || d > latest)) latest = d;
    }
  }
  const current = latest !== undefined && latest >= addDays(today, -maxAgeDays);
  return {
    current,
    note: latest
      ? `letzter Kontoauszug bis ${formatGermanDate(latest as CalendarDate)}`
      : "noch kein Kontoauszug importiert",
  };
}

export interface LoadedInvoice {
  inv: SalesDoc;
  contact: Doc<"contacts"> | null;
  dunningCase: CaseDoc | null;
  reminders: SalesDoc[];
  state: InvoiceState;
}

export async function loadInvoiceState(ctx: ReadCtx, inv: SalesDoc, today: CalendarDate): Promise<LoadedInvoice> {
  const contact = inv.contactId ? await ctx.db.get(inv.contactId) : null;
  const dunningCase = await caseOf(ctx, inv._id);
  const reminders = await remindersOf(ctx, inv._id);
  const snap = await snapshotOf(ctx, inv);
  const contactName = contact?.displayName ?? inv.contactName ?? "";
  const state: InvoiceState = {
    invoiceId: inv._id,
    number: inv.number ?? "",
    openAmountCents: inv.openAmountCents ?? inv.totals.payableCents,
    dueDate: (inv.dueDate ?? inv.documentDate ?? today) as CalendarDate,
    ...(inv.zugang ? { zugang: inv.zugang.date as CalendarDate } : {}),
    hasB2c286Note: snap?.notes.some((n) => n.id === "b2c_286") ?? false,
    blocked: inv.dunningBlocked !== undefined,
    disputed: inv.disputed !== undefined,
    contact: {
      isConsumer: contact?.isConsumer ?? snap?.buyer.isConsumer ?? false,
      ...(contact?.dunning?.policyId ? { policyId: contact.dunning.policyId } : {}),
      blocked: contact?.dunning?.blocked === true,
      calendarDueDateAgreed: contact?.dunning?.calendarDueDateAgreed === true,
    },
    ...(dunningCase
      ? {
          case: {
            status: dunningCase.status,
            currentLevel: dunningCase.currentLevel,
            ...(dunningCase.pausedUntil ? { pausedUntil: dunningCase.pausedUntil as CalendarDate } : {}),
            flatFeeCharged: dunningCase.flatFeeCharged,
            ...(dunningCase.graceUntil ? { graceUntil: dunningCase.graceUntil as CalendarDate } : {}),
          },
        }
      : {}),
    reminders: reminders.map((r) => reminderState(r, dunningCase)),
    paymentSignal: await paymentSignal(ctx, inv, contactName, today),
    history: await principalHistory(ctx, inv),
    ...(inv.currency !== "EUR" ? { currency: inv.currency } : {}),
  };
  return { inv, contact, dunningCase, reminders, state };
}

export interface RunSettings {
  ctx: EvaluationContext;
  postalDeliveryDays: number;
  reopenGraceDays: number;
}

export async function evaluationContext(ctx: ReadCtx, today: CalendarDate): Promise<RunSettings> {
  const profile = await getCompanyProfile(ctx);
  const r = profile?.receivables;
  const bank = await bankDataFreshness(ctx, today, r?.bankDataMaxAgeDays ?? 7);
  const basiszins = (await loadRuleOverrides(ctx)).basiszinssatz;
  return {
    ctx: {
      // SET-122/DUN-021: owner Basiszinssatz rows win over the shipped table.
      ...(basiszins.length ? { overrides: basiszins } : {}),
      policies: await listPolicies(ctx),
      autoFinalizeReminders: r?.autoFinalizeReminders ?? false,
      defaultStartViaReminder: r?.defaultStartViaReminder ?? "after_printed_deadline",
      bankDataCurrent: bank.current,
      ...(bank.note ? { bankDataNote: bank.note } : {}),
      ...(profile?.taxNumberState ? { state: profile.taxNumberState } : {}),
    },
    postalDeliveryDays: r?.postalDeliveryDays ?? 3,
    reopenGraceDays: r?.reopenGraceDays ?? 7,
  };
}

/** Invoices the run looks at (§4.5): invoice family, finalised or sent, open amount > 0. */
export async function dunnableInvoices(ctx: ReadCtx): Promise<SalesDoc[]> {
  const out: SalesDoc[] = [];
  for (const status of ["open", "partially_paid"] as const) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_paymentStatus_due", (q) => q.eq("paymentStatus", status))
      .collect()) {
      if (DUNNABLE.has(d.type) && (d.status === "finalized" || d.status === "sent") && (d.openAmountCents ?? 0) > 0) {
        out.push(d);
      }
    }
  }
  return out.sort((a, b) => ((a.dueDate ?? "") < (b.dueDate ?? "") ? -1 : 1));
}

export function defaultStartFor(l: LoadedInvoice, s: RunSettings): DefaultStart | null {
  return defaultStartOf({
    dueDate: l.state.dueDate,
    invoiceZugang: l.state.zugang,
    isConsumer: l.state.contact.isConsumer,
    hasB2c286Note: l.state.hasB2c286Note,
    calendarDueDateAgreed: l.state.contact.calendarDueDateAgreed,
    reminders: l.state.reminders,
    route: s.ctx.defaultStartViaReminder,
  });
}

// ── cases ───────────────────────────────────────────────────────────────────────────────────────────────────────

async function ensureCase(ctx: ModelCtx, inv: SalesDoc, policyId: string | null): Promise<CaseDoc> {
  const existing = await caseOf(ctx, inv._id);
  if (existing) return existing;
  const id = await auditedInsert(
    ctx,
    "dunningCases",
    {
      invoiceId: inv._id,
      ...(policyId && !policyId.startsWith("seed:") ? { policyId: policyId as Id<"dunningPolicies"> } : {}),
      currentLevel: 0,
      status: "active",
      flatFeeCharged: false,
      reminders: [],
      limitationDate: limitationDateOf((inv.dueDate ?? inv.documentDate ?? todayOf(ctx)) as CalendarDate),
    },
    { action: "dunning.case.create", label: inv.number ?? "Rechnung" },
  );
  return (await ctx.db.get(id)) as CaseDoc;
}

/** PAY-053: recompute and store the default start of a case after any input changed. */
async function refreshDefaultStart(ctx: ModelCtx, invoiceId: Id<"salesDocuments">) {
  const c = await caseOf(ctx, invoiceId);
  if (!c) return;
  const inv = await getDocument(ctx, invoiceId);
  const today = todayOf(ctx);
  const l = await loadInvoiceState(ctx, inv, today);
  const s = await evaluationContext(ctx, today);
  const start = defaultStartFor(l, s);
  await auditedPatch(
    ctx,
    "dunningCases",
    c._id,
    { defaultStartDate: start?.date, defaultRoute: start?.route },
    { action: "dunning.case.default_start", label: inv.number ?? "Rechnung" },
  );
}

// ── reminder documents (DUN-004/005/007/008) ────────────────────────────────────────────────────────────────────

export interface ReminderPlan {
  inv: SalesDoc;
  loaded: LoadedInvoice;
  settings: RunSettings;
  policyId: string | null;
  step: PolicyStep;
  computed: Claim;
  claim: Claim;
  findings: { code: string; severity: "E" | "W"; message: string; rule?: string; field?: string }[];
}

const err = (code: string, message: string, rule?: string) => ({
  code,
  severity: "E" as const,
  message,
  ...(rule ? { rule } : {}),
});
const warn = (code: string, message: string, rule?: string) => ({
  code,
  severity: "W" as const,
  message,
  ...(rule ? { rule } : {}),
});

/** EC-DUN-21/29: only issued, unpaid invoice-family documents can be dunned. */
function dunnableIssue(inv: SalesDoc) {
  const status =
    inv.status === "cancelled" ? "storniert" : (inv.openAmountCents ?? inv.totals.payableCents) <= 0 ? "bezahlt" : null;
  if (!DUNNABLE.has(inv.type) || inv.status === "draft" || status) {
    return err(
      "reminder_not_allowed",
      `Für diese Rechnung kann keine Mahnung erstellt werden (Status: ${status ?? (inv.status === "draft" ? "Entwurf" : "kein Rechnungsbeleg")}).`,
    );
  }
  return null;
}

function stepFor(policy: PolicyRow | undefined, level: number): { step: PolicyStep; beyond: boolean } {
  const steps = [...(policy?.steps ?? DEFAULT_POLICIES[0]?.steps ?? [])].sort((a, b) => a.level - b.level);
  const exact = steps.find((s) => s.level === level);
  if (exact) return { step: exact, beyond: false };
  const last = steps.at(-1) as PolicyStep;
  return { step: { ...last, level, title: `${level - 1}. Mahnung` }, beyond: true };
}

/** Plans a reminder for `invoiceId` on `today` (manual or by the run); writes nothing. */
export async function planReminder(
  ctx: ReadCtx,
  invoiceId: Id<"salesDocuments">,
  input: ReminderCreateValues & { manual?: ManualAmounts },
  today: CalendarDate,
  opts: { forFinalize?: boolean; excludeReminderId?: string } = {},
): Promise<ReminderPlan> {
  const inv = await getDocument(ctx, invoiceId);
  const settings = await evaluationContext(ctx, today);
  const loaded = await loadInvoiceState(ctx, inv, today);
  const findings: ReminderPlan["findings"] = [];
  const notAllowed = dunnableIssue(inv);
  if (notAllowed) findings.push(notAllowed);
  const policyId = resolvePolicyId(settings.ctx.policies, loaded.state.contact);
  const policy = settings.ctx.policies.find((p) => p.id === policyId) as PolicyRow | undefined;
  const reminders = loaded.state.reminders.filter((r) => r.id !== opts.excludeReminderId);
  const issued = issuedReminders(reminders);
  const latest = issued.at(-1);
  const currentLevel = Math.max(loaded.dunningCase?.currentLevel ?? 0, latest?.level ?? 0);
  const level = input.level ?? currentLevel + 1;
  const { step, beyond } = stepFor(policy, level);
  if (beyond) findings.push(warn("beyond_policy", `Stufe ${level} ist in der Mahnrichtlinie nicht vorgesehen.`));
  // DUN-056/DUN-009: the case level is never decremented, but a withdrawn level may be issued again („Gegenstandslos
  // setzen und neu erstellen“) as long as no issued reminder has that level or a higher one.
  const reissue = reminders.some((r) => r.status === "cancelled" && r.level === level) && level > (latest?.level ?? 0);
  if (level <= currentLevel && !opts.excludeReminderId && !reissue) {
    findings.push(
      err("level_exists", `Mahnstufe ${level} wurde bereits erstellt. Nächste Stufe: ${currentLevel + 1}.`),
    );
  }
  if (latest && latest.status === "finalized") {
    findings.push(
      err(
        "previous_reminder_not_marked_sent",
        `Die Mahnung ${latest.number ?? ""} ist noch nicht als versendet markiert. Bitte zuerst exportieren und den Versand markieren.`,
        "MAHN-05",
      ),
    );
  } else if (latest && level > 1) {
    const earliest = nextLevelEarliest(latest, step.daysAfter);
    if (earliest && today < earliest) {
      findings.push(
        warn(
          "previous_deadline_running",
          `Die Frist der letzten Mahnung läuft noch bis ${formatGermanDate(addDays(earliest, -1))}.`,
        ),
      );
    }
  }
  if (!opts.excludeReminderId && reminders.some((r) => r.status === "draft")) {
    findings.push(err("draft_exists", "Für diese Rechnung gibt es bereits einen Mahnentwurf."));
  }
  if (!loaded.state.zugang) {
    const f = {
      code: "invoice_not_marked_sent",
      message: "Die Rechnung ist nicht als versendet markiert. Ohne Zugang der Rechnung kann nicht gemahnt werden.",
      rule: "MAHN-01",
    };
    findings.push(opts.forFinalize ? { ...f, severity: "E" } : { ...f, severity: "W" });
  }
  if (loaded.state.blocked || loaded.state.contact.blocked) {
    findings.push(warn("dunning_blocked", "Für diese Rechnung bzw. diesen Kunden ist „Nicht mahnen“ gesetzt."));
  }
  if (loaded.state.disputed) findings.push(warn("disputed", "Die Forderung ist als bestritten markiert."));
  const lim = limitationStatus(loaded.state.dueDate, today);
  if (lim.state === "expired" && lim.message) findings.push(warn("time_barred", lim.message, "MAHN-05"));
  const defaultStart = defaultStartFor({ ...loaded, state: { ...loaded.state, reminders } }, settings);
  const computedR = computeClaim({
    date: today,
    step,
    isConsumer: loaded.state.contact.isConsumer,
    defaultStart,
    openAmountCents: loaded.state.openAmountCents,
    history: loaded.state.history,
    flatFeeCharged: loaded.dunningCase?.flatFeeCharged ?? false,
    state: settings.ctx.state,
    ...(settings.ctx.overrides ? { overrides: settings.ctx.overrides } : {}),
    ...(inv.currency !== "EUR" ? { currency: inv.currency } : {}),
  });
  if (!computedR.ok) throw appError("invalid_input", computedR.error.message, { reason: computedR.error.code });
  const flatFeeRem = loaded.dunningCase?.flatFeeReminderId
    ? await ctx.db.get(loaded.dunningCase.flatFeeReminderId)
    : null;
  const manual = input.manual ?? {
    ...(input.feeCents !== undefined ? { feeCents: input.feeCents } : {}),
    ...(input.interestCents !== undefined ? { interestCents: input.interestCents } : {}),
    ...(input.interestReason ? { interestReason: input.interestReason } : {}),
    ...(input.includeFlatFee !== undefined ? { includeFlatFee: input.includeFlatFee } : {}),
    ...(input.newDueDate ? { newDueDate: input.newDueDate } : {}),
  };
  const applied = applyManualAmounts(computedR.value, manual, {
    isConsumer: loaded.state.contact.isConsumer,
    flatFeeCharged: loaded.dunningCase?.flatFeeCharged ?? false,
    ...(flatFeeRem?.number ? { flatFeeReminderNumber: flatFeeRem.number } : {}),
    date: today,
  });
  findings.push(...applied.findings);
  // EC-DUN-27: the reminder document prints all amounts in the document currency; until it can show the EUR flat
  // fee as a separate line, a non-EUR reminder with the 40 € may be drafted but not finalised.
  // LEGAL-OPEN: F05 EC-DUN-27 spec note (snapshot/PDF currency split, F04 template).
  if (opts.forFinalize && applied.claim.flatFeeCurrency && applied.claim.flatFee40Cents > 0) {
    findings.push(
      err(
        "flat_fee_eur_not_printable",
        "Die 40-€-Pauschale einer Rechnung in Fremdwährung kann auf der Mahnung noch nicht gesondert in EUR ausgewiesen werden. Bitte die Pauschale weglassen und gesondert in EUR geltend machen.",
        "MAHN-03",
      ),
    );
  }
  return { inv, loaded, settings, policyId, step, computed: computedR.value, claim: applied.claim, findings };
}

function assertPlan(plan: ReminderPlan, acknowledged: readonly string[]) {
  const errors = plan.findings.filter((f) => f.severity === "E");
  if (errors.length > 0) {
    const first = errors[0] as (typeof errors)[number];
    throw appError("invalid_input", first.message, {
      reason: first.code,
      ...(first.field ? { field: first.field } : {}),
    });
  }
  const missing = plan.findings.filter((f) => f.severity === "W" && !acknowledged.includes(f.code));
  if (missing.length > 0) {
    throw appError("invalid_input", missing.map((w) => w.message).join(" "), {
      reason: "WARNINGS_UNACKNOWLEDGED",
      warnings: missing.map((w) => w.code).join(","),
    });
  }
}

const reminderField = (plan: ReminderPlan, manual: ManualAmounts, byRun: boolean) => ({
  invoiceId: plan.inv._id,
  level: plan.claim.level,
  title: plan.claim.title,
  feeCents: plan.claim.feeCents,
  interestCents: plan.claim.interestCents,
  flatFee40Cents: plan.claim.flatFee40Cents,
  newDueDate: plan.claim.newDueDate,
  newDueDays: plan.step.newDueDays,
  totalCents: plan.claim.totalCents,
  openAmountCents: plan.claim.openAmountCents,
  interestSegments: plan.claim.interestSegments.map((s) => ({
    from: s.from,
    to: s.to,
    days: s.days,
    principalCents: s.principalCents,
    rateBp: s.rateBp,
    amountCents: s.amountCents,
  })),
  ...(plan.claim.defaultStartDate ? { defaultStartDate: plan.claim.defaultStartDate } : {}),
  ...(Object.keys(manual).length ? { manual } : {}),
  ...(byRun ? { createdByRun: true } : {}),
});

function manualOf(input: ReminderCreateValues): ManualAmounts {
  return {
    ...(input.feeCents !== undefined ? { feeCents: input.feeCents } : {}),
    ...(input.interestCents !== undefined ? { interestCents: input.interestCents } : {}),
    ...(input.interestReason?.trim() ? { interestReason: input.interestReason.trim() } : {}),
    ...(input.includeFlatFee !== undefined ? { includeFlatFee: input.includeFlatFee } : {}),
    ...(input.newDueDate ? { newDueDate: input.newDueDate } : {}),
  };
}

/**
 * DUN-050 texts of a level: owner templates (`textTemplates` with docType `reminder` and `level`, or the step's
 * `textTemplateId`) win over the shipped defaults (src/domain/dunning/templates.ts).
 */
async function textsFor(ctx: ReadCtx, level: number, lang: "de" | "en", templateId?: string) {
  const base = defaultReminderTexts(level, lang);
  const all = (await ctx.db.query("textTemplates").collect()).filter(
    (t) => t.docTypes.includes("reminder") && t.language === lang,
  );
  const choose = (kind: "document_head" | "document_foot") =>
    all.find((t) => t._id === templateId && t.kind === kind) ?? all.find((t) => t.kind === kind && t.level === level);
  return {
    subject: base.subject,
    headText: choose("document_head")?.body ?? base.headText,
    footText: choose("document_foot")?.body ?? base.footText,
  };
}

/** DUN-008 „Mahnung erstellen“ / „Nächste Mahnstufe“ (DUN-007): a reminder draft; the run passes `byRun`. */
export async function createReminderDraft(
  ctx: ModelCtx,
  invoiceId: Id<"salesDocuments">,
  input: ReminderCreateValues,
  opts: { byRun?: boolean } = {},
): Promise<Id<"salesDocuments">> {
  await ensureDefaultPolicies(ctx);
  const today = todayOf(ctx);
  const plan = await planReminder(ctx, invoiceId, input, today);
  assertPlan(plan, opts.byRun ? plan.findings.map((f) => f.code) : (input.acknowledgeWarnings ?? []));
  const inv = plan.inv;
  const texts = await textsFor(ctx, plan.claim.level, inv.language, plan.step.textTemplateId);
  const manual = manualOf(input);
  const id = await auditedInsert(
    ctx,
    "salesDocuments",
    {
      type: "reminder",
      status: "draft",
      ...(inv.contactId ? { contactId: inv.contactId } : {}),
      ...(inv.contactName ? { contactName: inv.contactName } : {}),
      ...(inv.billingAddressId ? { billingAddressId: inv.billingAddressId } : {}),
      supplyDateMode: "document_date",
      currency: inv.currency,
      priceMode: inv.priceMode,
      taxCase: inv.taxCase,
      paymentTerms: { dueDays: plan.step.newDueDays },
      ...(inv.paymentMethodId ? { paymentMethodId: inv.paymentMethodId } : {}),
      ...(inv.bankAccountId ? { bankAccountId: inv.bankAccountId } : {}),
      showEpcQr: false,
      language: inv.language,
      einvoice: {},
      subject: texts.subject,
      headText: input.headText ?? texts.headText,
      footText: input.footText ?? texts.footText,
      totals: { netCents: 0, vatCents: 0, grossCents: 0, advancesDeductedGrossCents: 0, payableCents: 0, byGroup: [] },
      reminder: reminderField(plan, manual, opts.byRun === true),
      retentionClass: "letters6",
      tags: [],
      customFields: {},
      createdBy: ctx.actor,
      channel: ctx.actorContext.channel === "cron" ? "system" : ctx.actorContext.channel,
      version: 1,
    },
    {
      action: "dunning.reminder.create_draft",
      label: `Mahnentwurf Stufe ${plan.claim.level} zu ${inv.number ?? ""}`,
      ...(manual.interestReason ? { reason: manual.interestReason } : {}),
    },
  );
  const c = await ensureCase(ctx, inv, plan.policyId);
  await auditedPatch(
    ctx,
    "dunningCases",
    c._id,
    { reminders: [...c.reminders, id] },
    {
      action: "dunning.case.reminder",
      label: inv.number ?? "Rechnung",
    },
  );
  return id;
}

async function requireReminder(
  ctx: ReadCtx,
  id: Id<"salesDocuments">,
): Promise<SalesDoc & { reminder: NonNullable<SalesDoc["reminder"]> }> {
  const r = await ctx.db.get(id);
  if (r?.type !== "reminder" || !r.reminder) throw appError("not_found", "Die Mahnung existiert nicht.");
  return r as SalesDoc & { reminder: NonNullable<SalesDoc["reminder"]> };
}

/** Reminder editor: amounts, deadline and texts of a draft (DUN-008, §6.5). EC-DUN-13: finalised = immutable. */
export async function updateReminderDraft(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  version: number,
  input: ReminderCreateValues,
): Promise<{ version: number }> {
  const r = await requireReminder(ctx, id);
  if (r.status !== "draft") {
    throw appError(
      "document_not_draft",
      "Mahnungen sind nach dem Fertigstellen unveränderbar. Bitte als gegenstandslos markieren und neu erstellen.",
    );
  }
  if (r.version !== version)
    throw appError("version_conflict", "Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
  const plan = await planReminder(ctx, r.reminder.invoiceId, { ...input, level: r.reminder.level }, todayOf(ctx), {
    excludeReminderId: id,
  });
  assertPlan(plan, input.acknowledgeWarnings ?? []);
  const manual = manualOf(input);
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      reminder: reminderField(plan, manual, r.reminder.createdByRun === true),
      ...(input.headText !== undefined ? { headText: input.headText } : {}),
      ...(input.footText !== undefined ? { footText: input.footText } : {}),
      version: r.version + 1,
    },
    {
      action: "dunning.reminder.update_draft",
      label: label(r),
      ...(manual.interestReason ? { reason: manual.interestReason } : {}),
    },
  );
  return { version: r.version + 1 };
}

async function dropFromCase(ctx: ModelCtx, r: SalesDoc & { reminder: NonNullable<SalesDoc["reminder"]> }) {
  const c = await caseOf(ctx, r.reminder.invoiceId);
  if (c?.reminders.includes(r._id)) {
    await auditedPatch(
      ctx,
      "dunningCases",
      c._id,
      { reminders: c.reminders.filter((x) => x !== r._id) },
      {
        action: "dunning.case.reminder",
      },
    );
  }
}

export async function deleteReminderDraft(ctx: ModelCtx, id: Id<"salesDocuments">, reason?: string): Promise<void> {
  const r = await requireReminder(ctx, id);
  if (r.status !== "draft") throw appError("document_not_draft");
  await dropFromCase(ctx, r);
  await auditedDelete(ctx, "salesDocuments", id, {
    action: "dunning.reminder.delete_draft",
    label: `Mahnentwurf Stufe ${r.reminder.level}`,
    ...(reason ? { reason } : {}),
  });
}

/** EC-DUN-24/25 and the infrastructure gates of the F04 pipeline, checked before any write. */
function pipelineFindings(l: Awaited<ReturnType<typeof loadDocumentContext>>) {
  const out: string[] = [];
  if (!l.ctx.setupComplete) out.push("Die Einrichtung ist noch nicht abgeschlossen → Einrichtung fortsetzen.");
  if (l.ctx.integrityAlertOpen) {
    out.push(
      "Die Integritätsprüfung hat einen Fehler gemeldet. Bitte zuerst unter Einstellungen › System prüfen und bestätigen.",
    );
  }
  if (!l.ctx.numberRangeAvailable) {
    out.push("Kein aktiver Nummernkreis für Mahnungen. Bitte unter Einstellungen › Nummernkreise anlegen.");
  }
  const blocking = l.ctx.company.validation.blocking;
  if (blocking.length > 0) {
    out.push(`Pflichtangaben im Geschäftsbrief fehlen: ${blocking.map((b) => b.message).join(" ")}`);
  }
  if (!l.ctx.contact) out.push("Kein Kunde ausgewählt.");
  return out;
}

/**
 * DUN-004 finalisation: re-plans the claim on the finalisation date (fees/interest/deadline, DUN-026, §4.5 step 7),
 * blocks per EC-DUN-22/24/25/31/32, then — in this transaction — number, snapshot + hash, status, retention,
 * `artifactStatus = pending`, the case level/flat fee/default start and the to-do „exportieren und als versendet
 * markieren“ (DUN-055). No journal entry (DUN-006), no XML. The caller schedules the render.
 */
export async function finalizeReminder(
  ctx: ModelCtx,
  id: Id<"salesDocuments">,
  opts: { version?: number; acknowledgeWarnings?: readonly string[]; byRun?: boolean } = {},
): Promise<{ number: string }> {
  const r = await requireReminder(ctx, id);
  if (r.status !== "draft") throw appError("document_not_draft");
  if (opts.version !== undefined && opts.version !== r.version) {
    throw appError("version_conflict", "Der Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.");
  }
  const today = todayOf(ctx);
  const inv = await getDocument(ctx, r.reminder.invoiceId);
  if ((inv.openAmountCents ?? 0) <= 0 || inv.status === "cancelled") {
    throw appError("conflict", "Die Rechnung ist inzwischen bezahlt. Die Mahnung wurde nicht fertiggestellt.", {
      reason: "invoice_settled",
    });
  }
  const plan = await planReminder(ctx, inv._id, { level: r.reminder.level, manual: r.reminder.manual ?? {} }, today, {
    forFinalize: true,
    excludeReminderId: id,
  });
  assertPlan(
    plan,
    opts.byRun ? plan.findings.filter((f) => f.severity === "W").map((f) => f.code) : (opts.acknowledgeWarnings ?? []),
  );
  const now = ctx.now();
  const probe = { ...r, documentDate: today } as SalesDoc;
  const loaded = await loadDocumentContext(ctx, probe, now, []);
  const blockers = pipelineFindings(loaded);
  if (blockers.length > 0) throw appError("validation_failed", blockers[0], { reason: "reminder_pipeline" });
  const draft = draftFromDoc(probe, [], loaded.contact?.context.buyer.address);
  const resolved = resolveDraft({ ...draft, documentDate: today }, loaded.ctx);
  const claim = plan.claim;
  const [year, month] = today.split("-").map(Number) as [number, number];
  const assigned = await assignCounterNumber(ctx, {
    docType: "reminder",
    date: { year, month },
    documentId: id,
    action: "dunning.reminder.finalize",
  });
  const values = {
    ...placeholderValues({ draft, ctx: loaded.ctx, resolved, number: assigned.number, documentDate: today }),
    ...reminderPlaceholderValues({
      claim,
      invoiceNumber: inv.number ?? "",
      invoiceDate: inv.documentDate ?? "",
      invoiceDueDate: inv.dueDate ?? "",
      number: assigned.number,
      date: today,
    }),
  };
  const texts = {
    subject: resolveText(r.subject, values),
    headText: resolveText(r.headText, values),
    footText: resolveText(r.footText, values),
  };
  const input = buildSnapshotInput(
    {
      ...draft,
      documentDate: today,
      ...(texts.subject ? { subject: texts.subject } : {}),
      ...(texts.headText ? { headText: texts.headText } : {}),
      ...(texts.footText ? { footText: texts.footText } : {}),
    },
    loaded.ctx,
    resolved,
    {
      number: assigned.number,
      documentDate: today,
      layoutVersionId: loaded.layoutVersionId,
      plan: planEinvoice(draft, loaded.ctx, resolved),
    },
  );
  const reminder: SnapshotReminder = {
    level: claim.level,
    title: claim.title,
    invoiceNumber: inv.number ?? "",
    invoiceDate: inv.documentDate ?? "",
    invoiceDueDate: inv.dueDate ?? "",
    invoiceGrossCents: inv.totals.payableCents,
    paymentsReceivedCents: inv.totals.payableCents - claim.openAmountCents,
    openAmountCents: claim.openAmountCents,
    feeCents: claim.feeCents,
    interestCents: claim.interestCents,
    ...(claim.interestSegments.length
      ? {
          interestSegments: claim.interestSegments.map((s) => ({
            from: s.from,
            to: s.to,
            days: s.days,
            rateBp: s.rateBp,
            amountCents: s.amountCents,
          })),
        }
      : {}),
    flatFee40Cents: claim.flatFee40Cents,
    ...(claim.flatFeeAlreadyClaimed && claim.flatFee40Cents === 0 ? { flatFeeAlreadyClaimed: true } : {}),
    ...(claim.inDefault && claim.defaultStartDate ? { defaultStartDate: claim.defaultStartDate } : {}),
    newDueDate: claim.newDueDate,
    totalCents: claim.totalCents,
  };
  // SET-122: the reminder records the Basiszinssatz rows its interest used (shipped or owner override).
  const built = buildSnapshot({
    ...input,
    ...noteOverridesOf(loaded),
    ruleVersions: { ...(input.ruleVersions ?? {}), ...basiszinsRuleVersions(claim.interestSegments) },
    reminder,
  });
  if (!built.ok) throw appError("validation_failed", built.error.message, { reason: built.error.code });
  const snapshot = built.value;
  const snapshotId = await auditedInsert(
    ctx,
    "documentSnapshots",
    {
      documentId: id,
      json: canonicalSnapshotJson(snapshot),
      snapshotHash: await snapshotHash(snapshot),
      ruleVersions: { ...snapshot.ruleVersions },
      layoutVersionId: snapshot.layoutVersionId,
      createdAt: now,
    },
    { action: "dunning.reminder.finalize", label: assigned.number },
  );
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      status: nextStatus(r, "finalize"),
      number: assigned.number,
      ...(assigned.rangeId ? { numberRangeId: assigned.rangeId } : {}),
      documentDate: today,
      contactName: snapshot.buyer.name,
      ...(loaded.contact?.billingAddressId ? { billingAddressId: loaded.contact.billingAddressId } : {}),
      einvoice: { format: "none", decidedAt: now, validation: "not_required" },
      reminder: reminderField(plan, r.reminder.manual ?? {}, r.reminder.createdByRun === true),
      snapshotId,
      artifactStatus: "pending",
      artifactAttempts: 0,
      finalizedAt: now,
      finalizedBy: ctx.actor,
      finalizedFromVersion: r.version,
      retentionClass: "letters6",
      retentionUntil: retentionUntil("reminder", today),
    },
    { action: "dunning.reminder.finalize", label: assigned.number },
  );
  const c = await ensureCase(ctx, inv, plan.policyId);
  const start = defaultStartFor(plan.loaded, plan.settings);
  await auditedPatch(
    ctx,
    "dunningCases",
    c._id,
    {
      currentLevel: Math.max(c.currentLevel, claim.level),
      ...(claim.flatFee40Cents > 0 ? { flatFeeCharged: true, flatFeeReminderId: id } : {}),
      reminders: c.reminders.includes(id) ? c.reminders : [...c.reminders, id],
      defaultStartDate: start?.date,
      defaultRoute: start?.route,
      nextActionDate: undefined,
    },
    { action: "dunning.case.reminder_finalized", label: `${inv.number ?? ""} → ${assigned.number}` },
  );
  await upsertNotification(ctx, {
    kind: "reminder_mark_sent",
    severity: "info",
    title: `Mahnung ${assigned.number} exportieren und als versendet markieren`,
    link: `/mahnungen/${id}`,
    entity: { table: "salesDocuments", id },
    dedupeKey: `reminder_mark_sent:${id}`,
  });
  await emitDocumentEvent(ctx, id, "finalized", { status: "draft" }); // PAY-060 reminder.finalized
  return { number: assigned.number };
}

/**
 * DUN-009 „Mahnung gegenstandslos“: status `cancelled` with a reason; the archived document stays; the case level is
 * not decremented. A 40 € claim is reset only if the reminder was never marked sent (DUN-024). The optional
 * „gegenstandslos“ notice letter is not generated in P1 (see the slice report); the owner can write it manually.
 */
export async function withdrawReminder(ctx: ModelCtx, id: Id<"salesDocuments">, reason: string): Promise<void> {
  const r = await requireReminder(ctx, id);
  const why = reason.trim();
  if (why.length < 5)
    throw appError("invalid_input", "Bitte einen Grund angeben (mindestens 5 Zeichen).", { field: "reason" });
  if (r.status === "draft") {
    await deleteReminderDraft(ctx, id, why);
    return;
  }
  if (r.status !== "finalized" && r.status !== "sent") {
    throw appError("illegal_transition", "Die Mahnung ist bereits gegenstandslos.");
  }
  const later = (await remindersOf(ctx, r.reminder.invoiceId)).find(
    (x) =>
      x._id !== id && (x.reminder?.level ?? 0) > r.reminder.level && (x.status === "finalized" || x.status === "sent"),
  );
  if (later) {
    throw appError(
      "conflict",
      `Die Mahnung kann nicht gegenstandslos gesetzt werden, weil ${later.number ?? "eine spätere Mahnung"} darauf aufbaut.`,
      {
        reason: "later_reminder_exists",
      },
    );
  }
  const neverMarked = r.sentAt === undefined;
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    { status: nextStatus(r, "cancel"), cancellation: { at: ctx.now(), reason: why } },
    { action: "dunning.reminder.withdraw", label: label(r), reason: why },
  );
  const c = await caseOf(ctx, r.reminder.invoiceId);
  if (c && c.flatFeeReminderId === id && neverMarked) {
    await auditedPatch(
      ctx,
      "dunningCases",
      c._id,
      { flatFeeCharged: false, flatFeeReminderId: undefined },
      {
        action: "dunning.case.flat_fee_reset",
        label: label(r),
        reason: why,
      },
    );
  }
  await resolveNotifications(ctx, id, "reminder_mark_sent");
  await resolveNotifications(ctx, id, "reminder_withdraw_suggested");
  await refreshDefaultStart(ctx, r.reminder.invoiceId);
}

// ── hooks ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SettlementChangeLike {
  documentId: Id<"salesDocuments">;
  before: { paymentStatus?: string; openAmountCents?: number };
  after: { paymentStatus?: string; openAmountCents: number };
}

/** DUN-034/035, EC-125/129, EC-DUN-22/23: called by payments.onSettlementChanged inside the payment transaction. */
export async function onSettlementChanged(ctx: ModelCtx, change: SettlementChangeLike): Promise<void> {
  const c = await caseOf(ctx, change.documentId);
  const reminders = await remindersOf(ctx, change.documentId);
  if (!c && reminders.length === 0) return;
  const inv = await getDocument(ctx, change.documentId);
  const before = change.before.openAmountCents ?? inv.totals.payableCents;
  const after = change.after.openAmountCents;
  const today = todayOf(ctx);
  if (after <= 0) {
    for (const r of reminders) {
      if (r.status !== "draft" || !r.reminder) continue;
      if (r.reminder.createdByRun) {
        await deleteReminderDraft(ctx, r._id, "Rechnung inzwischen bezahlt (EC-DUN-22)");
      } else {
        await upsertNotification(ctx, {
          kind: "reminder_draft_obsolete",
          severity: "warning",
          title: `Mahnentwurf zu ${inv.number ?? ""}: Rechnung inzwischen bezahlt – Entwurf löschen`,
          link: `/mahnungen/${r._id}`,
          entity: { table: "salesDocuments", id: r._id },
          dedupeKey: `reminder_draft_obsolete:${r._id}`,
        });
      }
    }
    for (const r of reminders) {
      if (r.status === "finalized" && r.number) {
        // EC-DUN-23: unmarked → do not send; marked → withdrawal suggested.
        await upsertNotification(ctx, {
          kind: "reminder_mark_sent",
          severity: "warning",
          title: `Mahnung ${r.number}: Nicht versenden – gegenstandslos setzen`,
          link: `/mahnungen/${r._id}`,
          entity: { table: "salesDocuments", id: r._id },
          dedupeKey: `reminder_mark_sent:${r._id}`,
        });
      } else if (r.status === "sent" && r.number) {
        // EC-DUN-23 / DUN-009: the reminder stays (immutable); „gegenstandslos“ (+ optional notice) is suggested.
        await upsertNotification(ctx, {
          kind: "reminder_withdraw_suggested",
          severity: "info",
          title: `Mahnung ${r.number}: Zahlung nach Mahnung eingegangen – Mahnung als gegenstandslos markieren?`,
          link: `/mahnungen/${r._id}`,
          entity: { table: "salesDocuments", id: r._id },
          dedupeKey: `reminder_withdraw_suggested:${r._id}`,
        });
      }
    }
    if (c && c.status !== "closed") {
      await auditedPatch(
        ctx,
        "dunningCases",
        c._id,
        { status: "closed", pausedUntil: undefined, graceUntil: undefined },
        {
          action: "dunning.case.close",
          label: inv.number ?? "Rechnung",
          reason: change.after.paymentStatus === "written_off" ? "abgeschrieben" : "bezahlt",
        },
      );
    }
    return;
  }
  if (!c) return;
  if (c.status === "closed" && before <= 0) {
    const s = await evaluationContext(ctx, today);
    await auditedPatch(
      ctx,
      "dunningCases",
      c._id,
      { status: "active", graceUntil: addDays(today, s.reopenGraceDays) },
      { action: "dunning.case.reopen", label: inv.number ?? "Rechnung", reason: "Zahlung storniert (EC-129)" },
    );
    return;
  }
  if (after < before && c.status === "active") {
    const policies = await listPolicies(ctx);
    const policy = policies.find((p) => p.id === c.policyId) ?? policies.find((p) => p.isDefault);
    const days = policy?.pauseOnPartialPaymentDays ?? 14;
    if (days > 0) {
      await auditedPatch(
        ctx,
        "dunningCases",
        c._id,
        { status: "paused", pausedUntil: addDays(today, days), pausedReason: "Teilzahlung" },
        { action: "dunning.case.pause", label: inv.number ?? "Rechnung", reason: "Teilzahlung (DUN-034)" },
      );
      await emitDunningCaseEvent(ctx, "dunning_case.paused", c._id, { status: c.status }); // PAY-060
    }
  }
}

/** DUN-058 / PAY-052 / PAY-053: a sent mark, retraction or Zugang override of an invoice or reminder changed. */
export async function onDispatchChanged(ctx: ModelCtx, documentId: Id<"salesDocuments">): Promise<void> {
  const d = await ctx.db.get(documentId);
  if (!d) return;
  if (d.type === "reminder" && d.reminder) {
    if (d.sentAt !== undefined) await resolveNotifications(ctx, documentId, "reminder_mark_sent");
    await refreshDefaultStart(ctx, d.reminder.invoiceId);
  } else if (DUNNABLE.has(d.type)) {
    const before = await caseOf(ctx, documentId);
    await refreshDefaultStart(ctx, documentId);
    // EC-DUE-10: the invoice mark was retracted → Zugang gone, a default start depending on it was reset.
    // (A calendar-route default start needs no Zugang and survives — then nothing was reset.)
    const after = before ? await caseOf(ctx, documentId) : null;
    if (!d.zugang && before?.defaultStartDate && !after?.defaultStartDate && before.status !== "closed") {
      await upsertNotification(ctx, {
        kind: "dunning_reset",
        severity: "warning",
        title: `${d.number ?? "Rechnung"}: ${ZUGANG_MESSAGES.markRetracted}`,
        link: `/rechnungen/${documentId}`,
        entity: { table: "salesDocuments", id: documentId },
        dedupeKey: `dunning_reset:${documentId}:${before.defaultStartDate}`,
      });
    }
  }
}

/** EC-DUN-35 / PAY-064 / EC-198: retraction blocked when a later act depends on the mark. */
export async function assertRetractionAllowed(ctx: ReadCtx, doc: SalesDoc): Promise<void> {
  if (doc.type === "reminder" && doc.reminder) {
    const rem = doc.reminder;
    const later = (await remindersOf(ctx, rem.invoiceId)).find(
      (x) => x._id !== doc._id && (x.reminder?.level ?? 0) > rem.level && x.status !== "cancelled",
    );
    const c = await caseOf(ctx, rem.invoiceId);
    if (later || c?.status === "handed_over") {
      throw appError(
        "retraction_invalid",
        `Die Versandmarkierung kann nicht zurückgenommen werden, weil ${later?.number ?? (later ? "ein Mahnentwurf" : "die Übergabe an das Inkassobüro")} darauf aufbaut.`,
        { reason: "dependent_reminder" },
      );
    }
    return;
  }
  if (DUNNABLE.has(doc.type)) {
    const dependent = (await remindersOf(ctx, doc._id)).find((x) => x.status === "finalized" || x.status === "sent");
    if (dependent) {
      throw appError(
        "retraction_invalid",
        `Die Versandmarkierung kann nicht zurückgenommen werden, weil ${dependent.number ?? "eine Mahnung"} darauf aufbaut.`,
        { reason: "dependent_reminder" },
      );
    }
  }
}

/** DUN-056 / EC-DUN-33: a reminder marked sent more than 3 days after its document date (src/domain/dunning). */
export function lateMarkWarning(doc: Pick<SalesDoc, "type" | "documentDate">, sentOn: string): string | null {
  return domainLateMarkWarning(doc.type, doc.documentDate, sentOn);
}

/** EC-077: a Storno closes the case; the reminders stay archived. Open reminder drafts are removed. */
export async function onDocumentCancelled(ctx: ModelCtx, invoiceId: Id<"salesDocuments">): Promise<void> {
  const c = await caseOf(ctx, invoiceId);
  for (const r of await remindersOf(ctx, invoiceId)) {
    if (r.status === "draft") await deleteReminderDraft(ctx, r._id, "Rechnung storniert (EC-077)");
    else if (r.status === "finalized") await resolveNotifications(ctx, r._id, "reminder_mark_sent");
  }
  if (c && c.status !== "closed") {
    await auditedPatch(
      ctx,
      "dunningCases",
      c._id,
      { status: "closed" },
      { action: "dunning.case.close", reason: "storniert" },
    );
  }
}

// ── case actions (DUN-002, DUN-034, DUN-042/043) ────────────────────────────────────────────────────────────────

export async function caseAction(
  ctx: ModelCtx,
  invoiceId: Id<"salesDocuments">,
  a: {
    action: "pause" | "resume" | "dispute" | "block" | "unblock" | "hand_over";
    reason?: string;
    until?: string;
    partner?: string;
    acknowledgeWarnings?: string[];
  },
): Promise<void> {
  const inv = await getDocument(ctx, invoiceId);
  if (!DUNNABLE.has(inv.type) || inv.status === "draft")
    throw appError("invalid_input", "Nur fertiggestellte Rechnungen haben ein Mahnverfahren.");
  const reason = a.reason?.trim() ?? "";
  const lbl = inv.number ?? "Rechnung";
  const needReason = () => {
    if (reason.length < 3) throw appError("invalid_input", "Bitte einen Grund angeben.", { field: "reason" });
  };
  const today = todayOf(ctx);
  switch (a.action) {
    case "block":
      needReason();
      await auditedPatch(
        ctx,
        "salesDocuments",
        invoiceId,
        { dunningBlocked: { reason, at: ctx.now() } },
        { action: "dunning.block", label: lbl, reason },
      );
      return;
    case "unblock":
      await auditedPatch(
        ctx,
        "salesDocuments",
        invoiceId,
        { dunningBlocked: undefined },
        { action: "dunning.unblock", label: lbl },
      );
      return;
    case "dispute": {
      needReason();
      await auditedPatch(
        ctx,
        "salesDocuments",
        invoiceId,
        { disputed: { at: ctx.now(), reason } },
        { action: "dunning.dispute", label: lbl, reason },
      );
      const c = await caseOf(ctx, invoiceId);
      if (c && c.status !== "closed" && c.status !== "handed_over") {
        await auditedPatch(
          ctx,
          "dunningCases",
          c._id,
          { status: "paused", pausedUntil: undefined, pausedReason: "Bestritten", disputed: { at: ctx.now(), reason } },
          {
            action: "dunning.case.pause",
            label: lbl,
            reason,
          },
        );
        await emitDunningCaseEvent(ctx, "dunning_case.paused", c._id, { status: c.status }); // PAY-060
      }
      return;
    }
    case "pause": {
      if (a.until && a.until <= today)
        throw appError("invalid_input", "Das Datum muss in der Zukunft liegen.", { field: "until" });
      const c = await ensureCase(ctx, inv, null);
      if (c.status === "closed" || c.status === "handed_over")
        throw appError("conflict", "Der Mahnfall kann nicht pausiert werden.");
      await auditedPatch(
        ctx,
        "dunningCases",
        c._id,
        { status: "paused", pausedUntil: a.until, pausedReason: reason || "manuell" },
        {
          action: "dunning.case.pause",
          label: lbl,
          ...(reason ? { reason } : {}),
        },
      );
      await emitDunningCaseEvent(ctx, "dunning_case.paused", c._id, { status: c.status }); // PAY-060
      return;
    }
    case "resume": {
      if (inv.disputed)
        await auditedPatch(
          ctx,
          "salesDocuments",
          invoiceId,
          { disputed: undefined },
          { action: "dunning.undispute", label: lbl },
        );
      const c = await caseOf(ctx, invoiceId);
      if (c && c.status === "paused") {
        await auditedPatch(
          ctx,
          "dunningCases",
          c._id,
          { status: "active", pausedUntil: undefined, pausedReason: undefined, disputed: undefined },
          {
            action: "dunning.case.resume",
            label: lbl,
          },
        );
      }
      return;
    }
    case "hand_over": {
      const partner = a.partner?.trim() ?? "";
      if (partner.length < 2) throw appError("invalid_input", "Bitte das Inkassobüro angeben.", { field: "partner" });
      if (inv.disputed && !(a.acknowledgeWarnings ?? []).includes("disputed_hand_over")) {
        throw appError(
          "invalid_input",
          "Die Forderung ist als bestritten markiert. Bestrittene Forderungen sollten nicht ohne Prüfung an ein Inkassobüro übergeben werden.",
          { reason: "WARNINGS_UNACKNOWLEDGED", warnings: "disputed_hand_over" },
        );
      }
      const c = await ensureCase(ctx, inv, null);
      if (c.status === "closed") throw appError("conflict", "Der Mahnfall ist abgeschlossen.");
      await auditedPatch(
        ctx,
        "dunningCases",
        c._id,
        { status: "handed_over", handedOver: { at: ctx.now(), partner } },
        {
          action: "dunning.case.hand_over",
          label: lbl,
          reason: partner,
        },
      );
      await emitDunningCaseEvent(ctx, "dunning_case.handed_over", c._id, { status: c.status }); // PAY-060
      return;
    }
  }
}

/** Contact dunning settings (DUN-002, PAY-053): policy, „Nicht mahnen“ + reason, calendar due date agreed. */
export async function saveContactDunning(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  v: { policyId?: string; blocked?: boolean; blockedReason?: string; calendarDueDateAgreed?: boolean },
): Promise<void> {
  const contact = await ctx.db.get(contactId);
  if (!contact) throw appError("not_found", "Der Kontakt existiert nicht.");
  if (v.blocked && (v.blockedReason?.trim().length ?? 0) < 3) {
    throw appError("invalid_input", "Bitte einen Grund für „Nicht mahnen“ angeben.", { field: "blockedReason" });
  }
  let policyId: Id<"dunningPolicies"> | undefined;
  if (v.policyId) {
    try {
      policyId = (await resolvePolicyRef(ctx, v.policyId)).policy._id;
    } catch {
      throw appError("invalid_input", "Die Mahnrichtlinie existiert nicht.", { field: "policyId" });
    }
  }
  const dunning = {
    ...(policyId ? { policyId } : {}),
    ...(v.blocked ? { blocked: true, blockedReason: v.blockedReason?.trim() } : {}),
    ...(v.calendarDueDateAgreed ? { calendarDueDateAgreed: true } : {}),
  };
  await auditedPatch(
    ctx,
    "contacts",
    contactId,
    { dunning: Object.keys(dunning).length ? dunning : undefined, version: contact.version + 1 },
    {
      action: "contact.dunning.update",
      label: contact.displayName,
    },
  );
}

/** PAY-052 / EC-DUE-09: manual Zugang override (Rückschein, confirmation) — only while no later reminder depends on it. */
export async function overrideZugang(
  ctx: ModelCtx,
  documentId: Id<"salesDocuments">,
  v: { date: string; reason: string },
) {
  const d = await getDocument(ctx, documentId);
  const invalid = validateZugangOverride({ date: v.date, reason: v.reason, sentOn: d.sentOn, today: todayOf(ctx) });
  if (invalid) throw appError("invalid_input", invalid, { field: "date" });
  await assertRetractionAllowed(ctx, d).catch(() => {
    throw appError(
      "conflict",
      "Der Zugang kann nicht mehr geändert werden, weil eine spätere Mahnung darauf aufbaut.",
      {
        reason: "dependent_reminder",
      },
    );
  });
  await auditedPatch(
    ctx,
    "salesDocuments",
    documentId,
    { zugang: { date: v.date, basis: "manual", reason: v.reason.trim() } },
    {
      action: "document.zugang_override",
      label: label(d),
      reason: v.reason.trim(),
    },
  );
  await onDispatchChanged(ctx, documentId);
}

// ── run and preview (DUN-030/031/037) ───────────────────────────────────────────────────────────────────────────

export interface PlannedRun {
  date: CalendarDate;
  actions: DunningAction[];
  digest: string;
  bankDataCurrent: boolean;
  bankDataNote?: string;
}

/** The same evaluation for preview and run (DUN-031). Auto-resumes expired pauses in the facts only. */
export async function planRun(ctx: ReadCtx, date: CalendarDate, invoiceIds?: readonly string[]): Promise<PlannedRun> {
  const s = await evaluationContext(ctx, date);
  const actions: DunningAction[] = [];
  for (const inv of await dunnableInvoices(ctx)) {
    if (invoiceIds && !invoiceIds.includes(inv._id)) continue;
    const l = await loadInvoiceState(ctx, inv, date);
    actions.push(evaluateInvoice(date, l.state, s.ctx));
  }
  return {
    date,
    actions,
    // SHA-256 of the canonical plan: short enough for the REST confirm_token, bound by the MCP token (DUN-031).
    digest: await sha256Hex(planDigest(actions)),
    bankDataCurrent: s.ctx.bankDataCurrent,
    ...(s.ctx.bankDataNote ? { bankDataNote: s.ctx.bankDataNote } : {}),
  };
}

export interface RunResult {
  runId: Id<"dunningRuns">;
  evaluated: number;
  drafts: number;
  finalized: Id<"salesDocuments">[];
  todos: number;
  skipped: number;
  errors: number;
}

/**
 * DUN-030 run: per invoice at most one action, idempotent per (invoice, level) because the evaluation sees the
 * reminder created by an earlier run (draft_pending / previous level). `mode: "drafts"` never finalises; `selected`
 * restricts to chosen invoices (cockpit „Ausgewählte jetzt ausführen“, bulk „Mahnen“ DUN-036). A failure of one
 * invoice is recorded on its action (all writes of an action happen after its validation) and the run continues.
 */
export async function runDunning(
  ctx: ModelCtx,
  a: { mode: "auto" | "manual"; allowFinalize: boolean; invoiceIds?: readonly string[]; expectedDigest?: string },
): Promise<RunResult> {
  await ensureDefaultPolicies(ctx);
  const startedAt = ctx.now();
  const today = todayOf(ctx);
  // Expired pauses resume (DUN-034 auto-resume date).
  for (const c of await ctx.db.query("dunningCases").collect()) {
    if (c.status === "paused" && c.pausedUntil && c.pausedUntil <= today) {
      await auditedPatch(
        ctx,
        "dunningCases",
        c._id,
        { status: "active", pausedUntil: undefined, pausedReason: undefined },
        {
          action: "dunning.case.resume",
          reason: "Pausendatum erreicht",
        },
      );
    }
  }
  const plan = await planRun(ctx, today, a.invoiceIds);
  if (a.expectedDigest !== undefined && a.expectedDigest !== plan.digest) {
    throw appError("preview_outdated");
  }
  const actions: Doc<"dunningRuns">["actions"] = [];
  const finalized: Id<"salesDocuments">[] = [];
  let drafts = 0;
  let todos = 0;
  let errors = 0;
  for (const act of plan.actions) {
    const invoiceId = act.invoiceId as Id<"salesDocuments">;
    if (act.kind === "skip") {
      actions.push({ invoiceId, action: "skip", skipReason: act.reason, ...(act.level ? { level: act.level } : {}) });
      continue;
    }
    if (act.kind === "todo_mark_sent") {
      const reminderId = act.reminderId as Id<"salesDocuments">;
      await upsertNotification(ctx, {
        kind: "reminder_mark_sent",
        severity: "warning",
        title: `Mahnung ${act.reminderNumber ?? ""} exportieren und als versendet markieren`,
        link: `/mahnungen/${reminderId}`,
        entity: { table: "salesDocuments", id: reminderId },
        dedupeKey: `reminder_mark_sent:${reminderId}`,
      });
      const c = await caseOf(ctx, invoiceId);
      if (c) {
        await auditedPatch(
          ctx,
          "dunningCases",
          c._id,
          { todoLogged: [...(c.todoLogged ?? []), reminderId] },
          {
            action: "dunning.case.todo_mark_sent",
          },
        );
      }
      actions.push({ invoiceId, action: "todo_mark_sent", reminderId });
      todos++;
      continue;
    }
    const finalize = act.kind === "finalize" && a.allowFinalize;
    try {
      const reminderId = await createReminderDraft(ctx, invoiceId, { level: act.level }, { byRun: true });
      if (finalize) {
        await finalizeReminder(ctx, reminderId, { byRun: true });
        finalized.push(reminderId);
      } else drafts++;
      actions.push({ invoiceId, action: finalize ? "finalize" : "create_draft", level: act.level, reminderId });
    } catch (e) {
      errors++;
      const message = (e as { data?: { message?: string } }).data?.message ?? (e as Error).message;
      actions.push({ invoiceId, action: finalize ? "finalize" : "create_draft", level: act.level, error: message });
    }
  }
  if (drafts > 0) {
    await upsertNotification(ctx, {
      kind: "reminder_drafts_review",
      severity: "info",
      title: `${drafts} Mahnvorschläge prüfen`,
      link: "/mahnungen?tab=entwuerfe",
      dedupeKey: `reminder_drafts_review:${today}`,
    });
  }
  const runId = await auditedInsert(
    ctx,
    "dunningRuns",
    {
      date: today,
      mode: a.mode,
      evaluated: plan.actions.length,
      actions,
      startedAt,
      finishedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "dunning.run", label: `Mahnlauf ${formatGermanDate(today)}` },
  );
  return {
    runId,
    evaluated: plan.actions.length,
    drafts,
    finalized,
    todos,
    skipped: actions.filter((x) => x.action === "skip").length,
    errors,
  };
}

/** Run log (DUN-037): counts per run and skip reasons. */
export async function recentRuns(ctx: ReadCtx, limit = 30) {
  const runs = await ctx.db.query("dunningRuns").withIndex("by_date").order("desc").take(limit);
  return runs.map((r) => {
    const reasons: Record<string, number> = {};
    for (const x of r.actions) if (x.skipReason) reasons[x.skipReason] = (reasons[x.skipReason] ?? 0) + 1;
    return {
      id: r._id,
      date: r.date,
      mode: r.mode,
      actor: r.actor,
      evaluated: r.evaluated,
      drafts: r.actions.filter((x) => x.action === "create_draft" && !x.error).length,
      finalized: r.actions.filter((x) => x.action === "finalize" && !x.error).length,
      todos: r.actions.filter((x) => x.action === "todo_mark_sent").length,
      errors: r.actions.filter((x) => x.error).length,
      skipped: Object.entries(reasons).map(([reason, count]) => ({
        reason,
        label: SKIP_REASON_LABEL_DE[reason as keyof typeof SKIP_REASON_LABEL_DE] ?? reason,
        count,
      })),
      startedAt: r.startedAt,
    };
  });
}

// ── „Bald fällig“ and the overdue job (DUN-053, PAY-044) ─────────────────────────────────────────────────────────

export async function dueSoon(ctx: ReadCtx, today: CalendarDate) {
  const policies = await listPolicies(ctx);
  const horizon = Math.max(...policies.map((p) => p.dueSoonDays ?? 3), 0);
  const out: SalesDoc[] = [];
  for (const d of await dunnableInvoices(ctx)) {
    if (d.dueDate && d.dueDate >= today && d.dueDate <= addDays(today, horizon)) out.push(d);
  }
  return out;
}

/**
 * `receivables.refreshOverdue` (02 §7, 00:15): records `overdueNotifiedAt` once per overdue document and emits the
 * webhook `invoice.overdue` once (05 §5.3, PAY-060) and, with `dueSoonTodo`, one „Bald fällig“ to-do per
 * invoice (DUN-053). Writes no status: overdue is derived.
 */
export async function refreshOverdue(ctx: ModelCtx): Promise<{ overdue: number; dueSoon: number }> {
  const today = todayOf(ctx);
  let overdue = 0;
  for (const d of await dunnableInvoices(ctx)) {
    if (d.dueDate && d.dueDate < today && d.overdueNotifiedAt === undefined) {
      await auditedPatch(
        ctx,
        "salesDocuments",
        d._id,
        { overdueNotifiedAt: ctx.now() },
        {
          action: "receivables.overdue",
          label: d.number ?? "Rechnung",
        },
      );
      await emitDocumentEvent(ctx, d._id, "overdue"); // PAY-060: once per document (overdueNotifiedAt)
      overdue++;
    }
  }
  let soon = 0;
  const policies = await listPolicies(ctx);
  for (const d of await dueSoon(ctx, today)) {
    const contact = d.contactId ? await ctx.db.get(d.contactId) : null;
    const pid = resolvePolicyId(policies, {
      isConsumer: contact?.isConsumer ?? false,
      ...(contact?.dunning?.policyId ? { policyId: contact.dunning.policyId } : {}),
    });
    const policy = policies.find((p) => p.id === pid);
    if (!policy?.dueSoonTodo || !d.dueDate || d.dueDate > addDays(today, policy.dueSoonDays ?? 3)) continue;
    await upsertNotification(ctx, {
      kind: "due_soon",
      severity: "info",
      title: `Bald fällig: ${d.number ?? ""} am ${formatGermanDate(d.dueDate as CalendarDate)} – ggf. Kunden erinnern`,
      link: `/rechnungen/${d._id}`,
      entity: { table: "salesDocuments", id: d._id },
      dedupeKey: `due_soon:${d._id}`,
    });
    soon++;
  }
  return { overdue, dueSoon: soon };
}

/** RI-24 inputs: every finalised reminder of a consumer carries no 40 €. */
export async function flatFeeOnConsumerReminders(ctx: ReadCtx): Promise<string[]> {
  const out: string[] = [];
  for (const r of await ctx.db
    .query("salesDocuments")
    .withIndex("by_type_status_date", (q) => q.eq("type", "reminder"))
    .collect()) {
    if (!r.reminder || r.status === "draft" || r.reminder.flatFee40Cents === 0 || !r.contactId) continue;
    const c = await ctx.db.get(r.contactId);
    if (c?.isConsumer) out.push(r.number ?? r._id);
  }
  return out;
}

/**
 * E2E stand-in (IS_TEST only, convex/testFixtures.ts): moves an invoice **draft** into the past — document date
 * `today − dueDaysAgo` (supply date = document date), due the same day, with a backdating reason — so the regular finalisation and mark produce an
 * overdue invoice for the dunning journey (T05-161). Finalised documents are never touched (GoBD).
 */
export async function backdateDraftForTest(ctx: ModelCtx, id: Id<"salesDocuments">, dueDaysAgo: number) {
  const doc = await getDocument(ctx, id);
  if (doc.status !== "draft") throw appError("document_not_draft");
  const documentDate = addDays(todayOf(ctx), -dueDaysAgo);
  const version = doc.version + 1;
  await auditedPatch(
    ctx,
    "salesDocuments",
    id,
    {
      documentDate,
      // UST-08: the supply date must not lie after the (moved) document date.
      supplyDateMode: "document_date",
      supplyDate: undefined,
      paymentTerms: { ...doc.paymentTerms, dueDays: 0 },
      backdateReason: "E2E: überfällige Rechnung für den Mahnlauf",
      version,
    },
    { action: "document.update_draft", reason: "E2E-Testdaten (IS_TEST)" },
  );
  return { documentDate, dueDate: documentDate, version };
}
