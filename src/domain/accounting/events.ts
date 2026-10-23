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
  /** ACC-019: cost centre of the revenue line when all item lines of the group share one (`groupCostCenter`). */
  costCenterId?: string;
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
  /** `advance_invoice` (Abschlagsrechnung) and the amount-based `partial_invoice` produce no journal entry (S9). */
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

/**
 * Where the money moved. `bank_account` covers bank and clearing rows of `bankAccounts` (role `bank.<id>`);
 * `customer_credit` applies the contact's credit balance (PAY-032, P12: debtor against debtor, user-dated).
 */
export type PaymentMeans =
  | { kind: "bank_account"; bankAccountId: string }
  | { kind: "cash" }
  | { kind: "customer_credit" }
  | { kind: "none" };
/** Means that move money (refunds, recoveries). */
export type MoneyMeans = Exclude<PaymentMeans, { kind: "none" } | { kind: "customer_credit" }>;

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
/** P11 refund to the customer: of a credit balance (PAY-031/033 a) or of a credit correction's open refund (PAY-033 b). */
export interface CustomerRefundEvent {
  kind: "customer_refund";
  paymentId: string;
  date: string;
  means: MoneyMeans;
  amountCents: number;
  contactId: string;
  counterpartyName?: string;
  /** PAY-033 (b): the refunded Rechnungskorrektur (booking text). */
  target?: { kind: "salesDocument"; id: string; number?: string };
  /**
   * Ist (P11-ist): the correction's VAT reduction that S13-ist parked on `vat.output.notdue.*`, as **magnitudes**
   * (credit gross, VAT per rate, part settled before — absorbed by the invoice or refunded earlier). The refund
   * releases its pro-rata share into the refund's period.
   */
  ist?: IstVatBasis;
}

