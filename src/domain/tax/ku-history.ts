/**
 * Kleinunternehmer history guard (F01 SET-034; KU-03, GOBD-06, UST-30). Entries whose effective range contains a
 * finalised document are immutable; corrections append a new entry. A retroactive entry (validFrom ≤ the latest
 * finalised document date) needs a reason and returns the affected documents (Rechnungsberichtigung or Storno).
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { lookupRule } from "../rules/rule-table";
import { KU_WAIVER_RULES } from "../rules/thresholds";
import { type CalendarDate, daysInMonth, formatGermanDate } from "../time/calendar-date";

export interface KuEntry {
  validFrom: string;
  isKU: boolean;
  waiverDate?: string | undefined;
}

export interface FinalisedDocRef {
  id: string;
  number: string;
  /** Supply date the KU status was resolved by (§4.2). */
  date: string;
}

const sorted = (h: readonly KuEntry[]) => [...h].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
const same = (a: KuEntry, b: KuEntry) =>
  a.validFrom === b.validFrom && a.isKU === b.isKU && a.waiverDate === b.waiverDate;

function docsInRange(history: readonly KuEntry[], index: number, docs: readonly FinalisedDocRef[]): FinalisedDocRef[] {
  const from = history[index]?.validFrom ?? "";
  const to = history[index + 1]?.validFrom;
  return docs.filter((d) => d.date >= from && (to === undefined || d.date < to));
}

const de = (d: string) => formatGermanDate(d as CalendarDate);

/**
 * KU-04 (§ 19 Abs. 3 UStG): the waiver active on `date`, if its binding period (first waived year + n − 1, from the
 * rule table) still covers `date`. A regular-taxation entry without `waiverDate` (limit exceeded) locks nothing.
 */
export function waiverLockOf(
  history: readonly KuEntry[],
  date: string,
): { waiverDate: string; lockEnd: string } | null {
  for (const e of sorted(history)) {
    if (e.isKU || !e.waiverDate || e.validFrom > date) continue;
    const rules = lookupRule(KU_WAIVER_RULES, `${e.validFrom.slice(0, 4)}-01-01` as CalendarDate);
    if (!rules.ok) continue;
    const lockEnd = `${Number(e.validFrom.slice(0, 4)) + rules.value.value.bindingYears - 1}-12-31`;
    if (date <= lockEnd) return { waiverDate: e.waiverDate, lockEnd };
  }
  return null;
}

/** Form rules of a new waiver entry (F01 §5.3: KU_WAIVER_START_INVALID, KU_WAIVER_TOO_LATE). */
function checkWaiverEntry(e: KuEntry): Issue | null {
  if (e.isKU || !e.waiverDate) return null;
  if (!e.validFrom.endsWith("-01-01")) {
    return issue("KU_WAIVER_START_INVALID", "Ein Verzicht wirkt immer ab Beginn eines Kalenderjahres.");
  }
  const year = Number(e.validFrom.slice(0, 4));
  const rules = lookupRule(KU_WAIVER_RULES, e.validFrom as CalendarDate);
  const after = rules.ok ? rules.value.value.declarationYearsAfter : null;
  if (after !== null) {
    const y = year + after;
    const deadline = `${y}-02-${String(daysInMonth(y, 2)).padStart(2, "0")}`;
    if (e.waiverDate > deadline) {
      return issue("KU_WAIVER_TOO_LATE", `Der Verzicht für ${year} kann nur bis 28./29.02.${y} erklärt werden.`, {
        year,
        deadline,
      });
    }
  }
  return null;
}

export function checkKuHistoryChange(
  before: readonly KuEntry[],
  after: readonly KuEntry[],
  docs: readonly FinalisedDocRef[],
  reason?: string,
): Result<{ affected: FinalisedDocRef[] }> {
  const prev = sorted(before);
  const next = sorted(after);
  const added = next.filter((e) => !prev.some((p) => same(p, e)));
  for (const e of added) {
    const problem = checkWaiverEntry(e);
    if (problem) return err(problem);
    if (!e.isKU) continue;
    const lock = waiverLockOf(next, e.validFrom);
    if (lock && !reason?.trim()) {
      return err(
        issue(
          "KU_WAIVER_LOCKED",
          `Der Verzicht auf die Kleinunternehmerregelung vom ${de(lock.waiverDate)} bindet bis ${de(lock.lockEnd)} (§ 19 Abs. 3 UStG). Wechsel nur mit Begründung möglich.`,
          { waiverDate: lock.waiverDate, lockEnd: lock.lockEnd },
        ),
      );
    }
  }
  for (const [i, entry] of prev.entries()) {
    if (docsInRange(prev, i, docs).length === 0) continue;
    if (!next.some((e) => same(e, entry))) {
      return err(
        issue(
          "HISTORY_ENTRY_LOCKED",
          "Dieser Eintrag wurde bereits für fertiggestellte Dokumente verwendet und kann nicht geändert werden. Bitte einen neuen Eintrag hinzufügen.",
          { validFrom: entry.validFrom },
        ),
      );
    }
  }
  const latest = docs.reduce((m, d) => (d.date > m ? d.date : m), "");
  const affected: FinalisedDocRef[] = [];
  for (const [i, entry] of next.entries()) {
    if (prev.some((e) => same(e, entry)) || !latest || entry.validFrom > latest) continue;
    affected.push(...docsInRange(next, i, docs));
  }
  if (affected.length > 0 && !reason?.trim()) {
    return err(
      issue(
        "REASON_REQUIRED",
        `Der rückwirkende Eintrag betrifft ${affected.length} fertiggestellte Dokument(e). Bitte eine Begründung angeben und die Dokumente per Rechnungsberichtigung oder Storno korrigieren.`,
        { affected: affected.length },
      ),
    );
  }
  return ok({ affected });
}
