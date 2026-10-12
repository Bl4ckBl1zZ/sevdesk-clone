/**
 * Sample documents for the layout preview (F01 SET-073): Rechnung, Angebot, Mahnung or Lieferschein, B2B or B2C,
 * Kleinunternehmer or regular taxation. Amounts come from the real totals engine and rule tables, so the preview
 * shows what a document would look like; the number is marked „(Muster)“ and nothing is ever stored.
 */
import { formatBasisPoints } from "../money/format";
import { lookupNoteText } from "../rules/note-texts";
import { lookupVatRate } from "../rules/vat-rates";
import type { CalendarDate } from "../time/calendar-date";
import { addDays, formatGermanDate } from "../time/calendar-date";
import type { PreviewSampleType } from "./layout";
import { computeTotals } from "./totals";

export interface SampleLine {
  name: string;
  description: string;
  quantityMilli: number;
  unit: string;
  unitPriceMicros: number;
  netCents: number;
  rateLabel: string;
}

export interface SampleDocument {
  type: PreviewSampleType;
  title: string;
  number: string;
  date: string;
  recipient: string[];
  intro: string;
  lines: SampleLine[];
  showPrices: boolean;
  totals: { netCents: number; vatCents: number; grossCents: number } | null;
  vatLines: { label: string; baseCents: number; vatCents: number }[];
  notes: string[];
}

const TITLE: Record<PreviewSampleType, string> = {
  invoice: "Rechnung",
  quote: "Angebot",
  reminder: "Zahlungserinnerung",
  delivery_note: "Lieferschein",
};
const PREFIX: Record<PreviewSampleType, string> = { invoice: "RE", quote: "AN", reminder: "MA", delivery_note: "LS" };

const LINES = [
  {
    name: "Konzeption und Gestaltung",
    description: "Workshop, Entwurf und zwei Korrekturschleifen",
    quantityMilli: 8_000,
    unit: "Std.",
    unitPriceMicros: 950_000,
  },
  {
    name: "Lizenz Bildmaterial",
    description: "Nutzungsrecht für ein Jahr",
    quantityMilli: 1_000,
    unit: "pauschal",
    unitPriceMicros: 7_400_000,
  },
];

export function sampleDocument(input: {
  type: PreviewSampleType;
  b2b: boolean;
  ku: boolean;
  today: string;
}): SampleDocument {
  const today = input.today as CalendarDate;
  const year = today.slice(0, 4);
  const rate = lookupVatRate("standard", today);
  const rateBp = input.ku || !rate.ok ? 0 : rate.value.value.rateBp;
  const category = input.ku ? "KU" : "S";
  const totalsResult = computeTotals({
    priceMode: "net",
    lines: LINES.map((l) => ({
      quantityMilli: l.quantityMilli,
      unitPriceMicros: l.unitPriceMicros,
      vatCategory: category,
      rateBp,
    })),
  });
  const totals = totalsResult.ok ? totalsResult.value : null;
  const showPrices = input.type !== "delivery_note";
  const rateLabel = input.ku ? "—" : `${formatBasisPoints(rateBp)} %`;
  const notes: string[] = [];
  if (input.type === "reminder") {
    notes.push(
      `Unsere Rechnung RE-${year}-0001 vom ${formatGermanDate(addDays(today, -30))} ist noch offen. Bitte überweisen Sie den Betrag bis ${formatGermanDate(addDays(today, 10))}.`,
    );
  }
  if (input.type === "invoice") notes.push(`Zahlbar bis ${formatGermanDate(addDays(today, 14))} ohne Abzug.`);
  if (input.type === "quote") notes.push(`Dieses Angebot ist gültig bis ${formatGermanDate(addDays(today, 30))}.`);
  if (input.ku && showPrices) {
    const note = lookupNoteText("ku_note_19", today);
    if (note.ok) notes.push(note.value.value.de);
  }
  return {
    type: input.type,
    title: TITLE[input.type],
    number: `${PREFIX[input.type]}-${year}-0001 (Muster)`,
    date: formatGermanDate(today),
    recipient: input.b2b
      ? ["Beispiel Kunde GmbH", "z. Hd. Herrn Max Beispiel", "Musterweg 5", "50667 Köln"]
      : ["Erika Beispiel", "Lindenallee 12", "04109 Leipzig"],
    intro: input.b2b ? "Sehr geehrter Herr Beispiel," : "Sehr geehrte Frau Beispiel,",
    lines: LINES.map((l, i) => ({ ...l, netCents: totals?.lines[i]?.netCents ?? 0, rateLabel })),
    showPrices,
    totals:
      showPrices && totals
        ? { netCents: totals.taxExclusiveCents, vatCents: totals.vatTotalCents, grossCents: totals.grossCents }
        : null,
    vatLines:
      showPrices && totals && !input.ku
        ? totals.groups.map((g) => ({
            label: `USt ${formatBasisPoints(g.rateBp)} %`,
            baseCents: g.baseCents,
            vatCents: g.vatCents,
          }))
        : [],
    notes,
  };
}
