/**
 * Import protocol (F09 IMP-024, GOBD-20/GOBD-23): the migration evidence of a committed sevdesk export import as a
 * section model that src/pdf/import-protocol.tsx renders. Built only from the frozen `imports` row (+ the commit's
 * audit entry), so regenerating it gives the same content: source files with SHA-256 (incl. the ZIP each file was
 * unpacked from), mapping per CSV file, counts, owner decisions (number ranges, missing-PDF reason, exclusions,
 * PDF assignments, entered open amounts), findings and deviations (EC-190, E-IMP-32 gaps, …), open points, run log,
 * actor, start/end times (Europe/Berlin) and the importer version. Referenced from the Verfahrensdokumentation
 * (data migration section, F12).
 */
import { ROLE_LABEL_DE } from "../../access/permissions";
import { formatCents } from "../../money/format";
import type { MemberRole } from "../../schemas/actor";
import { IMPORT_FILE_KIND_LABELS, type ImportFileKind, isMappedCsvKind, targetLabel } from "./mapping";

export interface ProtocolFileInput {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly detectedKind: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly ignored?: boolean;
  readonly container?: string;
  readonly rows?: number;
  readonly encoding?: string;
  readonly delimiter?: string;
  readonly unpacked?: { readonly files: number; readonly ignored: readonly string[] };
}

export interface ProtocolFinding {
  readonly code: string;
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly fileName?: string;
  readonly line?: number;
}

export interface ImportProtocolInput {
  readonly importId: string;
  readonly importerVersion: string;
  readonly createdBy: string;
  readonly startedAt: number;
  readonly commit: {
    readonly actor: string;
    readonly label?: string;
    readonly role?: string;
    /** First `import.commit` audit entry (the run may have been resumed after E-IMP-14). */
    readonly startedAt?: number;
    readonly finishedAt: number;
  };
  readonly retentionUntil?: string;
  readonly files: readonly ProtocolFileInput[];
  readonly mapping: Readonly<Record<string, { readonly columns: Readonly<Record<string, string>> }>>;
  readonly resolutions: {
    readonly excluded?: readonly string[];
    readonly pdfAssignments?: Readonly<Record<string, string>>;
    readonly openAmounts?: Readonly<Record<string, number>>;
  };
  readonly decisions?: {
    readonly numberRanges?: readonly {
      readonly rangeKey: string;
      readonly format: string;
      readonly resetPolicy: string;
      readonly next: number;
    }[];
    readonly missingPdfReason?: string;
    /** IMP-022: the acknowledged open-item difference (imported vs. sevdesk total). */
    readonly openItemDifference?: { readonly expectedCents: number; readonly importedCents: number };
  };
  /** The stored preview (IMP-009) the commit ran against; only these fields are read. */
  readonly preview?: {
    readonly findings?: readonly ProtocolFinding[];
    readonly findingsTotal?: number;
    readonly openItems?: { readonly count: number; readonly totalCents: number };
    readonly pdf?: { readonly orphans?: readonly string[]; readonly missing?: readonly string[] };
  };
  readonly stats: Readonly<Record<string, number>>;
  readonly log: readonly string[];
}

export interface ProtocolTable {
  readonly headers: string[];
  readonly rows: string[][];
  /** Relative column widths (sum 100). */
  readonly widths: number[];
  /** Columns set in a monospace font (hashes). */
  readonly mono?: number[];
}

export interface ProtocolSection {
  readonly title: string;
  readonly paragraphs?: string[];
  readonly table?: ProtocolTable;
}

export interface ImportProtocol {
  readonly title: string;
  readonly subtitle: string;
  readonly fileName: string;
  /** PDF creation/modification date (= end of the commit) — keeps the bytes reproducible. */
  readonly createdAt: number;
  readonly sections: ProtocolSection[];
  readonly footer: string;
}

/** The stored preview keeps at most this many findings (summarizePlan's `findingLimit`). */
export const PROTOCOL_FINDING_LIMIT = 500;

