/**
 * Journal search, list and report (F08 ACC-025, RPT-008; GOBD-01, GOBD-05). Pure: the Convex query feeds the entries
 * of the date range and applies these filters; the Buchungsjournal CSV uses the shared list exporter (F09 EXP-021).
 */
import { type CsvColumn, type CsvVariant, formatCsv } from "../csv/export";
import { parseCents } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import { isCalendarDate } from "../time/calendar-date";

export const JOURNAL_SORTS = ["seq_desc", "seq_asc", "date_desc", "date_asc"] as const;
export type JournalSort = (typeof JOURNAL_SORTS)[number];

export interface JournalFilter {
  from?: string;
  to?: string;
  account?: string;
  contactId?: string;
  sourceKind?: string;
  text?: string;
  minCents?: number;
  maxCents?: number;
  /** Only late postings (ACC-006 b, „Nachbuchung“). */
  late?: boolean;
  /** `only` = reversals and reversed entries; `exclude` = neither. */
  reversals?: "only" | "exclude";
  actor?: string;
}

export interface SearchableEntry {
  seq: number;
  date: string;
  text: string;
  source: { kind: string; id: string };
  lines: readonly { account: string; debitCents: number; creditCents: number; contactId?: string }[];
  late: boolean;
  /** This entry is a reversal (Storno/Gegenbuchung). */
  reversal: boolean;
  /** This entry was reversed later. */
  reversed: boolean;
  actor: string;
}

export const JOURNAL_FILTER_MESSAGES = {
  date: "Bitte gültige Datumsangaben (TT.MM.JJJJ) verwenden.",
  range: "Das Von-Datum liegt nach dem Bis-Datum.",
  amount: "Bitte gültige Beträge angeben.",
  amountRange: "Der Mindestbetrag liegt über dem Höchstbetrag.",
} as const;

export function validateJournalFilter(f: JournalFilter): Result<JournalFilter, Issue<"invalid_filter">> {
  for (const d of [f.from, f.to]) {
    if (d !== undefined && !isCalendarDate(d)) return err(issue("invalid_filter", JOURNAL_FILTER_MESSAGES.date));
  }
  if (f.from && f.to && f.from > f.to) return err(issue("invalid_filter", JOURNAL_FILTER_MESSAGES.range));
  for (const c of [f.minCents, f.maxCents]) {
    if (c !== undefined && (!Number.isSafeInteger(c) || c < 0)) {
      return err(issue("invalid_filter", JOURNAL_FILTER_MESSAGES.amount));
    }
  }
  if (f.minCents !== undefined && f.maxCents !== undefined && f.minCents > f.maxCents) {
    return err(issue("invalid_filter", JOURNAL_FILTER_MESSAGES.amountRange));
  }
  return ok(f);
}

const totalOf = (e: SearchableEntry) => e.lines.reduce((s, l) => s + l.debitCents, 0);

export function matchesJournalFilter(e: SearchableEntry, f: JournalFilter): boolean {
  if (f.from && e.date < f.from) return false;
  if (f.to && e.date > f.to) return false;
  if (f.account && !e.lines.some((l) => l.account === f.account)) return false;
  if (f.contactId && !e.lines.some((l) => l.contactId === f.contactId)) return false;
  if (f.sourceKind && e.source.kind !== f.sourceKind) return false;
  if (f.actor && e.actor !== f.actor) return false;
  if (f.late && !e.late) return false;
  if (f.reversals === "only" && !e.reversal && !e.reversed) return false;
  if (f.reversals === "exclude" && (e.reversal || e.reversed)) return false;
  const total = totalOf(e);
  if (f.minCents !== undefined && total < f.minCents) return false;
  if (f.maxCents !== undefined && total > f.maxCents) return false;
  const needle = f.text?.trim().toLocaleLowerCase("de");
  if (needle) {
    const hay = `${e.seq} ${e.text}`.toLocaleLowerCase("de");
    if (!hay.includes(needle)) return false;
  }
  return true;
}

export function sortJournal<T extends { seq: number; date: string }>(entries: readonly T[], sort: JournalSort): T[] {
  const out = [...entries];
  const dir = sort.endsWith("asc") ? 1 : -1;
  if (sort.startsWith("seq")) out.sort((a, b) => dir * (a.seq - b.seq));
  else out.sort((a, b) => dir * (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));
  return out;
}

/** „1.234,56“ / „1234,56“ / „1234.56“ → cents; empty → undefined; invalid → null. */
export function amountFilterCents(text: string): number | undefined | null {
  if (text.trim() === "") return undefined;
  const r = parseCents(text);
  return r.ok && r.value >= 0 ? r.value : null;
}

