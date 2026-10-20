/**
 * Journal-based reports (F08 RPT-003 BWA-light, RPT-004 Summen- und Saldenliste, RPT-005 Kontenblatt; GOBD-01,
 * GOBD-05). Pure: the Convex model feeds the journal lines (`journalLines` read model) and the account master data.
 * Every figure keeps the journal entry ids so the UI drills down to the entries and their source documents (RPT-001).
 */
import { roundHalfAway } from "../money";
import type { BwaGroup } from "../rules/accounting/types";

export interface ReportLine {
  entryId: string;
  seq: number;
  date: string;
  account: string;
  debitCents: number;
  creditCents: number;
  /** Journal source kind (opening balances go to the EB-Wert of the SuSa). */
  sourceKind: string;
  sourceId: string;
  text: string;
  /** Belegfeld 1 (document/voucher number) when known. */
  belegfeld1?: string;
  /** Other accounts of the same entry („Gegenkonto“). */
  contra?: string[];
  costCenterId?: string;
}

export interface AccountInfo {
  number: string;
  name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense" | "neutral" | "bank";
  bwaGroup: BwaGroup | string;
}

// ── Summen- und Saldenliste (RPT-004) ─────────────────────────────────────────────────────────────────

export interface SusaRow {
  account: string;
  name: string;
  accountClass: string;
  /** EB-Wert: balance carried into the fiscal year plus the opening entries (debit − credit). */
  openingCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  ytdDebitCents: number;
  ytdCreditCents: number;
  /** EB + YTD debit − YTD credit (positive = Soll-Saldo). */
  balanceCents: number;
}

export interface SusaTotals {
  openingCents: number;
  periodDebitCents: number;
  periodCreditCents: number;
  ytdDebitCents: number;
  ytdCreditCents: number;
  balanceCents: number;
}

export interface Susa {
  from: string;
  to: string;
  fiscalYearStart: string;
  rows: SusaRow[];
  classes: (SusaTotals & { accountClass: string })[];
  totals: SusaTotals;
  /** Σ Soll = Σ Haben check (period and YTD, incl. opening entries). */
  balanced: boolean;
}

const zeroTotals = (): SusaTotals => ({
  openingCents: 0,
  periodDebitCents: 0,
  periodCreditCents: 0,
  ytdDebitCents: 0,
  ytdCreditCents: 0,
  balanceCents: 0,
});

const addTotals = (t: SusaTotals, r: SusaTotals) => {
  t.openingCents += r.openingCents;
  t.periodDebitCents += r.periodDebitCents;
  t.periodCreditCents += r.periodCreditCents;
  t.ytdDebitCents += r.ytdDebitCents;
  t.ytdCreditCents += r.ytdCreditCents;
  t.balanceCents += r.balanceCents;
};

/** The SKR account class: first digit (personal accounts 10000–69999 / 70000–99999 are „Debitoren/Kreditoren“). */
export function accountClassOf(account: string): string {
  if (/^\d{5,}$/.test(account)) return Number(account) >= 70000 ? "Kreditoren" : "Debitoren";
  return account.slice(0, 1);
}

export function computeSusa(input: {
  lines: readonly ReportLine[];
  accounts: ReadonlyMap<string, AccountInfo>;
  fiscalYearStart: string;
  from: string;
  to: string;
  accountClass?: string;
  includePersonal?: boolean;
}): Susa {
  const rows = new Map<string, SusaRow>();
  const row = (account: string): SusaRow => {
    let r = rows.get(account);
    if (!r) {
      r = {
        account,
        name: input.accounts.get(account)?.name ?? "",
        accountClass: accountClassOf(account),
        ...zeroTotals(),
      };
      rows.set(account, r);
    }
    return r;
  };
  for (const l of input.lines) {
    if (l.date > input.to) continue;
    const r = row(l.account);
    const opening = l.date < input.fiscalYearStart || l.sourceKind === "opening_balance";
    if (opening) {
      r.openingCents += l.debitCents - l.creditCents;
      continue;
    }
    r.ytdDebitCents += l.debitCents;
    r.ytdCreditCents += l.creditCents;
    if (l.date >= input.from) {
      r.periodDebitCents += l.debitCents;
      r.periodCreditCents += l.creditCents;
    }
  }
  const out = [...rows.values()]
    .map((r) => ({ ...r, balanceCents: r.openingCents + r.ytdDebitCents - r.ytdCreditCents }))
    .filter((r) => r.openingCents !== 0 || r.ytdDebitCents !== 0 || r.ytdCreditCents !== 0)
    .filter((r) => !input.accountClass || r.accountClass === input.accountClass)
    .filter((r) => input.includePersonal !== false || !/^(Debitoren|Kreditoren)$/.test(r.accountClass))
    .sort((a, b) => a.account.localeCompare(b.account, "de", { numeric: true }));
  const classes = new Map<string, SusaTotals & { accountClass: string }>();
  const totals = zeroTotals();
  for (const r of out) {
    const c = classes.get(r.accountClass) ?? { accountClass: r.accountClass, ...zeroTotals() };
    addTotals(c, r);
    classes.set(r.accountClass, c);
    addTotals(totals, r);
  }
  const balanced =
    totals.periodDebitCents === totals.periodCreditCents &&
    totals.ytdDebitCents === totals.ytdCreditCents &&
    totals.openingCents === 0;
  return {
    from: input.from,
    to: input.to,
    fiscalYearStart: input.fiscalYearStart,
    rows: out,
    classes: [...classes.values()],
    totals,
    balanced: input.accountClass ? true : balanced,
  };
}

