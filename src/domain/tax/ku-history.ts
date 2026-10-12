/**
 * Kleinunternehmer history guard (F01 SET-034; KU-03, GOBD-06, UST-30). Entries whose effective range contains a
 * finalised document are immutable; corrections append a new entry. A retroactive entry (validFrom ≤ the latest
 * finalised document date) needs a reason and returns the affected documents (Rechnungsberichtigung or Storno).
 */
import { err, issue, ok, type Result } from "../result";

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

export function checkKuHistoryChange(
  before: readonly KuEntry[],
  after: readonly KuEntry[],
  docs: readonly FinalisedDocRef[],
  reason?: string,
): Result<{ affected: FinalisedDocRef[] }> {
  const prev = sorted(before);
  const next = sorted(after);
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
