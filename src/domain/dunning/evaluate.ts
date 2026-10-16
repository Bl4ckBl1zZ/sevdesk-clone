/**
 * Daily dunning evaluation `evaluateDunning(today, state) → Action[]` — F05 §4.5, DUN-030/033/054/055/057. Pure: the
 * Convex run (and the dry-run preview, DUN-031) read the state, this function decides, the model executes. At most one
 * action per invoice; it never sends anything.
 */
import type { BasiszinssatzValue } from "../rules/basiszinssatz";
import type { RuleOverride } from "../rules/rule-table";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { type Claim, computeClaim, type PrincipalHistory } from "./claim";
import { type DefaultStartViaReminder, defaultStartOf, type ReminderFacts } from "./default-start";
import { limitationDateOf } from "./limitation";
import { type DunningPolicy, nextStepOf, type PolicyStep, resolvePolicyId } from "./policy";

export type SkipReason =
  | "no_policy"
  | "not_marked_sent"
  | "previous_reminder_not_marked_sent"
  | "draft_pending"
  | "last_level_reached"
  | "not_due_yet"
  | "excluded"
  | "disputed"
  | "paused"
  | "handed_over"
  | "closed"
  | "reopen_grace"
  | "below_minimum"
  | "payment_signal"
  | "time_barred"
  | "previous_deadline_running"
  | "claim_error";

export const SKIP_REASON_LABEL_DE: Readonly<Record<SkipReason, string>> = {
  no_policy: "Keine Mahnrichtlinie",
  not_marked_sent: "Rechnung nicht als versendet markiert – ohne Zugang wird nicht gemahnt",
  previous_reminder_not_marked_sent: "Letzte Mahnung noch nicht als versendet markiert",
  draft_pending: "Mahnentwurf liegt bereits vor",
  last_level_reached: "Letzte Mahnstufe erreicht",
  not_due_yet: "Nächste Stufe noch nicht fällig",
  excluded: "„Nicht mahnen“ gesetzt",
  disputed: "Forderung bestritten",
  paused: "Mahnverfahren pausiert",
  handed_over: "An Inkasso übergeben",
  closed: "Mahnfall abgeschlossen",
  reopen_grace: "Wieder geöffnet – Karenzzeit läuft",
  below_minimum: "Offener Betrag unter dem Mindestbetrag",
  payment_signal: "Zahlung möglicherweise eingegangen – Zuordnung prüfen.",
  time_barred: "Forderung verjährt",
  previous_deadline_running: "Frist der letzten Mahnung läuft noch",
  claim_error: "Berechnung nicht möglich",
};

export interface CaseFacts {
  readonly status: "active" | "paused" | "closed" | "handed_over";
  readonly currentLevel: number;
  readonly pausedUntil?: CalendarDate | undefined;
  readonly flatFeeCharged: boolean;
  /** DUN-035: automation resumes only after this day (reopened by a reversal). */
  readonly graceUntil?: CalendarDate | undefined;
}

export interface ReminderState extends ReminderFacts {
  readonly id: string;
  readonly level: number;
  readonly number?: string | undefined;
  /** Europe/Berlin date of the finalisation. */
  readonly finalizedOn?: CalendarDate | undefined;
  readonly newDueDays: number;
  /** DUN-055: `todo_mark_sent` already logged for this reminder. */
  readonly todoLogged?: boolean | undefined;
}

export interface InvoiceState {
  readonly invoiceId: string;
  readonly number: string;
  readonly openAmountCents: number;
  readonly dueDate: CalendarDate;
  readonly zugang?: CalendarDate | undefined;
  readonly hasB2c286Note: boolean;
  readonly blocked: boolean;
  readonly disputed: boolean;
  readonly contact: {
    readonly isConsumer: boolean;
    readonly policyId?: string | undefined;
    readonly blocked: boolean;
    readonly calendarDueDateAgreed: boolean;
  };
  readonly case?: CaseFacts | undefined;
  /** All reminders of the invoice incl. drafts and withdrawn ones. */
  readonly reminders: readonly ReminderState[];
  readonly paymentSignal: boolean;
  readonly history: PrincipalHistory;
}

