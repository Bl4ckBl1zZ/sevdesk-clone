/**
 * Bewirtung (F06 VOU-060…062, MISC-05; EC-BEW-01…08, EC-163).
 *
 * A business meal needs a structured, immutable Eigenbeleg: occasion type, the **specific** occasion, all
 * participants (≥ 1 guest plus the host), host, place, date, tip (separate, no VAT) and the confirmations
 * „maschinell erstellt mit TSE-Angaben“ and — above 250 € — „Name des Bewirtenden steht auf der Rechnung“.
 * Approval („Eigenbeleg freigeben“) freezes the data; corrections create a superseding version (VOU-062, D-07).
 * Split: `geschäftlich` 70 % deductible / 30 % non-deductible on every line incl. the tip (VOU-061); input VAT
 * 100 % (unless KU). `Arbeitnehmer` is a staff event: 100 % on its own account, no split. Pure.
 */

import { formatMoneyDe } from "../banking/amount";
import type { EigenbelegContent } from "../banking/eigenbeleg";
import { roundHalfAway } from "../money";
import { type Issue, issue } from "../result";
import { lookupRule } from "../rules/rule-table";
import { KLEINBETRAG_LIMIT } from "../rules/thresholds";
import { VAT_RATE_KEYS } from "../rules/vat-rates";
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";

export const BEWIRTUNG_NON_DEDUCTIBLE_BP = 3000;

export type BewirtungOccasionType = "geschaeftlich" | "arbeitnehmer";

export interface BewirtungData {
  occasionType: BewirtungOccasionType;
  occasion: string;
  /** Guests (the host is separate). */
  participants: readonly string[];
  host: string;
  place: string;
  date: string;
  tipCents?: number;
  tseConfirmed: boolean;
  hostOnInvoiceConfirmed?: boolean;
  approvedAt?: number;
}

/** EC-BEW-02: occasions that are too generic (R 4.10 Abs. 8 EStR: the specific occasion is required). */
export const GENERIC_OCCASIONS: readonly string[] = [
  "geschäftsessen",
  "geschaeftsessen",
  "besprechung",
  "arbeitsessen",
  "meeting",
  "business lunch",
  "kundengespräch",
  "kundengespraech",
  "geschäftlich",
  "bewirtung",
];

export const BEWIRTUNG_MESSAGES = {
  participants: "Bitte alle Teilnehmer der Bewirtung angeben.",
  occasion:
    "Bitte den konkreten Anlass angeben (z. B. ‚Projektbesprechung Website-Relaunch mit Müller GmbH‘). Allgemeine Angaben wie ‚Geschäftsessen‘ reichen nicht aus.",
  hostOnInvoice:
    "Bei Rechnungen über 250 € muss der Name des Bewirtenden auf der Rechnung stehen. Bitte bestätigen oder Rechnung korrigieren lassen.",
  tse: "Bewirtungsbelege müssen maschinell erstellt sein und TSE-Angaben enthalten. Ohne diese Angaben ist der Betriebsausgabenabzug gefährdet.",
  approved: "Der Bewirtungsbeleg ist freigegeben und unveränderbar. Bitte eine berichtigte Fassung erstellen.",
  notApproved: "Bitte zuerst den Bewirtungsbeleg freigeben.",
  food19: "Speisen in der Gastronomie unterliegen seit 01.01.2026 dem ermäßigten Satz von 7 %. Bitte prüfen.",
  tip: "Trinkgeld bitte als eigene Position ohne Umsatzsteuer erfassen.",
  fields: "Bitte Bewirtende Person, Ort und Datum der Bewirtung angeben.",
} as const;

export type BewirtungIssue = Issue<
  | "bewirtung_participants"
  | "bewirtung_occasion"
  | "bewirtung_host_on_invoice"
  | "bewirtung_tse"
  | "bewirtung_fields"
  | "bewirtung_food_rate"
  | "bewirtung_tip"
>;

/** EC-BEW-02: empty, a generic term, or a generic term with filler only. */
export function isGenericOccasion(occasion: string): boolean {
  const t = occasion
    .trim()
    .toLowerCase()
    .replace(/[.,;:!]+$/g, "");
  if (t.length < 5) return true;
  return GENERIC_OCCASIONS.some((g) => t === g || t === `${g} mit kunden` || t === `${g} mit kunde`);
}

/** Approval checks (VOU-060/062): errors block the approval, warnings must be acknowledged. */
export function checkBewirtungApproval(
  data: BewirtungData,
  grossEurCents: number,
  documentDate: CalendarDate,
): { errors: BewirtungIssue[]; warnings: BewirtungIssue[] } {
  const errors: BewirtungIssue[] = [];
  const warnings: BewirtungIssue[] = [];
  const guests = data.participants.map((p) => p.trim()).filter((p) => p && p !== data.host.trim());
  if (guests.length === 0) errors.push(issue("bewirtung_participants", BEWIRTUNG_MESSAGES.participants));
  if (isGenericOccasion(data.occasion)) errors.push(issue("bewirtung_occasion", BEWIRTUNG_MESSAGES.occasion));
  if (!data.host.trim() || !data.place.trim() || !data.date.trim()) {
    errors.push(issue("bewirtung_fields", BEWIRTUNG_MESSAGES.fields));
  }
  const limit = lookupRule(KLEINBETRAG_LIMIT, documentDate);
  const limitCents = limit.ok ? limit.value.value.limitCents : 25_000;
  if (grossEurCents > limitCents && !data.hostOnInvoiceConfirmed) {
    errors.push(issue("bewirtung_host_on_invoice", BEWIRTUNG_MESSAGES.hostOnInvoice));
  }
  if (!data.tseConfirmed) warnings.push(issue("bewirtung_tse", BEWIRTUNG_MESSAGES.tse));
  return { errors, warnings };
}

