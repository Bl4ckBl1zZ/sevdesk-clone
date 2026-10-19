/**
 * Hybrid E-Rechnung: XML vs. the visible PDF (F06 EC-INB-15, 10-edge-cases EC-101, ER-13). The XML is authoritative
 * and the booking uses its values; key values found in the PDF text layer (no OCR call) are compared and the
 * differing fields listed: Rechnungsnummer, Rechnungsdatum, Bruttobetrag, IBAN. A field is only compared when the PDF
 * text contains a recognisable value for it (label + value, or for the IBAN any IBAN); German and ISO number and date
 * formats are understood. Pure.
 */
import { parseDecimal } from "../money/parse";
import type { ReceivedInvoice } from "./received";

const squash = (s: string) => s.replace(/[\s ]+/g, "").toUpperCase();

const NUMBER_LABEL =
  /(?:Rechnungs(?:-|\s)?(?:nummer|nr\.?)|Rechnung\s+Nr\.?|Beleg(?:nummer|-?nr\.?)|Invoice\s+(?:No\.?|Number|#))\s*:?\s*([A-Za-z0-9][A-Za-z0-9/_.-]{1,40})/i;
const DATE_LABEL =
  /(?:Rechnungsdatum|Belegdatum|Invoice\s+date|Datum)\s*:?\s*(\d{1,2}\.\d{1,2}\.\d{2,4}|\d{4}-\d{2}-\d{2})/i;
const GROSS_LABEL =
  /(?:Rechnungsbetrag|Gesamtbetrag|Bruttobetrag|Gesamtsumme|Endbetrag|Summe\s+brutto|Brutto(?:summe)?|Zu\s+zahlen(?:der\s+Betrag)?|Total)\s*(?:\(?\s*(?:EUR|€)\s*\)?)?\s*:?\s*(?:EUR|€)?\s*(-?\d{1,3}(?:[.\s]\d{3})*,\d{2}|-?\d+,\d{2}|-?\d{1,3}(?:,\d{3})*\.\d{2}|-?\d+\.\d{2})/gi;
const IBAN = /\b([A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?)\b/g;

function isoFromGerman(d: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const m = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/.exec(d);
  if (!m) return null;
  const year = (m[3] as string).length === 2 ? `20${m[3]}` : (m[3] as string);
  return `${year}-${(m[2] as string).padStart(2, "0")}-${(m[1] as string).padStart(2, "0")}`;
}

function amountCents(s: string): number | null {
  const t = s.replace(/\s/g, "");
  const german = /,\d{2}$/.test(t);
  const r = parseDecimal(t, { scale: 2, decimalSeparator: german ? "," : ".", grouping: true, currencySymbol: true });
  return r.ok ? Number(r.value) : null;
}

export function compareWithPdfText(inv: ReceivedInvoice, pdfText: string): string[] {
  const text = pdfText.replace(/ /g, " ");
  if (text.trim() === "") return [];
  const flat = squash(text);
  const out: string[] = [];

  const num = NUMBER_LABEL.exec(text)?.[1];
  if (num && !flat.includes(squash(inv.number)) && squash(num) !== squash(inv.number)) out.push("Rechnungsnummer");

  const dateRaw = DATE_LABEL.exec(text)?.[1];
  const date = dateRaw ? isoFromGerman(dateRaw) : null;
  if (date && date !== inv.issueDate) out.push("Rechnungsdatum");

  const grossValues = [...text.matchAll(GROSS_LABEL)]
    .map((m) => amountCents(m[1] as string))
    .filter((v): v is number => v !== null);
  if (grossValues.length > 0) {
    const expected = new Set([inv.totals.taxInclusiveCents, inv.totals.payableCents]);
    if (!grossValues.some((v) => expected.has(v) || expected.has(-v))) out.push("Bruttobetrag");
  }

  if (inv.payment.iban) {
    const ibans = [...text.toUpperCase().matchAll(IBAN)]
      .map((m) => squash(m[1] as string))
      .filter((i) => i.length >= 15);
    if (ibans.length > 0 && !ibans.includes(squash(inv.payment.iban))) out.push("IBAN");
  }
  return out;
}

/** EC-INB-15. */
export const pdfMismatchMessage = (fields: readonly string[]): string =>
  `PDF-Darstellung und XML weichen ab (${fields.join(", ")}). Maßgeblich ist die XML; bitte ggf. Korrektur beim Lieferanten anfordern.`;
