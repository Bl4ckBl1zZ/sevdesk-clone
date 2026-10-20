/**
 * F09 EXP-017 / EXP-018 / GOBD-11: GDPdU (Z3) package writer — CSV tables per `gdpdu-v1`, `index.xml` per the
 * Beschreibungsstandard, the bundled DTD and a German `README.txt`. Pure: the caller supplies the rows (built by
 * `adapters.ts` from the database), the DB row counts and the file list; the result is the package file map or
 * the blocking errors (E-EXP-31 DTD, E-EXP-32 row counts).
 *
 * Format (EXP-018): `;` delimiter, `"` encapsulator (every text value), CRLF records, no header line (the column
 * layout is in index.xml), decimal comma with 2 places for amounts (`<Accuracy>2</Accuracy>`), dates DD.MM.YYYY,
 * UTF-8 (`<UTF8/>`) by default or Windows-1252 (`<ANSI/>`). Line breaks inside a text value are written as LF.
 */
import { encodeCp1252 } from "../csv/cp1252";
import { GDPDU_DTD, GDPDU_DTD_FILE } from "./dtd";
import { validateAgainstDtd } from "./dtd-validate";
import {
  GDPDU_SCHEMA_VERSION,
  GDPDU_V1_TABLES,
  type GdpduColumn,
  type GdpduRow,
  type GdpduTable,
  type GdpduValue,
} from "./schema-v1";

export type GdpduEncoding = "utf8" | "ansi";

export const GDPDU_MESSAGES = {
  dtdInvalid: (detail: string) => `Die GDPdU-Beschreibungsdatei ist ungültig (${detail}). Export abgebrochen.`,
  rowCount: (table: string, a: number, b: number) => `Zeilenanzahl ${table} stimmt nicht (${a} statt ${b}).`,
} as const;

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** "YYYY-MM-DD" → "DD.MM.YYYY". */
export function gdpduDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`invalid date ${iso}`);
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/** Integer cents → "1234,56" / "-0,05" (no grouping; the declared DigitGroupingSymbol is never used). */
export function gdpduAmount(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`amount must be integer cents: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.trunc(abs / 100)},${pad(abs % 100)}`;
}

function cell(col: GdpduColumn, v: GdpduValue): string {
  if (v === null || v === undefined || v === "") return "";
  switch (col.type.kind) {
    case "numeric":
      if (typeof v !== "number") throw new Error(`${col.name}: numeric value expected, got ${typeof v}`);
      if (col.type.accuracy === 2) return gdpduAmount(v);
      if (!Number.isSafeInteger(v)) throw new Error(`${col.name}: integer expected`);
      return String(v);
    case "date":
      return gdpduDate(String(v));
    case "alnum": {
      const s = String(v).replace(/\r\n?/g, "\n");
      return `"${s.replace(/"/g, '""')}"`;
    }
  }
}

