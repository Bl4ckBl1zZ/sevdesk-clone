/**
 * F09 EXP-019 / GOBD-11 / GOBD-23: the versioned GDPdU export schema `gdpdu-v1` (§4.2.1). Every table and column is
 * defined here, independently of the internal Convex schema; `adapters.ts` maps internal records of any internal
 * schema version onto these columns. Changing a column here is a new export schema (`gdpdu-v2`), never an edit.
 *
 * Not (yet) part of gdpdu-v1 (README lists it): `anlagen.csv`/`afa.csv` and `ustva.csv` — the asset register and
 * the UStVA filings are built by the bookkeeping P2 slice; they are added as tables of a later export schema version.
 */

export const GDPDU_SCHEMA_VERSION = "gdpdu-v1";

export type GdpduColumnType =
  | { kind: "numeric"; accuracy: 0 | 2 }
  | { kind: "alnum"; maxLength?: number }
  | { kind: "date" };

export interface GdpduColumn {
  name: string;
  description: string;
  type: GdpduColumnType;
}

export interface GdpduTable {
  /** File name in the package root. */
  file: string;
  /** `<Name>` in index.xml. */
  name: string;
  description: string;
  /** Primary key columns (in order; declared as `VariablePrimaryKey`). */
  primaryKey: readonly string[];
  columns: readonly GdpduColumn[];
  foreignKeys?: readonly { columns: readonly string[]; references: string }[];
  /** Table carries data of the exported fiscal year only (adds `<Validity>`); master data tables do not. */
  yearScoped: boolean;
}

const N0: GdpduColumnType = { kind: "numeric", accuracy: 0 };
const N2: GdpduColumnType = { kind: "numeric", accuracy: 2 };
const A: GdpduColumnType = { kind: "alnum" };
const D: GdpduColumnType = { kind: "date" };
const c = (name: string, type: GdpduColumnType, description: string): GdpduColumn => ({ name, type, description });

