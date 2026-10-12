/**
 * Payment methods (F01 SET-092/093, §5.8). The EN 16931 payment means code (BT-81, ER-10) is derived from the kind.
 * Cash is a payment on an issued invoice — the software is no cash register (AO-04, no §146a TSE), so the cash
 * text must never imply a till receipt.
 */
import { extractIBAN, isSEPACountry } from "ibantools";
import { err, type Issue, issue, ok, type Result } from "../result";

export const PAYMENT_METHOD_KINDS = ["transfer", "sepa_debit", "cash", "paypal", "card", "other"] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

export interface PaymentMethodValues {
  name: string;
  text: string;
  kind: PaymentMethodKind;
  isDefault: boolean;
  active: boolean;
}

/** SET-093 (AO-04): help text next to the cash method. */
export const CASH_HELP_TEXT = "Barzahlung wird als Zahlung auf eine Rechnung gebucht. Diese Software ist keine Kasse.";

export const SEED_PAYMENT_METHODS: readonly PaymentMethodValues[] = [
  {
    name: "Überweisung",
    kind: "transfer",
    text: "Bitte überweisen Sie den Betrag unter Angabe der Rechnungsnummer auf das unten genannte Konto.",
    isDefault: true,
    active: true,
  },
  {
    name: "SEPA-Lastschrift",
    kind: "sepa_debit",
    text: "Der Betrag wird gemäß erteiltem SEPA-Lastschriftmandat von Ihrem Konto eingezogen.",
    isDefault: false,
    active: false,
  },
  { name: "Barzahlung", kind: "cash", text: "Betrag in bar erhalten.", isDefault: false, active: true },
  { name: "PayPal", kind: "paypal", text: "Zahlung per PayPal.", isDefault: false, active: true },
  { name: "Kartenzahlung", kind: "card", text: "Zahlung per Karte.", isDefault: false, active: true },
  { name: "Sonstige", kind: "other", text: "", isDefault: false, active: true },
];

const BT81: Record<PaymentMethodKind, string> = {
  transfer: "58",
  sepa_debit: "59",
  cash: "10",
  card: "48",
  paypal: "68",
  other: "ZZZ",
};

/** BT-81: transfer is 58 (SEPA credit transfer) when the account IBAN is in a SEPA country, else 30. */
export function bt81Code(kind: PaymentMethodKind, iban: string | undefined): string {
  if (kind !== "transfer") return BT81[kind];
  const country = iban ? extractIBAN(iban).countryCode : undefined;
  return country && isSEPACountry(country) ? "58" : "30";
}

export function checkActivatePaymentMethod(kind: PaymentMethodKind, creditorId: string | undefined): Issue | null {
  if (kind === "sepa_debit" && !creditorId) {
    return issue("CREDITOR_ID_REQUIRED", "Für SEPA-Lastschrift wird eine Gläubiger-ID benötigt.");
  }
  return null;
}

/** Words that suggest a till receipt (Kassenbon, Registrierkasse, TSE) — not allowed in the cash text. */
const TILL_WORDS = /kassen(bon|beleg|zettel|quittung)|registrierkasse|\btse\b|\bbon\b/i;

/** SET-092/093: names 1–60 unique (case-insensitive), texts ≤ 500, exactly one default, no till wording. */
export function validatePaymentMethods(methods: readonly PaymentMethodValues[]): Result<void> {
  const names = new Set<string>();
  for (const m of methods) {
    const name = m.name.trim();
    if (name.length < 1 || name.length > 60 || m.text.length > 500) {
      return err(issue("PAYMENT_METHOD_INVALID", "Name: 1 bis 60 Zeichen, Text: höchstens 500 Zeichen.", { name }));
    }
    const key = name.toLocaleLowerCase("de");
    if (names.has(key)) {
      return err(issue("PAYMENT_METHOD_DUPLICATE", "Eine Zahlungsart mit diesem Namen existiert bereits.", { name }));
    }
    names.add(key);
    if (m.kind === "cash" && TILL_WORDS.test(m.text)) {
      return err(
        issue(
          "CASH_TEXT_TILL",
          "Der Text der Barzahlung darf keinen Kassenbeleg andeuten. Diese Software ist keine Kasse (§ 146a AO).",
        ),
      );
    }
  }
  if (methods.filter((m) => m.isDefault).length !== 1) {
    return err(issue("PAYMENT_METHOD_DEFAULT", "Genau eine Zahlungsart muss Standard sein."));
  }
  return ok(undefined);
}
