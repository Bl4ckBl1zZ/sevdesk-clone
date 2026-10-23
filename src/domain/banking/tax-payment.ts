/**
 * F07 BNK-064 tax payments: a transfer to or from the tax authority (Finanzamt/Finanzkasse, Revolut type `TAX`) becomes
 * a voucher of kind `tax_payment` (F08 TAX-018, X1–X7). Subtype and period are suggested from the Finanzamt reference
 * in the purpose; the owner confirms or selects them on the voucher before finalising (never applied silently). Pure.
 */
import { suggestTaxPayment, TAX_PAYMENT_LABEL_DE } from "../vouchers/tax-payment";
import type { TaxPaymentSubtype } from "../vouchers/types";

/** Payee/payer names of German tax authorities (the purpose alone is not enough: „USt“ appears on supplier rows). */
const AUTHORITY = /\b(finanzamt|finanzkasse|steuerkasse|bundeszentralamt f(ue|ü)r steuern)\b/i;

export interface TaxPaymentHint {
  subtype?: TaxPaymentSubtype;
  period?: string;
  hint: string;
}

export function taxPaymentFromTransaction(tx: {
  amountCents: number;
  purpose: string;
  reference?: string;
  counterpartyName?: string;
  proprietaryCode?: string;
}): TaxPaymentHint | null {
  const byType = tx.proprietaryCode?.toUpperCase() === "TAX";
  if (!byType && !AUTHORITY.test(tx.counterpartyName ?? "")) return null;
  const s = suggestTaxPayment(`${tx.reference ?? ""} ${tx.purpose}`);
  if (!s) return { hint: "Steuerzahlung – Art und Zeitraum bitte auswählen" };
  return {
    subtype: s.subtype,
    ...(s.period ? { period: s.period } : {}),
    hint: `Steuerzahlung: ${TAX_PAYMENT_LABEL_DE[s.subtype]}${s.period ? ` ${s.period}` : ""}`,
  };
}
