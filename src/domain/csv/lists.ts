/**
 * Column sets of the list CSV exports (F09 EXP-021). Each list exports the rows of its current filter in both variants
 * (see ./export). Vouchers (F06) add their own set when the purchase side ships; the audit log has its own export
 * with hashes (F12 AUD-008).
 */
import type { CsvColumn } from "./export";

export const CSV_LISTS = [
  "documents",
  "contacts",
  "products",
  "open_items",
  "payments",
  "bank_transactions",
  "journal",
] as const;
export type CsvList = (typeof CSV_LISTS)[number];

export const CSV_LIST_FILE: Readonly<Record<CsvList, string>> = {
  documents: "dokumente",
  contacts: "kontakte",
  products: "produkte",
  open_items: "offene-posten",
  payments: "zahlungen",
  bank_transactions: "bankumsaetze",
  journal: "journal",
};

export interface DocumentCsvRow {
  id: string;
  type: string;
  typeLabel: string;
  number: string | null;
  contactName: string | null;
  documentDate: string | null;
  dueDate: string | null;
  netCents: number;
  vatCents: number;
  grossCents: number;
  openCents: number | null;
  currency: string;
  status: string;
}

export const DOCUMENT_COLUMNS: readonly CsvColumn<DocumentCsvRow>[] = [
  { label: "ID", key: "id", kind: "id", value: (r) => r.id },
  { label: "Art", key: "type", kind: "text", value: (r) => r.typeLabel },
  { label: "Nummer", key: "number", kind: "text", value: (r) => r.number },
  { label: "Kunde", key: "contact_name", kind: "text", value: (r) => r.contactName },
  { label: "Datum", key: "document_date", kind: "date", value: (r) => r.documentDate },
  { label: "Fällig", key: "due_date", kind: "date", value: (r) => r.dueDate },
  { label: "Netto", key: "net_cents", kind: "cents", value: (r) => r.netCents },
  { label: "USt", key: "vat_cents", kind: "cents", value: (r) => r.vatCents },
  { label: "Brutto", key: "gross_cents", kind: "cents", value: (r) => r.grossCents },
  { label: "Offen", key: "open_cents", kind: "cents", value: (r) => r.openCents },
  { label: "Währung", key: "currency", kind: "text", value: (r) => r.currency },
  { label: "Status", key: "status", kind: "text", value: (r) => r.status },
];

export interface OpenItemCsvRow {
  id: string;
  number: string;
  contactName: string;
  documentDate: string;
  dueDate?: string | undefined;
  daysOverdue: number;
  payableCents: number;
  paidCents: number;
  openCents: number;
  overdue: boolean;
}

export const OPEN_ITEM_COLUMNS: readonly CsvColumn<OpenItemCsvRow>[] = [
  { label: "ID", key: "id", kind: "id", value: (r) => r.id },
  { label: "Nr.", key: "number", kind: "text", value: (r) => r.number },
  { label: "Kunde", key: "contact_name", kind: "text", value: (r) => r.contactName },
  { label: "Rechnungsdatum", key: "document_date", kind: "date", value: (r) => r.documentDate },
  { label: "Fällig", key: "due_date", kind: "date", value: (r) => r.dueDate },
  { label: "Tage überfällig", key: "days_overdue", kind: "int", value: (r) => r.daysOverdue },
  { label: "Betrag", key: "payable_cents", kind: "cents", value: (r) => r.payableCents },
  { label: "Bezahlt", key: "paid_cents", kind: "cents", value: (r) => r.paidCents },
  { label: "Offen", key: "open_cents", kind: "cents", value: (r) => r.openCents },
  { label: "Status", key: "status", kind: "text", value: (r) => (r.overdue ? "überfällig" : "offen") },
];

export interface PaymentCsvRow {
  id: string;
  date: string;
  number: string | null;
  targetLabel: string;
  contactName: string | null;
  sourceKind: string;
  amountCents: number;
  reversed: boolean;
  note: string | null;
}

export const PAYMENT_COLUMNS: readonly CsvColumn<PaymentCsvRow>[] = [
  { label: "ID", key: "id", kind: "id", value: (r) => r.id },
  { label: "Datum", key: "date", kind: "date", value: (r) => r.date },
  { label: "Zahlungsnr.", key: "number", kind: "text", value: (r) => r.number },
  { label: "Beleg", key: "target", kind: "text", value: (r) => r.targetLabel },
  { label: "Kontakt", key: "contact_name", kind: "text", value: (r) => r.contactName },
  { label: "Quelle", key: "source_kind", kind: "text", value: (r) => r.sourceKind },
  { label: "Betrag", key: "amount_cents", kind: "cents", value: (r) => r.amountCents },
  { label: "Storniert", key: "reversed", kind: "bool", value: (r) => r.reversed },
  { label: "Notiz", key: "note", kind: "text", value: (r) => r.note },
];

export interface BankTransactionCsvRow {
  id: string;
  accountName: string;
  bookingDate: string;
  valueDate: string | null;
  amountCents: number;
  currency: string;
  counterpartyName: string | null;
  counterpartyIban: string | null;
  purpose: string;
  status: string;
}

export const BANK_TRANSACTION_COLUMNS: readonly CsvColumn<BankTransactionCsvRow>[] = [
  { label: "ID", key: "id", kind: "id", value: (r) => r.id },
  { label: "Konto", key: "account", kind: "text", value: (r) => r.accountName },
  { label: "Buchungstag", key: "booking_date", kind: "date", value: (r) => r.bookingDate },
  { label: "Valuta", key: "value_date", kind: "date", value: (r) => r.valueDate },
  { label: "Betrag", key: "amount_cents", kind: "cents", value: (r) => r.amountCents },
  { label: "Währung", key: "currency", kind: "text", value: (r) => r.currency },
  { label: "Gegenpartei", key: "counterparty_name", kind: "text", value: (r) => r.counterpartyName },
  { label: "IBAN", key: "counterparty_iban", kind: "text", value: (r) => r.counterpartyIban },
  { label: "Verwendungszweck", key: "purpose", kind: "text", value: (r) => r.purpose },
  { label: "Status", key: "status", kind: "text", value: (r) => r.status },
];

export interface JournalCsvRow {
  entryId: string;
  seq: number;
  date: string;
  text: string;
  lineIndex: number;
  account: string;
  debitCents: number;
  creditCents: number;
  sourceKind: string;
  reversal: boolean;
}

export const JOURNAL_COLUMNS: readonly CsvColumn<JournalCsvRow>[] = [
  { label: "ID", key: "entry_id", kind: "id", value: (r) => r.entryId },
  { label: "Nr.", key: "seq", kind: "int", value: (r) => r.seq },
  { label: "Datum", key: "date", kind: "date", value: (r) => r.date },
  { label: "Buchungstext", key: "text", kind: "text", value: (r) => r.text },
  { label: "Zeile", key: "line", kind: "int", value: (r) => r.lineIndex + 1 },
  { label: "Konto", key: "account", kind: "text", value: (r) => r.account },
  { label: "Soll", key: "debit_cents", kind: "cents", value: (r) => r.debitCents },
  { label: "Haben", key: "credit_cents", kind: "cents", value: (r) => r.creditCents },
  { label: "Quelle", key: "source_kind", kind: "text", value: (r) => r.sourceKind },
  { label: "Storno", key: "reversal", kind: "bool", value: (r) => r.reversal },
];