const FOOD_RE = /(speise|essen|food|menü|menue|gericht|mittagstisch|frühstück|fruehstueck)/i;
const TIP_RE = /(trinkgeld|\btip\b)/i;

/**
 * Line checks of a Bewirtung voucher: EC-BEW-07 (food at the standard rate where the restaurant-food rate is lower on
 * the supply date) and EC-BEW-08 (tip with VAT, or a tip without its own 0 % line).
 */
export function checkBewirtungLines(
  lines: readonly { description?: string; vatRateBp: number; grossCents: number }[],
  data: Pick<BewirtungData, "tipCents">,
  supplyDate: CalendarDate,
): { errors: BewirtungIssue[]; warnings: BewirtungIssue[] } {
  const errors: BewirtungIssue[] = [];
  const warnings: BewirtungIssue[] = [];
  const food = lookupRule(VAT_RATE_KEYS.restaurant_food, supplyDate);
  const standard = lookupRule(VAT_RATE_KEYS.standard, supplyDate);
  if (food.ok && standard.ok && food.value.value.rateBp < standard.value.value.rateBp) {
    const std = standard.value.value.rateBp;
    if (lines.some((l) => l.vatRateBp === std && FOOD_RE.test(l.description ?? ""))) {
      warnings.push(issue("bewirtung_food_rate", BEWIRTUNG_MESSAGES.food19));
    }
  }
  const tipWithVat = lines.some((l) => TIP_RE.test(l.description ?? "") && l.vatRateBp !== 0);
  const tip = data.tipCents ?? 0;
  const tipLine = lines.some((l) => l.vatRateBp === 0 && l.grossCents === tip);
  if (tipWithVat || (tip > 0 && !tipLine)) errors.push(issue("bewirtung_tip", BEWIRTUNG_MESSAGES.tip));
  return { errors, warnings };
}

/** VOU-061 split of an amount: [deductible 70 %, non-deductible 30 %] — the 30 % share rounded half-up. */
export function splitShare(amountCents: number, nonDeductibleBp: number): [deductible: number, nonDeductible: number] {
  const nd = Number(roundHalfAway(BigInt(amountCents) * BigInt(nonDeductibleBp), 10_000n));
  return [amountCents - nd, nd];
}

const OCCASION_TYPE_DE: Record<BewirtungOccasionType, string> = {
  geschaeftlich: "Bewirtung von Geschäftspartnern (70 % abziehbar)",
  arbeitnehmer: "Bewirtung von Arbeitnehmern (100 %, Betriebsveranstaltung)",
};

/** VOU-062: the content of the Eigenbeleg PDF (all fields, linked receipt number and hash). */
export function bewirtungEigenbelegContent(input: {
  data: BewirtungData;
  grossCents: number;
  currency: string;
  receipt: { number?: string; supplierName?: string; sha256?: string };
  company: { name: string };
  createdOn: string;
  createdBy: string;
  version: number;
  supersedesReason?: string;
}): EigenbelegContent {
  const d = input.data;
  const rows: [string, string][] = [
    ["Art der Bewirtung", OCCASION_TYPE_DE[d.occasionType]],
    ["Anlass", d.occasion.trim()],
    ["Teilnehmer", d.participants.filter((p) => p.trim()).join(", ")],
    ["Bewirtende Person", d.host],
    ["Ort", d.place],
    ["Tag der Bewirtung", formatGermanDate(d.date as CalendarDate)],
    ["Höhe der Aufwendungen", formatMoneyDe(input.grossCents, input.currency)],
  ];
  if (d.tipCents) rows.push(["davon Trinkgeld", formatMoneyDe(d.tipCents, input.currency)]);
  rows.push(["Beleg maschinell mit TSE", d.tseConfirmed ? "ja (bestätigt)" : "nein"]);
  if (d.hostOnInvoiceConfirmed !== undefined) {
    rows.push(["Name des Bewirtenden auf der Rechnung", d.hostOnInvoiceConfirmed ? "ja (bestätigt)" : "nein"]);
  }
  const receipt = [input.receipt.supplierName, input.receipt.number].filter(Boolean).join(" · ");
  if (receipt) rows.push(["Rechnung", receipt]);
  if (input.receipt.sha256) rows.push(["SHA-256 der Rechnung", input.receipt.sha256]);
  if (input.version > 1) rows.push(["Fassung", `${input.version} (ersetzt die vorherige Fassung)`]);
  if (input.supersedesReason) rows.push(["Grund der Berichtigung", input.supersedesReason]);
  rows.push(["Freigegeben am", `${formatGermanDate(input.createdOn as CalendarDate)} von ${input.createdBy}`]);
  return {
    title: "Bewirtungsbeleg (Angaben nach § 4 Abs. 5 Nr. 2 EStG)",
    fileName: `Bewirtungsbeleg-${d.date}-v${input.version}.pdf`,
    rows,
    statement:
      "Die Angaben zur Bewirtung wurden vom Bewirtenden elektronisch freigegeben und sind danach unveränderbar. Berichtigungen erfolgen nur über eine neue Fassung; frühere Fassungen bleiben erhalten.",
  };
}
