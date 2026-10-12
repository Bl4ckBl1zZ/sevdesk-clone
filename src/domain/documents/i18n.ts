/**
 * Language-dependent formatting for documents (F04 DOC-16: "labels, units, dates and number formats follow the
 * language"). Deterministic, ICU-independent: de = "1.190,00 €" / "11.11.2026", en = "EUR 1,190.00" / "11 Nov 2026".
 */
import { formatDecimal } from "../money/format";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export type DocLanguage = "de" | "en";

const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** de "1.234,56", en "1,234.56" for a scaled integer. */
export function formatNumber(
  value: number | bigint,
  scale: number,
  lang: DocLanguage,
  minFractionDigits: number = scale,
): string {
  const de = formatDecimal(value, scale, { minFractionDigits });
  if (lang === "de") return de;
  return de.replace(/[.,]/g, (c) => (c === "." ? "," : "."));
}

/** Amount with currency: de "1.190,00 €" (other currencies "1.190,00 USD"), en "EUR 1,190.00". */
export function formatAmount(cents: number, currency: string, lang: DocLanguage): string {
  const n = formatNumber(cents, 2, lang);
  if (lang === "en") return cents < 0 ? `-${currency} ${n.slice(1)}` : `${currency} ${n}`;
  return `${n} ${currency === "EUR" ? "€" : currency}`;
}

/** de "11.11.2026", en "11 Nov 2026". */
export function formatDate(date: string, lang: DocLanguage): string {
  if (lang === "de") return formatGermanDate(date as CalendarDate);
  const [y, m, d] = date.split("-");
  return `${Number(d)} ${EN_MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** Percentage without sign: de "19" / "2,5", en "19" / "2.5". */
export const formatRate = (bp: number, lang: DocLanguage): string => formatNumber(bp, 2, lang, 0);

/** Quantity (0–3 decimals). */
export const formatQuantity = (milli: number, lang: DocLanguage): string => formatNumber(milli, 3, lang, 0);

/** Unit price (2–4 decimals). */
export const formatUnitPrice = (micros: number, lang: DocLanguage): string => formatNumber(micros, 4, lang, 2);