const STAT_LABELS: Readonly<Record<string, string>> = {
  contactsNew: "Neue Kontakte",
  contactsExisting: "Vorhandene Kontakte (nicht überschrieben)",
  contactsSkipped: "Bereits importierte Kontakte",
  contactsMinimal: "Unvollständige Kontakte (aus Rechnungen)",
  productsNew: "Neue Artikel",
  productsExisting: "Vorhandene Artikel (nicht überschrieben)",
  productsSkipped: "Bereits importierte Artikel",
  invoices: "Rechnungen",
  corrections: "Gutschriften/Korrekturen",
  cancellations: "Stornorechnungen",
  documentsSkipped: "Bereits importierte Belege",
  documentsExcluded: "Ausgeschlossene Belege",
  openItems: "Offene Posten",
  pdfMatched: "Zugeordnete PDFs",
  pdfMissing: "Belege ohne PDF",
  pdfOrphans: "PDFs ohne Beleg",
  duplicatesDropped: "Doppelte Einträge (einmal gezählt)",
  drafts: "Entwürfe (nicht übernommen)",
  nameMatched: "Kontakte über den Namen zugeordnet",
  errors: "Fehler",
  warnings: "Warnungen",
  rows: "Übernommene Zeilen",
  contactsCreated: "Angelegte Kontakte",
  productsCreated: "Angelegte Artikel",
  documentsCreated: "Angelegte Belege",
  openingItemsCreated: "Offene Posten in der Eröffnungsbilanz",
  skipped: "Übersprungen (bereits vorhanden)",
};

const RANGE_LABELS: Readonly<Record<string, string>> = { invoice: "Rechnungen", correction: "Rechnungskorrekturen" };
const RESET_LABELS: Readonly<Record<string, string>> = { never: "nie", yearly: "jährlich", monthly: "monatlich" };
const SEVERITY_LABELS = { error: "Fehler", warning: "Warnung", info: "Hinweis" } as const;
const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Europe/Berlin",
});
const DATE_ISO = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Europe/Berlin",
});

const at = (ms: number) => `${DATE_TIME.format(ms)} (Europe/Berlin)`;
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const euro = (cents: number) => `${formatCents(cents)} €`;
const germanDate = (iso: string) => iso.split("-").reverse().join(".");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const kindLabel = (k: string) => IMPORT_FILE_KIND_LABELS[k as ImportFileKind] ?? k;
const roleLabel = (r: string | undefined) => (r ? (ROLE_LABEL_DE[r as MemberRole] ?? r) : undefined);

