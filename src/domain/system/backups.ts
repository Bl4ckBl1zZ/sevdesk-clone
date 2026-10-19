/**
 * Backup status (F12 AUD-026, SEC-05, GOBD-09; 02 §7 `backups.verify`). The R2 backup bucket of the Dokploy
 * destination is listed with read-only credentials; per source the latest object's time and size are evaluated
 * against the ops thresholds of AUD-026 (Postgres / Convex export > 26 h warning, > 50 h error; Convex volume
 * > 8 days warning). Plus the latest object of the checkpoint bucket and whether a bucket-lock rule is visible
 * (recommended, not required). Pure; `now` is passed in.
 */

export type BackupStatus = "ok" | "warning" | "error" | "unknown";

export interface BackupSource {
  readonly prefix: string;
  readonly label: string;
  readonly warnHours: number;
  readonly errorHours: number | null;
}

export const BACKUP_SOURCES: readonly BackupSource[] = [
  { prefix: "postgres/", label: "Dokploy-Datenbank (Postgres)", warnHours: 26, errorHours: 50 },
  { prefix: "convex-export/", label: "Convex-Export", warnHours: 26, errorHours: 50 },
  { prefix: "convex-volume/", label: "Convex-Volume", warnHours: 8 * 24, errorHours: null },
];

export interface LatestObject {
  readonly key: string;
  readonly at: number;
  readonly bytes: number;
}

export interface BackupRow {
  prefix: string;
  label: string;
  latest: LatestObject | null;
  ageHours: number | null;
  status: BackupStatus;
  detail: string;
}

const HOUR = 3_600_000;

const ageText = (hours: number): string =>
  hours < 48 ? `vor ${Math.floor(hours)} Stunden` : `vor ${Math.floor(hours / 24)} Tagen`;

export function evaluateBackup(source: BackupSource, latest: LatestObject | null, now: number): BackupRow {
  const base = { prefix: source.prefix, label: source.label, latest };
  if (!latest) {
    return { ...base, ageHours: null, status: "error", detail: `Keine Sicherung unter ${source.prefix} gefunden.` };
  }
  const ageHours = Math.max(0, (now - latest.at) / HOUR);
  const status: BackupStatus =
    source.errorHours !== null && ageHours > source.errorHours
      ? "error"
      : ageHours > source.warnHours
        ? "warning"
        : "ok";
  const detail =
    status === "ok" ? `Letzte Sicherung ${ageText(ageHours)}.` : `Letzte Sicherung ${ageText(ageHours)} – zu alt.`;
  return { ...base, ageHours, status, detail };
}

const RANK: Record<BackupStatus, number> = { ok: 0, unknown: 1, warning: 2, error: 3 };

export function worstStatus(statuses: readonly BackupStatus[]): BackupStatus {
  return statuses.reduce<BackupStatus>((w, s) => (RANK[s] > RANK[w] ? s : w), "ok");
}

/** S3 ListObjectsV2 XML → objects (Key, LastModified, Size) and the continuation token. */
export function parseListObjects(xml: string): { objects: LatestObject[]; next: string | null } {
  const objects: LatestObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = m[1] ?? "";
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    const at = modified ? Date.parse(modified) : Number.NaN;
    if (key && !Number.isNaN(at)) objects.push({ key, at, bytes: Number(size ?? 0) });
  }
  const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
  const next = truncated ? (/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null) : null;
  return { objects, next };
}

export const latestOf = (objects: readonly LatestObject[]): LatestObject | null =>
  objects.reduce<LatestObject | null>((best, o) => (!best || o.at > best.at ? o : best), null);