/** One table as CSV text (records end with CRLF). */
export function gdpduCsv(table: GdpduTable, rows: readonly GdpduRow[]): string {
  let out = "";
  for (const r of rows) out += `${table.columns.map((c) => cell(c, r[c.name])).join(";")}\r\n`;
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

function columnXml(col: GdpduColumn, primary: boolean): string {
  const tag = primary ? "VariablePrimaryKey" : "VariableColumn";
  const type =
    col.type.kind === "numeric"
      ? col.type.accuracy > 0
        ? `<Numeric><Accuracy>${col.type.accuracy}</Accuracy></Numeric>`
        : "<Numeric/>"
      : col.type.kind === "date"
        ? "<Date><Format>DD.MM.YYYY</Format></Date>"
        : `<AlphaNumeric/>${col.type.maxLength ? `<MaxLength>${col.type.maxLength}</MaxLength>` : ""}`;
  return `        <${tag}><Name>${esc(col.name)}</Name><Description>${esc(col.description)}</Description>${type}</${tag}>`;
}

function tableXml(t: GdpduTable, range: { from: string; to: string }, encoding: GdpduEncoding): string {
  const pk = t.primaryKey.map((name) => t.columns.find((c) => c.name === name) as GdpduColumn);
  const rest = t.columns.filter((c) => !t.primaryKey.includes(c.name));
  const lines = [
    "    <Table>",
    `      <URL>${esc(t.file)}</URL><Name>${esc(t.name)}</Name><Description>${esc(t.description)}</Description>`,
    ...(t.yearScoped
      ? [
          `      <Validity><Range><From>${gdpduDate(range.from)}</From><To>${gdpduDate(range.to)}</To></Range><Format>DD.MM.YYYY</Format></Validity>`,
        ]
      : []),
    `      ${encoding === "ansi" ? "<ANSI/>" : "<UTF8/>"}<DecimalSymbol>,</DecimalSymbol><DigitGroupingSymbol>.</DigitGroupingSymbol>`,
    "      <VariableLength>",
    '        <ColumnDelimiter>;</ColumnDelimiter><RecordDelimiter>&#13;&#10;</RecordDelimiter><TextEncapsulator>"</TextEncapsulator>',
    ...pk.map((c) => columnXml(c, true)),
    ...rest.map((c) => columnXml(c, false)),
    ...(t.foreignKeys ?? []).map(
      (fk) =>
        `        <ForeignKey>${fk.columns.map((n) => `<Name>${esc(n)}</Name>`).join("")}<References>${esc(fk.references)}</References></ForeignKey>`,
    ),
    "      </VariableLength>",
    "    </Table>",
  ];
  return lines.join("\r\n");
}

export interface IndexXmlInput {
  supplier: { name: string; location: string };
  app: { name: string; version: string };
  year: number;
  range: { from: string; to: string };
  encoding: GdpduEncoding;
  tables?: readonly GdpduTable[];
}

/** §4.2.2 `index.xml` (always UTF-8; the CSV encoding is declared per table). */
export function gdpduIndexXml(input: IndexXmlInput): string {
  const tables = input.tables ?? GDPDU_V1_TABLES;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<!DOCTYPE DataSet SYSTEM "${GDPDU_DTD_FILE}">`,
    "<DataSet>",
    "  <Version>1.0</Version>",
    `  <DataSupplier><Name>${esc(input.supplier.name)}</Name><Location>${esc(input.supplier.location)}</Location><Comment>${esc(`${input.app.name} ${input.app.version}, Export-Schema ${GDPDU_SCHEMA_VERSION}, Wirtschaftsjahr ${input.year}`)}</Comment></DataSupplier>`,
    "  <Media>",
    `    <Name>Datenträger 1</Name>`,
    ...tables.map((t) => tableXml(t, input.range, input.encoding)),
    "  </Media>",
    "</DataSet>",
    "",
  ].join("\r\n");
}

export interface GdpduPurgeNote {
  id: string;
  date: string;
  classes: readonly string[];
  count: number;
}

export interface GdpduPackageInput extends IndexXmlInput {
  createdAt: string;
  rows: Readonly<Record<string, readonly GdpduRow[]>>;
  /** Row counts read from the database per table file (E-EXP-32). */
  dbCounts: Readonly<Record<string, number>>;
  /** Files placed under `belege/` (path → bytes); referenced from dokumente.csv. */
  belege?: Readonly<Record<string, Uint8Array>>;
  /** Internal Convex schema versions the exported records were written under (E-EXP-30). */
  internalSchemaVersions: readonly string[];
  restrictedContacts: number;
  purges: readonly GdpduPurgeNote[];
}

export interface GdpduPackage {
  files: Record<string, Uint8Array>;
  counts: Record<string, number>;
  /** Characters not representable in Windows-1252 (ANSI only; written as "?"). */
  unmappable: string[];
}

export type GdpduBuild = { ok: true; value: GdpduPackage } | { ok: false; errors: string[] };

const utf8 = new TextEncoder();

function readme(input: GdpduPackageInput, counts: Record<string, number>): string {
  const tables = input.tables ?? GDPDU_V1_TABLES;
  const lines = [
    `GDPdU-Datenträger (Z3-Zugriff) Wirtschaftsjahr ${input.year}`,
    "",
    `Unternehmen: ${input.supplier.name}, ${input.supplier.location}`,
    `Zeitraum: ${gdpduDate(input.range.from)} bis ${gdpduDate(input.range.to)}`,
    `Erstellt: ${input.createdAt}`,
    `Software: ${input.app.name} ${input.app.version}`,
    `Export-Schema: ${GDPDU_SCHEMA_VERSION} (interne Datenbankschemata: ${input.internalSchemaVersions.join(", ") || "—"})`,
    `Zeichensatz der CSV-Dateien: ${input.encoding === "ansi" ? "ANSI (Windows-1252)" : "UTF-8"}`,
    "",
    "Aufbau",
    "- index.xml: Beschreibung aller Tabellen nach dem Beschreibungsstandard (DTD gdpdu-01-09-2004.dtd, beiliegend).",
    "- CSV-Dateien ohne Kopfzeile; Spaltentrenner Semikolon, Texte in Anführungszeichen, Datensatzende CR LF,",
    "  Dezimalkomma mit zwei Nachkommastellen, Datumsangaben TT.MM.JJJJ.",
    ...(input.belege && Object.keys(input.belege).length > 0
      ? ["- belege/: Originaldateien; Zuordnung über dokumente.csv (Spalte dateiname, Prüfsumme sha256)."]
      : ["- Originaldateien sind nicht enthalten; dokumente.csv nennt Prüfsummen und Größen."]),
    "",
    "Tabellen (Datensätze)",
    ...tables.map((t) => `- ${t.file} (${t.name}): ${counts[t.file] ?? 0}`),
    "",
    "Hinweise",
    `- Gesperrte Kontakte (Art. 18 DSGVO) sind enthalten, weil die Aufbewahrungspflicht vorgeht (Art. 17 Abs. 3 lit. b DSGVO): ${input.restrictedContacts}.`,
    "- Nicht enthalten: Anlagenverzeichnis/AfA und Umsatzsteuer-Voranmeldungen (in dieser Version der Software nicht geführt).",
    ...(input.purges.length === 0
      ? ["- Keine Löschläufe: Es wurden keine Datensätze nach Ablauf der Aufbewahrungsfrist gelöscht."]
      : [
          "- Löschläufe nach Ablauf der Aufbewahrungsfrist (Löschnachweise in protokoll.csv, Aktion retention.purge):",
          ...input.purges.map((p) => `  ${p.date} Lauf ${p.id}: ${p.count} Datensätze (${p.classes.join(", ")})`),
        ]),
    "",
  ];
  return lines.join("\r\n");
}

/** Builds and checks the whole package; any error blocks the export. */
export function buildGdpduPackage(input: GdpduPackageInput): GdpduBuild {
  const tables = input.tables ?? GDPDU_V1_TABLES;
  const errors: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const counts: Record<string, number> = {};
  const unmappable = new Set<string>();
  for (const t of tables) {
    const rows = input.rows[t.file] ?? [];
    const csv = gdpduCsv(t, rows);
    const written = csv.length === 0 ? 0 : csv.split("\r\n").length - 1;
    counts[t.file] = written;
    const expected = input.dbCounts[t.file];
    if (expected !== undefined && expected !== written) errors.push(GDPDU_MESSAGES.rowCount(t.file, written, expected));
    if (input.encoding === "ansi") {
      const enc = encodeCp1252(csv);
      for (const ch of enc.unmappable) unmappable.add(ch);
      files[t.file] = enc.bytes;
    } else files[t.file] = utf8.encode(csv);
  }
  const xml = gdpduIndexXml(input);
  const dtdErrors = validateAgainstDtd(xml, GDPDU_DTD, GDPDU_DTD_FILE);
  if (dtdErrors.length > 0) errors.push(GDPDU_MESSAGES.dtdInvalid(dtdErrors.slice(0, 3).join("; ")));
  if (errors.length > 0) return { ok: false, errors };
  files["index.xml"] = utf8.encode(xml);
  files[GDPDU_DTD_FILE] = utf8.encode(GDPDU_DTD);
  files["README.txt"] = utf8.encode(readme(input, counts));
  for (const [path, bytes] of Object.entries(input.belege ?? {})) files[`belege/${path}`] = bytes;
  return { ok: true, value: { files, counts, unmappable: [...unmappable] } };
}

/** E-EXP-31 guard for an index.xml produced elsewhere (tests, re-validation of a stored package). */
export function validateIndexXml(xml: string): string[] {
  return validateAgainstDtd(xml, GDPDU_DTD, GDPDU_DTD_FILE);
}
