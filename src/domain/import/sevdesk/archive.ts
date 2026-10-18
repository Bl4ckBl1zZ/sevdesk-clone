/**
 * ZIP uploads of the sevdesk export import (F09 IMP-016, IMP-018, §4.3.1 container row, E-IMP-29/39/40).
 *
 * sevdesk delivers the invoice PDFs as a flat `Rechnungen_<dd.mm.yy>.zip` (verified 2026-10-18) and the GoBD/
 * „Datenexport“ as a ZIP of CSVs and files (layout UNSURE). Each contained file is handed to `visit` one at a time
 * (the caller classifies, hashes and stores it like a single upload), so memory stays at archive + one entry.
 *
 * Safety (decided 2026-10-18, F09 §5.3): the whole central directory of an archive is checked before its first
 * entry is extracted — path traversal, absolute paths, symlinks, encrypted entries (E-IMP-41), more than 10.000
 * entries or an entry above the 50 MB per-file limit (E-IMP-40), compression ratio above 100:1 for entries of at
 * least 1 MB (small repetitive CSVs compress better than that legitimately), expanded total above the import's
 * remaining 2 GB budget. Any violation rejects the whole archive: a partially imported export would silently miss
 * records. Directories and OS metadata (`__MACOSX/`, `._*`, `.DS_Store`, `Thumbs.db`, `desktop.ini`) are skipped
 * and reported. Nested ZIPs are unpacked (inner paths `inner.zip/file.pdf`) up to 3 levels; deeper → E-IMP-29.
 */
import { extractZipEntry, readZipDirectory, type ZipCentralEntry } from "../../archive/zip";
import { err, type Issue, ok, type Result } from "../../result";
import { IMPORT_FILE_MAX_BYTES, IMPORT_TOTAL_MAX_BYTES } from "./files";

export interface ImportZipLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRatio: number;
  readonly ratioFloorBytes: number;
  readonly maxDepth: number;
}

export const IMPORT_ZIP_LIMITS: ImportZipLimits = {
  maxEntries: 10_000,
  maxEntryBytes: IMPORT_FILE_MAX_BYTES,
  maxTotalBytes: IMPORT_TOTAL_MAX_BYTES,
  maxRatio: 100,
  ratioFloorBytes: 1024 * 1024,
  maxDepth: 3,
};

export type ImportZipErrorCode = "E-IMP-29" | "E-IMP-41" | "E-IMP-40";

