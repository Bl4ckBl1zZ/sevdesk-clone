/**
 * Retention engine rules (F12 PRV-003…PRV-009, 01 GOBD-21, DSGVO-02). Pure: `today` is passed in.
 *
 * Nothing is ever purged automatically: `retention.scan` only lists what may be purged; the owner runs the purge
 * wizard (Ablaufhemmung checklist + confirmation phrase) and the purge job replaces each record with a tombstone.
 */

import { isRetained, type RetentionClass, retentionUntilFor } from "../rules/retention";
import { berlinCalendarDate } from "../time/berlin";
import { addDays, type CalendarDate } from "../time/calendar-date";

export const PURGE_PHRASE = "ENDGÜLTIG LÖSCHEN";

/** PRV-005: each item must be confirmed „trifft nicht zu“ (§ 147 Abs. 3 Satz 5 AO Ablaufhemmung). */
export const ABLAUFHEMMUNG_ITEMS = [
  { id: "aussenpruefung", label: "Keine laufende oder angekündigte Außenprüfung (Betriebsprüfung)" },
  { id: "einspruch", label: "Keine offenen Einsprüche oder Klagen" },
  {
    id: "vorbehalt",
    label:
      "Keine Steuerbescheide unter Vorbehalt der Nachprüfung (§ 164 AO) oder vorläufig (§ 165 AO) für die betroffenen Jahre",
  },
  { id: "steuerfahndung", label: "Keine laufende Steuerfahndung und kein Steuerstrafverfahren" },
  {
    id: "zivilrecht",
    label: "Keine zivilrechtlichen Verfahren und keine Aufbewahrung aus anderen Gründen",
  },
] as const;

export type AblaufhemmungId = (typeof ABLAUFHEMMUNG_ITEMS)[number]["id"];

export const PURGE_MESSAGES = {
  hold: "Während einer Betriebsprüfung sind Löschungen gesperrt.",
  checklist: "Bitte bestätigen Sie alle Punkte zur Ablaufhemmung (§ 147 Abs. 3 Satz 5 AO).",
  phrase: `Bitte geben Sie „${PURGE_PHRASE}“ ein.`,
  apiForbidden: "Löschungen nach Ablauf der Aufbewahrungsfrist sind nur in der Anwendung möglich.",
  nothing: "Für die Auswahl gibt es keine löschbaren Datensätze.",
} as const;

/** GOBD-21 / RI-20: eligible only after `retentionUntil` (the last day itself is still retained). */
export function isPurgeEligible(retentionUntil: string | null | undefined, today: CalendarDate): boolean {
  return typeof retentionUntil === "string" && !isRetained(retentionUntil, today);
}

export interface RetainedRecord {
  table: string;
  id: string;
  retentionClass: Exclude<RetentionClass, "none">;
  retentionUntil: string;
}

export interface EligibleGroup {
  retentionClass: Exclude<RetentionClass, "none">;
  /** Year in which the retention ended (31.12. of that year). */
  year: number;
  count: number;
  tables: Record<string, number>;
}

/** PRV-003: purge-eligible records grouped by class and the year their retention ended (oldest first). */
export function groupEligible(records: readonly RetainedRecord[], today: CalendarDate): EligibleGroup[] {
  const map = new Map<string, EligibleGroup>();
  for (const r of records) {
    if (!isPurgeEligible(r.retentionUntil, today)) continue;
    const year = Number(r.retentionUntil.slice(0, 4));
    const key = `${r.retentionClass}|${year}`;
    const g = map.get(key) ?? { retentionClass: r.retentionClass, year, count: 0, tables: {} };
    g.count++;
    g.tables[r.table] = (g.tables[r.table] ?? 0) + 1;
    map.set(key, g);
  }
  return [...map.values()].sort((a, b) => a.retentionClass.localeCompare(b.retentionClass) || a.year - b.year);
}

/** PRV-005: E-PRV-02 (hold), E-PRV-03 (checklist), E-PRV-04 (phrase) — empty when the purge may start. */
export function checkPurgeRequest(input: {
  checklist: Readonly<Record<string, boolean>>;
  phrase: string;
  holdActive: boolean;
}): string[] {
  if (input.holdActive) return [PURGE_MESSAGES.hold];
  if (!ABLAUFHEMMUNG_ITEMS.every((i) => input.checklist[i.id] === true)) return [PURGE_MESSAGES.checklist];
  if (input.phrase.trim() !== PURGE_PHRASE) return [PURGE_MESSAGES.phrase];
  return [];
}

/** §4.7: audit entries belong to class books10 with the entry's `at` (Europe/Berlin) as trigger. */
export function auditRetentionUntil(atMs: number): string {
  return retentionUntilFor("books10", berlinCalendarDate(atMs)) as string;
}

/**
 * PRV-008 / E-PRV-07: the audit log is purged only as a prefix — the largest `n` such that every entry with
 * `seq ≤ n` has expired. `entries` must be in `seq` order starting at the current first entry.
 */
export function auditPrefixEnd(entries: readonly { seq: number; at: number }[], today: CalendarDate): number {
  let end = 0;
  for (const e of entries) {
    if (!isPurgeEligible(auditRetentionUntil(e.at), today)) break;
    end = e.seq;
  }
  return end;
}

/**
 * DSGVO-02 / CON-162: the due date for the manual purge worklist = the day after the longest `retentionUntil` of the
 * records referencing the person; `null` when nothing is retained (the data can go now).
 */
export function scheduledPurgeDate(retentionUntils: readonly string[]): CalendarDate | null {
  if (retentionUntils.length === 0) return null;
  const max = [...retentionUntils].sort().at(-1) as CalendarDate;
  return addDays(max, 1);
}