/** P9 recovery of a written-off receivable: VAT due again on receipt. */
export interface WriteOffRecoveredEvent {
  kind: "writeoff_recovered";
  paymentId: string;
  date: string;
  means: MoneyMeans;
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
  mark: "private" | "transfer" | "loan";
  date: string;
  amountCents: number;
  feeCents?: number;
  bankAccountId: string;
  /** Corporations (ACC-028): private marks go to `shareholder.clearing` with shareholder + note. */
  shareholder?: { name: string; note: string };
  /**
   * F07 BNK-062 Darlehen (L1 disbursement / L2 repayment): principal to the loan account, interest to the interest
   * expense account (chart accounts, defaults in `rules/accounting/loan-accounts.ts`).
   */
  loan?: { principalCents: number; interestCents: number; loanAccount: string; interestAccount: string };
  /**
   * F07 BNK-028 / F08 R1–R2: the foreign-currency pocket side of a Geldtransit (`amountCents` in `fx.currency`).
   * `eurCents` = EUR value of the paired EUR side (transit amount); `costCents` = moving-average EUR cost of an
   * outflow (inflow: = eurCents). The difference of an outflow is the realised FX result.
   */
  fx?: {
    currency: string;
    eurCents: number;
    costCents: number;
    rate: { rate: string; source: "bmf_monthly" | "ecb_daily" | "manual" | "transaction"; date: string };
  };
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

// ── purchase vouchers (F06, F08 §4.2.3 V1–V14, §4.2.4 T6/T7, §4.2.6 X1–X7) ─────────────────────────────

/** One voucher line in EUR as booked (VOU-028: EUR amounts per line). */
export interface VoucherPostingLine {
  /** The SKR account chosen on the line. */
  account: string;
  /**
   * Role that replaces the account (set by the model for Einfuhrumsatzsteuer lines on the `vat.import` account,
   * VOU-024). Bewirtung, asset and tax-payment roles are derived by the engine.
   */
  role?: string;
  netCents: number;
  /** VAT shown on the supplier's document (0 for self-assessment rules). */
  vatCents: number;
  vatRateBp: number;
  /** §13b / §1a self-assessed VAT on the EUR base (VOU-022). */
  selfAssessedVatCents?: number;
  /** Bewirtung 30 % or a private share (VOU-027). */
  nonDeductibleShareBp?: number;
  /** ACC-019: cost centre of the line, carried onto the expense/revenue journal line (DATEV KOST1). */
  costCenterId?: string;
  /** VOU-065: GWG/Sammelposten post to the asset roles; `asset` keeps the chosen fixed-asset account. */
  assetDecision?: "gwg" | "pool" | "asset" | "none";
}

/**
 * V1/V4–V10/V13 (expense) and the income voucher row (VOU-010), posted at booking („Buchen“, VOU-007) with the
 * voucher date; a voucher dated in a locked period is posted into the first open period (EC-VOU-09, ACC-006 b).
 */
export interface VoucherBookedEvent {
  kind: "voucher_booked";
  voucherId: string;
  /** Internal number BE-… (journal text). */
  number: string;
  direction: "expense" | "income";
  voucherKind: "standard" | "bewirtung" | "eigenbeleg" | "asset" | "tax_payment" | "private";
  /** The effective tax rule (KU replacement already applied, VOU-026). */
  taxRule: string;
  /** KU on the supply date (KU-01): no input-VAT deduction, self-assessed VAT is an expense. */
  companyIsKu: boolean;
  date: string;
  supplyDate: SupplyDate;
  /** Receipt date of the invoice (Europe/Berlin) — input VAT tax point = max(supply end, receipt) (§4.3). */
  receivedDate: string;
  contactId?: string;
  counterpartyName?: string;
  lines: VoucherPostingLine[];
  bewirtungOccasion?: "geschaeftlich" | "arbeitnehmer";
  taxPaymentSubtype?: "ust_prepayment" | "sondervorauszahlung" | "ust_annual" | "gewerbesteuer" | "est_private" | "kst";
  /**
   * ACC-023 / MISC-08: a foreign-currency voucher is posted in EUR; the open item (payable/receivable) keeps the
   * currency, the gross source amount (minor units) and the rate used, so the settlement can derive the FX result.
   */
  fx?: {
    currency: string;
    grossFxCents: number;
    fxRate: {
      rate: string;
      source: "bmf_monthly" | "ecb_daily" | "manual" | "transaction";
      sourceText?: string;
      date: string;
    };
  };
}

/**
 * Generalumkehr of a voucher's booking: `correction` (VOU-008: mirrored on the original posting date with the
 * original tax points, then re-posted) or `cancel` (VOU-009: dated in the current open period, §17 UStG).
 */
export interface VoucherReversedEvent {
  kind: "voucher_reversed";
  voucherId: string;
  number: string;
  date: string;
  reason: string;
  mode: "correction" | "cancel";
}

/** Where a voucher payment came from (T6 cash, T7 private, V2 bank). */
export type VoucherMeans = { kind: "bank_account"; bankAccountId: string } | { kind: "cash" } | { kind: "private" };

export interface VoucherPaymentDifference {
  /**
   * `skonto` = Skonto received (VOU-132, V3); `bank_fees` (− = we paid more than the voucher); `other`;
   * `fx_difference` = realised exchange difference of a foreign-currency voucher (EC-BNK-76, no VAT).
   */
  reason: "skonto" | "bank_fees" | "other" | "fx_difference";
  /** + = settles more than the money moved (Skonto); − = the money exceeds the voucher (fees). */
  amountCents: number;
  /** Skonto: net/VAT per rate (pro rata by gross, UST-32). */
  vatCorrection?: RateAmount[];
  account?: string;
}

/**
 * V2/T6/T7 voucher payment (payable cleared against bank, cash or the private/shareholder account), V3 Skonto
 * received; income vouchers mirrored (receivable cleared). Amounts are signed like the voucher: a supplier credit note
 * (negative) is settled by a negative payment = money received (VOU-134).
 */
export interface VoucherPaidEvent {
  kind: "voucher_paid";
  paymentId: string;
  date: string;
  direction: "expense" | "income";
  means: VoucherMeans;
  amountCents: number;
  voucher: { id: string; number?: string };
  contactId?: string;
  counterpartyName?: string;
  differences?: VoucherPaymentDifference[];
  /** Skonto VAT correction only when input VAT was deducted (not KU, `input_vat_deductible`). */
  inputVatDeducted: boolean;
  /** Income voucher with output VAT under Ist: the VAT share becomes due with the payment (P1-ist mirrored). */
  ist?: IstVatBasis;
  /** Corporations (ACC-028): „privat bezahlt“ posts against `shareholder.clearing`. */
  corporation?: boolean;
}

export type BusinessEvent =
  | VoucherBookedEvent
  | VoucherReversedEvent
  | VoucherPaidEvent
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
  | OpeningBalanceEvent
  | AssetDepreciationEvent
  | AssetDisposalEvent
  | ManualEntryEvent
  | ManualEntryReversedEvent;

/** Events that mirror earlier entries instead of using the matrix. */
export type ReversalEvent =
  | VoucherReversedEvent
  | InvoiceCancelledEvent
  | PaymentReversedEvent
  | CashTransferReversedEvent
  | BankTransactionMarkReversedEvent
  | ManualEntryReversedEvent;

export const isReversalEvent = (e: BusinessEvent): e is ReversalEvent =>
  e.kind === "manual_entry_reversed" ||
  e.kind === "voucher_reversed" ||
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
    case "voucher_booked":
    case "voucher_reversed":
      return { kind: "voucher", id: e.voucherId };
    case "voucher_paid":
      return { kind: "payment", id: e.paymentId };
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
    case "asset_depreciation":
      return { kind: "asset_depreciation", id: assetDepreciationSourceId(e.assetId, e.period) };
    case "asset_disposal":
      return { kind: "asset_depreciation", id: assetDisposalSourceId(e.assetId) };
    case "manual_entry":
    case "manual_entry_reversed":
      return { kind: "manual", id: e.manualEntryId };
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
    case "voucher_reversed":
      return { kind: "voucher", id: e.voucherId };
    case "invoice_cancelled":
      return { kind: "salesDocument", id: e.originalDocumentId };
    case "payment_reversed":
      return { kind: "payment", id: e.originalPaymentId };
    case "cash_transfer_reversed":
      return { kind: "cashTransfer", id: e.originalCashTransferId };
    case "bank_transaction_mark_reversed":
      return { kind: "bankTransaction", id: e.transactionId };
    case "manual_entry_reversed":
      return { kind: "manual", id: e.manualEntryId };
  }
}

