/**
 * Revolut Business statement CSV (F07 BNK-032). Parsed **by header names** through the data-driven mapping below
 * (research 13 §5); the column names are **UNSURE** until the owner's real export exists (F07 Q-03) — every column
 * carries an `unsure` flag, unknown columns are ignored, and adding a new header spelling is a data change here.
 *
 *  - Dates: „Date completed (UTC)“ → Europe/Berlin booking date (BNK-112); a local-time column
 *    „Date completed (<IANA zone>)“ is read in that zone; without a completion date the start date is used.
 *  - Only completed rows (`State` = COMPLETED, if the column exists; rows without completion date are skipped).
 *  - Amount: `Total amount` if present (the account movement incl. fee); otherwise `Amount` combined with `Fee`
 *    per the mapper constant `amountIncludesFee` (BNK-023, EC-145). If the file has a `Balance` column, the
 *    running balance decides which semantics the file follows (`feeSemantics.verifiedBy = "balance"`).
 *  - `ID` → `providerTransactionId` (dedupe + cross-source matching, BNK-110); repeated IDs in one file get `#n`.
 */

import { detectSeparator, parseCsv } from "../../csv/csv";
import { err, ok, type Result } from "../../result";
import { parseBankAmount } from "../amount";
import { parseBankDateTime } from "../dates";
import { normaliseIban } from "../normalise";
import {
  type ParsedStatement,
  type ParsedTransaction,
  type ParseIssue,
  type UnreadableFile,
  unreadable,
} from "../types";

export type RevolutField =
  | "dateStartedUtc"
  | "dateCompletedUtc"
  | "dateStartedLocal"
  | "dateCompletedLocal"
  | "id"
  | "type"
  | "state"
  | "description"
  | "reference"
  | "payer"
  | "cardNumber"
  | "origCurrency"
  | "origAmount"
  | "paymentCurrency"
  | "amount"
  | "totalAmount"
  | "exchangeRate"
  | "fee"
  | "feeCurrency"
  | "balance"
  | "account"
  | "beneficiaryIban"
  | "beneficiaryBic"
  | "mcc"
  | "relatedTransactionId";

export interface RevolutColumn {
  key: RevolutField;
  /** Accepted header spellings (compared case-insensitively, whitespace collapsed). */
  headers: readonly string[];
  /** Alternative: a header pattern; the first capture group is the IANA time zone of a local-time column. */
  pattern?: RegExp;
  /** true = not confirmed by a real Revolut export yet (research 13 §5, F07 Q-03). */
  unsure: boolean;
}

export interface RevolutCsvMapping {
  version: string;
  amountIncludesFee: boolean;
  completedStates: readonly string[];
  reversalTypes: readonly string[];
  cardTypes: readonly string[];
  noCounterpartyTypes: readonly string[];
  columns: readonly RevolutColumn[];
}

