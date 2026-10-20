/**
 * Time entries (F11 PRJ-005…007, PRJ-012, E-PRJ-02…11). Pure: instants are passed in (UTC epoch ms), `today` is
 * the Europe/Berlin business date of the caller.
 *
 * - Durations are computed from instants, never from wall-clock times, so DST nights are exact (PRJ-006, EC-020).
 * - The entry date is the Europe/Berlin date of the start instant; a timer across midnight stays one entry unless
 *   „an Mitternacht teilen“ is chosen.
 * - Manual input accepts `1:30`, `1,5`, `1.5h`, `90m`, `2h 15m` (PRJ-007).
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { berlinCalendarDate, berlinStartOfDay, berlinWallClockInstant } from "../time/berlin";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";

export const MAX_ENTRY_MINUTES = 24 * 60;
export const TIMER_WARN_AFTER_MS = 10 * 3_600_000;
export const TIMER_AUTO_STOP_MS = 24 * 3_600_000;
export const MIN_DESCRIPTION_LENGTH = 3;

export const TIME_ENTRY_STATUSES = ["open", "in_draft", "invoiced"] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];
export const TIME_ENTRY_SOURCES = ["timer", "manual", "mcp", "api", "offline"] as const;
export type TimeEntrySource = (typeof TIME_ENTRY_SOURCES)[number];

export const TIME_ENTRY_STATUS_LABELS: Readonly<Record<TimeEntryStatus, string>> = {
  open: "Offen",
  in_draft: "Im Entwurf",
  invoiced: "Abgerechnet",
};

export const TIME_MESSAGES = {
  durationUnparsed: "Dauer nicht erkannt. Beispiele: 1:30, 1,5, 90m, 2h 15m.",
  durationRange: "Die Dauer muss zwischen 1 Minute und 24 Stunden liegen.",
  endBeforeStart: "Das Ende liegt vor dem Beginn.",
  future: "Zeiten können nicht für die Zukunft erfasst werden.",
  description: "Bitte eine Beschreibung mit mindestens 3 Zeichen angeben.",
  generic: "Die Beschreibung ist sehr allgemein und erscheint so auf der Rechnung.",
  incomplete: "Bitte Beschreibung und Projekt oder Kunde ergänzen.",
  autoStopped: "Timer lief über 24 Stunden und wurde angehalten. Bitte Dauer prüfen.",
} as const;

const MS_PER_MINUTE = 60_000;

// ── duration input (PRJ-007, E-PRJ-08) ─────────────────────────────────────────────────────────────────────

/** Decimal hours („1,5“, „0.25“) to whole minutes, half-up, integer arithmetic only. */
function decimalHoursToMinutes(whole: string, fraction: string): number {
  const digits = fraction.slice(0, 6);
  const scale = 10n ** BigInt(digits.length);
  const units = BigInt(whole || "0") * scale + BigInt(digits || "0");
  // minutes = units × 60 / scale, rounded half-up (units ≥ 0)
  return Number((units * 120n + scale) / (2n * scale));
}

const HHMM = /^(\d{1,2}):([0-5]\d)$/;
const DECIMAL = /^(\d{0,3})(?:[.,](\d{1,6}))?\s*(h|std|std\.|stunden?)?$/;
const PARTS = /^(?:(\d{1,3})(?:[.,](\d{1,6}))?\s*(?:h|std\.?|stunden?))?\s*(?:(\d{1,4})\s*(?:m|min\.?|minuten?))?$/;

/**
 * Parses a duration typed by a person into minutes. Plain numbers are hours („1,5“ = 90 min, „2“ = 120 min).
 * Range checks (1 min … 24 h) are separate (`checkDurationRange`).
 */
export function parseDuration(input: string): Result<number, Issue<"duration_unparsed">> {
  const s = input.trim().toLowerCase().replace(/\s+/g, " ");
  const fail = err(issue("duration_unparsed", TIME_MESSAGES.durationUnparsed));
  if (!s) return fail;
  const hm = HHMM.exec(s);
  if (hm) return ok(Number(hm[1]) * 60 + Number(hm[2]));
  const dec = DECIMAL.exec(s);
  if (dec && (dec[1] || dec[2])) return ok(decimalHoursToMinutes(dec[1] ?? "", dec[2] ?? ""));
  const parts = PARTS.exec(s);
  if (parts && (parts[1] !== undefined || parts[3] !== undefined)) {
    const hours = parts[1] !== undefined ? decimalHoursToMinutes(parts[1], parts[2] ?? "") : 0;
    return ok(hours + Number(parts[3] ?? "0"));
  }
  return fail;
}

export function checkDurationRange(minutes: number): Issue<"duration_range"> | null {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_ENTRY_MINUTES
    ? null
    : issue("duration_range", TIME_MESSAGES.durationRange);
}

