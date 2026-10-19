/**
 * Enable Banking feed rows → the normalised model (F07 BNK-100, BNK-120, BNK-111, BNK-109, BNK-021, BNK-112, BNK-114).
 * Wire shapes follow the Enable Banking OpenAPI (research 13 §3.1: `Transaction`, `AccountResource`).
 *
 *  - Only `BOOK` rows enter `bankTransactions`; `PDNG` rows are provisional (`bankPendingTransactions`, BNK-111);
 *    every other state (CNCL, RJCT, HOLD, SCHD, INFO, OTHR) is skipped.
 *  - `entry_reference` is the bank ID (dedupe key `:er:`); `transaction_id` "may change" and is **never** used as an
 *    identifier — it stays in the raw payload only (BNK-109, EC-157).
 *  - Money from the decimal string (`transaction_amount.amount`) into minor units per ISO 4217; more decimals than the
 *    currency exponent → the row is rejected with a finding (EC-BNK-23).
 *  - `booking_date` is a date and taken as delivered (BNK-112); a pending row may only carry `transaction_date`.
 *  - Counterparty: the debtor for credits, the creditor for debits (BNK-120); missing fields stay missing (BNK-114).
 */

import { parseBankAmount } from "../amount";
import { normaliseIban } from "../normalise";
import type { ParsedTransaction, ParseIssue } from "../types";

export interface EbAmount {
  currency: string;
  amount: string;
}

export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  status: string;
  credit_debit_indicator: "CRDT" | "DBIT" | string;
  transaction_amount: EbAmount;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  creditor?: { name?: string | null } | null;
  creditor_account?: { iban?: string | null } | null;
  creditor_agent?: { bic_fi?: string | null } | null;
  debtor?: { name?: string | null } | null;
  debtor_account?: { iban?: string | null } | null;
  debtor_agent?: { bic_fi?: string | null } | null;
  bank_transaction_code?: { code?: string | null; sub_code?: string | null; description?: string | null } | null;
  merchant_category_code?: string | null;
  remittance_information?: string[] | null;
  reference_number?: string | null;
  balance_after_transaction?: { balance_amount?: EbAmount | null } | null;
  exchange_rate?: {
    exchange_rate?: string | null;
    unit_currency?: string | null;
    instructed_amount?: EbAmount | null;
  } | null;
  note?: string | null;
  [key: string]: unknown;
}

/** One account of a session (`POST /sessions` → `accounts[]`). */
export interface EbAccount {
  uid: string;
  identification_hash?: string | null;
  identification_hashes?: string[] | null;
  account_id?: {
    iban?: string | null;
    other?: { identification?: string | null; scheme_name?: string | null } | null;
  } | null;
  all_account_ids?: { identification?: string | null; scheme_name?: string | null }[] | null;
  name?: string | null;
  details?: string | null;
  currency?: string | null;
  cash_account_type?: string | null;
  product?: string | null;
  /** UNSURE (research 13): whether Enable Banking reports a closed account explicitly; read when delivered (SET-050c). */
  status?: string | null;
  [key: string]: unknown;
}

/** A provisional feed row (03 §7 `bankPendingTransactions`, BNK-111) before hashing. */
export interface PendingRow {
  entryReference?: string;
  bookingDate?: string;
  amountCents: number;
  currency: string;
  counterpartyName?: string;
  purpose: string;
  raw: string;
}