/** Mapping data `revolut-csv-2026.1` (BNK-032). Verify against the owner's export, then flip `unsure`. */
export const REVOLUT_CSV_MAPPING: RevolutCsvMapping = {
  version: "revolut-csv-2026.1",
  /** UNSURE (EC-145): `Amount` excludes the fee, the fee reduces the balance in addition. Checked by `Balance`. */
  amountIncludesFee: false,
  /** UNSURE: only these `State` values are booked (research 13 §5 „State“). */
  completedStates: ["COMPLETED"],
  /** UNSURE: Revolut `Type` values that are bank counter-entries (BNK-121). */
  reversalTypes: ["REVERSAL"],
  /** UNSURE: card-like types whose description is the merchant name. */
  cardTypes: ["CARD_PAYMENT", "CARD_REFUND", "ATM", "CARD_CREDIT"],
  /** UNSURE: types whose description names no counterparty (fees, exchanges between own pockets). */
  noCounterpartyTypes: ["FEE", "EXCHANGE", "CHARGE", "INTEREST"],
  columns: [
    { key: "dateStartedUtc", headers: ["Date started (UTC)"], unsure: true },
    { key: "dateCompletedUtc", headers: ["Date completed (UTC)"], unsure: true },
    { key: "dateStartedLocal", headers: [], pattern: /^date started \((?!utc\))(.+)\)$/i, unsure: true },
    { key: "dateCompletedLocal", headers: [], pattern: /^date completed \((?!utc\))(.+)\)$/i, unsure: true },
    { key: "id", headers: ["ID", "Transaction ID"], unsure: true },
    { key: "type", headers: ["Type"], unsure: true },
    { key: "state", headers: ["State", "Status"], unsure: true },
    { key: "description", headers: ["Description"], unsure: true },
    { key: "reference", headers: ["Reference"], unsure: true },
    { key: "payer", headers: ["Payer"], unsure: true },
    { key: "cardNumber", headers: ["Card number"], unsure: true },
    { key: "origCurrency", headers: ["Orig currency", "Original currency"], unsure: true },
    { key: "origAmount", headers: ["Orig amount", "Original amount"], unsure: true },
    { key: "paymentCurrency", headers: ["Payment currency", "Currency"], unsure: true },
    { key: "amount", headers: ["Amount"], unsure: true },
    { key: "totalAmount", headers: ["Total amount"], unsure: true },
    { key: "exchangeRate", headers: ["Exchange rate"], unsure: true },
    { key: "fee", headers: ["Fee"], unsure: true },
    { key: "feeCurrency", headers: ["Fee currency"], unsure: true },
    { key: "balance", headers: ["Balance"], unsure: true },
    { key: "account", headers: ["Account"], unsure: true },
    { key: "beneficiaryIban", headers: ["Beneficiary IBAN"], unsure: true },
    { key: "beneficiaryBic", headers: ["Beneficiary BIC"], unsure: true },
    { key: "mcc", headers: ["MCC"], unsure: true },
    { key: "relatedTransactionId", headers: ["Related transaction id"], unsure: true },
  ],
};

const norm = (h: string) => h.replace(/^﻿/, "").trim().replace(/\s+/g, " ").toLowerCase();

export interface HeaderMap {
  columns: Partial<Record<RevolutField, number>>;
  /** IANA zone of the local-time date columns (if used). */
  localZone?: string;
  unmapped: string[];
}

export function mapRevolutHeaders(headers: readonly string[]): HeaderMap {
  const columns: Partial<Record<RevolutField, number>> = {};
  let localZone: string | undefined;
  const used = new Set<number>();
  for (const spec of REVOLUT_CSV_MAPPING.columns) {
    const wanted = spec.headers.map(norm);
    for (const [i, h] of headers.entries()) {
      if (used.has(i)) continue;
      const n = norm(h);
      const m = spec.pattern?.exec(n);
      if (wanted.includes(n) || m) {
        columns[spec.key] = i;
        used.add(i);
        if (m?.[1]) localZone = (headers[i] ?? "").trim().match(/\(([^)]+)\)\s*$/)?.[1] ?? localZone;
        break;
      }
    }
  }
  return {
    columns,
    ...(localZone ? { localZone } : {}),
    unmapped: headers.filter((_, i) => !used.has(i)).map((h) => h.trim()),
  };
}

interface RawRow {
  line: number;
  get: (k: RevolutField) => string | undefined;
  record: Record<string, string>;
}

