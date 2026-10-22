/**
 * F09 EXP-023 Vollexport (readable archive) and EXP-024 restore checks (E-EXP-38…41). Pure.
 *
 * SPEC-GAP EXP-023 (a)(d) and `age` encryption: the archive does not contain `convex-snapshot.zip` (the self-hosted
 * Convex export API needs the deployment admin key, which the app does not hold), no `gdpdu/` (P3) and is not
 * encrypted. The restorable snapshot is the daily `convex-export/` backup (deploy/runbooks/restore.md); this archive
 * is the readable copy (GoBD long-term readability, 08 §7) with tables as NDJSON, every stored file and a manifest.
 */
import { type Issue, issue } from "../result";

export const FULL_EXPORT_FORMAT = "rechnungen-vollexport/1";

/** Upper bound for files + table data processed in one export action (the archive is assembled in memory). */
export const FULL_EXPORT_MAX_BYTES = 150 * 1024 * 1024;

export interface ManifestFile {
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface FullExportManifest {
  readonly format: typeof FULL_EXPORT_FORMAT;
  readonly appVersion: string;
  readonly schemaVersion: string;
  readonly instanceName: string;
  readonly exportedAt: string;
  /** Audit chain head at the export (E-EXP-37: the tables are read after it, so later entries may appear). */
  readonly auditHead: { readonly seq: number; readonly hash: string } | null;
  /**
   * E-EXP-37: the readable tables are read page by page after `auditHead`, so they are not a point-in-time snapshot.
   * When the chain moved while the export ran, the audit entries written meanwhile are named here (seq range) —
   * rows they touched may or may not be in the tables; `auditHead` stays the reference for a restore check.
   */
  readonly writesDuringExport: { readonly fromSeq: number; readonly toSeq: number } | null;
  readonly lastCheckpoint: { readonly date: string; readonly lastSeq: number; readonly lastHash: string } | null;
  readonly snapshot: { readonly included: false; readonly reason: string };
  readonly tables: Readonly<Record<string, number>>;
  readonly files: readonly ManifestFile[];
}

export const SNAPSHOT_NOT_INCLUDED =
  "convex-snapshot.zip ist nicht enthalten: Die wiederherstellbare Sicherung ist der tägliche convex-export (Runbook Wiederherstellung).";

export function buildManifest(
  input: Omit<FullExportManifest, "format" | "snapshot" | "files" | "writesDuringExport"> & {
    files: readonly ManifestFile[];
    /** Seqs of other actors' audit entries written while the tables were read (E-EXP-37; the job's own excluded). */
    otherWritesSeqs?: readonly number[];
  },
): FullExportManifest {
  const seqs = input.otherWritesSeqs ?? [];
  return {
    format: FULL_EXPORT_FORMAT,
    appVersion: input.appVersion,
    schemaVersion: input.schemaVersion,
    instanceName: input.instanceName,
    exportedAt: input.exportedAt,
    auditHead: input.auditHead,
    writesDuringExport: seqs.length > 0 ? { fromSeq: Math.min(...seqs), toSeq: Math.max(...seqs) } : null,
    lastCheckpoint: input.lastCheckpoint,
    snapshot: { included: false, reason: SNAPSHOT_NOT_INCLUDED },
    tables: Object.fromEntries(Object.entries(input.tables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    files: [...input.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
}

/** `sha256sum -c` compatible list of every file in the manifest. */
export function sha256Sums(files: readonly ManifestFile[]): string {
  return `${files.map((f) => `${f.sha256}  ${f.path}`).join("\n")}\n`;
}

/** E-EXP-39: every manifest file must exist with the recorded SHA-256. */
export function verifyManifest(
  manifest: Pick<FullExportManifest, "files">,
  actual: ReadonlyMap<string, string>,
): Issue<"EXPORT_FILE_TAMPERED"> | null {
  for (const f of manifest.files) {
    if (actual.get(f.path) !== f.sha256) {
      return issue("EXPORT_FILE_TAMPERED", `Die Exportdatei ist beschädigt oder verändert (${f.path}).`, {
        datei: f.path,
      });
    }
  }
  return null;
}

/** Convex stores the SHA-256 of a file as base64; the archive names files by the hex digest. */
export function base64ToHex(b64: string): string {
  const bin = atob(b64);
  let out = "";
  for (let i = 0; i < bin.length; i++) out += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return out;
}

const EXT: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/xml": "xml",
  "text/xml": "xml",
  "application/zip": "zip",
  "application/json": "json",
  "text/csv": "csv",
  "text/plain": "txt",
  "text/markdown": "md",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "message/rfc822": "eml",
};

export function storedFilePath(sha256Hex: string, contentType: string | undefined): string {
  const ext = contentType ? EXT[contentType.split(";")[0]?.trim().toLowerCase() ?? ""] : undefined;
  return `files/${sha256Hex}${ext ? `.${ext}` : ""}`;
}

/** One JSON document per line (`tables/<table>.ndjson`). */
export function ndjson(rows: readonly unknown[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
}

/**
 * E-EXP-42 / AO-06: the owner chooses where the export is stored (the app offers no storage target) — every full
 * export (card and README) carries the warning that books must be kept in the EU (§ 146 Abs. 2 AO).
 */
export const EU_STORAGE_WARNING = "Die Bücher müssen in der EU aufbewahrt werden (§ 146 Abs. 2 AO).";

export function fullExportReadme(m: FullExportManifest): string {
  const head = m.auditHead ? `seq ${m.auditHead.seq}, Hash ${m.auditHead.hash}` : "keine Einträge";
  return [
    `Vollexport ${m.instanceName} vom ${m.exportedAt}`,
    "",
    `Format ${m.format} · App-Version ${m.appVersion} · Schema ${m.schemaVersion}`,
    `Prüfkette (Audit-Log) beim Export: ${head}`,
    ...(m.writesDuringExport
      ? [
          `Während des Exports wurden weitere Änderungen protokolliert (seq ${m.writesDuringExport.fromSeq}–${m.writesDuringExport.toSeq}).`,
          "Die Tabellen können diese Änderungen teilweise enthalten; maßgeblich ist der Prüfkettenkopf oben.",
        ]
      : []),
    m.lastCheckpoint
      ? `Letzter signierter Prüfpunkt: ${m.lastCheckpoint.date} (seq ${m.lastCheckpoint.lastSeq})`
      : "Noch kein signierter Prüfpunkt.",
    "",
    "Inhalt",
    "- tables/<tabelle>.ndjson: alle Tabellen, ein JSON-Dokument je Zeile (UTF-8). Beträge sind ganze Cent",
    "  (*Cents), Einzelpreise 1/10.000 (*Micros), Mengen 1/1.000 (*Milli), Sätze in Basispunkten (*Bp).",
    "- files/<sha256>.<endung>: alle gespeicherten Dateien (PDF, XML, Belege, Anhänge), benannt nach ihrem",
    "  SHA-256; files/index.csv ordnet Speicher-ID, Dateityp und Größe zu.",
    "- manifest.json: Versionen, Zeitpunkt, Prüfkettenkopf, Zeilenzahlen und SHA-256 jeder Datei.",
    "- SHA256SUMS.txt: Prüfsummen zum Abgleich mit `sha256sum -c SHA256SUMS.txt`.",
    "",
    "Personenbezogene Daten gesperrter Kontakte bleiben verschlüsselt (Schlüssel in contactKeys, ohne den",
    "Instanzschlüssel nicht lesbar). Zugangsdaten sind nicht enthalten: API-Schlüssel und Bestätigungstoken nur",
    "als SHA-256, Integrations-Geheimnisse nur verschlüsselt; Anmeldedaten (Passkeys, Sitzungen) liegen nicht in",
    "den App-Tabellen.",
    "",
    "Wiederherstellung",
    `${m.snapshot.reason} Dieser Export ist die lesbare Kopie für die Aufbewahrung (GoBD) und zum Abgleich:`,
    "Nach einer Wiederherstellung bestätigt `restore:complete` mit seq und Hash aus manifest.json, dass die",
    "Prüfkette bis zu diesem Stand unverändert ist (deploy/runbooks/restore.md).",
    "",
    "Aufbewahrung",
    `${EU_STORAGE_WARNING} Diese Datei nur bei einem Speicherort in der EU ablegen (kein Cloud-Speicher`,
    "außerhalb der EU); 10 Jahre aufbewahren und lesbar halten.",
    "",
  ].join("\n");
}

// ── EXP-024 restore checks ──────────────────────────────────────────────────────────────────────────────

export const RESTORE_NOT_EMPTY = "Wiederherstellung ist nur in eine leere Instanz möglich.";

/** E-EXP-40: the chain head after the import must equal the expected head (manifest / backup). */
export function restoreHeadIssue(
  expected: { readonly seq: number; readonly hash: string },
  actual: { readonly seq: number; readonly hash: string } | null,
): Issue<"RESTORE_HEAD_MISMATCH"> | null {
  if (actual && actual.seq === expected.seq && actual.hash === expected.hash) return null;
  const seq = actual?.seq ?? 0;
  return issue(
    "RESTORE_HEAD_MISMATCH",
    `Prüfkette nach Wiederherstellung weicht ab (seq ${seq}). Bitte nicht weiterarbeiten.`,
    { a: seq, expected: expected.seq },
  );
}

/** E-EXP-41: an off-host checkpoint newer than the restored head means data after the backup is missing. */
export function restoreCheckpointWarning(
  head: { readonly seq: number; readonly at: number } | null,
  offHost: { readonly date: string; readonly lastSeq: number } | null,
  formatTime: (ms: number) => string,
): Issue<"RESTORE_OLDER_THAN_CHECKPOINT"> | null {
  if (!offHost || offHost.lastSeq <= (head?.seq ?? 0)) return null;
  const [y, m, d] = offHost.date.split("-");
  const zeit = head ? formatTime(head.at) : "dem Beginn";
  return issue(
    "RESTORE_OLDER_THAN_CHECKPOINT",
    `Die Sicherung ist älter als der letzte Prüfpunkt (${d}.${m}.${y}). Daten nach ${zeit} fehlen und müssen nacherfasst werden.`,
    { datum: offHost.date, lastSeq: offHost.lastSeq },
  );
}

/** The payload of a compact JWS checkpoint (`header.payload.signature`); null if it cannot be read. */
export function checkpointPayload(jws: string): { date: string; lastSeq: number; lastHash: string } | null {
  const part = jws.split(".")[1];
  if (!part) return null;
  try {
    const json = atob(
      part
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(part.length / 4) * 4, "="),
    );
    const p = JSON.parse(json) as { date?: unknown; lastSeq?: unknown; lastHash?: unknown };
    return typeof p.date === "string" && typeof p.lastSeq === "number" && typeof p.lastHash === "string"
      ? { date: p.date, lastSeq: p.lastSeq, lastHash: p.lastHash }
      : null;
  } catch {
    return null;
  }
}