export const GDPDU_V1_TABLES: readonly GdpduTable[] = [
  {
    file: "firma.csv",
    name: "Firma",
    description: "Unternehmensstammdaten je Version (gültig ab/bis)",
    primaryKey: ["version"],
    yearScoped: false,
    columns: [
      c("version", N0, "Version der Unternehmensdaten"),
      c("gueltig_ab", D, "Gültig ab"),
      c("gueltig_bis", D, "Abgelöst am (leer = aktuell)"),
      c("name", A, "Firma / Name"),
      c("rechtsform", A, "Rechtsform"),
      c("anschrift", A, "Anschrift"),
      c("steuernummer", A, "Steuernummer"),
      c("ust_idnr", A, "Umsatzsteuer-Identifikationsnummer"),
      c("kontenrahmen", A, "Kontenrahmen im Exportjahr"),
      c("gewinnermittlung", A, "Gewinnermittlungsart im Exportjahr (EÜR/Bilanz)"),
      c("versteuerung", A, "Soll- oder Ist-Versteuerung im Exportjahr"),
      c("kleinunternehmer", A, "Kleinunternehmerregelung § 19 UStG im Exportjahr (ja/nein)"),
      c("wirtschaftsjahr_beginn", N0, "Beginn des Wirtschaftsjahres (Monat)"),
    ],
  },
  {
    file: "konten.csv",
    name: "Konten",
    description: "Kontenplan inkl. Personenkonten",
    primaryKey: ["kontonummer"],
    yearScoped: false,
    columns: [
      c("kontonummer", A, "Kontonummer"),
      c("bezeichnung", A, "Kontobezeichnung"),
      c("kontoart", A, "Kontoart"),
      c("euer_zeile", A, "EÜR-Zuordnung"),
      c("automatikkonto", A, "Automatikkonto (Umsatzsteuer wird aus dem Konto abgeleitet, ja/nein)"),
    ],
  },
  {
    file: "kontakte.csv",
    name: "Kontakte",
    description: "Debitoren und Kreditoren (gesperrte Kontakte eingeschlossen, Art. 17 Abs. 3 lit. b DSGVO)",
    primaryKey: ["kontakt_id"],
    yearScoped: false,
    columns: [
      c("kontakt_id", A, "Interne ID"),
      c("kontaktnummer", A, "Kontaktnummer"),
      c("art", A, "Organisation oder Person"),
      c("name", A, "Name"),
      c("anschrift", A, "Rechnungsanschrift"),
      c("ust_idnr", A, "USt-IdNr."),
      c("steuernummer", A, "Steuernummer"),
      c("debitorenkonto", A, "Debitorenkonto"),
      c("kreditorenkonto", A, "Kreditorenkonto"),
      c("gesperrt", A, "Gesperrt nach Art. 18 DSGVO (ja/nein)"),
    ],
  },
  {
    file: "buchungen.csv",
    name: "Buchungen",
    description: "Buchungsjournal",
    primaryKey: ["seq"],
    yearScoped: true,
    columns: [
      c("seq", N0, "Laufende Buchungsnummer"),
      c("datum", D, "Buchungsdatum"),
      c("belegdatum", D, "Ursprüngliches Datum (Nachbuchung)"),
      c("periode", A, "Buchungsperiode (JJJJ-MM)"),
      c("text", A, "Buchungstext"),
      c("quelle_art", A, "Art des Ursprungsbelegs"),
      c("quelle_id", A, "ID des Ursprungsbelegs"),
      c("storno_von", N0, "Storniert Buchung (seq)"),
      c("erfasst_am", A, "Erfassungszeitpunkt (UTC, ISO 8601)"),
      c("festgeschrieben_am", A, "Festschreibung (UTC, ISO 8601)"),
      c("akteur", A, "Erfasst von"),
    ],
  },
  {
    file: "buchungszeilen.csv",
    name: "Buchungszeilen",
    description: "Zeilen der Buchungen (Soll/Haben je Konto)",
    primaryKey: ["seq", "zeile"],
    yearScoped: true,
    foreignKeys: [
      { columns: ["seq"], references: "Buchungen" },
      { columns: ["konto"], references: "Konten" },
    ],
    columns: [
      c("seq", N0, "Buchungsnummer"),
      c("zeile", N0, "Zeilennummer"),
      c("konto", A, "Konto"),
      c("soll", N2, "Soll (EUR)"),
      c("haben", N2, "Haben (EUR)"),
      c("steuerschluessel", A, "Steuerschlüssel"),
      c("steuerperiode", A, "Steuerperiode"),
      c("kostenstelle", A, "Kostenstelle"),
      c("kontakt_id", A, "Kontakt"),
    ],
  },
  {
    file: "rechnungen.csv",
    name: "Ausgangsbelege",
    description: "Ausgangsrechnungen, Gutschriften, Stornos und Korrekturen",
    primaryKey: ["beleg_id"],
    yearScoped: true,
    foreignKeys: [{ columns: ["kontakt_id"], references: "Kontakte" }],
    columns: [
      c("beleg_id", A, "Interne ID"),
      c("art", A, "Belegart"),
      c("nummer", A, "Belegnummer"),
      c("belegdatum", D, "Belegdatum"),
      c("leistungsdatum", A, "Leistungsdatum oder -zeitraum"),
      c("faellig_am", D, "Fälligkeit"),
      c("kontakt_id", A, "Kontakt"),
      c("empfaenger", A, "Empfänger (Name laut Beleg)"),
      c("steuerfall", A, "Steuerfall"),
      c("waehrung", A, "Währung"),
      c("netto", N2, "Netto"),
      c("umsatzsteuer", N2, "Umsatzsteuer"),
      c("brutto", N2, "Brutto"),
      c("status", A, "Status"),
      c("storniert_durch", A, "Storniert durch (Beleg)"),
      c("korrigiert", A, "Korrigiert (Beleg)"),
      c("datei_sha256", A, "SHA-256 der Originaldatei"),
    ],
  },
  {
    file: "rechnungspositionen.csv",
    name: "Ausgangsbelegpositionen",
    description: "Positionen der Ausgangsbelege",
    primaryKey: ["beleg_id", "pos"],
    yearScoped: true,
    foreignKeys: [{ columns: ["beleg_id"], references: "Ausgangsbelege" }],
    columns: [
      c("beleg_id", A, "Beleg"),
      c("pos", N0, "Position"),
      c("bezeichnung", A, "Bezeichnung"),
      c("menge", A, "Menge"),
      c("einheit", A, "Einheit (UN/ECE Rec. 20)"),
      c("einzelpreis", A, "Einzelpreis (bis zu 4 Nachkommastellen)"),
      c("netto", N2, "Nettobetrag der Position"),
      c("ust_kategorie", A, "USt-Kategorie (EN 16931)"),
      c("ust_satz", A, "USt-Satz in Prozent"),
    ],
  },
  {
    file: "eingangsbelege.csv",
    name: "Eingangsbelege",
    description: "Eingangsrechnungen und sonstige Ausgabenbelege",
    primaryKey: ["voucher_id"],
    yearScoped: true,
    columns: [
      c("voucher_id", A, "Interne ID"),
      c("interne_nummer", A, "Interne Belegnummer"),
      c("lieferanten_nummer", A, "Rechnungsnummer des Lieferanten"),
      c("lieferant", A, "Lieferant"),
      c("kontakt_id", A, "Kontakt"),
      c("belegdatum", D, "Belegdatum"),
      c("eingang", A, "Eingang (UTC, ISO 8601)"),
      c("steuerregel", A, "Steuerregel"),
      c("waehrung", A, "Währung"),
      c("netto", N2, "Netto"),
      c("vorsteuer", N2, "Umsatzsteuer/Vorsteuer"),
      c("brutto", N2, "Brutto"),
      c("status", A, "Status"),
      c("datei_sha256", A, "SHA-256 der Originaldatei"),
    ],
  },
  {
    file: "eingangsbelegpositionen.csv",
    name: "Eingangsbelegpositionen",
    description: "Positionen der Eingangsbelege",
    primaryKey: ["voucher_id", "pos"],
    yearScoped: true,
    foreignKeys: [{ columns: ["voucher_id"], references: "Eingangsbelege" }],
    columns: [
      c("voucher_id", A, "Beleg"),
      c("pos", N0, "Position"),
      c("konto", A, "Konto"),
      c("netto", N2, "Netto"),
      c("ust_satz", A, "USt-Satz in Prozent"),
      c("umsatzsteuer", N2, "Umsatzsteuer"),
      c("nicht_abziehbar", A, "Nicht abziehbarer Anteil in Prozent"),
    ],
  },
  {
    file: "zahlungen.csv",
    name: "Zahlungen",
    description: "Zahlungen auf Belege",
    primaryKey: ["zahlung_id"],
    yearScoped: true,
    columns: [
      c("zahlung_id", A, "Interne ID"),
      c("ziel_art", A, "Art des Zahlungsziels"),
      c("ziel_id", A, "Zahlungsziel"),
      c("belegnummer", A, "Belegnummer des Ziels"),
      c("datum", D, "Zahlungsdatum"),
      c("betrag", N2, "Betrag"),
      c("waehrung", A, "Währung"),
      c("quelle", A, "Quelle (Bank, Kasse, manuell)"),
      c("differenzen", A, "Differenzen (Skonto, Gebühren, …)"),
      c("storniert_durch", A, "Storniert durch (Zahlung)"),
      c("storno_von", A, "Storniert Zahlung"),
    ],
  },
  {
    file: "bankumsaetze.csv",
    name: "Bankumsaetze",
    description: "Gebuchte Bankumsätze",
    primaryKey: ["umsatz_id"],
    yearScoped: true,
    columns: [
      c("umsatz_id", A, "Interne ID"),
      c("konto", A, "Bankkonto (IBAN oder Name)"),
      c("buchungsdatum", D, "Buchungsdatum"),
      c("wertstellung", D, "Wertstellung"),
      c("betrag", N2, "Betrag"),
      c("waehrung", A, "Währung"),
      c("gegenseite", A, "Gegenseite"),
      c("gegenseite_iban", A, "IBAN der Gegenseite"),
      c("verwendungszweck", A, "Verwendungszweck"),
      c("status", A, "Status"),
      c("quelle", A, "Quelle (Kontoauszug-Import oder Bankanbindung)"),
    ],
  },
  {
    file: "kassenbewegungen.csv",
    name: "Kassenbewegungen",
    description: "Bewegungen auf dem Kassenkonto aus dem Journal (kein Kassenbuch)",
    primaryKey: ["seq", "zeile"],
    yearScoped: true,
    foreignKeys: [{ columns: ["seq"], references: "Buchungen" }],
    columns: [
      c("seq", N0, "Buchungsnummer"),
      c("zeile", N0, "Zeilennummer"),
      c("datum", D, "Datum"),
      c("text", A, "Buchungstext"),
      c("quelle_art", A, "Art des Ursprungs (Zahlung, Bargeldtransfer)"),
      c("quelle_id", A, "Ursprung"),
      c("betrag", N2, "Betrag (Einnahme positiv, Ausgabe negativ)"),
      c("saldo", N2, "Laufender Saldo"),
    ],
  },
  {
    file: "nummernregister.csv",
    name: "Nummernregister",
    description: "Alle vergebenen Belegnummern mit Status",
    primaryKey: ["nummer"],
    yearScoped: true,
    columns: [
      c("nummer", A, "Nummer"),
      c("belegart", A, "Belegart"),
      c("beleg_id", A, "Beleg"),
      c("periode", A, "Nummernkreis-Periode"),
      c("zaehler", N0, "Zähler"),
      c("vergeben_am", A, "Vergeben am (UTC, ISO 8601)"),
      c("status", A, "Status"),
    ],
  },
  {
    file: "dokumente.csv",
    name: "Dokumentenindex",
    description: "Archivierte Dateien (Originale) mit Prüfsumme",
    primaryKey: ["datei_id"],
    yearScoped: true,
    columns: [
      c("datei_id", A, "Interne ID"),
      c("entitaet", A, "Zugehöriger Datensatz (Tabelle)"),
      c("entitaet_id", A, "Zugehöriger Datensatz (ID)"),
      c("art", A, "Dateiart"),
      c("dateiname", A, "Dateiname im Ordner belege/ (leer = nicht enthalten)"),
      c("sha256", A, "SHA-256"),
      c("bytes", N0, "Größe in Bytes"),
      c("mime", A, "MIME-Typ"),
      c("erstellt_am", A, "Erstellt (UTC, ISO 8601)"),
    ],
  },
  {
    file: "protokoll.csv",
    name: "Protokoll",
    description: "Änderungsprotokoll (Hash-Kette) einschließlich Löschnachweisen",
    primaryKey: ["seq"],
    yearScoped: true,
    columns: [
      c("seq", N0, "Laufende Nummer"),
      c("zeit_utc", A, "Zeitpunkt (UTC, ISO 8601)"),
      c("zeit_berlin", A, "Zeitpunkt (Europe/Berlin)"),
      c("akteur", A, "Akteur"),
      c("rolle", A, "Rolle"),
      c("kanal", A, "Kanal"),
      c("aktion", A, "Aktion"),
      c("tabelle", A, "Entität (Tabelle)"),
      c("entitaet_id", A, "Entität (ID)"),
      c("bezeichnung", A, "Entität (Bezeichnung)"),
      c("grund", A, "Begründung"),
      c("aenderung", A, "Änderung (JSON)"),
      c("hash", A, "Hash"),
      c("vorheriger_hash", A, "Vorheriger Hash"),
    ],
  },
];

export const gdpduTable = (file: string): GdpduTable => {
  const t = GDPDU_V1_TABLES.find((x) => x.file === file);
  if (!t) throw new Error(`unknown gdpdu table ${file}`);
  return t;
};

/** A row: column name → value. Numeric accuracy 2 = integer cents; dates = "YYYY-MM-DD". */
export type GdpduValue = string | number | null | undefined;
export type GdpduRow = Readonly<Record<string, GdpduValue>>;
