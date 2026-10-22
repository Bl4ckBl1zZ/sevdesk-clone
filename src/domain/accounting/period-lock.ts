/**
 * Period lock / Festschreibung (F08 ACC-015…ACC-017, §4.7, E-ACC-15…18, E-ACC-33; GOBD-06). Pure: the caller passes
 * the stored `periods` rows and the checklist counts read from the database.
 *
 *  - `planLock`: locking month M locks every not yet locked month of M's fiscal year from the fiscal-year start (or
 *    the Buchungsbeginn, if later) through M in the same action („Festschreibung erfolgt lückenlos“, ACC-016).
 *  - `lockChecklist`: blockers (1) drafts, (2) pending artifacts, (2a) bank ledger ≠ statement balance; everything
 *    in (3) is a warning listed for review (ACC-017).
 */
import { formatCents } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import { fiscalYearOf, fiscalYearStart, periodOf } from "./period";

export type PeriodStatus = "open" | "locking" | "locked";

export type LockReason =
  | "ustva_submitted"
  | "zm_submitted"
  | "euer_submitted"
  | "manual"
  | "datev_export"
  | "year_close";

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isMonthPeriod = (p: string): boolean => PERIOD_RE.test(p);

export const formatMonth = (p: string): string => `${p.slice(5, 7)}/${p.slice(0, 4)}`;
const formatDay = (d: string): string => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const euro = (cents: number): string => `${formatCents(cents)} €`;

export function nextMonthOf(p: string): string {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** Calendar months `from`…`to` inclusive (`YYYY-MM`); empty when `from` > `to`. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let p = from; p <= to; p = nextMonthOf(p)) out.push(p);
  return out;
}

export interface LockPlanInput {
  target: string;
  fiscalYearStartMonth: number;
  bookkeepingStartDate?: string | undefined;
  periods: readonly { period: string; status: PeriodStatus }[];
}

export type LockPlanIssue = Issue<"invalid_period" | "already_locked">;

export interface LockPlan {
  months: string[];
  /** E-ACC-15: shown when earlier open months are locked together with the target. */
  gapNotice?: string;
}

export function planLock(input: LockPlanInput): Result<LockPlan, LockPlanIssue> {
  if (!isMonthPeriod(input.target)) return err(issue("invalid_period", "Ungültiger Zeitraum (JJJJ-MM)."));
  const status = new Map(input.periods.map((p) => [p.period, p.status]));
  if (status.get(input.target) === "locked" || status.get(input.target) === "locking") {
    return err(
      issue("already_locked", `Der Zeitraum ${formatMonth(input.target)} ist bereits festgeschrieben.`, {
        period: input.target,
      }),
    );
  }
  const fy = fiscalYearOf(`${input.target}-01`, input.fiscalYearStartMonth);
  let first = periodOf(fiscalYearStart(fy, input.fiscalYearStartMonth));
  const start = input.bookkeepingStartDate ? periodOf(input.bookkeepingStartDate) : undefined;
  if (start && start > first && start <= input.target) first = start;
  const months = monthsBetween(first, input.target).filter((p) => status.get(p) !== "locked");
  const earlier = months.filter((p) => p !== input.target);
  if (earlier.length === 0) return ok({ months });
  return ok({
    months,
    gapNotice: `Festschreibung muss lückenlos erfolgen. ${formatMonth(earlier[0] as string)} bis ${formatMonth(earlier[earlier.length - 1] as string)} werden mit festgeschrieben.`,
  });
}

// ── checklist (ACC-017) ─────────────────────────────────────────────────────────────────────────────────

export interface LockChecklistInput {
  /** (1) sales-document and voucher drafts dated in the months. */
  draftsInPeriod: number;
  /** (2) finalised documents whose artifact pipeline is still `pending`. */
  pendingArtifacts: number;
  /** (2a) bank ledger balance at month end − bank-reported balance (RI-27), only accounts with a difference. */
  bankDifferences: readonly { account: string; date: string; diffCents: number }[];
  /** (3) inbox items received in the months that are not yet a booked voucher. */
  unbookedInboxItems: number;
  /** (3) booked bank transactions of the months that are neither matched nor marked. */
  unmatchedBankTransactions: number;
  /** (3) EC-156: monthly statements not archived. */
  missingStatements: readonly { account: string; month: string }[];
  /** (3) booked vouchers without an original file or approved Eigenbeleg. */
  vouchersWithoutAttachment: number;
  /** (3) E-ACC-18: balance of `transit` at the last month end. */
  transitBalanceCents: number;
  /** (3) cash payments/transfers recorded more than 10 days after their date. */
  backdatedCash: readonly { label: string; date: string; recordedOn: string }[];
}

export type ChecklistCode =
  | "drafts"
  | "pending_artifacts"
  | "bank_balance_mismatch"
  | "unbooked_vouchers"
  | "unmatched_bank_transactions"
  | "missing_statement"
  | "voucher_without_attachment"
  | "transit_open"
  | "backdated_cash";

export interface ChecklistItem {
  code: ChecklistCode;
  message: string;
  /** Number of records behind the item (drafts, pending artifacts …). */
  count?: number;
}