// ── assets (F08 AST-009/AST-010, posting matrix D1–D8) ──────────────────────────────────────────────────

/** D1–D3: one AfA entry per asset and month (pool: last month of the fiscal year); dated on the month end. */
export interface AssetDepreciationEvent {
  kind: "asset_depreciation";
  assetId: string;
  inventoryNumber: string;
  name: string;
  /** `YYYY-MM` of the plan row. */
  period: string;
  /** Last day of `period` (externally dated: a locked month moves to the first open period, E-AST-14). */
  date: string;
  amountCents: number;
  /** The asset's account (credited). */
  assetAccount: string;
  afaRole: "afa.tangible" | "afa.vehicle" | "afa.intangible" | "afa.gwg" | "afa.pool";
}

/** D4–D7: the remaining book value leaves the asset account; a withdrawal also posts the Wertabgabe. */
export interface AssetDisposalEvent {
  kind: "asset_disposal";
  assetId: string;
  inventoryNumber: string;
  name: string;
  date: string;
  disposalKind: "sale" | "scrap" | "withdrawal";
  assetAccount: string;
  rbwCents: number;
  /** Sale: proceeds above the RBW (D4) or not (D5). */
  gain?: boolean;
  /** Withdrawal (D7): Teilwert net and the VAT (only if input VAT was deducted, § 3 Abs. 1b S. 2 UStG). */
  withdrawal?: { teilwertCents: number; vatCents: number };
}

/** The journal source id of an AfA entry: one per (asset, period) — the idempotency key of AST-009. */
export const assetDepreciationSourceId = (assetId: string, period: string): string => `${assetId}:${period}`;
export const assetDisposalSourceId = (assetId: string): string => `${assetId}:disposal`;

// ── manual entries (ACC-011, GOBD-07) ───────────────────────────────────────────────────────────────────

/** One line of a manual entry as built by `buildManualLines` (explicit account or VAT role, one side). */
export interface ManualPostingLine {
  account?: string;
  role?: string;
  debitCents: number;
  creditCents: number;
  taxKey?: string;
  taxPointDate?: string;
  contactId?: string;
  costCenterId?: string;
}

/** M1: a manual entry; the user picks the date, so a locked period refuses it (E-ACC-04). */
export interface ManualEntryEvent {
  kind: "manual_entry";
  manualEntryId: string;
  date: string;
  text: string;
  lines: ManualPostingLine[];
}

/** „Gegenbuchung“ of a manual entry (Generalumkehr, dated by the user in an open period). */
export interface ManualEntryReversedEvent {
  kind: "manual_entry_reversed";
  manualEntryId: string;
  date: string;
  reason: string;
}
