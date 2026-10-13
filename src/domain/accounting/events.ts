/**
 * Business events the posting engine turns into journal entries (F08 ACC-002, posting matrix §4.2 `posting-2026.1`).
 *
 * These are the payloads the invoice, payment, cash and import slices hand to the internal Convex API
 * `postJournalEntry(ctx, event)` (convex/model/journal.ts) **inside their own mutation**, so the business record,
 * its journal entry, the audit entries and the gapless `seq` are written in one transaction (PAY-016, GOBD-03/05).
 *
 * Conventions (02 §5): money in integer cents (signed where stated), rates in basis points, business dates as
 * `YYYY-MM-DD` (Europe/Berlin). Ids are passed as strings (Convex ids stringify losslessly). Shapes follow 03
 * (`SupplyDate`, `TaxCase`, `VatCategory`, payments `differences`) so the slices can pass their rows through.
 */
import type { VatCategory } from "../tax/vat-category";

/** 03 §0.2 `SupplyDate`. */
export type SupplyDate =
  | { kind: "date"; date: string }
  | { kind: "period"; from: string; to: string }
  | { kind: "month"; month: string /* YYYY-MM */ };

/** 03 §0.2 `TaxCase` (document level). */
export type SalesTaxCase =
  | "domestic"
  | "kleinunternehmer"
  | "eu_b2b_service"
  | "intra_community_supply"
  | "export"
  | "not_taxable_domestic"
  | "reverse_charge_13b"
  | "exempt_4"
  | "unknown_imported";

export type TaxationMethod = "soll" | "ist";

/**
 * One VAT group exactly as on the document (UST-10, F08 S2: one revenue + VAT pair per (category, rate, revenue
 * account)). Amounts are signed as on the document (a credit note has negative amounts).
 */
export interface VatGroup {
  category: VatCategory;
  /** 1900 / 700 for category S; 0 for every other category. */
  rateBp: number;
  netCents: number;
  vatCents: number;
  /** Optional revenue account of the group (product/line account, F03); default = the role for the category. */
  revenueAccount?: string;
}

/** VAT of one rate (Skonto / write-off corrections, opening items, Ist bases). */
export interface RateAmount {
  rateBp: number;
  netCents: number;
  vatCents: number;
}

/** A deducted advance in a final invoice (S11, UST-41): received amounts at the advance's own rate. */
export interface AdvanceDeduction {
  advanceDocumentId: string;
  rateBp: number;
  netCents: number;
  vatCents: number;
}

// ── sales documents ─────────────────────────────────────────────────────────────────────────────────────

/** S1–S8, S9 (advance: no entry), S11 (final invoice). Posted in the finalisation transaction. */
export interface InvoiceFinalisedEvent {
  kind: "invoice_finalised";
  documentId: string;
  documentNumber: string;
  /** `advance_invoice` (Abschlagsrechnung) produces no journal entry (S9). */
  documentType: "invoice" | "partial_invoice" | "advance_invoice" | "final_invoice";
  /** Invoice date = journal date (user-chosen within the backdating window → period lock rule ACC-006 a). */
  date: string;
  /** Tax point source (TAX-008, §4.3). */
  supplyDate: SupplyDate;
  taxCase: SalesTaxCase;
  contactId: string;
  counterpartyName?: string;
  vatGroups: VatGroup[];
  /** Final invoice only: advances deducted per rate (received amounts, UST-41). */
  advanceDeductions?: AdvanceDeduction[];
}

/** S12 Stornorechnung: reversal of the original document's entry, dated on the Storno date. */
export interface InvoiceCancelledEvent {
  kind: "invoice_cancelled";
  /** The Storno document (journal source). */
  documentId: string;
  documentNumber: string;
  originalDocumentId: string;
  date: string;
}

/**
 * S13 Rechnungskorrektur: the change in amounts as on the correction document (a partial credit has negative
 * amounts). A pure Rechnungsberichtigung with unchanged amounts (all zero) produces no entry.
 */
export interface InvoiceCorrectedEvent {
  kind: "invoice_corrected";
  documentId: string;
  documentNumber: string;
  correctedDocumentId: string;
  date: string;
  taxCase: SalesTaxCase;
  contactId: string;
  counterpartyName?: string;
  vatGroups: VatGroup[];
  /** Method the corrected invoice was posted with (default: the method valid on `date`). */
  taxedAs?: TaxationMethod;
}

// ── payments (F05, F07 cash) ────────────────────────────────────────────────────────────────────────────

/** Where the money moved. `bank_account` covers bank and clearing rows of `bankAccounts` (role `bank.<id>`). */
export type PaymentMeans = { kind: "bank_account"; bankAccountId: string } | { kind: "cash" } | { kind: "none" };

/**
 * 03 `payments.differences` (+ `fx_difference` for R3/MISC-08). `amountCents`: + = settles more than the cash
 * (underpayment accepted: Skonto, fees, write-off, FX loss); − = cash exceeds the claim (dunning fees, interest,
 * FX gain).
 */
