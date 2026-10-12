/** Requirement IDs: UST-06, INV-012, EC-013, RI-02, EC-DOC-01, ER03-01, T07-151, BUG-123, … */
export const ID_SOURCE = String.raw`[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d+[a-z]?`;
export const ID_RE = new RegExp(`^${ID_SOURCE}$`);

/** IDs at the start of a test title: "INV-012 …", "EC-013/RI-02 …", "UST-09, UST-10 …". */
const LEADING_IDS_RE = new RegExp(`^\\s*(${ID_SOURCE}(?:\\s*[,/+&]\\s*${ID_SOURCE}|\\s+${ID_SOURCE}(?=[\\s,/+&]))*)`);

export function leadingIds(title: string): string[] {
  const m = LEADING_IDS_RE.exec(title);
  if (!m?.[1]) return [];
  return m[1].split(/[\s,/+&]+/).filter((s) => ID_RE.test(s));
}

/** IDs that are allowed in test names without a spec entry (regression tests for issues). */
export function isAdHocId(id: string): boolean {
  return id.startsWith("BUG-");
}
