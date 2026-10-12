/**
 * Mandatory and standard note texts as versioned rule rows (F04 App. B, F01 SET-036, SET-121 owner overrides).
 * Placeholders in `{braces}` are filled by the renderer. EN documents print the English text followed by the German
 * text (DOC-16). Rows start at 2007-01-01 (the floor of all shipped tables) unless the legal basis is younger.
 */
import { err, type Issue, issue, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import {
  defineRuleTable,
  lookupRule,
  type RuleMissing,
  type RuleOverride,
  type RuleRow,
  type RuleTable,
} from "./rule-table";

export interface NoteTextValue {
  readonly de: string;
  readonly en: string;
}

const FLOOR = "2007-01-01";

function note(id: string, validFrom: string, source: string, de: string, en: string): RuleTable<NoteTextValue> {
  return defineRuleTable<NoteTextValue>(id, [{ validFrom, value: { de, en }, source }]);
}

export const NOTE_TEXTS = {
  // KU-02 default; owner wording via override (SET-036). Valid from the 2025 KU reform (supply is tax-exempt).
  // LEGAL-OPEN: 01 item 2 — XML: category E, rate 0, BT-120 = this text, no BT-121 (F04 9.2).
  ku_note_19: note(
    "ku_note_19",
    "2025-01-01",
    "§ 19 Abs. 1 UStG i. d. F. JStG 2024 (BGBl. 2024 I Nr. 387); KU-02",
    "Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung).",
    "VAT-exempt supply under Section 19 (1) German VAT Act (small business scheme).",
  ),
  rc_eu: note(
    "rc_eu",
    FLOOR,
    "§ 14a Abs. 1 und 5 UStG, § 13b Abs. 1 UStG; Art. 196 MwStSystRL",
    "Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge). USt-IdNr. Leistender: {sellerVatId} · USt-IdNr. Leistungsempfänger: {buyerVatId}",
    "Reverse charge: the recipient is liable for VAT (Art. 196 Council Directive 2006/112/EC).",
  ),
  igl: note(
    "igl",
    FLOOR,
    "§ 4 Nr. 1 Buchst. b, § 6a, § 14a Abs. 3 UStG; Art. 138 MwStSystRL",
    "Steuerfreie innergemeinschaftliche Lieferung (§ 4 Nr. 1 Buchst. b, § 6a UStG). USt-IdNr. Lieferer: {sellerVatId} · USt-IdNr. Abnehmer: {buyerVatId}",
    "VAT-exempt intra-Community supply of goods (Art. 138 Council Directive 2006/112/EC).",
  ),
  export: note(
    "export",
    FLOOR,
    "§ 4 Nr. 1 Buchst. a, § 6 UStG; § 14 Abs. 4 Satz 1 Nr. 8 UStG",
    "Steuerfreie Ausfuhrlieferung (§ 4 Nr. 1 Buchst. a, § 6 UStG).",
    "VAT-exempt export delivery (Section 4 No. 1a, Section 6 German VAT Act).",
  ),
  o_3a2: note(
    "o_3a2",
    FLOOR,
    "§ 3a Abs. 2 UStG",
    "Nicht im Inland steuerbare Leistung (§ 3a Abs. 2 UStG).",
    "Service not taxable in Germany (Section 3a (2) German VAT Act); place of supply is the recipient's country.",
  ),
  o_3a4: note(
    "o_3a4",
    FLOOR,
    "§ 3a Abs. 4 UStG",
    "Nicht im Inland steuerbare Leistung (§ 3a Abs. 4 UStG).",
    "Service not taxable in Germany (Section 3a (4) German VAT Act).",
  ),
  rc_13b: note(
    "rc_13b",
    FLOOR,
    "§ 13b Abs. 2 und 5 UStG; § 14a Abs. 5 UStG",
    "Steuerschuldnerschaft des Leistungsempfängers (§ 13b Abs. 2 Nr. {nr}, Abs. 5 UStG).",
    "Reverse charge: the recipient is liable for VAT (Section 13b German VAT Act).",
  ),
  exempt_4: note(
    "exempt_4",
    FLOOR,
    "§ 4 UStG; § 14 Abs. 4 Satz 1 Nr. 8 UStG",
    "Steuerfreie Leistung nach § 4 Nr. {nr} UStG.",
    "VAT-exempt supply under Section 4 No. {nr} German VAT Act.",
  ),
  zero_pv: note(
    "zero_pv",
    "2023-01-01",
    "§ 12 Abs. 3 UStG i. d. F. JStG 2022 (BGBl. 2022 I S. 2294)",
    "Nullsteuersatz nach § 12 Abs. 3 UStG (Photovoltaikanlage).",
    "Zero VAT rate under Section 12 (3) German VAT Act (photovoltaic system).",
  ),
  p14b: note(
    "p14b",
    FLOOR,
    "§ 14 Abs. 4 Satz 1 Nr. 9, § 14b Abs. 1 Satz 5 UStG",
    "Sie sind gesetzlich verpflichtet, diese Rechnung zwei Jahre lang aufzubewahren (§ 14b Abs. 1 Satz 5 UStG).",
    "You are legally required to keep this invoice for two years (Section 14b (1) sentence 5 German VAT Act).",
  ),
  // LEGAL-OPEN: 01 item 1 — wording and XML location (BT-22 subject REG) of the Ist-Versteuerer note; printed on
  // every invoice of an Ist-taxing company with invoice date ≥ 2028-01-01, incl. Kleinbetrag, not on KU invoices.
  ist_2028: note(
    "ist_2028",
    "2028-01-01",
    "§ 14 Abs. 4 Satz 1 Nr. 6a UStG n. F. (Art. 27 JStG 2024, BGBl. 2024 I Nr. 387)",
    "Versteuerung nach vereinnahmten Entgelten.",
    "VAT accounted for on a cash basis (Versteuerung nach vereinnahmten Entgelten).",
  ),
  b2c_286: note(
    "b2c_286",
    FLOOR,
    "§ 286 Abs. 3 Satz 1 Halbsatz 2 BGB",
    "Sie kommen spätestens 30 Tage nach Fälligkeit und Zugang dieser Rechnung in Verzug, ohne dass es einer Mahnung bedarf (§ 286 Abs. 3 BGB).",
    "You will be in default no later than 30 days after the due date and receipt of this invoice without a further reminder (Section 286 (3) German Civil Code).",
  ),
  supply_same: note(
    "supply_same",
    FLOOR,
    "§ 14 Abs. 4 Satz 1 Nr. 6 UStG; § 31 Abs. 4 UStDV",
    "Leistungsdatum: {date} (entspricht dem Rechnungsdatum)",
    "Date of supply: {date} (same as invoice date)",
  ),
  advance_info: note(
    "advance_info",
    FLOOR,
    "§ 14 Abs. 5 UStG; § 13 Abs. 1 Nr. 1 Buchst. a Satz 4 UStG (Mindest-Ist)",
    "{n}. Abschlagsrechnung zu {orderType} {orderNumber} vom {orderDate}. Die Leistung ist noch nicht (vollständig) erbracht; die Abrechnung erfolgt mit der Schlussrechnung.",
    "Advance invoice no. {n} for {orderNumber}. The supply has not yet been (fully) rendered; it will be settled in the final invoice.",
  ),
  final_info: note(
    "final_info",
    FLOOR,
    "§ 14 Abs. 5 Satz 2 UStG",
    "Schlussrechnung zu {orderType} {orderNumber}. Bereits geleistete Abschlagszahlungen und die darauf entfallende Umsatzsteuer werden abgezogen.",
    "Final invoice for {orderNumber}. Advance payments received and the VAT thereon are deducted.",
  ),
  storno_info: note(
    "storno_info",
    FLOOR,
    "§ 14 Abs. 4 UStG; § 31 Abs. 5 UStDV (Bezug auf die ursprüngliche Rechnung)",
    "Stornorechnung zur Rechnung {nr} vom {date}. Die Rechnung {nr} wird hiermit vollständig storniert.",
    "Cancellation of invoice {nr} dated {date}. Invoice {nr} is hereby cancelled in full.",
  ),
  credit_info: note(
    "credit_info",
    FLOOR,
    "§ 17 UStG; § 31 Abs. 5 UStDV",
    "Rechnungskorrektur zur Rechnung {nr} vom {date}. Die folgenden Positionen werden gemindert:",
    "Correction of invoice {nr} dated {date}. The following items are reduced:",
  ),
  rect_info: note(
    "rect_info",
    FLOOR,
    "§ 31 Abs. 5 UStDV",
    "Berichtigung der Rechnung {nr} vom {date}. Berichtigte Angaben: {fields}. Alle übrigen Angaben und Beträge bleiben unverändert.",
    "Correction of invoice {nr} dated {date}. Corrected details: {fields}. All other details and amounts remain unchanged.",
  ),
  proforma_info: note(
    "proforma_info",
    FLOOR,
    "§ 14 UStG (keine Rechnung; vermeidet § 14c UStG)",
    "Proforma-Rechnung – keine Rechnung im Sinne des § 14 UStG.",
    "Pro forma invoice – not a VAT invoice.",
  ),
  sb_info: note(
    "sb_info",
    FLOOR,
    "§ 14 Abs. 2 Satz 2, § 14 Abs. 4 Satz 1 Nr. 10 UStG",
    "Gutschrift (Abrechnung durch den Leistungsempfänger, § 14 Abs. 2 Satz 2 UStG).",
    "Self-billing invoice (Gutschrift) issued by the recipient (Section 14 (2) German VAT Act).",
  ),
  terms: note(
    "terms",
    FLOOR,
    "§ 286 BGB; F04 DOC-50",
    "Zahlbar ohne Abzug bis zum {dueDate}.",
    "Payable without deduction by {dueDate}.",
  ),
  terms_immediate: note(
    "terms_immediate",
    FLOOR,
    "§ 271 Abs. 1 BGB; F04 DOC-50",
    "Zahlbar sofort ohne Abzug.",
    "Payable immediately.",
  ),
  skonto: note(
    "skonto",
    FLOOR,
    "§ 14 Abs. 4 Satz 1 Nr. 7 UStG (im Voraus vereinbarte Minderung)",
    "Bei Zahlung bis zum {skontoDate} gewähren wir {percent} % Skonto ({skontoAmount}; Zahlbetrag {skontoPayable}). Ohne Abzug zahlbar bis zum {dueDate}.",
    "{percent} % early payment discount ({skontoAmount}; amount payable {skontoPayable}) if paid by {skontoDate}. Otherwise payable without deduction by {dueDate}.",
  ),
  pay_ref: note(
    "pay_ref",
    FLOOR,
    "F04 DOC-51 (Verwendungszweck = Rechnungsnummer)",
    "Bitte geben Sie als Verwendungszweck ausschließlich an: {paymentReference}",
    "Please use only this payment reference: {paymentReference}",
  ),
  p35a: note(
    "p35a",
    FLOOR,
    "§ 35a Abs. 5 Satz 3 EStG",
    "Im Rechnungsbetrag enthaltene Arbeitskosten (§ 35a EStG): {net} netto zzgl. {vat} USt = {gross}.",
    "Labour costs included (Section 35a German Income Tax Act): {net} net plus {vat} VAT = {gross}.",
  ),
  fx: note(
    "fx",
    FLOOR,
    "§ 14 Abs. 4 Satz 1 Nr. 8, § 16 Abs. 6 UStG",
    "Umsatzsteuer in EUR: {vatEur} (Kurs 1 EUR = {rate} {currency}, Quelle: {source} vom {date}).",
    "VAT in EUR: {vatEur} (rate 1 EUR = {rate} {currency}, source: {source}, {date}).",
  ),
  copy_stamp: note("copy_stamp", FLOOR, "F04 DOC-32 (UST-34: Kopie statt zweites Original)", "Kopie", "Copy / Kopie"),
} as const satisfies Record<string, RuleTable<NoteTextValue>>;

export type NoteTextId = keyof typeof NOTE_TEXTS;

export const NOTE_TEXT_IDS = Object.keys(NOTE_TEXTS) as NoteTextId[];

export function lookupNoteText(
  id: NoteTextId,
  date: CalendarDate,
  overrides: readonly RuleOverride<NoteTextValue>[] = [],
): Result<RuleRow<NoteTextValue>, RuleMissing | Issue<"note_text_unknown">> {
  if (!Object.hasOwn(NOTE_TEXTS, id))
    return err(issue("note_text_unknown", `Unbekannter Hinweistext „${id}“.`, { id }));
  return lookupRule(NOTE_TEXTS[id], date, overrides);
}
