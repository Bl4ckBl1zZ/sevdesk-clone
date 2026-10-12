/**
 * Display formatting in de-DE (04-ui-ux §8). Display only — parsing user input (money, quantities) belongs to
 * `src/domain/money`. Money stays integer: cents are split with integer division, never divided as floats.
 */
import { timeZone } from "./config";

const LOCALE = "de-DE";
const integerFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const currencyLayoutCache = new Map<string, { symbol: string; before: boolean; gap: string }>();

function currencyLayout(currency: string) {
  let layout = currencyLayoutCache.get(currency);
  if (!layout) {
    const parts = new Intl.NumberFormat(LOCALE, { style: "currency", currency }).formatToParts(1);
    const symbolIndex = parts.findIndex((p) => p.type === "currency");
    const integerIndex = parts.findIndex((p) => p.type === "integer");
    const literal = parts.find((p) => p.type === "literal")?.value ?? "";
    layout = { symbol: parts[symbolIndex]?.value ?? currency, before: symbolIndex < integerIndex, gap: literal };
    currencyLayoutCache.set(currency, layout);
  }
  return layout;
}

/** `123456` → `1.234,56 €` (no-break space before the symbol, like Intl). Assumes 2 minor digits. */
export function formatCents(cents: number, currency = "EUR"): string {
  if (!Number.isSafeInteger(cents)) throw new TypeError(`formatCents expects integer cents, got ${cents}`);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const major = (abs - (abs % 100)) / 100;
  const minor = String(abs % 100).padStart(2, "0");
  const amount = `${negative ? "-" : ""}${integerFormat.format(major)},${minor}`;
  const { symbol, before, gap } = currencyLayout(currency);
  return before ? `${symbol}${gap}${amount}` : `${amount}${gap}${symbol}`;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Business date `YYYY-MM-DD` → `12.10.2026`. Pure string operation: no time-zone conversion. */
export function formatIsoDate(isoDate: string): string {
  const m = ISO_DATE.exec(isoDate);
  if (!m) throw new RangeError(`Expected YYYY-MM-DD, got "${isoDate}"`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

const dateFormat = new Intl.DateTimeFormat(LOCALE, { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat(LOCALE, {
  timeZone,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Epoch milliseconds → `12.10.2026` (or `12.10.2026, 14:05`) in Europe/Berlin. */
export function formatTimestamp(ms: number, options: { withTime?: boolean } = {}): string {
  return (options.withTime ? dateTimeFormat : dateFormat).format(ms);
}

export function formatInteger(value: number): string {
  return integerFormat.format(value);
}

/** Basis points → percentage with up to 2 decimals: `1900` → `19 %`, `250` → `2,5 %`. */
export function formatBasisPoints(bp: number): string {
  if (!Number.isSafeInteger(bp)) throw new TypeError(`formatBasisPoints expects an integer, got ${bp}`);
  const negative = bp < 0;
  const abs = Math.abs(bp);
  const whole = (abs - (abs % 100)) / 100;
  const fraction = String(abs % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${integerFormat.format(whole)}${fraction ? `,${fraction}` : ""} %`;
}
