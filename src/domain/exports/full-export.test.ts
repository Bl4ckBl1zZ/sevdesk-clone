import { describe, expect, test } from "vitest";
import {
  base64ToHex,
  buildManifest,
  checkpointPayload,
  fullExportReadme,
  ndjson,
  restoreCheckpointWarning,
  restoreHeadIssue,
  sha256Sums,
  storedFilePath,
  verifyManifest,
} from "./full-export";

const manifest = buildManifest({
  appVersion: "1.4.0",
  schemaVersion: "p0-1",
  instanceName: "rechnungen",
  exportedAt: "2026-10-19T10:00:00.000Z",
  auditHead: { seq: 42, hash: "ab".repeat(32) },
  lastCheckpoint: { date: "2026-10-18", lastSeq: 40, lastHash: "cd".repeat(32) },
  tables: { salesDocuments: 3, auditLog: 42 },
  files: [
    { path: "tables/salesDocuments.ndjson", sha256: "1".repeat(64), bytes: 10 },
    { path: "files/aa.pdf", sha256: "aa", bytes: 5 },
  ],
});

describe("Vollexport (F09 EXP-023)", () => {
  test("EXP-023 the manifest carries versions, instance, time, audit head, checkpoint, row counts and file hashes", () => {
    expect(manifest).toMatchObject({
      format: "rechnungen-vollexport/1",
      appVersion: "1.4.0",
      instanceName: "rechnungen",
      auditHead: { seq: 42 },
      lastCheckpoint: { date: "2026-10-18", lastSeq: 40 },
      snapshot: { included: false },
      tables: { auditLog: 42, salesDocuments: 3 },
    });
    expect(Object.keys(manifest.tables)).toEqual(["auditLog", "salesDocuments"]);
    expect(manifest.files.map((f) => f.path)).toEqual(["files/aa.pdf", "tables/salesDocuments.ndjson"]);
    expect(sha256Sums(manifest.files)).toBe(`aa  files/aa.pdf\n${"1".repeat(64)}  tables/salesDocuments.ndjson\n`);
    const readme = fullExportReadme(manifest);
    expect(readme).toContain("seq 42");
    expect(readme).toContain("convex-snapshot.zip ist nicht enthalten");
    expect(readme).toContain("sha256sum -c SHA256SUMS.txt");
  });

  test("EXP-023 files are named by their hex SHA-256 with an extension from the content type; tables as NDJSON", () => {
    expect(base64ToHex("3q2+7w==")).toBe("deadbeef");
    expect(storedFilePath("deadbeef", "application/pdf")).toBe("files/deadbeef.pdf");
    expect(storedFilePath("deadbeef", "text/xml; charset=utf-8")).toBe("files/deadbeef.xml");
    expect(storedFilePath("deadbeef", undefined)).toBe("files/deadbeef");
    expect(ndjson([{ a: 1 }, { b: "x" }])).toBe('{"a":1}\n{"b":"x"}\n');
    expect(ndjson([])).toBe("");
  });
});

describe("restore checks (F09 EXP-024)", () => {
  test("EXP-024 E-EXP-39 a changed or missing file is reported with its path", () => {
    const ok = new Map(manifest.files.map((f) => [f.path, f.sha256]));
    expect(verifyManifest(manifest, ok)).toBeNull();
    const tampered = new Map(ok).set("files/aa.pdf", "bb");
    expect(verifyManifest(manifest, tampered)).toEqual({
      code: "EXPORT_FILE_TAMPERED",
      message: "Die Exportdatei ist beschädigt oder verändert (files/aa.pdf).",
      params: { datei: "files/aa.pdf" },
    });
  });

  test("EXP-024 E-EXP-40 E-EXP-41 head mismatch blocks; a newer off-host checkpoint warns", () => {
    const expected = { seq: 42, hash: "ab".repeat(32) };
    expect(restoreHeadIssue(expected, expected)).toBeNull();
    expect(restoreHeadIssue(expected, { seq: 41, hash: "x" })?.message).toBe(
      "Prüfkette nach Wiederherstellung weicht ab (seq 41). Bitte nicht weiterarbeiten.",
    );
    const fmt = () => "18.10.2026, 04:00";
    expect(restoreCheckpointWarning({ seq: 42, at: 0 }, { date: "2026-10-18", lastSeq: 42 }, fmt)).toBeNull();
    expect(restoreCheckpointWarning({ seq: 42, at: 0 }, { date: "2026-10-19", lastSeq: 50 }, fmt)?.message).toBe(
      "Die Sicherung ist älter als der letzte Prüfpunkt (19.10.2026). Daten nach 18.10.2026, 04:00 fehlen und müssen nacherfasst werden.",
    );
    const payload = btoa(JSON.stringify({ date: "2026-10-19", lastSeq: 50, lastHash: "h" })).replace(/=+$/, "");
    expect(checkpointPayload(`eyJhbGciOiJFUzI1NiJ9.${payload}.sig`)).toEqual({
      date: "2026-10-19",
      lastSeq: 50,
      lastHash: "h",
    });
    expect(checkpointPayload("garbage")).toBeNull();
  });
});
