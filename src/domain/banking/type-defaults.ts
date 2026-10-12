/**
 * Type defaults (F07 BNK-027): a suggestion per booked transaction derived from the ISO 20022 bank transaction code
 * (`Domain-Family-SubFamily`), the Revolut `Type` (CSV / CAMT `Prtry`) and description patterns. Rule data,
 * versioned; the first matching rule wins. Suggestions never act on their own — the owner marks or matches.
 */
import { normaliseIban } from "./normalise";

export type TypeDefaultKind = "transfer" | "fee" | "card_refund" | "atm" | "incoming" | "tax" | "loan" | "interest";

export interface TypeDefault {
  kind: TypeDefaultKind;
  ruleId: string;
  /** German hint shown on the transaction („Vorschlag“). */
  hint: string;
}

interface Rule {
  id: string;
  kind: TypeDefaultKind;
  hint: string;
  direction?: "in" | "out";
  /** ISO subfamily codes (third part of `PMNT-CCRD-CWDL`) or family codes. */
  codes?: readonly string[];
  /** Revolut types (UNSURE until the owner's export). */
  types?: readonly string[];
  pattern?: RegExp;
}

export const TYPE_DEFAULTS_VERSION = "bank-types-2026.1";

const RULES: readonly Rule[] = [
  {
    id: "exchange",
    kind: "transfer",
    hint: "Geldtransit (Umtausch zwischen eigenen Konten)",
    types: ["EXCHANGE"],
    codes: ["FORX"],
    pattern: /\bexchanged (to|from)\b|\bumtausch\b/i,
  },
  {
    id: "atm",
    kind: "atm",
    hint: "Bargeldabhebung in die Kasse oder Privatentnahme",
    direction: "out",
    types: ["ATM"],
    codes: ["CWDL"],
    pattern: /\b(atm|geldautomat|cash withdrawal|bargeldauszahlung)\b/i,
  },
  {
    id: "fee",
    kind: "fee",
    hint: "Bankgebühren (ohne Umsatzsteuer, kein § 13b)",
    types: ["FEE", "CHARGE"],
    codes: ["CHRG", "FEES", "COMM"],
    pattern: /\b(plan fee|kontofuehrung|kontoführung|entgelt|monthly fee|gebuehr|gebühr)\b/i,
  },
  {
    id: "card_refund",
    kind: "card_refund",
    hint: "Kartenerstattung – Zuordnung zum ursprünglichen Beleg",
    direction: "in",
    types: ["CARD_REFUND", "REFUND"],
    codes: ["POSD", "POSC"],
  },
  {
    id: "tax",
    kind: "tax",
    hint: "Steuerzahlung oder -erstattung – bitte manuell zuordnen",
    types: ["TAX"],
    pattern: /\b(finanzamt|finanzkasse|steuer)\b/i,
  },
  {
    id: "loan",
    kind: "loan",
    hint: "Darlehen – bitte Tilgung und Zinsen manuell erfassen",
    types: ["LOAN"],
    codes: ["LOAN", "LBDB"],
    pattern: /\b(darlehen|kredit|tilgung)\b/i,
  },
  {
    id: "interest",
    kind: "interest",
    hint: "Zinsen – bitte manuell zuordnen",
    types: ["INTEREST"],
    codes: ["INTR"],
    pattern: /\b(zinsen|interest)\b/i,
  },
  {
    id: "topup",
    kind: "incoming",
    hint: "Zahlungseingang – Zuordnung zu einer Rechnung",
    direction: "in",
    types: ["TOPUP", "TRANSFER"],
    codes: ["RCDT", "ESCT"],
  },
];

export function suggestTypeDefault(
  tx: {
    amountCents: number;
    bankTransactionCode?: string;
    proprietaryCode?: string;
    purpose: string;
    counterpartyIban?: string;
    counterpartyName?: string;
  },
  ownIbans: readonly string[] = [],
): TypeDefault | null {
  const direction = tx.amountCents >= 0 ? "in" : "out";
  if (tx.counterpartyIban && ownIbans.map(normaliseIban).includes(normaliseIban(tx.counterpartyIban))) {
    return { kind: "transfer", ruleId: "own_iban", hint: "Geldtransit (Überweisung an ein eigenes Konto)" };
  }
  const parts = (tx.bankTransactionCode ?? "").split("-");
  const type = tx.proprietaryCode?.toUpperCase();
  const text = `${tx.purpose} ${tx.counterpartyName ?? ""}`;
  for (const r of RULES) {
    if (r.direction && r.direction !== direction) continue;
    const byType = type !== undefined && r.types?.includes(type);
    const byCode = r.codes?.some((c) => parts.includes(c)) ?? false;
    const byText = r.pattern?.test(text) ?? false;
    if (byType || byCode || byText) return { kind: r.kind, ruleId: r.id, hint: r.hint };
  }
  return null;
}