export interface ImportZipEntry {
  /** Path inside the upload; nested archives prefix their own path (`innen.zip/RE-1.pdf`). */
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface ImportZipSummary {
  readonly files: number;
  readonly expandedBytes: number;
  /** Skipped OS metadata (shown to the owner); directories are not listed. */
  readonly ignored: string[];
}

/** Local file header or the end record of an empty archive. */
export const isZipBytes = (b: Uint8Array): boolean =>
  b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && ((b[2] === 3 && b[3] === 4) || (b[2] === 5 && b[3] === 6));

const JUNK_SEGMENTS = new Set(["__macosx", ".spotlight-v100", ".trashes", ".fseventsd"]);
const JUNK_FILES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

function isJunk(path: string): boolean {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const base = (parts.at(-1) ?? "").toLowerCase();
  return parts.some((p) => JUNK_SEGMENTS.has(p.toLowerCase())) || JUNK_FILES.has(base) || base.startsWith("._");
}

function unsafePath(path: string): string | null {
  if (path === "" || path.includes("\0")) return `Ein Eintrag hat keinen gültigen Namen.`;
  if (/^[\\/]/.test(path) || /^[a-z]:/i.test(path)) return `„${path}“ ist ein absoluter Pfad.`;
  if (path.split(/[\\/]/).includes("..")) return `„${path}“ zeigt aus dem Archiv heraus.`;
  return null;
}

const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const megabytes = (n: number) => `${Math.round(n / (1024 * 1024))} MB`;

class ZipRejected extends Error {
  constructor(readonly issue: Issue<ImportZipErrorCode>) {
    super(issue.message);
  }
}

interface Budget {
  entries: number;
  bytes: number;
  files: number;
  ignored: string[];
}

/**
 * Unpacks `bytes` (the upload `name`) and calls `visit` for every contained file in archive order. Returns the
 * first violation as a German E-IMP-29/39/40 issue; errors thrown by `visit` propagate unchanged.
 */
export async function unpackImportZip(
  name: string,
  bytes: Uint8Array,
  visit: (entry: ImportZipEntry) => Promise<void>,
  opts: { limits?: ImportZipLimits; usedBytes?: number } = {},
): Promise<Result<ImportZipSummary, Issue<ImportZipErrorCode>>> {
  const limits = opts.limits ?? IMPORT_ZIP_LIMITS;
  const budget: Budget = { entries: 0, bytes: opts.usedBytes ?? 0, files: 0, ignored: [] };
  const reject = (code: ImportZipErrorCode, message: string): never => {
    throw new ZipRejected({ code, message });
  };
  const invalid = (reason: string): never =>
    reject("E-IMP-29", `Die ZIP-Datei ${name} ist ungültig oder zu groß: ${reason}`);

  async function walk(archive: Uint8Array, prefix: string, depth: number): Promise<void> {
    const dir = readZipDirectory(archive);
    if (!dir.ok) return invalid(dir.error.message);
    const files: ZipCentralEntry[] = [];
    for (const e of dir.value) {
      const path = `${prefix}${e.path}`;
      const unsafe = unsafePath(e.path);
      if (unsafe) invalid(unsafe.replace(e.path, path));
      if (e.isSymlink) invalid(`„${path}“ ist eine symbolische Verknüpfung.`);
      if (e.isDirectory) continue;
      if (e.encrypted) {
        reject(
          "E-IMP-41",
          `Die ZIP-Datei ${name} enthält verschlüsselte Dateien (${path}). Bitte das Archiv ohne Passwort erstellen und erneut hochladen.`,
        );
      }
      if (isJunk(e.path)) {
        budget.ignored.push(path);
        continue;
      }
      budget.entries += 1;
      if (budget.entries > limits.maxEntries) {
        reject(
          "E-IMP-40",
          `Die ZIP-Datei ${name} enthält mehr als ${thousands(limits.maxEntries)} Dateien. Bitte auf mehrere Archive aufteilen.`,
        );
      }
      if (e.size > limits.maxEntryBytes) {
        reject(
          "E-IMP-40",
          `${path} in ${name} ist entpackt größer als ${megabytes(limits.maxEntryBytes)}. Bitte die Datei einzeln hochladen.`,
        );
      }
      if (e.size >= limits.ratioFloorBytes && e.size > limits.maxRatio * Math.max(1, e.compressedSize)) {
        invalid(`„${path}“ ist ungewöhnlich stark komprimiert (über ${limits.maxRatio}:1).`);
      }
      budget.bytes += e.size;
      if (budget.bytes > limits.maxTotalBytes) {
        invalid(`Entpackt wären die Dateien größer als ${IMPORT_TOTAL_MAX_BYTES / 1024 ** 3} GB je Import.`);
      }
      files.push(e);
    }
    for (const e of files) {
      const path = `${prefix}${e.path}`;
      const data = extractZipEntry(archive, e);
      if (!data.ok) return invalid(data.error.message.replace(`„${e.path}“`, `„${path}“`));
      if (isZipBytes(data.value)) {
        if (depth >= limits.maxDepth) invalid(`Archive sind tiefer als ${limits.maxDepth} Ebenen verschachtelt.`);
        // The inner archive counts as one entry of the outer one; its own entries count against the same budget.
        budget.bytes -= e.size;
        budget.entries -= 1;
        await walk(data.value, `${path}/`, depth + 1);
        continue;
      }
      budget.files += 1;
      await visit({ path, bytes: data.value });
    }
  }

  try {
    await walk(bytes, "", 1);
  } catch (e) {
    if (e instanceof ZipRejected) return err(e.issue);
    throw e;
  }
  return ok({ files: budget.files, expandedBytes: budget.bytes - (opts.usedBytes ?? 0), ignored: budget.ignored });
}