/** „1:30 h“ style display of minutes. */
export function formatMinutes(minutes: number): string {
  const sign = minutes < 0 ? "−" : "";
  const m = Math.abs(minutes);
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")} h`;
}

/** Running timer display (PRJ-005): milliseconds → „h:mm:ss“; negative clock skew shows 0. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** „09:30“ → 570; null when not a valid wall-clock time. */
export function parseClockTime(input: string): number | null {
  const m = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/.exec(input.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

// ── instants (PRJ-006, EC-020, E-PRJ-27/28) ────────────────────────────────────────────────────────────────

export interface EntrySpan {
  readonly date: CalendarDate;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly durationMinutes: number;
}

/** Whole minutes between two instants, half-up (a timer of 29.5 s counts as 0 min, 30 s as 1 min). */
export const minutesBetween = (startedAt: number, endedAt: number): number =>
  Math.floor((endedAt - startedAt + MS_PER_MINUTE / 2) / MS_PER_MINUTE);

/**
 * The entry (or entries, when split at Europe/Berlin midnight) for a timer run from `startedAt` to `endedAt`.
 * The duration comes from the instants; the date is the Berlin date of the start instant.
 */
export function spansFromInstants(
  startedAt: number,
  endedAt: number,
  opts: { splitAtMidnight?: boolean } = {},
): EntrySpan[] {
  if (endedAt < startedAt) return [];
  if (!opts.splitAtMidnight) {
    return [
      { date: berlinCalendarDate(startedAt), startedAt, endedAt, durationMinutes: minutesBetween(startedAt, endedAt) },
    ];
  }
  const out: EntrySpan[] = [];
  let from = startedAt;
  while (from < endedAt) {
    const date = berlinCalendarDate(from);
    const midnight = berlinStartOfDay(addDays(date, 1));
    const to = Math.min(midnight, endedAt);
    out.push({ date, startedAt: from, endedAt: to, durationMinutes: minutesBetween(from, to) });
    from = to;
  }
  return out;
}

// ── timer (PRJ-005, E-PRJ-01/03) ───────────────────────────────────────────────────────────────────────────

export interface RunningTimerLike {
  readonly startedAt: number;
  readonly description?: string | undefined;
  readonly projectId?: string | undefined;
  readonly contactId?: string | undefined;
}

export type TimerAlert = "none" | "warn_10h" | "auto_stop_24h";

export function timerAlert(timer: Pick<RunningTimerLike, "startedAt">, now: number): TimerAlert {
  const elapsed = now - timer.startedAt;
  if (elapsed >= TIMER_AUTO_STOP_MS) return "auto_stop_24h";
  if (elapsed >= TIMER_WARN_AFTER_MS) return "warn_10h";
  return "none";
}

/** E-PRJ-02: a stopped timer without description or without project/contact is saved but flagged „unvollständig“. */
export function isIncomplete(e: {
  readonly description?: string | undefined;
  readonly projectId?: string | undefined;
  readonly contactId?: string | undefined;
}): boolean {
  return (e.description?.trim().length ?? 0) < MIN_DESCRIPTION_LENGTH || (!e.projectId && !e.contactId);
}

/** E-PRJ-01 confirmation text. */
export function timerRunningConfirm(projectLabel: string | undefined, elapsedMinutes: number): string {
  return `Es läuft bereits ein Timer (${projectLabel ?? "ohne Projekt"}, ${formatMinutes(elapsedMinutes)}). Stoppen und neuen Timer starten?`;
}

// ── manual entry (PRJ-007, E-PRJ-04…09) ────────────────────────────────────────────────────────────────────

const GENERIC_DESCRIPTIONS = new Set([
  "arbeit",
  "arbeiten",
  "arbeitszeit",
  "diverses",
  "div",
  "sonstiges",
  "leistung",
  "leistungen",
  "tätigkeit",
  "tätigkeiten",
  "dienstleistung",
  "support",
  "beratung",
  "misc",
  "allgemein",
]);

/** E-PRJ-09 (UST-07): the description flows into the invoice — generic texts get a warning. */
export function isGenericDescription(text: string): boolean {
  const core = text
    .trim()
    .replace(/[.,;:!?…\-–\s]+$/u, "")
    .toLowerCase();
  return GENERIC_DESCRIPTIONS.has(core);
}

export interface ManualEntryInput {
  readonly date: CalendarDate;
  /** Either start–end wall-clock times („09:00“, „10:30“) … */
  readonly startTime?: string | undefined;
  readonly endTime?: string | undefined;
  /** … or a duration in any accepted notation. */
  readonly duration?: string | undefined;
  readonly description: string;
}

export interface ManualEntry {
  readonly date: CalendarDate;
  readonly durationMinutes: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly description: string;
  readonly warnings: readonly Issue[];
}

export type ManualEntryIssue = Issue<
  "duration_unparsed" | "duration_range" | "end_before_start" | "date_future" | "description_required"
> & { readonly field: "duration" | "startTime" | "endTime" | "date" | "description" };

const fieldIssue = (
  field: ManualEntryIssue["field"],
  code: ManualEntryIssue["code"],
  message: string,
): ManualEntryIssue => ({ ...issue(code, message), field });

/** Validates a manual entry; the duration comes from the instants of the wall-clock times (DST-exact) or the input. */
export function buildManualEntry(
  input: ManualEntryInput,
  today: CalendarDate,
): Result<ManualEntry, readonly ManualEntryIssue[]> {
  const issues: ManualEntryIssue[] = [];
  if (input.date > today) issues.push(fieldIssue("date", "date_future", TIME_MESSAGES.future));
  const description = input.description.trim();
  if (description.length < MIN_DESCRIPTION_LENGTH) {
    issues.push(fieldIssue("description", "description_required", TIME_MESSAGES.description));
  }
  let minutes: number | undefined;
  let span: { startedAt: number; endedAt: number } | undefined;
  if (input.startTime?.trim() || input.endTime?.trim()) {
    const start = parseClockTime(input.startTime ?? "");
    const end = parseClockTime(input.endTime ?? "");
    if (start === null) issues.push(fieldIssue("startTime", "duration_unparsed", TIME_MESSAGES.durationUnparsed));
    if (end === null) issues.push(fieldIssue("endTime", "duration_unparsed", TIME_MESSAGES.durationUnparsed));
    if (start !== null && end !== null) {
      const startedAt = berlinWallClockInstant(input.date, start);
      const endedAt = berlinWallClockInstant(input.date, end);
      if (endedAt < startedAt) issues.push(fieldIssue("endTime", "end_before_start", TIME_MESSAGES.endBeforeStart));
      else {
        minutes = minutesBetween(startedAt, endedAt);
        span = { startedAt, endedAt };
      }
    }
  } else {
    const parsed = parseDuration(input.duration ?? "");
    if (parsed.ok) minutes = parsed.value;
    else issues.push(fieldIssue("duration", "duration_unparsed", parsed.error.message));
  }
  if (minutes !== undefined) {
    const range = checkDurationRange(minutes);
    if (range) issues.push(fieldIssue(span ? "endTime" : "duration", "duration_range", range.message));
  }
  if (issues.length > 0 || minutes === undefined) return err(issues);
  const warnings = isGenericDescription(description) ? [issue("generic_description", TIME_MESSAGES.generic)] : [];
  return ok({ date: input.date, durationMinutes: minutes, ...(span ?? {}), description, warnings });
}

/** E-PRJ-07 (warning only): how many other entries overlap the instants of this one. */
export function overlapCount(
  span: { startedAt?: number | undefined; endedAt?: number | undefined },
  others: readonly { startedAt?: number | undefined; endedAt?: number | undefined }[],
): number {
  if (span.startedAt === undefined || span.endedAt === undefined) return 0;
  const { startedAt: a, endedAt: b } = span;
  return others.filter((o) => o.startedAt !== undefined && o.endedAt !== undefined && o.startedAt < b && a < o.endedAt)
    .length;
}

export const overlapWarning = (n: number): string => `Diese Zeit überschneidet sich mit ${n} anderen Einträgen.`;

// ── locking (PRJ-012, E-PRJ-10/11) ─────────────────────────────────────────────────────────────────────────

export interface LockableEntry {
  readonly status: TimeEntryStatus;
  /** Number of the invoice the entry was billed with (invoiced) or the draft label (in_draft). */
  readonly documentLabel?: string | undefined;
}

/** Only `open` entries may be edited or deleted; in_draft/invoiced entries are locked with the E-PRJ-10/11 text. */
export function entryLock(e: LockableEntry): Issue<"time_entry_locked"> | null {
  if (e.status === "in_draft") {
    return issue(
      "time_entry_locked",
      `Dieser Eintrag ist in Rechnungsentwurf ${e.documentLabel ?? "Entwurf"} enthalten. Entfernen Sie ihn dort zuerst.`,
    );
  }
  if (e.status === "invoiced") {
    return issue(
      "time_entry_locked",
      `Dieser Eintrag wurde mit Rechnung ${e.documentLabel ?? "(ohne Nummer)"} abgerechnet und kann nicht mehr geändert werden.`,
    );
  }
  return null;
}

/** „03.09.2026“ or „03.09.–28.09.2026“ style period label. */
export function periodLabel(from: CalendarDate, to: CalendarDate): string {
  if (from === to) return formatGermanDate(from);
  const f = formatGermanDate(from);
  const t = formatGermanDate(to);
  return from.slice(0, 4) === to.slice(0, 4) ? `${f.slice(0, 6)}–${t}` : `${f}–${t}`;
}
