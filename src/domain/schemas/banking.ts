/**
 * Form schemas of the F07 P1 banking slice (shared by the UI, Convex and later REST/MCP — CLAUDE.md rule 5):
 * statement accounts (one per currency pocket, BNK-020), marking (BNK-060/061/063, CSH-025) and cash transfers
 * (CSH-024).
 */
import { electronicFormatIBAN, isValidBIC, isValidIBAN } from "ibantools";
import { z } from "zod";
import { parseCents } from "../money/parse";
import { isCalendarDate } from "../time/calendar-date";

const trimmed = () => z.string().trim();

/**
 * A statement account: Revolut Business pockets share one IBAN across currencies (research 13 §2), so the IBAN is
 * unique per currency, not globally. Non-EUR pockets may have no IBAN of their own.
 */
export const statementAccountSchema = z.object({
  name: trimmed().min(1, "Bitte einen Namen angeben.").max(60, "Höchstens 60 Zeichen."),
  currency: trimmed()
    .transform((v) => v.toUpperCase())
    .refine((v) => /^[A-Z]{3}$/.test(v), "Bitte einen ISO-Währungscode angeben (z. B. EUR, USD)."),
  iban: trimmed()
    .transform((v) => (v ? (electronicFormatIBAN(v) ?? v) : ""))
    .refine((v) => v === "" || isValidIBAN(v), "Die IBAN ist ungültig."),
  bic: trimmed()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .refine((v) => v === "" || isValidBIC(v), "Die BIC ist ungültig."),
  accountHolder: trimmed()
    .min(1, "Kontoinhaber fehlt oder ist länger als 70 Zeichen.")
    .max(70, "Kontoinhaber fehlt oder ist länger als 70 Zeichen."),
  showOnInvoices: z.boolean(),
});
export type StatementAccountFormValues = z.input<typeof statementAccountSchema>;
export type StatementAccountValues = z.output<typeof statementAccountSchema>;

export const emptyStatementAccountForm = (): StatementAccountFormValues => ({
  name: "",
  currency: "EUR",
  iban: "",
  bic: "",
  accountHolder: "",
  showOnInvoices: false,
});

export const MARK_KINDS = ["private", "transfer", "cash_withdrawal", "ignored"] as const;
export const IGNORE_REASON_VALUES = ["duplicate_of_file_import", "neutralised_pair", "test_or_zero"] as const;

export const IGNORE_REASON_LABEL_DE: Readonly<Record<(typeof IGNORE_REASON_VALUES)[number], string>> = {
  duplicate_of_file_import: "Dublette aus Dateiimport",
  neutralised_pair: "Hin- und Rückbuchung (neutralisiert)",
  test_or_zero: "Testbuchung / Nullbetrag",
};

export const shareholderSchema = z.object({
  name: trimmed().min(1, "Bitte den Gesellschafter angeben.").max(120),
  note: trimmed().min(3, "Bitte einen Vermerk angeben.").max(300),
});

/** „Bargeld eingezahlt / entnommen“ (CSH-024); amounts as German decimal strings in the form. */
export const cashTransferFormSchema = z
  .object({
    kind: z.enum(["deposit_to_bank", "private_withdrawal"]),
    date: trimmed().refine(isCalendarDate, "Bitte ein gültiges Datum angeben."),
    amount: trimmed(),
    bankAccountId: trimmed(),
    note: trimmed().max(300, "Höchstens 300 Zeichen."),
    backdateReason: trimmed().max(300, "Höchstens 300 Zeichen."),
    shareholderName: trimmed().max(120),
    shareholderNote: trimmed().max(300),
  })
  .superRefine((v, ctx) => {
    const amount = parseCents(v.amount);
    if (!amount.ok) ctx.addIssue({ code: "custom", path: ["amount"], message: amount.error.message });
    else if (amount.value <= 0)
      ctx.addIssue({ code: "custom", path: ["amount"], message: "Der Betrag muss größer als 0 sein." });
    if (v.kind === "deposit_to_bank" && !v.bankAccountId) {
      ctx.addIssue({ code: "custom", path: ["bankAccountId"], message: "Bitte das Bankkonto angeben." });
    }
  })
  .transform((v) => ({
    kind: v.kind,
    date: v.date,
    amountCents: (parseCents(v.amount) as { ok: true; value: number }).value,
    ...(v.kind === "deposit_to_bank" ? { bankAccountId: v.bankAccountId } : {}),
    ...(v.note ? { note: v.note } : {}),
    ...(v.backdateReason ? { backdateReason: v.backdateReason } : {}),
    ...(v.shareholderName ? { shareholder: { name: v.shareholderName, note: v.shareholderNote } } : {}),
  }));
export type CashTransferFormValues = z.input<typeof cashTransferFormSchema>;

export const emptyCashTransferForm = (today: string): CashTransferFormValues => ({
  kind: "deposit_to_bank",
  date: today,
  amount: "",
  bankAccountId: "",
  note: "",
  backdateReason: "",
  shareholderName: "",
  shareholderNote: "",
});

/** Transaction list filters (04 §4.6 Bank › Umsätze). */
export const TRANSACTION_STATUS_FILTERS = ["all", "open", "matched", "private", "transfer", "ignored"] as const;
export type TransactionStatusFilter = (typeof TRANSACTION_STATUS_FILTERS)[number];
export const TRANSACTION_STATUS_LABEL_DE: Readonly<Record<string, string>> = {
  all: "Alle",
  open: "Offen",
  matched: "Zugeordnet",
  partially_matched: "Teilweise zugeordnet",
  booked: "Gebucht",
  private: "Privat",
  transfer: "Geldtransit",
  ignored: "Ignoriert",
};
