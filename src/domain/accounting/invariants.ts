/**
 * Journal invariants over a snapshot (10-edge-cases §2): RI-12 (every entry balances, `seq` gapless, every entry
 * has a source, lines reference existing accounts, the line read model mirrors the entries, a reversal mirrors an
 * existing entry and nothing is reversed twice) and RI-11 (the `cash` account is ≥ 0 after every movement).
 * Pure; convex/model/invariants.ts feeds it the database.
 */
import { firstNegativeBalance } from "../cash/check";
import { checkBalanced } from "./post";

export interface InvariantFinding {
  id: "RI-11" | "RI-12";
  severity: "ERROR";
  message: string;
}

export interface EntrySnapshot {
  id: string;
  seq: number;
  date: string;
  period: string;
  lines: readonly { account: string; debitCents: number; creditCents: number }[];
  source: { kind: string; id: string };
  reversalOfId?: string;
  attachmentsCount: number;
}

export interface LineSnapshot {
  entryId: string;
  lineIndex: number;
  seq: number;
  date: string;
  account: string;
  debitCents: number;
  creditCents: number;
}

const f = (message: string): InvariantFinding => ({ id: "RI-12", severity: "ERROR", message });

export function checkJournal(
  entries: readonly EntrySnapshot[],
  lineRows: readonly LineSnapshot[],
  accountExists: (account: string, date: string) => boolean,
): InvariantFinding[] {
  const out: InvariantFinding[] = [];
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  sorted.forEach((e, i) => {
    if (e.seq !== i + 1) out.push(f(`Journal-Nummer ${i + 1} fehlt oder ist doppelt (gefunden: ${e.seq}).`));
  });
  const byId = new Map(entries.map((e) => [e.id, e]));
  const reversed = new Map<string, string>();
  const rowsByEntry = new Map<string, LineSnapshot[]>();
  for (const r of lineRows) rowsByEntry.set(r.entryId, [...(rowsByEntry.get(r.entryId) ?? []), r]);

  for (const e of entries) {
    const label = `Buchung ${e.seq}`;
    const bal = checkBalanced(e.lines);
    if (!bal.ok) out.push(f(`${label}: ${bal.error.message}`));
    if (!e.source.kind || !e.source.id) out.push(f(`${label} hat keinen Beleg (Quelle).`));
    if (e.source.kind === "manual" && !e.reversalOfId && e.attachmentsCount === 0) {
      out.push(f(`${label}: manuelle Buchung ohne Beleg.`));
    }
    if (e.period !== e.date.slice(0, 7)) out.push(f(`${label}: Periode ${e.period} passt nicht zum Datum ${e.date}.`));
    for (const l of e.lines) {
      if (!accountExists(l.account, e.date)) out.push(f(`${label}: Konto ${l.account} existiert nicht.`));
    }
    if (e.reversalOfId) {
      const orig = byId.get(e.reversalOfId);
      if (!orig) out.push(f(`${label}: storniert eine unbekannte Buchung.`));
      else if (!mirrors(orig, e)) out.push(f(`${label} spiegelt Buchung ${orig.seq} nicht.`));
      const prev = reversed.get(e.reversalOfId);
      if (prev) out.push(f(`Buchung ${orig?.seq ?? "?"} wurde mehrfach storniert.`));
      reversed.set(e.reversalOfId, e.id);
    }
    const rows = (rowsByEntry.get(e.id) ?? []).sort((a, b) => a.lineIndex - b.lineIndex);
    const consistent =
      rows.length === e.lines.length &&
      rows.every((r, i) => {
        const l = e.lines[i];
        return (
          l !== undefined &&
          r.lineIndex === i &&
          r.seq === e.seq &&
          r.date === e.date &&
          r.account === l.account &&
          r.debitCents === l.debitCents &&
          r.creditCents === l.creditCents
        );
      });
    if (!consistent) out.push(f(`${label}: Zeilenverzeichnis weicht von der Buchung ab.`));
    rowsByEntry.delete(e.id);
  }
  for (const id of rowsByEntry.keys()) out.push(f(`Buchungszeilen ohne Buchung (${id}).`));
  return out;
}

function mirrors(orig: EntrySnapshot, rev: EntrySnapshot): boolean {
  return (
    orig.lines.length === rev.lines.length &&
    orig.lines.every((l, i) => {
      const r = rev.lines[i];
      return (
        r !== undefined && r.account === l.account && r.debitCents === l.creditCents && r.creditCents === l.debitCents
      );
    })
  );
}

/** RI-11 over the cash account's lines. */
export function checkCash(
  cashLines: readonly { date: string; seq: number; debitCents: number; creditCents: number }[],
) {
  const dip = firstNegativeBalance(
    cashLines.map((l) => ({ date: l.date, seq: l.seq, amountCents: l.debitCents - l.creditCents })),
  );
  return dip
    ? [
        {
          id: "RI-11" as const,
          severity: "ERROR" as const,
          message: `Kassenbestand am ${dip.date} negativ (${dip.balanceCents} Cent, Buchung ${dip.seq}).`,
        },
      ]
    : [];
}
