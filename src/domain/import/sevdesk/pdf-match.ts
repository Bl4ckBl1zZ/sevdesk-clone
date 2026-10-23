/**
 * PDF matching (F09 IMP-019, §4.3.5 steps 1, 2 and 4; E-IMP-07, E-IMP-22, E-IMP-23). Document files are matched to
 * list rows by the original document number in the file name after normalisation. The text-layer fallback
 * (step 3) needs a PDF parser in a Node action and follows later; until then unmatched rows use a manual assignment.
 */

/** §4.3.5 step 1: lower case, no extension, no leading document words, separators collapsed to „-“. */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.(pdf|xml|jpe?g|png)$/i, "")
    .replace(/^(rechnungskorrektur|stornorechnung|rechnung|gutschrift|storno|korrektur|invoice)(?=[\s_\-./]|\d|$)/, "")
    .replace(/[\s_\-./]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface MatchFile {
  readonly id: string;
  readonly name: string;
  readonly sha256: string;
}

export interface MatchRow {
  readonly key: string;
  readonly number: string;
}

export interface PdfMatchResult {
  /** Row key → file id. */
  readonly matched: Readonly<Record<string, string>>;
  /** Row key → candidate file ids (E-IMP-22, row blocked until assigned). */
  readonly ambiguous: Readonly<Record<string, string[]>>;
  /** Valid rows without a file (E-IMP-07, need the „ohne Original-PDF“ confirmation). */
  readonly missing: string[];
  /** Files no row claims (E-IMP-23, listed, not imported). */
  readonly orphans: string[];
  /** Files skipped as byte-identical copies of another upload (same SHA-256 under several names). */
  readonly duplicates: string[];
}

/**
 * Matches rows to files. `assignments` (row key → file id) are the owner's manual choices and win; an assigned
 * file is taken away from every other row.
 */
export function matchFiles(
  rows: readonly MatchRow[],
  files: readonly MatchFile[],
  assignments: Readonly<Record<string, string>> = {},
): PdfMatchResult {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  const unique: MatchFile[] = [];
  for (const f of files) {
    if (seen.has(f.sha256)) duplicates.push(f.id);
    else {
      seen.set(f.sha256, f.id);
      unique.push(f);
    }
  }
  const assigned = new Set(Object.values(assignments));
  // Files unpacked from a ZIP (IMP-016) carry their inner path; only the base name is the document's file name.
  const baseName = (name: string) => name.split(/[\\/]/).at(-1) ?? name;
  const normFiles = unique
    .filter((f) => !assigned.has(f.id))
    .map((f) => ({ f, n: normalizeForMatch(baseName(f.name)) }));
  const exact = new Map<string, string[]>(); // file id → rows with exact equality
  const contains = new Map<string, string[]>(); // file id → rows contained as whole token sequence
  for (const r of rows) {
    if (assignments[r.key]) continue;
    const n = normalizeForMatch(r.number);
    if (n === "") continue;
    for (const { f, n: fn } of normFiles) {
      if (fn === n) exact.set(f.id, [...(exact.get(f.id) ?? []), r.key]);
      else if (`-${fn}-`.includes(`-${n}-`)) contains.set(f.id, [...(contains.get(f.id) ?? []), r.key]);
    }
  }
  // A file's candidate rows: exact matches win over containment.
  const fileRows = new Map<string, string[]>();
  for (const { f } of normFiles) {
    const rowsForFile = exact.get(f.id) ?? contains.get(f.id) ?? [];
    if (rowsForFile.length > 0) fileRows.set(f.id, rowsForFile);
  }
  const rowFiles = new Map<string, string[]>();
  for (const [fileId, keys] of fileRows) for (const k of keys) rowFiles.set(k, [...(rowFiles.get(k) ?? []), fileId]);

  const matched: Record<string, string> = {};
  const ambiguous: Record<string, string[]> = {};
  for (const [key, fileId] of Object.entries(assignments)) {
    if (rows.some((r) => r.key === key) && unique.some((f) => f.id === fileId)) matched[key] = fileId;
  }
  for (const r of rows) {
    if (matched[r.key]) continue;
    const candidates = rowFiles.get(r.key) ?? [];
    if (candidates.length === 0) continue;
    const [only] = candidates;
    if (candidates.length === 1 && only !== undefined && (fileRows.get(only)?.length ?? 0) === 1) matched[r.key] = only;
    else ambiguous[r.key] = candidates;
  }
  const used = new Set([...Object.values(matched), ...Object.values(ambiguous).flat()]);
  return {
    matched,
    ambiguous,
    missing: rows.filter((r) => !matched[r.key] && !ambiguous[r.key]).map((r) => r.key),
    orphans: unique.filter((f) => !used.has(f.id)).map((f) => f.id),
    duplicates,
  };
}
