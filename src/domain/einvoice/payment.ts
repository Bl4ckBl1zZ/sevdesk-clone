/**
 * Payment instructions in the XML: BG-16 payment means (F04 App. A.5, BR-DE-1/19/23) and BT-20 payment terms incl.
 * the XRechnung Skonto line (App. A.4, BR-DE-18). Amount signs are those of the snapshot model (a refund owed is a
 * negative payable), independent of the credit-note sign flip of 381 documents.
 */
import { electronicFormatIBAN, isSEPACountry } from "ibantools";
import { formatDate, formatNumber } from "../documents/i18n";
import type { DocumentSnapshot } from "../documents/snapshot";
import { formatDecimal } from "../money/format";
import type { XmlPaymentMeans } from "./model";

const ibanCountry = (iban: string) => (electronicFormatIBAN(iban) ?? iban).slice(0, 2);

/** F04 App. A.5. */
export function paymentMeansFor(s: DocumentSnapshot): XmlPaymentMeans {
  const payable = s.totals.payableCents;
  const remittance = s.payment.paymentReference;
  if (s.type === "cancellation" || payable === 0) {
    return { code: "97", text: s.language === "en" ? "Clearing between partners" : "Verrechnung", remittance };
  }
  if (payable < 0) {
    return s.payment.refundIban
      ? {
          code: "58",
          text: "SEPA",
          remittance,
          account: { iban: electronicFormatIBAN(s.payment.refundIban) ?? s.payment.refundIban },
        }
      : { code: "97", text: s.language === "en" ? "Clearing between partners" : "Verrechnung", remittance };
  }
  switch (s.payment.method) {
    case "transfer": {
      const acc = s.payment.bankAccount;
      if (!acc) return { code: "30", remittance };
      const iban = electronicFormatIBAN(acc.iban) ?? acc.iban;
      const sepa = s.currency === "EUR" && isSEPACountry(ibanCountry(iban));
      return {
        code: sepa ? "58" : "30",
        text: sepa ? "SEPA-Überweisung" : s.language === "en" ? "Credit transfer" : "Überweisung",
        remittance,
        account: { iban, name: acc.accountHolder, ...(acc.bic ? { bic: acc.bic } : {}) },
      };
    }
    case "cash":
      return { code: "10", text: s.language === "en" ? "Cash" : "Bar", remittance };
    case "card":
      return { code: "48", text: s.language === "en" ? "Card payment" : "Kartenzahlung", remittance };
    case "paypal":
      return { code: "68", text: "PayPal", remittance };
    default:
      return { code: "ZZZ", text: s.payment.methodText ?? (s.language === "en" ? "Other" : "Sonstige"), remittance };
  }
}

/**
 * BT-20 (App. A.4): the terms sentence plus one `#SKONTO#…#` line (percent with 2 decimals and a dot, BASISBETRAG =
 * payable). Positive credit-note amounts (381) need BT-20 or BT-9 (BR-CO-25), so Storno/credit get a sentence too.
 */
export function paymentTermsText(s: DocumentSnapshot): string | undefined {
  const en = s.language === "en";
  const payable = s.totals.payableCents;
  const original = s.references.precedingInvoices.find((p) => p.role === "original");
  if (s.type === "cancellation") {
    const nr = original?.number ?? "";
    return en
      ? `No payment due (cancellation of invoice ${nr}).`
      : `Keine Zahlung erforderlich (Stornierung der Rechnung ${nr}).`;
  }
  if (payable < 0) return en ? "The amount will be refunded or offset." : "Der Betrag wird erstattet oder verrechnet.";
  if (payable === 0) return en ? "No amount payable." : "Kein Zahlbetrag.";
  const due = s.dueDate ? formatDate(s.dueDate, s.language) : undefined;
  const days = s.payment.dueDays;
  let text: string;
  if (days === 0) text = en ? "Payable immediately without deduction." : "Zahlbar sofort ohne Abzug.";
  else if (due) {
    text = en
      ? `Payable within ${days} days without deduction by ${due}.`
      : `Zahlbar innerhalb von ${days} Tagen ohne Abzug bis ${due}.`;
  } else
    text = en ? `Payable within ${days} days without deduction.` : `Zahlbar innerhalb von ${days} Tagen ohne Abzug.`;
  if (s.payment.termsText) text = `${s.payment.termsText}\n${text}`;
  const sk = s.payment.skonto;
  if (sk) {
    text += `\n#SKONTO#TAGE=${sk.days}#PROZENT=${formatDecimal(sk.percentBp, 2).replace(",", ".")}#BASISBETRAG=${formatNumber(payable, 2, "en").replaceAll(",", "")}#\n`;
  }
  return text;
}
