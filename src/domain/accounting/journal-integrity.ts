/**
 * Journal integrity (F08 ACC-020, GOBD-05, SEC-04, RI-13; part of `integrity.verify`). Pure, page by page:
 *  - `seq` is gapless and strictly increasing from 1 (GOBD-05),
 *  - every entry is balanced: Σ debit = Σ credit > 0, ≥ 2 lines, each line one-sided with integer cents (GOBD-03),
 *  - no entry of a locked period was recorded after that period's lock (`recordedAt > lockedAt` ⇒ finding, RI-13).
 */
import type { IntegrityFinding } from "../audit/chain";

export interface IntegrityEntry {
  id: string;
  seq: number;
  period: string;
  recordedAt: number;
  lines: readonly { debitCents: number; creditCents: number }[];
}

export interface JournalCursor {
  nextSeq: number;
}

const finding = (
  kind: IntegrityFinding["kind"],
  detail: string,
  e: IntegrityEntry,
  extra: Partial<IntegrityFinding> = {},
): IntegrityFinding => ({ kind, severity: "error", detail, entity: { table: "journalEntries", id: e.id }, ...extra });

export function verifyJournalPage(
  entries: readonly IntegrityEntry[],
  cursor: JournalCursor,
  lockedAt: ReadonlyMap<string, number>,
): { cursor: JournalCursor; findings: IntegrityFinding[] } {
  const findings: IntegrityFinding[] = [];
  let next = cursor.nextSeq;
  for (const e of entries) {
    if (e.seq !== next) {
      findings.push(
        finding(
          "journal_seq_gap",
          e.seq > next
            ? `Journal: Buchungsnummern ${next}–${e.seq - 1} fehlen.`
            : `Journal: Buchungsnummer ${e.seq} ist doppelt oder nicht aufsteigend.`,
          e,
          { firstBrokenSeq: Math.min(next, e.seq) },
        ),
      );
    }
    next = Math.max(next, e.seq + 1);
    let debit = 0;
    let credit = 0;
    let bad = e.lines.length < 2;
    for (const l of e.lines) {
      const okLine =
        Number.isSafeInteger(l.debitCents) &&
        Number.isSafeInteger(l.creditCents) &&
        l.debitCents >= 0 &&
        l.creditCents >= 0 &&
        (l.debitCents === 0) !== (l.creditCents === 0);
      if (!okLine) bad = true;
      debit += l.debitCents;
      credit += l.creditCents;
    }
    if (bad || debit !== credit || debit <= 0) {
      findings.push(
        finding("journal_unbalanced", `Journal: Buchung ${e.seq} ist nicht ausgeglichen oder ungültig.`, e, {
          firstBrokenSeq: e.seq,
        }),
      );
    }
    const lock = lockedAt.get(e.period);
    if (lock !== undefined && e.recordedAt > lock) {
      findings.push(
        finding(
          "journal_after_lock",
          `Journal: Buchung ${e.seq} im festgeschriebenen Zeitraum ${e.period.slice(5, 7)}/${e.period.slice(0, 4)} wurde nach der Festschreibung erfasst.`,
          e,
        ),
      );
    }
  }
  return { cursor: { nextSeq: next }, findings };
}

/**
 * E-ACC-27 (GOBD-22): postings continue while the server clock deviates (journal `recordedAt` stays server time);
 * every clock reading > 2 s off in the checked window becomes one `warning` finding (the 60 s block is F12 EC-027).
 */
export function clockSkewFindings(
  readings: readonly { id: string; at: number; offsetMs: number | null; status: string; detail: string }[],
): IntegrityFinding[] {
  const off = readings.filter((r) => r.status === "warning" || r.status === "error");
  if (off.length === 0) return [];
  const worst = off.reduce((a, b) => (Math.abs(b.offsetMs ?? 0) > Math.abs(a.offsetMs ?? 0) ? b : a));
  return [
    {
      kind: "clock_skew",
      severity: "warning",
      detail: `Serverzeit weicht ab: ${off.length} Messung(en) über 2 s, größte Abweichung ${Math.round(
        Math.abs(worst.offsetMs ?? 0) / 1000,
      )} s (${worst.detail}). Buchungen wurden mit der Serverzeit erfasst.`,
      entity: { table: "clockReadings", id: worst.id },
    },
  ];
}
