/**
 * Dunning case state machine — F05 §4.4, DUN-034/035/042. Pure: returns the next status (and pause date) for an
 * event or an issue with the German message.
 *
 *   (none) ─first reminder─▶ active ─partial payment─▶ paused(until) ─date reached─▶ active
 *   active ─dispute / manual pause─▶ paused ─resume─▶ active
 *   active|paused ─paid / written off / cancelled─▶ closed ─reversal reopens─▶ active (grace period)
 *   active|paused ─Inkasso export─▶ handed_over ─paid─▶ closed
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { addDays, type CalendarDate } from "../time/calendar-date";

export type CaseStatus = "active" | "paused" | "closed" | "handed_over";

export type CaseEvent =
  | { readonly kind: "partial_payment"; readonly today: CalendarDate; readonly days: number }
  | { readonly kind: "pause"; readonly until?: CalendarDate | undefined }
  | { readonly kind: "dispute" }
  | { readonly kind: "resume" }
  | { readonly kind: "settled" }
  | { readonly kind: "reopen"; readonly today: CalendarDate; readonly graceDays: number }
  | { readonly kind: "hand_over" };

export interface CaseTransition {
  readonly status: CaseStatus;
  readonly pausedUntil?: CalendarDate | undefined;
  readonly graceUntil?: CalendarDate | undefined;
}

const STATUS_LABEL_DE: Readonly<Record<CaseStatus, string>> = {
  active: "aktiv",
  paused: "pausiert",
  closed: "abgeschlossen",
  handed_over: "an Inkasso übergeben",
};

export const caseStatusLabel = (s: CaseStatus): string => STATUS_LABEL_DE[s];

const illegal = (from: CaseStatus, what: string): Issue<"case_transition"> =>
  issue("case_transition", `Der Mahnfall ist ${STATUS_LABEL_DE[from]} – ${what} ist nicht möglich.`);

export function transitionCase(from: CaseStatus, e: CaseEvent): Result<CaseTransition, Issue<"case_transition">> {
  switch (e.kind) {
    case "partial_payment":
      if (from !== "active" && from !== "paused") return ok({ status: from });
      return ok({ status: "paused", pausedUntil: addDays(e.today, e.days) });
    case "pause":
    case "dispute":
      if (from === "closed" || from === "handed_over") return err(illegal(from, "Pausieren"));
      return ok({ status: "paused", ...(e.kind === "pause" && e.until ? { pausedUntil: e.until } : {}) });
    case "resume":
      if (from !== "paused" && from !== "active") return err(illegal(from, "Fortsetzen"));
      return ok({ status: "active" });
    case "settled":
      return ok({ status: "closed" });
    case "reopen":
      if (from !== "closed") return ok({ status: from });
      return ok({ status: "active", graceUntil: addDays(e.today, e.graceDays) });
    case "hand_over":
      if (from === "closed") return err(illegal(from, "die Übergabe an ein Inkassobüro"));
      return ok({ status: "handed_over" });
  }
}
