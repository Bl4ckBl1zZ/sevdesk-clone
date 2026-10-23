import { describe, expect, test } from "vitest";
import { BACKUP_SOURCES, evaluateBackup, latestOf, parseListObjects, worstStatus } from "./backups";

const NOW = Date.UTC(2026, 9, 19, 6, 0);
const H = 3_600_000;
const [pg, exp, vol] = BACKUP_SOURCES as [
  (typeof BACKUP_SOURCES)[number],
  (typeof BACKUP_SOURCES)[number],
  (typeof BACKUP_SOURCES)[number],
];

describe("backup status (AUD-026)", () => {
  test("AUD-026 Postgres/export: > 26 h warning, > 50 h error; volume: > 8 days warning, never error", () => {
    const at = (hours: number) => ({ key: "k", at: NOW - hours * H, bytes: 10 });
    expect(evaluateBackup(pg, at(25), NOW).status).toBe("ok");
    expect(evaluateBackup(pg, at(27), NOW).status).toBe("warning");
    expect(evaluateBackup(exp, at(51), NOW)).toMatchObject({
      status: "error",
      detail: "Letzte Datenbanksicherung vor 51 Stunden.",
    });
    expect(evaluateBackup(vol, at(7 * 24), NOW).status).toBe("ok");
    expect(evaluateBackup(vol, at(9 * 24), NOW).status).toBe("warning");
    expect(evaluateBackup(vol, at(90 * 24), NOW).status).toBe("warning");
    expect(evaluateBackup(pg, null, NOW)).toMatchObject({ status: "error", ageHours: null });
    expect(worstStatus(["ok", "warning", "unknown"])).toBe("warning");
    expect(worstStatus([])).toBe("ok");
  });

  test("E-AUD-43 a backup older than the threshold is a warning/error naming its age in hours", () => {
    const at = (hours: number) => ({ key: "k", at: NOW - hours * H, bytes: 10 });
    expect(evaluateBackup(pg, at(30.5), NOW)).toMatchObject({
      status: "warning",
      detail: "Letzte Datenbanksicherung vor 30 Stunden.",
    });
    expect(evaluateBackup(pg, at(55), NOW)).toMatchObject({
      status: "error",
      detail: "Letzte Datenbanksicherung vor 55 Stunden.",
    });
    expect(evaluateBackup(vol, at(200), NOW)).toMatchObject({
      status: "warning",
      detail: "Letzte Datenbanksicherung vor 200 Stunden.",
    });
    expect(evaluateBackup(pg, at(4), NOW)).toMatchObject({ status: "ok", detail: "Letzte Sicherung vor 4 Stunden." });
  });

  test("AUD-026 parses S3 ListObjectsV2 pages and picks the newest object", () => {
    const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated>
      <Contents><Key>postgres/a.sql.gz</Key><LastModified>2026-10-18T02:00:00.000Z</LastModified><Size>100</Size></Contents>
      <Contents><Key>postgres/b.sql.gz</Key><LastModified>2026-10-19T02:00:00.000Z</LastModified><Size>120</Size></Contents>
      <NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>`;
    const page = parseListObjects(xml);
    expect(page.next).toBe("tok==");
    expect(latestOf(page.objects)).toEqual({ key: "postgres/b.sql.gz", at: Date.UTC(2026, 9, 19, 2), bytes: 120 });
    expect(parseListObjects("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>")).toEqual({
      objects: [],
      next: null,
    });
  });
});