export interface FeedMapResult {
  booked: ParsedTransaction[];
  pending: PendingRow[];
  issues: ParseIssue[];
  skipped: { line: number; reason: string }[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const str = (v: string | null | undefined): string | undefined => {
  const t = v?.trim();
  return t ? t : undefined;
};
const date = (v: string | null | undefined): string | undefined => {
  const t = str(v)?.slice(0, 10);
  return t && DATE.test(t) ? t : undefined;
};

export function mapEnableBankingTransactions(rows: readonly EbTransaction[], accountCurrency: string): FeedMapResult {
  const out: FeedMapResult = { booked: [], pending: [], issues: [], skipped: [] };
  for (const [i, t] of rows.entries()) {
    const line = i + 1;
    const raw = JSON.stringify(t);
    if (t.status !== "BOOK" && t.status !== "PDNG") {
      out.skipped.push({ line, reason: `Status ${t.status}` });
      continue;
    }
    const currency = (str(t.transaction_amount?.currency) ?? accountCurrency).toUpperCase();
    const amount = parseBankAmount(t.transaction_amount?.amount ?? "", currency);
    if (!amount.ok) {
      out.issues.push({ line, code: amount.error.code, message: amount.error.message });
      continue;
    }
    const sign = t.credit_debit_indicator === "DBIT" ? -1 : 1;
    const amountCents = sign * Math.abs(amount.value);
    const credit = sign > 0;
    const party = credit ? t.debtor : t.creditor;
    const partyAccount = credit ? t.debtor_account : t.creditor_account;
    const partyAgent = credit ? t.debtor_agent : t.creditor_agent;
    const counterpartyName = str(party?.name);
    const purpose = (t.remittance_information ?? [])
      .map((s) => s.trim())
      .filter(Boolean)
      .join(" ");
    const entryReference = str(t.entry_reference);
    if (t.status === "PDNG") {
      const bookingDate = date(t.booking_date) ?? date(t.transaction_date) ?? date(t.value_date);
      out.pending.push({
        ...(entryReference ? { entryReference } : {}),
        ...(bookingDate ? { bookingDate } : {}),
        amountCents,
        currency,
        ...(counterpartyName ? { counterpartyName } : {}),
        purpose,
        raw,
      });
      continue;
    }
    const bookingDate = date(t.booking_date) ?? date(t.value_date);
    if (!bookingDate) {
      out.issues.push({
        line,
        code: "bank_date_missing",
        message: "Gebuchter Umsatz ohne Buchungsdatum – bitte per Kontoauszug importieren.",
      });
      continue;
    }
    const iban = str(partyAccount?.iban);
    const code = [str(t.bank_transaction_code?.code), str(t.bank_transaction_code?.sub_code)].filter(Boolean).join("-");
    const mcc = str(t.merchant_category_code);
    const instructed = t.exchange_rate?.instructed_amount;
    const instructedMinor =
      instructed && str(instructed.currency) && str(instructed.amount)
        ? parseBankAmount(instructed.amount, instructed.currency)
        : null;
    const balance = t.balance_after_transaction?.balance_amount;
    const balanceMinor = balance && str(balance.amount) ? parseBankAmount(balance.amount, currency) : null;
    const tx: ParsedTransaction = {
      line,
      bookingDate,
      ...(date(t.value_date) ? { valueDate: date(t.value_date) as string } : {}),
      amountCents,
      currency,
      ...(counterpartyName ? { counterpartyName, counterpartySource: "provider" as const } : {}),
      ...(iban ? { counterpartyIban: normaliseIban(iban) } : {}),
      ...(str(partyAgent?.bic_fi) ? { counterpartyBic: str(partyAgent?.bic_fi) as string } : {}),
      purpose,
      ...(str(t.reference_number) ? { reference: str(t.reference_number) as string } : {}),
      ...(entryReference ? { entryReference } : {}),
      ...(code ? { bankTransactionCode: code } : {}),
      ...(str(t.bank_transaction_code?.description)
        ? { proprietaryCode: str(t.bank_transaction_code?.description) as string }
        : {}),
      ...(mcc ? { mcc } : {}),
      ...(mcc && !credit && counterpartyName ? { merchantName: counterpartyName } : {}),
      ...(str(t.exchange_rate?.exchange_rate) ? { exchangeRate: str(t.exchange_rate?.exchange_rate) as string } : {}),
      ...(instructedMinor?.ok && instructed
        ? {
            instructedAmount: {
              amountMinor: Math.abs(instructedMinor.value),
              currency: instructed.currency.toUpperCase(),
            },
          }
        : {}),
      ...(balanceMinor?.ok ? { balanceAfterCents: balanceMinor.value } : {}),
      raw,
    };
    out.booked.push(tx);
  }
  return out;
}

/** The IBAN of a session account (`account_id.iban`, else an IBAN among `all_account_ids`). */
export function accountIban(a: EbAccount): string | undefined {
  const direct = str(a.account_id?.iban);
  if (direct) return normaliseIban(direct);
  const other = (a.all_account_ids ?? []).find((x) => x.scheme_name === "IBAN" && str(x.identification));
  return other?.identification ? normaliseIban(other.identification) : undefined;
}

/** Local account details of a pocket without IBAN (SET-050a: account number / sort code / routing number). */
export function accountLocalDetails(a: EbAccount): { scheme: string; identification: string }[] {
  const ids = [
    ...(a.account_id?.other ? [a.account_id.other] : []),
    ...(a.all_account_ids ?? []).filter((x) => x.scheme_name !== "IBAN"),
  ];
  const seen = new Set<string>();
  const out: { scheme: string; identification: string }[] = [];
  for (const x of ids) {
    const identification = str(x.identification);
    if (!identification) continue;
    const scheme = str(x.scheme_name) ?? "OTHER";
    const k = `${scheme}:${identification}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ scheme, identification });
  }
  return out;
}

const CLOSED_STATES = new Set(["closed", "deleted", "inactive", "blocked"]);
/** SET-050c: the provider reports the account as closed (only when delivered explicitly; never inferred). */
export const accountClosed = (a: EbAccount): boolean => CLOSED_STATES.has(String(a.status ?? "").toLowerCase());
