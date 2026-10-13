/**
 * Text normalisation for bank data (F07 BNK-109 `normalise(…)` of the content hash, BNK-034 near-duplicates):
 * case, umlauts/diacritics, punctuation and whitespace never make two deliveries of the same booking look different.
 */
export const normaliseIban = (iban: string): string => iban.replace(/\s+/g, "").toUpperCase();

const UMLAUTS: Readonly<Record<string, string>> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss" };

export function normaliseText(value: string | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[äöüß]/g, (c) => UMLAUTS[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Counterparty key: IBAN if known, else the normalised name (BNK-109 `normalise(counterpartyIban ∨ counterpartyName)`). */
export const counterpartyKey = (t: { counterpartyIban?: string; counterpartyName?: string }): string =>
  t.counterpartyIban ? normaliseIban(t.counterpartyIban) : normaliseText(t.counterpartyName);