export interface EvaluationContext {
  readonly policies: readonly (DunningPolicy & { readonly id: string })[];
  readonly autoFinalizeReminders: boolean;
  readonly defaultStartViaReminder: DefaultStartViaReminder;
  /** P1: latest imported statement not older than `bankDataMaxAgeDays` (or no bank account). */
  readonly bankDataCurrent: boolean;
  readonly bankDataNote?: string | undefined;
  readonly state?: string | undefined;
  readonly overrides?: readonly RuleOverride<BasiszinssatzValue>[];
}

export type DunningAction =
  | {
      readonly kind: "create_draft" | "finalize";
      readonly invoiceId: string;
      readonly number: string;
      readonly policyId: string;
      readonly level: number;
      readonly step: PolicyStep;
      readonly claim: Claim;
      /** finalize downgraded to a draft (EC-DUN-19) or other notes. */
      readonly notes: readonly string[];
    }
  | {
      readonly kind: "todo_mark_sent";
      readonly invoiceId: string;
      readonly number: string;
      readonly reminderId: string;
      readonly reminderNumber?: string | undefined;
    }
  | {
      readonly kind: "skip";
      readonly invoiceId: string;
      readonly number: string;
      readonly reason: SkipReason;
      readonly detail?: string | undefined;
      readonly level?: number | undefined;
      /** DUN-010/054: `not_due_yet` / `previous_deadline_running` — the first day the action can happen. */
      readonly earliest?: CalendarDate | undefined;
    };

/** Reminders that count for the chain: finalised or marked sent (drafts and withdrawn ones do not). */
export const issuedReminders = (rs: readonly ReminderState[]) =>
  rs.filter((r) => r.status === "finalized" || r.status === "sent").sort((a, b) => a.level - b.level);

/** DUN-054: earliest day a level n > 1 may follow the previous reminder (null = previous has no Zugang). */
export function nextLevelEarliest(prev: ReminderState, daysAfter: number): CalendarDate | null {
  if (!prev.zugang) return null;
  const byDays = addDays(prev.zugang, daysAfter);
  const deadline =
    prev.newDueDate > addDays(prev.zugang, prev.newDueDays) ? prev.newDueDate : addDays(prev.zugang, prev.newDueDays);
  const afterDeadline = addDays(deadline, 1);
  return byDays > afterDeadline ? byDays : afterDeadline;
}

