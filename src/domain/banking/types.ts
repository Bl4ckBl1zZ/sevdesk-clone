/**
 * The normalised bank statement model (F07 BNK-100 `BankTransactionInput`, BNK-120). Every source — CAMT.053,
 * MT940, Revolut CSV (P1) and the Enable Banking feed (P2) — is mapped into these shapes by its parser in
 * `src/domain/banking/sources/*`; dedupe, continuity, reconciliation and the Convex import pipeline only ever see
 * this model (CLAUDE.md rule 5).
 *
 * Conventions: money in integer minor units of `currency` (BNK-021), signed (+ credit / − debit) and **including**
 * a fee that the source reports as a field (`feeCents` is the part of `amountCents` that is a fee, BNK-023);
 * `bookingDate` is the Europe/Berlin calendar date (BNK-112); instants are ISO strings in UTC.
 */
export type StatementFormat = "camt053" | "mt940" | "revolut_csv";
export type BankSourceKind = "enable_banking" | StatementFormat | "csv";

export const STATEMENT_FORMAT_LABEL: Readonly<Record<StatementFormat, string>> = {
  camt053: "CAMT.053",
  mt940: "MT940",
  revolut_csv: "Revolut CSV",
};

export interface ParsedTransaction {
  /** 1-based position in the file (CAMT entry, MT940 :61: line, CSV line) — the „Zeile“ of messages and revisions. */
  line: number;
  bookingDate: string;
  /** UTC instant as delivered (Revolut CSV „Date completed (UTC)“, CAMT `DtTm`) — statement reconciliation (EC-155). */
  bookedAtRaw?: string;
  valueDate?: string;
  amountCents: number;
  currency: string;
  counterpartyName?: string;
  counterpartyIban?: string;
  counterpartyBic?: string;
  /** Where the counterparty came from (BNK-120). */
  counterpartySource?: "provider" | "description" | "statement";
  /** Unstructured remittance (lines joined) or the CSV reference/description. */
  purpose: string;
  /** Structured creditor reference (e.g. RF…). */
  reference?: string;
  endToEndId?: string;
  mandateRef?: string;
  creditorId?: string;
  bankRef?: string;
  /** Statement entry reference (CAMT `AcctSvcrRef`, MT940 bank reference): dedupe key (BNK-109/034). */
  entryReference?: string;
  /** Revolut CSV `ID` (BNK-032): dedupe within CSV sources and cross-source matching (BNK-110). */
  providerTransactionId?: string;
  bankTransactionCode?: string;
  proprietaryCode?: string;
  merchantName?: string;
  mcc?: string;
  /** Fee part of `amountCents` (positive number), booked as a separate line (BNK-023). */
  feeCents?: number;
  exchangeRate?: string;
  instructedAmount?: { amountMinor: number; currency: string };
  balanceAfterCents?: number;
  /** CAMT `RvslInd = true`, MT940 `RC`/`RD`: a bank counter-entry (BNK-121). */
  reversal?: boolean;
  /** Raw entry as JSON (CAMT entry object, CSV row by header, MT940 :61:/:86: text) → `bankTransactionRevisions`. */
  raw: string;
}

/** A rejected row (EC-BNK-23 invalid amount, unparseable date): the import continues without it. */
export interface ParseIssue {
  line: number;
  code: string;
  message: string;
}

export interface ParsedStatement {
  format: StatementFormat;
  /** CAMT `Stmt/Id`, MT940 `:20:`/`:28C:`. */
  statementId?: string;
  iban?: string;
  /** Account currency of the file (CAMT `Acct/Ccy`, MT940 opening balance, CSV currency column). */
  currency?: string;
  /** Statement period as calendar dates (CAMT `FrToDt` date parts — statements are UTC by default, EC-155). */
  periodFrom?: string;
  periodTo?: string;
  periodStartUtc?: string;
  periodEndUtc?: string;
  openingBalanceCents?: number;
  closingBalanceCents?: number;
  /** How the balances are known: delivered by the file, derived from per-row balances (CSV), or not at all. */
  balanceSource: "statement" | "row_balances" | "none";
  transactions: ParsedTransaction[];
  issues: ParseIssue[];
  /** Rows the parser skipped on purpose (CAMT `Sts ≠ BOOK`, CSV `State ≠ COMPLETED`). */
  skipped: { line: number; reason: string }[];
  /** Fee semantics used for this file (BNK-023, EC-145): fixed per format, verified by balances when possible. */
  feeSemantics?: { amountIncludesFee: boolean; verifiedBy: "balance" | "mapper_constant" };
}

/** `Result` error of a parser for a file that cannot be read at all (EC-BNK-49). */
export interface UnreadableFile {
  code: "statement_unreadable";
  message: string;
  params: { line: number; error: string };
}

export function unreadable(line: number, error: string): UnreadableFile {
  return {
    code: "statement_unreadable",
    message: `Die Datei konnte nicht gelesen werden (Zeile ${line}: ${error}).`,
    params: { line, error },
  };
}