export interface LockChecklist {
  ok: boolean;
  blockers: ChecklistItem[];
  warnings: ChecklistItem[];
}

export function lockChecklist(input: LockChecklistInput): LockChecklist {
  const blockers: ChecklistItem[] = [];
  const warnings: ChecklistItem[] = [];
  if (input.draftsInPeriod > 0) {
    blockers.push({
      code: "drafts",
      message: `Im Zeitraum gibt es ${input.draftsInPeriod} Entwürfe. Bitte fertigstellen oder löschen.`,
      count: input.draftsInPeriod,
    });
  }
  if (input.pendingArtifacts > 0) {
    blockers.push({
      code: "pending_artifacts",
      message: `${input.pendingArtifacts} Dokumente werden noch verarbeitet. Bitte warten.`,
      count: input.pendingArtifacts,
    });
  }
  for (const d of input.bankDifferences) {
    if (d.diffCents === 0) continue;
    blockers.push({
      code: "bank_balance_mismatch",
      message: `Kontosaldo ${d.account} zum ${formatDay(d.date)} weicht vom Kontoauszug ab (${euro(d.diffCents)}). Festschreibung nicht möglich.`,
    });
  }
  if (input.unbookedInboxItems > 0) {
    warnings.push({
      code: "unbooked_vouchers",
      message: `${input.unbookedInboxItems} Belege im Posteingang sind noch nicht gebucht.`,
    });
  }
  if (input.unmatchedBankTransactions > 0) {
    warnings.push({
      code: "unmatched_bank_transactions",
      message: `${input.unmatchedBankTransactions} Bankumsätze sind noch nicht zugeordnet oder gebucht.`,
    });
  }
  for (const s of input.missingStatements) {
    warnings.push({
      code: "missing_statement",
      message: `Kontoauszug ${formatMonth(s.month)} für ${s.account} fehlt (CAMT.053 + PDF).`,
    });
  }
  if (input.vouchersWithoutAttachment > 0) {
    warnings.push({
      code: "voucher_without_attachment",
      message: `${input.vouchersWithoutAttachment} gebuchte Belege haben keine Belegdatei.`,
    });
  }
  if (input.transitBalanceCents !== 0) {
    warnings.push({
      code: "transit_open",
      message: `Geldtransit ist nicht ausgeglichen (${euro(input.transitBalanceCents)}). Fehlt die Gegenbuchung?`,
    });
  }
  for (const c of input.backdatedCash) {
    warnings.push({
      code: "backdated_cash",
      message: `${c.label} vom ${formatDay(c.date)} wurde erst am ${formatDay(c.recordedOn)} erfasst – bitte prüfen.`,
    });
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

/** The irreversible confirmation text of the lock dialog (F08 §6 /buchhaltung/festschreibung). */
export const LOCK_CONFIRM_TEXT =
  "Festschreiben kann nicht rückgängig gemacht werden. Korrekturen sind danach nur per Gegenbuchung möglich.";

// ── ACC-018 lock suggestion ─────────────────────────────────────────────────────────────────────────────

export interface LockSuggestion {
  /** Open months whose suggested lock date (end of M+1) has passed. */
  overdue: string[];
  /** The month to lock now (latest overdue month; earlier open months are locked with it, ACC-016). */
  suggestedTarget: string | null;
  /** The previous month: to be locked by the end of the current month. */
  dueSoon: { period: string; by: string } | null;
  /** `deadlines.notify` text when an open month is older than 2 months, else null. */
  reminder: string | null;
}

const lastDayOf = (p: string): string => {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  return `${p}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
const prevMonthOf = (p: string): string => {
  const y = Number(p.slice(0, 4));
  const m = Number(p.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/**
 * ACC-018 (sevdesk advice, GOBD-06): lock month M by the end of month M+1 (or right after the UStVA, which locks
 * automatically); a reminder is due once an open month is older than 2 months. `firstMonth` = the first month with
 * bookings (Buchungsbeginn); earlier months are ignored.
 */
export function lockSuggestion(input: {
  periods: readonly { period: string; status: PeriodStatus }[];
  today: string;
  firstMonth: string;
}): LockSuggestion {
  const status = new Map(input.periods.map((p) => [p.period, p.status]));
  const current = input.today.slice(0, 7);
  const previous = prevMonthOf(current);
  const open = (p: string) => (status.get(p) ?? "open") === "open";
  const overdue = monthsBetween(input.firstMonth, prevMonthOf(previous)).filter(open);
  const stale = monthsBetween(input.firstMonth, prevMonthOf(prevMonthOf(previous))).filter(open);
  return {
    overdue,
    suggestedTarget: overdue.at(-1) ?? null,
    dueSoon: previous >= input.firstMonth && open(previous) ? { period: previous, by: lastDayOf(current) } : null,
    reminder:
      stale.length > 0
        ? `Festschreibung empfohlen: ${formatMonth(stale[0] as string)}${
            stale.length > 1 ? ` bis ${formatMonth(stale.at(-1) as string)} sind` : " ist"
          } seit mehr als zwei Monaten nicht festgeschrieben.`
        : null,
  };
}