// ── Kontenblatt (RPT-005) ─────────────────────────────────────────────────────────────────────────────

export interface LedgerRow {
  entryId: string;
  seq: number;
  date: string;
  belegfeld1: string;
  text: string;
  contra: string;
  debitCents: number;
  creditCents: number;
  balanceCents: number;
  sourceKind: string;
  sourceId: string;
}

export interface AccountLedger {
  account: string;
  name: string;
  from: string;
  to: string;
  openingCents: number;
  rows: LedgerRow[];
  debitCents: number;
  creditCents: number;
  closingCents: number;
}

export function computeLedger(input: {
  lines: readonly ReportLine[];
  account: string;
  name: string;
  from: string;
  to: string;
}): AccountLedger {
  const own = input.lines
    .filter((l) => l.account === input.account && l.date <= input.to)
    .sort((a, b) => a.date.localeCompare(b.date) || a.seq - b.seq);
  let balance = 0;
  let debit = 0;
  let credit = 0;
  const rows: LedgerRow[] = [];
  for (const l of own) {
    if (l.date < input.from) {
      balance += l.debitCents - l.creditCents;
      continue;
    }
    balance += l.debitCents - l.creditCents;
    debit += l.debitCents;
    credit += l.creditCents;
    const contra = [...new Set(l.contra ?? [])];
    rows.push({
      entryId: l.entryId,
      seq: l.seq,
      date: l.date,
      belegfeld1: l.belegfeld1 ?? "",
      text: l.text,
      contra: contra.length > 1 ? "diverse" : (contra[0] ?? ""),
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      balanceCents: balance,
      sourceKind: l.sourceKind,
      sourceId: l.sourceId,
    });
  }
  const opening = balance - debit + credit;
  return {
    account: input.account,
    name: input.name,
    from: input.from,
    to: input.to,
    openingCents: opening,
    rows,
    debitCents: debit,
    creditCents: credit,
    closingCents: balance,
  };
}

// ── BWA-light (RPT-003, F08 §4.9) ─────────────────────────────────────────────────────────────────────

export type BwaRowKey =
  | "umsatz"
  | "bestand"
  | "gesamtleistung"
  | "waren"
  | "rohertrag"
  | "personal"
  | "raum"
  | "steuern_vers"
  | "kfz"
  | "werbe_reise"
  | "afa"
  | "reparatur"
  | "sonstige"
  | "gesamtkosten"
  | "betriebsergebnis"
  | "zins"
  | "neutral_aufwand"
  | "neutral_ertrag"
  | "ergebnis";

/** Rows in DATEV BWA 01 order (simplified): label, group, kind. */
export const BWA_ROWS: readonly { key: BwaRowKey; label: string; group?: BwaGroup; sum?: true }[] = [
  { key: "umsatz", label: "Umsatzerlöse", group: "UMSATZ" },
  { key: "bestand", label: "Bestandsveränderungen (nicht geführt)" },
  { key: "gesamtleistung", label: "Gesamtleistung", sum: true },
  { key: "waren", label: "Material-/Wareneinkauf", group: "WAREN" },
  { key: "rohertrag", label: "Rohertrag", sum: true },
  { key: "personal", label: "Personalkosten", group: "PERSONAL" },
  { key: "raum", label: "Raumkosten", group: "RAUM" },
  { key: "steuern_vers", label: "Betriebliche Steuern, Versicherungen, Beiträge", group: "STEUERN_VERS" },
  { key: "kfz", label: "Kfz-Kosten (ohne Steuer)", group: "KFZ" },
  { key: "werbe_reise", label: "Werbe- und Reisekosten", group: "WERBE_REISE" },
  { key: "afa", label: "Abschreibungen", group: "AFA" },
  { key: "reparatur", label: "Reparatur/Instandhaltung", group: "REPARATUR" },
  { key: "sonstige", label: "Sonstige Kosten", group: "SONSTIGE" },
  { key: "gesamtkosten", label: "Gesamtkosten", sum: true },
  { key: "betriebsergebnis", label: "Betriebsergebnis", sum: true },
  { key: "zins", label: "Zinsaufwand (saldiert)", group: "ZINS" },
  { key: "neutral_aufwand", label: "Sonstiger neutraler Aufwand", group: "NEUTRAL_AUFWAND" },
  { key: "neutral_ertrag", label: "Sonstiger neutraler Ertrag", group: "NEUTRAL_ERTRAG" },
  { key: "ergebnis", label: "Vorläufiges Ergebnis", sum: true },
];

