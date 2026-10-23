/**
 * Mahnbescheid data sheet (F05 DUN-044, MAHN-05): the data needed for the online application on online-mahnantrag.de
 * — Antragsteller, Antragsgegner (with legal form / representative), Anspruch („Rechnung Nr. … vom …“),
 * Hauptforderung, interest wording („9 Prozentpunkte über dem jeweiligen Basiszinssatz seit …“) and Nebenforderungen
 * (Mahnkosten, 40 € Pauschale). Pure; the app files nothing (no court interface) — the owner transfers the data.
 * A Mahnbescheid suspends the limitation (§ 204 Abs. 1 Nr. 3 BGB), a reminder does not (DUN-041).
 */
import type { LegalForm } from "../company/legal-forms";
import {
  de,
  eur,
  fileSafe,
  footerOf,
  type LetterCompany,
  type LetterContent,
  senderLineOf,
} from "../receivables/letter";
import { err, type Issue, issue, ok, type Result } from "../result";
import { lookupVerzugSurcharges } from "../rules/thresholds";
import type { CalendarDate } from "../time/calendar-date";
import type { DefaultStart } from "./default-start";
import { percentPoints } from "./interest-claim";
import { limitationDateOf } from "./limitation";

export const MAHNBESCHEID_MESSAGES = {
  notOpen: "Für einen Mahnbescheid muss die Forderung offen sein.",
  eurOnly: "Das gerichtliche Mahnverfahren ist nur für Forderungen in EUR möglich.",
  missing: (what: string) => `${what} – bitte im Online-Mahnantrag ergänzen.`,
} as const;

export interface MahnbescheidDebtor {
  readonly name: string;
  readonly kind: "person" | "organisation";
  readonly isConsumer: boolean;
  /** Organisation: legal form text (e.g. „GmbH“) if known. */
  readonly legalForm?: string | undefined;
  /** Organisation: legal representative (Geschäftsführer, Vorstand, Inhaber) if known. */
  readonly representative?: string | undefined;
  readonly address: {
    readonly street: string;
    readonly postalCode: string;
    readonly city: string;
    readonly countryCode: string;
  };
  readonly customerNumber?: string | undefined;
}

export interface MahnbescheidInput {
  readonly date: CalendarDate;
  readonly company: LetterCompany;
  readonly debtor: MahnbescheidDebtor;
  readonly invoice: {
    readonly number: string;
    readonly documentDate: string;
    readonly dueDate: string;
    readonly currency: string;
    readonly payableCents: number;
    readonly openAmountCents: number;
  };
  readonly defaultStart: DefaultStart | null;
  /** Fees of the issued reminders (vorgerichtliche Mahnkosten). */
  readonly reminderFeesCents: number;
  /** Fees/interest already received (PAY-024 differences). */
  readonly feesReceivedCents: number;
}

export interface MahnbescheidData {
  readonly antragsteller: {
    readonly name: string;
    readonly rechtsform: string;
    readonly strasse: string;
    readonly plz: string;
    readonly ort: string;
    readonly land: string;
    readonly gesetzlicheVertreter: readonly string[];
    readonly register?: string;
  };
  readonly antragsgegner: {
    readonly name: string;
    readonly art: "natürliche Person" | "Firma / juristische Person";
    readonly verbraucher: boolean;
    readonly rechtsform?: string;
    readonly gesetzlicherVertreter?: string;
    readonly strasse: string;
    readonly plz: string;
    readonly ort: string;
    readonly land: string;
    readonly kundennummer?: string;
  };
  readonly anspruch: {
    readonly bezeichnung: string;
    readonly rechnungsnummer: string;
    readonly rechnungsdatum: string;
    readonly faelligAm: string;
    readonly hauptforderungCents: number;
  };
  readonly zinsen: {
    readonly prozentpunkte: number;
    readonly seit: string;
    readonly text: string;
  } | null;
  readonly nebenforderungen: {
    readonly mahnkostenCents: number;
    readonly pauschale288Abs5Cents: number;
  };
  readonly verjaehrungAm: string;
  readonly hinweise: readonly string[];
}

const LEGAL_FORM_DE: Readonly<Record<LegalForm, string>> = {
  einzelunternehmen: "Einzelunternehmen",
  freiberufler: "Freiberufler",
  ek: "e. K.",
  gbr: "GbR",
  egbr: "eGbR",
  ohg: "OHG",
  kg: "KG",
  gmbh_co_kg: "GmbH & Co. KG",
  gmbh: "GmbH",
  ug: "UG (haftungsbeschränkt)",
  ag: "AG",
  partg: "PartG",
  other: "sonstige",
};