export function evaluateInvoice(today: CalendarDate, inv: InvoiceState, ctx: EvaluationContext): DunningAction {
  const skip = (
    reason: SkipReason,
    extra: { detail?: string; level?: number; earliest?: CalendarDate } = {},
  ): DunningAction => ({
    kind: "skip",
    invoiceId: inv.invoiceId,
    number: inv.number,
    reason,
    ...extra,
  });
  // 1. policy (DUN-002)
  const policyId = resolvePolicyId(ctx.policies, inv.contact);
  const policy = ctx.policies.find((p) => p.id === policyId);
  if (!policy || !policyId) return skip("no_policy");
  // 2. no Zugang of the invoice (PAY-064)
  if (!inv.zugang) return skip("not_marked_sent");
  // 3. latest reminder finalised but unmarked (DUN-055)
  const issued = issuedReminders(inv.reminders);
  const latest = issued.at(-1);
  if (latest && latest.status === "finalized") {
    if (!latest.todoLogged && latest.finalizedOn && addDays(latest.finalizedOn, 2) <= today) {
      return {
        kind: "todo_mark_sent",
        invoiceId: inv.invoiceId,
        number: inv.number,
        reminderId: latest.id,
        ...(latest.number ? { reminderNumber: latest.number } : {}),
      };
    }
    return skip("previous_reminder_not_marked_sent");
  }
  if (inv.reminders.some((r) => r.status === "draft")) return skip("draft_pending");
  // 4. next step
  const currentLevel = Math.max(inv.case?.currentLevel ?? 0, latest?.level ?? 0);
  const step = nextStepOf(policy, currentLevel);
  if (!step) return skip("last_level_reached");
  // 5. timing (DUN-054)
  if (!latest || step.level === 1 || currentLevel === 0) {
    const earliest = addDays(inv.dueDate, step.daysAfter);
    if (today < earliest)
      return skip("not_due_yet", { level: step.level, detail: formatGermanDate(earliest), earliest });
  } else if (latest.zugang && today < addDays(latest.zugang, step.daysAfter)) {
    const earliest = addDays(latest.zugang, step.daysAfter);
    return skip("not_due_yet", { level: step.level, detail: formatGermanDate(earliest), earliest });
  }
  // 6. safety skips (DUN-033) in the order of §4.5
  if (inv.blocked || inv.contact.blocked) return skip("excluded", { level: step.level });
  if (inv.disputed) return skip("disputed", { level: step.level });
  const c = inv.case;
  if (c?.status === "handed_over") return skip("handed_over", { level: step.level });
  if (c?.status === "closed") return skip("closed", { level: step.level });
  if (c?.status === "paused" && (!c.pausedUntil || c.pausedUntil > today)) {
    return skip("paused", { level: step.level, ...(c.pausedUntil ? { detail: formatGermanDate(c.pausedUntil) } : {}) });
  }
  if (c?.graceUntil && c.graceUntil > today) {
    return skip("reopen_grace", { level: step.level, detail: formatGermanDate(c.graceUntil) });
  }
  if (inv.openAmountCents < policy.minOpenAmountCents) return skip("below_minimum", { level: step.level });
  if (inv.paymentSignal) return skip("payment_signal", { level: step.level });
  if (today > limitationDateOf(inv.dueDate)) return skip("time_barred", { level: step.level });
  if (latest && step.level > 1) {
    const earliest = nextLevelEarliest(latest, step.daysAfter);
    if (!earliest || today < earliest) {
      return skip("previous_deadline_running", {
        level: step.level,
        detail: formatGermanDate(addDays(earliest ?? today, -1)),
        ...(earliest ? { earliest } : {}),
      });
    }
  }
  // 7. claim
  const defaultStart = defaultStartOf({
    dueDate: inv.dueDate,
    invoiceZugang: inv.zugang,
    isConsumer: inv.contact.isConsumer,
    hasB2c286Note: inv.hasB2c286Note,
    calendarDueDateAgreed: inv.contact.calendarDueDateAgreed,
    reminders: inv.reminders,
    route: ctx.defaultStartViaReminder,
  });
  const claim = computeClaim({
    date: today,
    step,
    isConsumer: inv.contact.isConsumer,
    defaultStart,
    openAmountCents: inv.openAmountCents,
    history: inv.history,
    flatFeeCharged: inv.case?.flatFeeCharged ?? false,
    state: ctx.state,
    ...(ctx.overrides ? { overrides: ctx.overrides } : {}),
  });
  if (!claim.ok) return skip("claim_error", { level: step.level, detail: claim.error.message });
  // 8. finalize or draft (DUN-057, EC-DUN-19)
  const wantsFinalize = ctx.autoFinalizeReminders && step.autoFinalize;
  const notes: string[] = [];
  if (wantsFinalize && !ctx.bankDataCurrent) {
    notes.push(`Bankdaten nicht aktuell${ctx.bankDataNote ? ` (${ctx.bankDataNote})` : ""} – nur Entwurf.`);
  }
  return {
    kind: wantsFinalize && ctx.bankDataCurrent ? "finalize" : "create_draft",
    invoiceId: inv.invoiceId,
    number: inv.number,
    policyId,
    level: step.level,
    step,
    claim: claim.value,
    notes,
  };
}

export function evaluateDunning(
  today: CalendarDate,
  invoices: readonly InvoiceState[],
  ctx: EvaluationContext,
): DunningAction[] {
  return invoices.map((inv) => evaluateInvoice(today, inv, ctx));
}

/** Stable digest input of a plan (the confirm token of `dunning_run` binds its hash, DUN-031). */
export function planDigest(actions: readonly DunningAction[]): string {
  return JSON.stringify(
    actions
      .map((a) =>
        a.kind === "skip"
          ? [a.invoiceId, a.kind, a.reason]
          : a.kind === "todo_mark_sent"
            ? [a.invoiceId, a.kind, a.reminderId]
            : [a.invoiceId, a.kind, a.level, a.claim.totalCents, a.claim.newDueDate],
      )
      .sort((x, y) => (String(x[0]) < String(y[0]) ? -1 : 1)),
  );
}
