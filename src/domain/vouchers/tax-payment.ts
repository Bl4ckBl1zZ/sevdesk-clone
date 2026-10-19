/**
 * Tax payments as vouchers (F08 TAX-018, posting §4.2.6 X1–X7): kind `tax_payment` with a subtype — USt-Voraus-
 * zahlung (period), Sondervorauszahlung, USt Jahreszahlung, Gewerbesteuer, ESt/KiSt/Soli (private) and KSt. The
 * subtype decides the account role; the payment (bank) clears the payable like every voucher. A subtype is suggested
 * from the Finanzamt reference in the bank purpose (never applied without confirmation). Pure.
 */
import { type Issue, issue } from "../result";
import type { TaxPaymentSubtype } from "./types";

/** Debit role of the booking (expense direction); refunds (income direction) credit the same role (X2/X4). */
export const TAX_PAYMENT_ROLE: Readonly<Record<TaxPaymentSubtype, string>> = {
  ust_prepayment: "vat.prepayment",
  sondervorauszahlung: "vat.special_prepayment",
  ust_annual: "vat.prior_year",
  gewerbesteuer: "expense.trade_tax",
  est_private: "private.taxes",
  kst: "expense.corp_tax",
};

/** Posting matrix row per subtype (F08 §4.2.6). */
export const TAX_PAYMENT_ROW: Readonly<Record<TaxPaymentSubtype, string>> = {
  ust_prepayment: "X1",
  sondervorauszahlung: "X3",
  ust_annual: "X4",
  gewerbesteuer: "X5",
  est_private: "X6",
  kst: "X7",
};

export const TAX_PAYMENT_LABEL_DE: Readonly<Record<TaxPaymentSubtype, string>> = {
  ust_prepayment: "USt-Vorauszahlung",
  sondervorauszahlung: "Sondervorauszahlung (1/11)",
  ust_annual: "USt-Jahreszahlung / -erstattung",
  gewerbesteuer: "Gewerbesteuer",
  est_private: "Einkommensteuer, Kirchensteuer, Soli (privat)",
  kst: "Körperschaftsteuer",
};

/** Subtypes that refer to a filing period (`taxPayment.period`). */
export const PERIOD_SUBTYPES: readonly TaxPaymentSubtype[] = ["ust_prepayment", "sondervorauszahlung", "ust_annual"];

export type TaxPaymentIssue = Issue<"tax_payment_subtype" | "tax_payment_period">;

/** ESt is private (sole proprietors and partnerships only); KSt exists only for corporations. */
export function checkTaxPayment(input: {
  subtype: TaxPaymentSubtype;
  period?: string;
  corporation: boolean;
}): TaxPaymentIssue | null {
  if (input.subtype === "est_private" && input.corporation) {
    return issue(
      "tax_payment_subtype",
      "Kapitalgesellschaften zahlen keine Einkommensteuer. Bitte Körperschaftsteuer oder Gewerbesteuer wählen.",
    );
  }
  if (input.subtype === "kst" && !input.corporation) {
    return issue("tax_payment_subtype", "Körperschaftsteuer fällt nur bei Kapitalgesellschaften an.");
  }
  if (input.period !== undefined && !/^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]))?$/.test(input.period)) {
    return issue("tax_payment_period", "Bitte den Zeitraum als JJJJ, JJJJ-MM oder JJJJ-Qn angeben.");
  }
  return null;
}

/** Subtype and period from a Finanzamt reference („USt 09/26“, „GewSt 2026 III“, „ESt-Vz IV/26“, „1/11 2026“). */
export function suggestTaxPayment(purpose: string): { subtype: TaxPaymentSubtype; period?: string } | null {
  const p = purpose.toUpperCase();
  const year =
    /\b(20\d{2})\b/.exec(p)?.[1] ?? (/\/(\d{2})\b/.exec(p)?.[1] ? `20${/\/(\d{2})\b/.exec(p)?.[1]}` : undefined);
  if (/SONDERVORAUSZ|1\/11/.test(p)) return { subtype: "sondervorauszahlung", ...(year ? { period: year } : {}) };
  if (/\bKST\b|KÖRPERSCHAFT|KOERPERSCHAFT/.test(p)) return { subtype: "kst" };
  if (/GEWST|GEWERBESTEUER/.test(p)) return { subtype: "gewerbesteuer" };
  if (/\bEST\b|EINKOMMENSTEUER|KIST|SOLI/.test(p)) return { subtype: "est_private" };
  const ust = /\bUST\b[^0-9]*(\d{1,2})\s*[/.]\s*(\d{2,4})/.exec(p);
  if (ust?.[1] && ust[2]) {
    const y = ust[2].length === 2 ? `20${ust[2]}` : ust[2];
    return { subtype: "ust_prepayment", period: `${y}-${ust[1].padStart(2, "0")}` };
  }
  if (/\bUST\b|UMSATZSTEUER/.test(p)) return { subtype: "ust_prepayment" };
  return null;
}