export interface PaymentDifference {
  reason: "skonto" | "bank_fees" | "dunning_fees" | "default_interest" | "write_off" | "other" | "fx_difference";
  amountCents: number;
  /** Required for `skonto` and `write_off` (UST-32, §17 UStG); optional for `other` (price reduction, E-TAX-14). */
  vatCorrection?: RateAmount[];
  /** `other` only: the ledger account chosen by the owner. */
  account?: string;
  text?: string;
}

/**
 * Ist-Versteuerung basis of the target (UVA-06): the VAT that was still **not due** when the target was posted
 * (invoice VAT, final-invoice remainder, Ist opening item), the gross payable and what was settled before this
 * payment (RI-09 net settled). Present only if the target was posted under Ist; then the VAT share of the payment
 * moves from `vat.output.notdue.r` to `vat.output.r` (P1, P2: the last payment absorbs the rounding).
 */
export interface IstVatBasis {
  notDueVat: { rateBp: number; vatCents: number }[];
  payableCents: number;
  settledBeforeCents: number;
}

/** P1/P3 customer payment, P4 Skonto, P5 fees, P6 overpayment (target contactCredit), P7, P8 write-off, R3. */
export interface PaymentReceivedEvent {
  kind: "payment_received";
  paymentId: string;
  /** Payment date (bank: booking date in Europe/Berlin → externally dated; cash/manual: user-chosen). */
  date: string;
  means: PaymentMeans;
  /** EUR moved (> 0; 0 only with means `none` for a write-off without cash). */
  amountCents: number;
  target: { kind: "salesDocument" | "opening_item" | "contactCredit"; id: string; number?: string };
  contactId: string;
  counterpartyName?: string;
  differences?: PaymentDifference[];
  ist?: IstVatBasis;
}

/** S10 payment on an Abschlagsrechnung: VAT due on receipt for Soll and Ist (Mindest-Ist, UST-40). */
export interface AdvancePaymentReceivedEvent {
  kind: "advance_payment_received";
  paymentId: string;
  date: string;
  means: PaymentMeans;
  amountCents: number;
  advance: {
    documentId: string;
    number?: string;
    vatGroups: RateAmount[];
    payableCents: number;
    settledBeforeCents: number;
  };
  contactId: string;
  counterpartyName?: string;
}

/** P10 / R13 payment reversal: mirrors every entry of the original payment (incl. the Ist transfer). */
export interface PaymentReversedEvent {
  kind: "payment_reversed";
  /** The reversal payment row (journal source). */
  paymentId: string;
  originalPaymentId: string;
  date: string;
  reason: string;
}

/** P11 refund of a customer credit balance. */
export interface CustomerRefundEvent {
  kind: "customer_refund";
  paymentId: string;
  date: string;
  means: Exclude<PaymentMeans, { kind: "none" }>;
  amountCents: number;
  contactId: string;
  counterpartyName?: string;
}

/** P9 recovery of a written-off receivable: VAT due again on receipt. */
export interface WriteOffRecoveredEvent {
  kind: "writeoff_recovered";
  paymentId: string;
  date: string;
  means: Exclude<PaymentMeans, { kind: "none" }>;
  /** Net/VAT per rate of the recovered amount (gross = cash received). */
  recovered: RateAmount[];
  documentNumber?: string;
  contactId: string;
  counterpartyName?: string;
}

// ── cash transfers (F07 CSH-024/025, T5/T8/T9) ──────────────────────────────────────────────────────────

export interface CashTransferEvent {
  kind: "cash_transfer";
  cashTransferId: string;
  transferKind: "deposit_to_bank" | "private_withdrawal" | "bank_withdrawal_to_cash";
  /** `deposit_to_bank` only: `cash` leg on the deposit date, `bank` leg when the bank credit is matched (T5). */
  leg?: "cash" | "bank";
  date: string;
  amountCents: number;
  /** Required for the T5 bank leg and T9. */
  bankAccountId?: string;
  /** T9 only: an ATM fee contained in the bank debit → `expense.bank_fees` (R5, CSH-025); `amountCents` is the cash. */
  feeCents?: number;
  /** Corporations (ACC-028, E-ACC-30): private withdrawals go to `shareholder.clearing` with shareholder + note. */
  shareholder?: { name: string; note: string };
}

/** T10 reversal of a cash transfer: mirrors every entry of the original transfer. */
export interface CashTransferReversedEvent {
  kind: "cash_transfer_reversed";
  cashTransferId: string;
  originalCashTransferId: string;
  date: string;
  reason: string;
}

// ── marked bank transactions (F07 BNK-060/061, T1/T2/T4) ───────────────────────────────────────────────

/**
 * A booked bank transaction the owner marked „Privat“ (T1/T2) or „Geldtransit“ (T4 leg), posted on its Europe/Berlin
 * booking date (externally dated, ACC-006 b). `amountCents` is the signed account movement in EUR; a fee contained in
 * it (`feeCents`, BNK-023) is a separate `expense.bank_fees` line (R5, no VAT).
 */
