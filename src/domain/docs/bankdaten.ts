/**
 * Verfahrensdokumentation chapter „Bankdaten“ (F07 BNK-116, F12 §5; GOBD-10, DSGVO-04): where the bank data comes
 * from (Enable Banking feed in restricted mode and/or statement import), the provider record with the consent periods
 * and the status of the written confirmation, and how the data is kept (immutable rows, signed statements).
 */
import { type CalendarDate, formatGermanDate } from "../time/calendar-date";
import type { DocChapter, DocSection } from "./zugriffskonzept";

export interface BankdatenInput {
  today: string;
  provider: string | null;
  applicationId: string | null;
  status: string | null;
  consentPeriods: readonly { from: string; until: string }[];
  confirmation: {
    label: string;
    recordedAt: string | null;
    note: string | null;
    fileName: string | null;
  } | null;
  feedLost: { at: string; reason: string } | null;
  accounts: readonly { name: string; currency: string; iban: string | null; source: string; archived: boolean }[];
}

const d = (iso: string) => formatGermanDate(iso as CalendarDate);

export function bankdaten(i: BankdatenInput): DocChapter {
  const sections: DocSection[] = [
    {
      heading: "Datenquellen",
      paragraphs: [
        i.provider
          ? `Bankumsätze werden über ${i.provider} viermal täglich abgerufen (PSD2-Kontoinformationsdienst, nur lesend) und zusätzlich durch monatliche Kontoauszüge (CAMT.053/CSV mit signiertem PDF) abgestimmt. Zahlungen können über diese Anbindung nicht ausgelöst werden.`
          : "Bankumsätze werden ausschließlich durch den Import der Kontoauszüge (CAMT.053, MT940 oder CSV mit signiertem PDF) erfasst.",
        "Doppelte Lieferungen derselben Buchung werden anhand der Buchungsreferenz der Bank bzw. eines Inhalts-Fingerabdrucks erkannt und nicht erneut gebucht; abweichende Lieferungen werden als Revision protokolliert, die gebuchte Zeile bleibt unverändert.",
      ],
      table: {
        head: ["Konto", "Währung", "IBAN", "Quelle"],
        rows: i.accounts.map((a) => [
          a.archived ? `${a.name} (archiviert)` : a.name,
          a.currency,
          a.iban ?? "—",
          a.source,
        ]),
      },
    },
  ];
  if (i.provider) {
    sections.push({
      heading: "Anbieter und Zustimmung",
      paragraphs: [
        `Anbieter: ${i.provider}. Anwendungs-ID: ${i.applicationId ?? "—"}. Status: ${i.status ?? "—"}.`,
        "Die Zustimmung des Kontoinhabers gilt höchstens 180 Tage und wird vor Ablauf erneuert (Erinnerung 14 und 3 Tage vorher). Der private Schlüssel der Anwendung und die Sitzungs-ID werden verschlüsselt gespeichert und nie angezeigt oder protokolliert.",
        i.confirmation
          ? `Schriftliche Bestätigung von Enable Banking zur Nutzung im eingeschränkten Modus: ${i.confirmation.label}${i.confirmation.recordedAt ? ` (erfasst am ${d(i.confirmation.recordedAt)})` : ""}${i.confirmation.note ? ` – ${i.confirmation.note}` : ""}${i.confirmation.fileName ? `; Nachweis: ${i.confirmation.fileName}` : ""}.`
          : "Schriftliche Bestätigung von Enable Banking: nicht erfasst.",
        ...(i.feedLost
          ? [
              `Zugang zur Bankanbindung beendet am ${d(i.feedLost.at)}: ${i.feedLost.reason}. Seitdem nur Kontoauszug-Import.`,
            ]
          : []),
      ],
      table: {
        head: ["Zustimmung von", "bis"],
        rows: i.consentPeriods.map((p) => [d(p.from), d(p.until)]),
      },
    });
  }
  sections.push({
    heading: "Aufbewahrung",
    paragraphs: [
      "Gebuchte Bankumsätze, ihre Rohdaten (mit SHA-256-Prüfsumme) und die signierten Kontoauszüge werden unveränderbar gespeichert und für die gesetzlichen Fristen (§ 147 AO) aufbewahrt. Korrekturen erfolgen nur durch Gegenbuchungen; vorgemerkte (noch nicht gebuchte) Umsätze werden nicht gebucht.",
    ],
  });
  return { title: "Bankdaten", stand: d(i.today), sections };
}
