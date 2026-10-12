/**
 * Supported document currencies (ISO 4217; F02 CON-006 „Die Währung wird nicht unterstützt“, MISC-08). Minor-unit
 * exponents per ISO 4217; amounts are stored in the minor unit.
 */
export const CURRENCIES = {
  EUR: { exponent: 2, labelDe: "Euro" },
  USD: { exponent: 2, labelDe: "US-Dollar" },
  GBP: { exponent: 2, labelDe: "Britisches Pfund" },
  CHF: { exponent: 2, labelDe: "Schweizer Franken" },
  PLN: { exponent: 2, labelDe: "Polnischer Złoty" },
  CZK: { exponent: 2, labelDe: "Tschechische Krone" },
  DKK: { exponent: 2, labelDe: "Dänische Krone" },
  SEK: { exponent: 2, labelDe: "Schwedische Krone" },
  NOK: { exponent: 2, labelDe: "Norwegische Krone" },
  HUF: { exponent: 2, labelDe: "Ungarischer Forint" },
  RON: { exponent: 2, labelDe: "Rumänischer Leu" },
  CAD: { exponent: 2, labelDe: "Kanadischer Dollar" },
  AUD: { exponent: 2, labelDe: "Australischer Dollar" },
  JPY: { exponent: 0, labelDe: "Japanischer Yen" },
} as const satisfies Record<string, { exponent: number; labelDe: string }>;

export type CurrencyCode = keyof typeof CURRENCIES;

export const CURRENCY_CODES = Object.keys(CURRENCIES) as CurrencyCode[];

export const isSupportedCurrency = (code: string): code is CurrencyCode => Object.hasOwn(CURRENCIES, code);