const INCOME_GROUPS = new Set<string>(["UMSATZ", "NEUTRAL_ERTRAG"]);

/** One amount per BWA group (income groups credit − debit, cost groups debit − credit). */
export type BwaAmounts = Partial<Record<BwaGroup, number>>;

export function bwaAmountsFromLines(
  lines: readonly ReportLine[],
  accounts: ReadonlyMap<string, AccountInfo>,
  range: { from: string; to: string },
  costCenterId?: string,
): BwaAmounts {
  const out: BwaAmounts = {};
  for (const l of lines) {
    if (l.date < range.from || l.date > range.to || l.sourceKind === "opening_balance") continue;
    if (costCenterId && l.costCenterId !== costCenterId) continue;
    const g = accounts.get(l.account)?.bwaGroup as BwaGroup | undefined;
    if (!g || g === "NONE") continue;
    const v = INCOME_GROUPS.has(g) ? l.creditCents - l.debitCents : l.debitCents - l.creditCents;
    out[g] = (out[g] ?? 0) + v;
  }
  return out;
}

/** Cash variant: EÜR items (payment date) by the BWA group of their account. */
export function bwaAmountsFromCash(
  items: readonly { key: string; cents: number; date: string; account?: string }[],
  accounts: ReadonlyMap<string, AccountInfo>,
  range: { from: string; to: string },
): BwaAmounts {
  const out: BwaAmounts = {};
  for (const i of items) {
    if (i.date < range.from || i.date > range.to || !i.account) continue;
    const g = accounts.get(i.account)?.bwaGroup as BwaGroup | undefined;
    if (!g || g === "NONE" || i.key.startsWith("PRIVAT")) continue;
    const income = i.key.startsWith("BE.");
    // BE items are income, BA items expenses — expressed in the group's own direction
    const v = INCOME_GROUPS.has(g) ? (income ? i.cents : -i.cents) : income ? -i.cents : i.cents;
    out[g] = (out[g] ?? 0) + v;
  }
  return out;
}

export function bwaRows(a: BwaAmounts): Record<BwaRowKey, number> {
  const g = (k: BwaGroup) => a[k] ?? 0;
  const gesamtleistung = g("UMSATZ");
  const rohertrag = gesamtleistung - g("WAREN");
  const kosten =
    g("PERSONAL") +
    g("RAUM") +
    g("STEUERN_VERS") +
    g("KFZ") +
    g("WERBE_REISE") +
    g("AFA") +
    g("REPARATUR") +
    g("SONSTIGE");
  const betriebsergebnis = rohertrag - kosten;
  return {
    umsatz: g("UMSATZ"),
    bestand: 0,
    gesamtleistung,
    waren: g("WAREN"),
    rohertrag,
    personal: g("PERSONAL"),
    raum: g("RAUM"),
    steuern_vers: g("STEUERN_VERS"),
    kfz: g("KFZ"),
    werbe_reise: g("WERBE_REISE"),
    afa: g("AFA"),
    reparatur: g("REPARATUR"),
    sonstige: g("SONSTIGE"),
    gesamtkosten: kosten,
    betriebsergebnis,
    zins: g("ZINS"),
    neutral_aufwand: g("NEUTRAL_AUFWAND"),
    neutral_ertrag: g("NEUTRAL_ERTRAG"),
    ergebnis: betriebsergebnis - g("ZINS") - g("NEUTRAL_AUFWAND") + g("NEUTRAL_ERTRAG"),
  };
}

export interface BwaRow {
  key: BwaRowKey;
  label: string;
  sum: boolean;
  monthCents: number;
  ytdCents: number;
  priorYtdCents: number;
  /** % of Gesamtleistung (YTD), basis points; null when the Gesamtleistung is 0. */
  ytdShareBp: number | null;
}

export function computeBwa(month: BwaAmounts, ytd: BwaAmounts, priorYtd: BwaAmounts): BwaRow[] {
  const m = bwaRows(month);
  const y = bwaRows(ytd);
  const p = bwaRows(priorYtd);
  return BWA_ROWS.map((r) => ({
    key: r.key,
    label: r.label,
    sum: r.sum === true,
    monthCents: m[r.key],
    ytdCents: y[r.key],
    priorYtdCents: p[r.key],
    ytdShareBp:
      y.gesamtleistung === 0 ? null : Number(roundHalfAway(BigInt(y[r.key]) * 10000n, BigInt(y.gesamtleistung))),
  }));
}
