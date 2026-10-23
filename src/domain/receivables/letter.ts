/**
 * Receivables letters (F05 PAY-005 Kontoauszug, PAY-048 Zahlungsbestätigung, DUN-028 Zinsforderung, DUN-044
 * Mahnbescheid-Datenblatt): one neutral content model that `src/pdf/letter.ts` lays out as an A4 business letter with
 * the Geschäftsbrief footer (MAIL-03). Pure. The app never sends them (B2): they are exported, archived and marked
 * sent manually like any document.
 */
import type { FooterAccount, FooterCompany } from "../company/footer";
import { geschaeftsbriefFooter } from "../company/footer";
import { formatEuro } from "../money/format";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export const LETTER_KINDS = ["account_statement", "payment_confirmation", "interest_claim", "mahnbescheid_sheet"] as const;
export type LetterKind = (typeof LETTER_KINDS)[number];

export const LETTER_KIND_LABEL_DE: Readonly<Record<LetterKind, string>> = {
  account_statement: "Kontoauszug",
  payment_confirmation: "Zahlungsbestätigung",
  interest_claim: "Zinsforderung",
  mahnbescheid_sheet: "Mahnbescheid-Datenblatt",
};

export interface LetterColumn {
  readonly label: string;
  readonly align?: "left" | "right";
  /** Relative width (the renderer scales the columns to the text width). */
  readonly width: number;
}

export interface LetterTable {
  readonly columns: readonly LetterColumn[];
  readonly rows: readonly (readonly string[])[];
  /** Row indexes printed bold (opening/closing balance, totals). */
  readonly bold?: readonly number[];
}

export interface LetterContent {
  readonly kind: LetterKind;
  readonly title: string;
  readonly fileName: string;
  /** Letter date (ISO); also the PDF creation date, so a re-render of the same content is byte-identical. */
  readonly date: string;
  /** Absenderzeile above the address window. */
  readonly senderLine: string;
  readonly recipient: readonly string[];
  /** Info block right of the address („Kundennummer“, „Datum“ …). */
  readonly meta: readonly (readonly [string, string])[];
  readonly subject: string;
  readonly paragraphs: readonly string[];
  readonly table?: LetterTable;
  /** Label/value list (data sheets) after the table. */
  readonly facts?: readonly (readonly [string, string])[];
  readonly closing: readonly string[];
  readonly footer: readonly [readonly string[], readonly string[], readonly string[]];
}

export interface LetterCompany extends FooterCompany {
  readonly accounts?: readonly FooterAccount[];
}

export interface LetterRecipient {
  readonly name: string;
  readonly customerNumber?: string | undefined;
  /** Postal lines below the name (street, postal code + city, country). */
  readonly address: readonly string[];
}

export const eur = (cents: number) => formatEuro(cents).replace("-", "−");
export const de = (date: string) => formatGermanDate(date as CalendarDate);

/** „Muster GmbH · Musterstraße 1 · 10115 Berlin“ */
export function senderLineOf(c: LetterCompany): string {
  const street = c.address.street || c.address.poBox || "";
  return [c.name, street, [c.address.postalCode, c.address.city].filter(Boolean).join(" ")]
    .filter((s) => s.trim() !== "")
    .join(" · ");
}

export function footerOf(c: LetterCompany): LetterContent["footer"] {
  return geschaeftsbriefFooter(c, c.accounts ?? []).columns;
}

export function recipientLines(r: LetterRecipient): string[] {
  return [r.name, ...r.address].filter((l) => l.trim() !== "");
}

/** `{name}` placeholders of the letter texts (plain text, no HTML); unknown names stay visible. */
export function fillPlaceholders(text: string, values: Readonly<Record<string, string>>): string {
  return text.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (m, k: string) => values[k] ?? m);
}

/** File-name safe part: letters, digits, dash. */
export const fileSafe = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