export function mahnbescheidData(
  i: MahnbescheidInput,
): Result<MahnbescheidData, Issue<"not_open" | "eur_only" | string>> {
  if (i.invoice.currency !== "EUR") return err(issue("eur_only", MAHNBESCHEID_MESSAGES.eurOnly));
  if (i.invoice.openAmountCents <= 0) return err(issue("not_open", MAHNBESCHEID_MESSAGES.notOpen));
  const hints: string[] = [];
  const c = i.company;
  const d = i.debtor;
  let zinsen: MahnbescheidData["zinsen"] = null;
  let flat = 0;
  if (i.defaultStart && i.defaultStart.date <= i.date) {
    const s = lookupVerzugSurcharges(i.defaultStart.date);
    if (!s.ok) return err(s.error);
    const bp = d.isConsumer ? s.value.value.b2cBp : s.value.value.b2bBp;
    const pp = percentPoints(bp);
    zinsen = {
      prozentpunkte: bp / 100,
      seit: i.defaultStart.date,
      text: `${pp} Prozentpunkte über dem jeweiligen Basiszinssatz seit ${de(i.defaultStart.date)} aus ${eur(i.invoice.openAmountCents)}`,
    };
    if (!d.isConsumer) flat = s.value.value.flatFeeB2bCents;
  } else {
    hints.push("Kein Verzugsbeginn festgestellt – ohne Verzug keine Zinsen und keine Pauschale.");
  }
  const reminderFees = Math.max(0, i.reminderFeesCents - i.feesReceivedCents);
  const flatOpen = Math.max(0, flat - Math.max(0, i.feesReceivedCents - i.reminderFeesCents));
  if (d.kind === "organisation" && !d.legalForm)
    hints.push(MAHNBESCHEID_MESSAGES.missing("Rechtsform des Antragsgegners fehlt"));
  if (d.kind === "organisation" && !d.representative) {
    hints.push(MAHNBESCHEID_MESSAGES.missing("Gesetzlicher Vertreter des Antragsgegners fehlt"));
  }
  if (!d.address.street || !d.address.postalCode || !d.address.city) {
    hints.push(MAHNBESCHEID_MESSAGES.missing("Anschrift des Antragsgegners unvollständig"));
  }
  hints.push(
    "Die Katalognummer des Anspruchs (z. B. Warenlieferung, Dienstleistung, Werkvertrag) im Online-Mahnantrag passend zum Vertrag wählen.",
  );
  const register = c.register ? `${c.register.court}, ${c.register.type} ${c.register.number}` : undefined;
  return ok({
    antragsteller: {
      name: c.name,
      rechtsform: LEGAL_FORM_DE[c.legalForm],
      strasse: c.address.street,
      plz: c.address.postalCode,
      ort: c.address.city,
      land: c.address.countryCode,
      gesetzlicheVertreter: c.representatives.map((r) => r.name),
      ...(register ? { register } : {}),
    },
    antragsgegner: {
      name: d.name,
      art: d.kind === "person" ? "natürliche Person" : "Firma / juristische Person",
      verbraucher: d.isConsumer,
      ...(d.legalForm ? { rechtsform: d.legalForm } : {}),
      ...(d.representative ? { gesetzlicherVertreter: d.representative } : {}),
      strasse: d.address.street,
      plz: d.address.postalCode,
      ort: d.address.city,
      land: d.address.countryCode,
      ...(d.customerNumber ? { kundennummer: d.customerNumber } : {}),
    },
    anspruch: {
      bezeichnung: `Rechnung Nr. ${i.invoice.number} vom ${de(i.invoice.documentDate)}`,
      rechnungsnummer: i.invoice.number,
      rechnungsdatum: i.invoice.documentDate,
      faelligAm: i.invoice.dueDate,
      hauptforderungCents: i.invoice.openAmountCents,
    },
    zinsen,
    nebenforderungen: { mahnkostenCents: reminderFees, pauschale288Abs5Cents: flatOpen },
    verjaehrungAm: limitationDateOf(i.invoice.dueDate as CalendarDate),
    hinweise: hints,
  });
}

/** The printable data sheet (PDF) of the same data. */
export function mahnbescheidSheet(data: MahnbescheidData, company: LetterCompany, date: string): LetterContent {
  const a = data.antragsteller;
  const g = data.antragsgegner;
  const facts: [string, string][] = [
    ["Antragsteller", `${a.name} (${a.rechtsform})`],
    ["Anschrift", `${a.strasse}, ${a.plz} ${a.ort}`],
    ["Gesetzliche Vertreter", a.gesetzlicheVertreter.join(", ") || "–"],
    ...(a.register ? ([["Register", a.register]] as [string, string][]) : []),
    ["Antragsgegner", `${g.name} (${g.art}${g.verbraucher ? ", Verbraucher" : ""})`],
    ["Rechtsform", g.rechtsform ?? "–"],
    ["Gesetzlicher Vertreter", g.gesetzlicherVertreter ?? "–"],
    ["Anschrift", `${g.strasse}, ${g.plz} ${g.ort}`],
    ...(g.kundennummer ? ([["Kundennummer", g.kundennummer]] as [string, string][]) : []),
    ["Anspruch", data.anspruch.bezeichnung],
    ["Fällig seit", de(data.anspruch.faelligAm)],
    ["Hauptforderung", eur(data.anspruch.hauptforderungCents)],
    ["Zinsen", data.zinsen?.text ?? "keine (kein Verzug festgestellt)"],
    ["Mahnkosten", eur(data.nebenforderungen.mahnkostenCents)],
    ["Pauschale § 288 Abs. 5 BGB", eur(data.nebenforderungen.pauschale288Abs5Cents)],
    ["Verjährung am", de(data.verjaehrungAm)],
  ];
  return {
    kind: "mahnbescheid_sheet",
    title: "Mahnbescheid – Datenblatt",
    fileName: `Mahnbescheid-Datenblatt-${fileSafe(data.anspruch.rechnungsnummer)}-${date}.pdf`,
    date,
    senderLine: senderLineOf(company),
    recipient: ["Interne Unterlage", "für den Online-Mahnantrag", "(www.online-mahnantrag.de)"],
    meta: [
      ["Rechnung", data.anspruch.rechnungsnummer],
      ["Stand", de(date)],
    ],
    subject: `Daten für den Antrag auf Erlass eines Mahnbescheids – ${data.anspruch.bezeichnung}`,
    paragraphs: [
      "Dieses Datenblatt fasst die Angaben für den Online-Mahnantrag zusammen. Es wird nicht an das Gericht übermittelt. Ein Mahnbescheid hemmt die Verjährung (§ 204 Abs. 1 Nr. 3 BGB).",
    ],
    facts,
    closing: data.hinweise.map((h) => `Hinweis: ${h}`),
    footer: footerOf(company),
  };
}