export function buildImportProtocol(input: ImportProtocolInput): ImportProtocol {
  const sections: ProtocolSection[] = [];
  const c = input.commit;

  const who = [c.actor, roleLabel(c.role)].filter(Boolean).join(", ");
  sections.push({
    title: "Import",
    table: {
      headers: ["Angabe", "Wert"],
      widths: [28, 72],
      rows: [
        ["Import-ID", input.importId],
        ["Quelle", "sevdesk-Export (Dateiexporte, keine API)"],
        ["Importer-Version", input.importerVersion],
        ["Projekt angelegt", `${at(input.startedAt)} von ${input.createdBy}`],
        ...(c.startedAt !== undefined ? [["Übernahme gestartet", at(c.startedAt)]] : []),
        ["Übernahme abgeschlossen", at(c.finishedAt)],
        ["Übernommen von", c.label ? `${c.label} (${who})` : who],
        ...(input.retentionUntil
          ? [["Aufbewahrung bis", `${germanDate(input.retentionUntil)} (Quelldateien und dieses Protokoll)`]]
          : []),
      ],
    },
  });

  const unpackNotes = input.files
    .filter((f) => (f.unpacked?.ignored.length ?? 0) > 0)
    .map(
      (f) =>
        `Beim Entpacken von ${f.id} übersprungen (Betriebssystem-Dateien): ${(f.unpacked?.ignored ?? []).join(", ")}`,
    );
  sections.push({
    title: "Quelldateien",
    paragraphs: [
      "Alle hochgeladenen Dateien werden unverändert mit ihrer SHA-256-Prüfsumme aufbewahrt. Aus ZIP-Archiven entpackte Dateien sind zusätzlich einzeln gespeichert; das Archiv selbst bleibt als Original erhalten.",
      ...unpackNotes,
    ],
    table: {
      headers: ["Nr.", "Datei", "Dateiart", "Bytes", "SHA-256"],
      widths: [6, 30, 17, 9, 38],
      mono: [4],
      rows: input.files.map((f) => {
        let kind = kindLabel(f.kind);
        if (f.kind !== f.detectedKind) kind += ` (erkannt: ${kindLabel(f.detectedKind)})`;
        if (f.unpacked) kind += ` (entpackt: ${plural(f.unpacked.files, "Datei", "Dateien")})`;
        if (f.ignored) kind += " (ignoriert)";
        return [f.id, f.container ? `${f.name} (aus ${f.container})` : f.name, kind, thousands(f.bytes), f.sha256];
      }),
    },
  });

  const csv = input.files.filter((f) => isMappedCsvKind(f.kind) && !f.ignored);
  if (csv.length > 0) {
    sections.push({
      title: "Spaltenzuordnung",
      paragraphs: csv.map((f) =>
        [
          `${f.id} ${f.name} – ${kindLabel(f.kind)}`,
          ...(f.encoding ? [`Kodierung ${f.encoding}`] : []),
          ...(f.delimiter ? [`Trennzeichen „${f.delimiter}“`] : []),
          ...(f.rows !== undefined ? [plural(f.rows, "Zeile", "Zeilen")] : []),
        ].join(", "),
      ),
      table: {
        headers: ["Datei", "Feld", "Spalte in der Datei"],
        widths: [10, 45, 45],
        rows: csv.flatMap((f) =>
          Object.entries(input.mapping[f.id]?.columns ?? {}).map(([field, header]) => [
            f.id,
            isMappedCsvKind(f.kind) ? targetLabel(f.kind, field) : field,
            header,
          ]),
        ),
      },
    });
  }

  const open = input.preview?.openItems;
  sections.push({
    title: "Mengen",
    table: {
      headers: ["Art", "Anzahl"],
      widths: [70, 30],
      rows: [
        ...Object.entries(input.stats).map(([k, n]) => [STAT_LABELS[k] ?? k, thousands(n)]),
        ...(open ? [["Summe offene Posten", `${open.count} · ${euro(open.totalCents)}`]] : []),
      ],
    },
  });

  const d = input.decisions ?? {};
  const r = input.resolutions;
  const excluded = r.excluded ?? [];
  const assigned = Object.entries(r.pdfAssignments ?? {});
  const amounts = Object.entries(r.openAmounts ?? {});
  sections.push({
    title: "Entscheidungen",
    paragraphs: [
      ...(d.numberRanges?.length ? [] : ["Keine Nummernkreise fortgesetzt."]),
      ...(d.missingPdfReason ? [`Ohne Original-PDF übernommen, Begründung: ${d.missingPdfReason}`] : []),
      ...(d.openItemDifference
        ? [
            `Abweichung der offenen Posten bestätigt (IMP-022): Import ${euro(d.openItemDifference.importedCents)}, laut sevdesk ${euro(d.openItemDifference.expectedCents)}.`,
          ]
        : []),
      ...(excluded.length ? [`Ausgeschlossene Zeilen (${excluded.length}): ${excluded.join(", ")}`] : []),
      ...(assigned.length
        ? [`Manuelle PDF-Zuordnungen (${assigned.length}): ${assigned.map(([k, f]) => `${k} → ${f}`).join(", ")}`]
        : []),
      ...(amounts.length
        ? [
            `Eingetragene offene Beträge (${amounts.length}): ${amounts.map(([k, v]) => `${k} = ${euro(v)}`).join(", ")}`,
          ]
        : []),
    ],
    ...(d.numberRanges?.length
      ? {
          table: {
            headers: ["Nummernkreis", "Format", "Zurücksetzen", "Nächste Nummer"],
            widths: [30, 30, 20, 20],
            rows: d.numberRanges.map((n) => [
              RANGE_LABELS[n.rangeKey] ?? n.rangeKey,
              n.format,
              RESET_LABELS[n.resetPolicy] ?? n.resetPolicy,
              String(n.next),
            ]),
          },
        }
      : {}),
  });

  const findings = [...(input.preview?.findings ?? [])]
    .map((f, i) => ({ f, i }))
    .sort((a, b) => SEVERITY_ORDER[a.f.severity] - SEVERITY_ORDER[b.f.severity] || a.i - b.i)
    .map(({ f }) => f);
  const total = input.preview?.findingsTotal ?? findings.length;
  const bySeverity = (s: ProtocolFinding["severity"]) => findings.filter((f) => f.severity === s).length;
  sections.push({
    title: "Befunde und Abweichungen",
    paragraphs: [
      `${plural(total, "Befund", "Befunde")}: ${bySeverity("error")} Fehler, ${plural(bySeverity("warning"), "Warnung", "Warnungen")}, ${plural(bySeverity("info"), "Hinweis", "Hinweise")}.`,
      ...(total > findings.length
        ? [
            `Die Vorschau speichert höchstens ${PROTOCOL_FINDING_LIMIT} Befunde: aufgeführt sind ${findings.length} von ${total}.`,
          ]
        : []),
      "Abweichungen historischer Belege von heutigen Regeln (EC-190) werden nur dokumentiert; die Belege sind unverändert aus dem sevdesk-Export übernommen.",
    ],
    table: {
      headers: ["Code", "Art", "Datei/Zeile", "Meldung"],
      widths: [11, 10, 17, 62],
      rows: findings.map((f) => [
        f.code,
        SEVERITY_LABELS[f.severity],
        f.fileName ? (f.line !== undefined ? `${f.fileName}:${f.line}` : f.fileName) : "",
        f.message,
      ]),
    },
  });

  const orphans = input.preview?.pdf?.orphans ?? [];
  const missing = input.preview?.pdf?.missing ?? [];
  const ignored = input.files.filter((f) => f.ignored);
  const notImported = input.files.filter(
    // IMP-025/026: voucher images and the DATEV export are read now; only unrecognised files remain.
    (f) => !f.ignored && !isMappedCsvKind(f.kind) && !["pdf", "image", "xml", "zip", "datev"].includes(f.kind),
  );
  const points = [
    ...(orphans.length ? [`PDFs ohne Beleg in der Liste (nicht übernommen): ${orphans.join(", ")}`] : []),
    ...(missing.length ? [`Belege ohne Original-PDF: ${missing.join(", ")}`] : []),
    ...(ignored.length ? [`Ignorierte Dateien: ${ignored.map((f) => `${f.id} ${f.name}`).join(", ")}`] : []),
    ...(notImported.length
      ? [
          `Nicht erkannte Dateien (nicht übernommen): ${notImported.map((f) => `${f.id} ${f.name} (${kindLabel(f.kind)})`).join(", ")}`,
        ]
      : []),
  ];
  sections.push({ title: "Offene Punkte", paragraphs: points.length ? points : ["Keine."] });

  sections.push({ title: "Ablauf", paragraphs: input.log.length ? [...input.log] : ["Keine Einträge."] });

  const day = DATE_ISO.format(c.finishedAt);
  return {
    title: "Importprotokoll sevdesk-Export",
    subtitle: `Import ${input.importId} · abgeschlossen ${at(c.finishedAt)}`,
    fileName: `Importprotokoll_${day}_${input.importId}.pdf`,
    createdAt: c.finishedAt,
    sections,
    footer: `Importprotokoll ${input.importId} · ${input.importerVersion}`,
  };
}