const compact = <T extends object>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function parseRevolutCsv(
  text: string,
  options: { currency?: string } = {},
): Result<ParsedStatement, UnreadableFile> {
  const rows = parseCsv(text.replace(/^﻿/, ""), detectSeparator(text));
  const [headers, ...body] = rows;
  if (!headers) return err(unreadable(1, "die Datei ist leer"));
  const map = mapRevolutHeaders(headers);
  const c = map.columns;
  const missing: string[] = [];
  if (
    c.dateCompletedUtc === undefined &&
    c.dateCompletedLocal === undefined &&
    c.dateStartedUtc === undefined &&
    c.dateStartedLocal === undefined
  ) {
    missing.push("Datum (abgeschlossen)");
  }
  if (c.amount === undefined && c.totalAmount === undefined) missing.push("Betrag");
  if (missing.length > 0) return err(unreadable(1, `Pflichtspalten fehlen: ${missing.join(", ")}`));

  const raw: RawRow[] = body.map((cells, i) => ({
    line: i + 2,
    get: (k) => {
      const idx = c[k];
      const v = idx === undefined ? undefined : cells[idx]?.trim();
      return v ? v : undefined;
    },
    record: Object.fromEntries(headers.map((h, j) => [h.trim(), cells[j] ?? ""])),
  }));

  const issues: ParseIssue[] = [];
  const skipped: { line: number; reason: string }[] = [];
  type Draft = {
    row: RawRow;
    instant: { date: string; instant: string };
    amount: number;
    fee: number;
    total?: number;
    currency: string;
  };
  const drafts: Draft[] = [];
  for (const row of raw) {
    const state = row.get("state");
    if (state && !REVOLUT_CSV_MAPPING.completedStates.includes(state.toUpperCase())) {
      skipped.push({ line: row.line, reason: `Status ${state.toUpperCase()} (nicht abgeschlossen)` });
      continue;
    }
    const completed =
      (c.dateCompletedUtc !== undefined ? row.get("dateCompletedUtc") : undefined) ??
      (c.dateCompletedLocal !== undefined ? row.get("dateCompletedLocal") : undefined);
    const zone = c.dateCompletedUtc !== undefined && row.get("dateCompletedUtc") ? "UTC" : (map.localZone ?? "UTC");
    const hasCompletedColumn = c.dateCompletedUtc !== undefined || c.dateCompletedLocal !== undefined;
    if (hasCompletedColumn && !completed) {
      skipped.push({ line: row.line, reason: "ohne Abschlussdatum (nicht abgeschlossen)" });
      continue;
    }
    const when = completed ?? row.get("dateStartedUtc") ?? row.get("dateStartedLocal") ?? "";
    const instant = parseBankDateTime(
      when,
      completed ? zone : c.dateStartedUtc !== undefined ? "UTC" : (map.localZone ?? "UTC"),
    );
    if (!instant) {
      issues.push({ line: row.line, code: "bank_date_invalid", message: `Ungültiges Datum in Bankdaten (${when}).` });
      continue;
    }
    const currency = (row.get("paymentCurrency") ?? options.currency ?? "EUR").toUpperCase();
    const amountLiteral = row.get("amount") ?? row.get("totalAmount") ?? "";
    const amount = parseBankAmount(amountLiteral, currency);
    if (!amount.ok) {
      issues.push({ line: row.line, code: amount.error.code, message: amount.error.message });
      continue;
    }
    const feeLiteral = row.get("fee");
    const feeCurrency = row.get("feeCurrency")?.toUpperCase();
    let fee = 0;
    if (feeLiteral && (!feeCurrency || feeCurrency === currency)) {
      const f = parseBankAmount(feeLiteral, currency);
      if (!f.ok) {
        issues.push({ line: row.line, code: f.error.code, message: f.error.message });
        continue;
      }
      fee = Math.abs(f.value);
    }
    let total: number | undefined;
    const totalLiteral = row.get("totalAmount");
    if (totalLiteral && row.get("amount")) {
      const t = parseBankAmount(totalLiteral, currency);
      if (!t.ok) {
        issues.push({ line: row.line, code: t.error.code, message: t.error.message });
        continue;
      }
      total = t.value;
    }
    drafts.push({ row, instant, amount: amount.value, fee, ...(total !== undefined ? { total } : {}), currency });
  }

  // Revolut's row order is UNSURE (newest first?) → chronological, stable.
  const ordered = drafts
    .map((d, i) => ({ d, i }))
    .sort((a, b) =>
      a.d.instant.instant < b.d.instant.instant ? -1 : a.d.instant.instant > b.d.instant.instant ? 1 : a.i - b.i,
    )
    .map((x) => x.d);

  const movement = (d: Draft, includesFee: boolean) =>
    d.total !== undefined ? d.total : includesFee ? d.amount : d.amount - d.fee;
  const balances = ordered.map((d) => {
    const b = d.row.get("balance");
    if (!b) return undefined;
    const p = parseBankAmount(b, d.currency);
    return p.ok ? p.value : undefined;
  });
  const continuous = (includesFee: boolean) => {
    let prev: number | undefined;
    for (const [i, d] of ordered.entries()) {
      const b = balances[i];
      if (b === undefined) return false;
      if (prev !== undefined && prev + movement(d, includesFee) !== b) return false;
      prev = b;
    }
    return ordered.length > 0;
  };
  const hasTotal = ordered.some((d) => d.total !== undefined);
  const hasFee = ordered.some((d) => d.fee > 0);
  let includesFee: boolean = REVOLUT_CSV_MAPPING.amountIncludesFee;
  let verifiedBy: "balance" | "mapper_constant" = "mapper_constant";
  if (hasTotal) {
    verifiedBy = "balance";
  } else if (hasFee) {
    if (continuous(includesFee) && !continuous(!includesFee)) verifiedBy = "balance";
    else if (!continuous(includesFee) && continuous(!includesFee)) {
      includesFee = !includesFee;
      verifiedBy = "balance";
    }
  }

  const seen = new Map<string, number>();
  const transactions: ParsedTransaction[] = ordered.map((d, i) => {
    const r = d.row;
    const total = movement(d, includesFee);
    const credit = total > 0;
    const type = r.get("type")?.toUpperCase();
    const description = r.get("description");
    const card = (type && REVOLUT_CSV_MAPPING.cardTypes.includes(type)) || !!r.get("cardNumber");
    const iban = r.get("beneficiaryIban");
    const payer = r.get("payer");
    const named = !(type && REVOLUT_CSV_MAPPING.noCounterpartyTypes.includes(type));
    const name = !named
      ? undefined
      : credit
        ? (payer ?? description)
        : card
          ? description
          : description?.replace(/^(To|An|Transfer to|Überweisung an)\s+/i, "");
    let id = r.get("id");
    if (id) {
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id = `${id}#${n}`;
    }
    const origCcy = r.get("origCurrency")?.toUpperCase();
    const origAmt = r.get("origAmount");
    const instructed =
      origCcy && origAmt && origCcy !== d.currency
        ? (() => {
            const p = parseBankAmount(origAmt, origCcy);
            return p.ok ? { amountMinor: Math.abs(p.value), currency: origCcy } : undefined;
          })()
        : undefined;
    const fee = d.total !== undefined ? Math.abs(d.total - d.amount) : d.fee;
    return compact<ParsedTransaction>({
      line: r.line,
      bookingDate: d.instant.date,
      bookedAtRaw: d.instant.instant,
      amountCents: total,
      currency: d.currency,
      counterpartyName: name,
      counterpartyIban: iban ? normaliseIban(iban) : undefined,
      counterpartyBic: r.get("beneficiaryBic"),
      counterpartySource: name ? (credit && payer ? "statement" : "description") : undefined,
      purpose: r.get("reference") ?? description ?? "",
      providerTransactionId: id,
      proprietaryCode: type,
      merchantName: card ? description : undefined,
      mcc: r.get("mcc"),
      feeCents: fee > 0 ? fee : undefined,
      exchangeRate: r.get("exchangeRate"),
      instructedAmount: instructed,
      balanceAfterCents: balances[i],
      reversal: type && REVOLUT_CSV_MAPPING.reversalTypes.includes(type) ? true : undefined,
      raw: JSON.stringify(r.record),
    });
  });

  const currencies = [...new Set(transactions.map((t) => t.currency))];
  const firstBalance = transactions[0]?.balanceAfterCents;
  const last = transactions[transactions.length - 1];
  const withBalances = transactions.length > 0 && transactions.every((t) => t.balanceAfterCents !== undefined);
  const dates = transactions.map((t) => t.bookingDate).sort();
  return ok(
    compact<ParsedStatement>({
      format: "revolut_csv",
      currency: currencies.length === 1 ? currencies[0] : options.currency,
      periodFrom: dates[0],
      periodTo: dates[dates.length - 1],
      periodStartUtc: transactions[0]?.bookedAtRaw,
      periodEndUtc: last?.bookedAtRaw,
      openingBalanceCents:
        withBalances && firstBalance !== undefined ? firstBalance - (transactions[0]?.amountCents ?? 0) : undefined,
      closingBalanceCents: withBalances ? last?.balanceAfterCents : undefined,
      balanceSource: withBalances ? "row_balances" : "none",
      transactions,
      issues,
      skipped,
      feeSemantics: { amountIncludesFee: includesFee, verifiedBy },
    }),
  );
}
