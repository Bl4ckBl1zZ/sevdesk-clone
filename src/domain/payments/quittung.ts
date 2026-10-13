/**
 * Quittung for a cash payment (F05 PAY-063, F07 CSH-028): business name and address, „Quittung“, receipt number =
 * payment reference, date, payer, amount in figures and words, „für Rechnung {number} vom {date}“, „Betrag bar
 * erhalten“, place/date and a signature line. Not a tax invoice — it references the invoice. Pure; the PDF renderer
 * (`src/pdf/quittung.ts`) lays it out, the Convex action archives the first print with its sha256.
 */
import { formatMoneyDe } from "../banking/amount";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

const ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun"];
const TEENS = [
  "zehn",
  "elf",
  "zwölf",
  "dreizehn",
  "vierzehn",
  "fünfzehn",
  "sechzehn",
  "siebzehn",
  "achtzehn",
  "neunzehn",
];
const TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];

/** 1…999 in German, `ein` instead of `eins` as a prefix (einhundert, eintausend, einundzwanzig). */
function below1000(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  let s = h > 0 ? `${h === 1 ? "ein" : ONES[h]}hundert` : "";
  if (r === 0) return s;
  if (r < 10) s += r === 1 ? "eins" : ONES[r];
  else if (r < 20) s += TEENS[r - 10];
  else {
    const o = r % 10;
    const t = TENS[Math.floor(r / 10)] ?? "";
    s += o === 0 ? t : `${o === 1 ? "ein" : ONES[o]}und${t}`;
  }
  return s;
}

const prefix = (n: number) => (n === 1 ? "ein" : below1000(n));

/** German number words (non-negative integers below 10^12). */
export function numberInWords(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n >= 1e12) throw new RangeError("numberInWords: 0 ≤ n < 10^12");
  if (n === 0) return "null";
  const billions = Math.floor(n / 1e9);
  const millions = Math.floor((n % 1e9) / 1e6);
  const thousands = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  const parts: string[] = [];
  if (billions) parts.push(billions === 1 ? "eine Milliarde" : `${below1000(billions)} Milliarden`);
  if (millions) parts.push(millions === 1 ? "eine Million" : `${below1000(millions)} Millionen`);
  const small = `${thousands ? `${prefix(thousands)}tausend` : ""}${rest ? below1000(rest) : ""}`;
  if (small) parts.push(small);
  return parts.join(" ");
}

/** „eintausendeinhundertneunzig Euro und fünf Cent“ (CSH-028). */
export function euroInWords(cents: number): string {
  const euros = Math.floor(Math.abs(cents) / 100);
  const c = Math.abs(cents) % 100;
  const e = euros === 1 ? "ein Euro" : `${numberInWords(euros)} Euro`;
  if (c === 0) return e;
  return `${e} und ${c === 1 ? "ein" : numberInWords(c)} Cent`;
}

export interface QuittungInput {
  paymentId: string;
  date: string;
  amountCents: number;
  payer: string;
  invoiceNumber?: string;
  invoiceDate?: string;
  company: { name: string; address: string; city: string; taxNumber?: string; vatId?: string };
}

export interface QuittungContent {
  title: string;
  fileName: string;
  company: QuittungInput["company"];
  rows: readonly (readonly [string, string])[];
  statement: string;
  placeDate: string;
  note: string;
}

export function quittungContent(input: QuittungInput): QuittungContent {
  const date = formatGermanDate(input.date as CalendarDate);
  const rows: [string, string][] = [
    ["Quittungsnummer", input.paymentId],
    ["Datum", date],
    ["Betrag", formatMoneyDe(input.amountCents, "EUR")],
    ["in Worten", euroInWords(input.amountCents)],
    ["Erhalten von", input.payer],
  ];
  if (input.invoiceNumber) {
    rows.push([
      "Verwendungszweck",
      `für Rechnung ${input.invoiceNumber}${input.invoiceDate ? ` vom ${formatGermanDate(input.invoiceDate as CalendarDate)}` : ""}`,
    ]);
  }
  const ref = input.invoiceNumber ? `${input.invoiceNumber}-` : "";
  return {
    title: "Quittung",
    fileName: `Quittung-${ref}${input.paymentId}.pdf`.replace(/[^\w.-]+/g, "_"),
    company: input.company,
    rows,
    statement: "Betrag bar erhalten.",
    placeDate: `${input.company.city ? `${input.company.city}, ` : ""}${date}`,
    note: "Diese Quittung ist keine Rechnung; sie bestätigt den Erhalt des Betrags zur genannten Rechnung.",
  };
}