export interface BankTransactionMarkedEvent {
  kind: "bank_transaction_marked";
  transactionId: string;
  mark: "private" | "transfer";
  date: string;
  amountCents: number;
  feeCents?: number;
  bankAccountId: string;
  /** Corporations (ACC-028): private marks go to `shareholder.clearing` with shareholder + note. */
  shareholder?: { name: string; note: string };
}

/** „Markierung aufheben“: mirrors the entries of the mark (Generalumkehr, ACC-004). */
export interface BankTransactionMarkReversedEvent {
  kind: "bank_transaction_mark_reversed";
  transactionId: string;
  date: string;
  reason: string;
}

// ── opening balances (ACC-013, P1 subset) ──────────────────────────────────────────────────────────────

export interface OpeningReceivable {
  /** `openingItems` row the later payments clear. */
  openingItemId: string;
  number: string;
  contactId?: string;
  openCents: number;
  taxedAs: TaxationMethod;
  /** Ist only: VAT contained in the open amount that is not yet due (per rate). */
  notDueVat?: { rateBp: number; vatCents: number }[];
}

export type OpeningBalancePart =
  | { kind: "cash"; amountCents: number }
  | { kind: "bank"; bankAccountId: string; amountCents: number }
  | { kind: "receivables"; items: OpeningReceivable[] };

export interface OpeningBalanceEvent {
  kind: "opening_balance";
  fiscalYear: number;
  /** First day of the fiscal year or the Buchungsbeginn (ACC-014). */
  date: string;
  part: OpeningBalancePart;
}

export type BusinessEvent =
  | InvoiceFinalisedEvent
  | InvoiceCancelledEvent
  | InvoiceCorrectedEvent
  | PaymentReceivedEvent
  | AdvancePaymentReceivedEvent
  | PaymentReversedEvent
  | CustomerRefundEvent
  | WriteOffRecoveredEvent
  | CashTransferEvent
  | CashTransferReversedEvent
  | BankTransactionMarkedEvent
  | BankTransactionMarkReversedEvent
  | OpeningBalanceEvent;

/** Events that mirror earlier entries instead of using the matrix. */
export type ReversalEvent =
  | InvoiceCancelledEvent
  | PaymentReversedEvent
  | CashTransferReversedEvent
  | BankTransactionMarkReversedEvent;

export const isReversalEvent = (e: BusinessEvent): e is ReversalEvent =>
  e.kind === "invoice_cancelled" ||
  e.kind === "payment_reversed" ||
  e.kind === "cash_transfer_reversed" ||
  e.kind === "bank_transaction_mark_reversed";

/** 03 §8 `journalEntries.source.kind`. */
export type JournalSourceKind =
  | "salesDocument"
  | "voucher"
  | "payment"
  | "bankTransaction"
  | "cashTransfer"
  | "asset_depreciation"
  | "manual"
  | "opening_balance"
  | "tax"
  | "fx"
  | "period_close";

export interface JournalSource {
  kind: JournalSourceKind;
  id: string;
}

/** The journal source of an event (ACC-005: every entry links to its voucher). */
export function sourceOf(e: BusinessEvent): JournalSource {
  switch (e.kind) {
    case "invoice_finalised":
    case "invoice_cancelled":
    case "invoice_corrected":
      return { kind: "salesDocument", id: e.documentId };
    case "payment_received":
    case "advance_payment_received":
    case "payment_reversed":
    case "customer_refund":
    case "writeoff_recovered":
      return { kind: "payment", id: e.paymentId };
    case "cash_transfer":
    case "cash_transfer_reversed":
      return { kind: "cashTransfer", id: e.cashTransferId };
    case "bank_transaction_marked":
    case "bank_transaction_mark_reversed":
      return { kind: "bankTransaction", id: e.transactionId };
    case "opening_balance":
      return { kind: "opening_balance", id: openingSourceId(e.fiscalYear, e.part) };
  }
}

/** One opening entry per fiscal year and part (E-ACC-13: entered twice → blocked). */
export function openingSourceId(
  fiscalYear: number,
  part: { kind: OpeningBalancePart["kind"]; bankAccountId?: string },
): string {
  if (part.kind === "bank") return `${fiscalYear}:bank:${part.bankAccountId ?? ""}`;
  return `${fiscalYear}:${part.kind}`;
}

/** For reversal events: the source whose entries are mirrored. */
export function reversedSourceOf(e: ReversalEvent): JournalSource {
  switch (e.kind) {
    case "invoice_cancelled":
      return { kind: "salesDocument", id: e.originalDocumentId };
    case "payment_reversed":
      return { kind: "payment", id: e.originalPaymentId };
    case "cash_transfer_reversed":
      return { kind: "cashTransfer", id: e.originalCashTransferId };
    case "bank_transaction_mark_reversed":
      return { kind: "bankTransaction", id: e.transactionId };
  }
}