// ── Buchungsjournal (RPT-008) ─────────────────────────────────────────────────────────────────────────────

/** One report row per journal line (DATEV-like: Nr., Datum, Beleg, Text, Konto, Soll, Haben, …). */
export interface JournalReportRow {
  seq: number;
  date: string;
  period: string;
  sourceLabel: string;
  sourceId: string;
  text: string;
  account: string;
  accountName: string;
  debitCents: number;
  creditCents: number;
  taxKey?: string;
  costCenter?: string;
  currency?: string;
  amountFx?: number;
  reversalOfSeq?: number;
  reversedBySeq?: number;
  latePosting?: string;
  originalDate?: string;
  locked: boolean;
  actor: string;
}

export interface ReportEntry {
  seq: number;
  date: string;
  period: string;
  text: string;
  source: { id: string; label: string };
  lines: readonly {
    account: string;
    accountName: string;
    debitCents: number;
    creditCents: number;
    taxKey?: string;
    costCenter?: string;
    currency?: string;
    amountFx?: number;
  }[];
  reversalOfSeq?: number;
  reversedBySeq?: number;
  latePostingReason?: string;
  originalDate?: string;
  locked: boolean;
  actor: string;
}

export function journalReportRows(entries: readonly ReportEntry[]): JournalReportRow[] {
  return entries.flatMap((e) =>
    e.lines.map((l) => ({
      seq: e.seq,
      date: e.date,
      period: e.period,
      sourceLabel: e.source.label,
      sourceId: e.source.id,
      text: e.text,
      account: l.account,
      accountName: l.accountName,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      ...(l.taxKey ? { taxKey: l.taxKey } : {}),
      ...(l.costCenter ? { costCenter: l.costCenter } : {}),
      ...(l.currency ? { currency: l.currency } : {}),
      ...(l.amountFx !== undefined ? { amountFx: l.amountFx } : {}),
      ...(e.reversalOfSeq !== undefined ? { reversalOfSeq: e.reversalOfSeq } : {}),
      ...(e.reversedBySeq !== undefined ? { reversedBySeq: e.reversedBySeq } : {}),
      ...(e.latePostingReason ? { latePosting: e.latePostingReason } : {}),
      ...(e.originalDate ? { originalDate: e.originalDate } : {}),
      locked: e.locked,
      actor: e.actor,
    })),
  );
}

export const JOURNAL_REPORT_COLUMNS: readonly CsvColumn<JournalReportRow>[] = [
  { label: "Nr.", key: "seq", kind: "int", value: (r) => r.seq },
  { label: "Buchungsdatum", key: "date", kind: "date", value: (r) => r.date },
  { label: "Periode", key: "period", kind: "text", value: (r) => r.period },
  { label: "Beleg", key: "source", kind: "text", value: (r) => r.sourceLabel },
  { label: "Beleg-ID", key: "source_id", kind: "id", value: (r) => r.sourceId },
  { label: "Buchungstext", key: "text", kind: "text", value: (r) => r.text },
  { label: "Konto", key: "account", kind: "text", value: (r) => r.account },
  { label: "Kontobezeichnung", key: "account_name", kind: "text", value: (r) => r.accountName },
  { label: "Soll", key: "debit_cents", kind: "cents", value: (r) => r.debitCents || null },
  { label: "Haben", key: "credit_cents", kind: "cents", value: (r) => r.creditCents || null },
  { label: "Steuerschlüssel", key: "tax_key", kind: "text", value: (r) => r.taxKey },
  { label: "Kostenstelle", key: "cost_center", kind: "text", value: (r) => r.costCenter },
  { label: "Währung", key: "currency", kind: "text", value: (r) => r.currency },
  { label: "Betrag Fremdwährung", key: "amount_fx_minor", kind: "cents", value: (r) => r.amountFx },
  { label: "Storno von Nr.", key: "reversal_of_seq", kind: "int", value: (r) => r.reversalOfSeq },
  { label: "Storniert durch Nr.", key: "reversed_by_seq", kind: "int", value: (r) => r.reversedBySeq },
  { label: "Nachbuchung", key: "late_posting", kind: "text", value: (r) => r.latePosting },
  { label: "Ursprüngliches Datum", key: "original_date", kind: "date", value: (r) => r.originalDate },
  { label: "Festgeschrieben", key: "locked", kind: "bool", value: (r) => r.locked },
  { label: "Erfasst von", key: "actor", kind: "text", value: (r) => r.actor },
];

export function journalCsv(entries: readonly ReportEntry[], variant: CsvVariant = "excel"): string {
  return formatCsv(JOURNAL_REPORT_COLUMNS, journalReportRows(entries), variant);
}
