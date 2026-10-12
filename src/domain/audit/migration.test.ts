import { describe, expect, test } from "vitest";
import {
  blockingViolations,
  MIGRATION_CHECKED_INVARIANTS,
  migrationAbortMessage,
  protectedChanges,
  snapshotProtected,
  validateMigrationName,
} from "./migration";

describe("AUD-028 migration safety (pure part)", () => {
  test("AUD-028 RI-01, RI-04 and RI-14 errors block a migration; warnings and other invariants do not", () => {
    expect(MIGRATION_CHECKED_INVARIANTS).toEqual(["RI-01", "RI-04", "RI-14"]);
    const v = blockingViolations([
      { id: "RI-14", severity: "ERROR", message: "seq gap" },
      { id: "RI-04", severity: "WARN", message: "w" },
      { id: "RI-15", severity: "ERROR", message: "unaudited" },
      { id: "RI-01", severity: "ERROR", message: "hash" },
    ]);
    expect(v.map((x) => x.id)).toEqual(["RI-14", "RI-01"]);
  });

  test("AUD-028 GOBD-23 EC-184 existing protected rows must stay byte-identical; new rows are allowed", () => {
    const before = snapshotProtected({
      auditLog: [{ _id: "a1", _creationTime: 1, seq: 1, hash: "h1" }],
      companyProfileVersions: [{ _id: "v1", _creationTime: 2, version: 1, data: { name: "Muster" } }],
    });
    const same = snapshotProtected({
      auditLog: [
        { _id: "a1", _creationTime: 1, seq: 1, hash: "h1" },
        { _id: "a2", _creationTime: 3, seq: 2, hash: "h2" },
      ],
      companyProfileVersions: [{ _id: "v1", _creationTime: 2, data: { name: "Muster" }, version: 1 }],
    });
    expect(protectedChanges(before, same)).toEqual([]);

    const changed = snapshotProtected({
      auditLog: [],
      companyProfileVersions: [{ _id: "v1", _creationTime: 2, version: 1, data: { name: "Neu" } }],
    });
    expect(protectedChanges(before, changed)).toEqual([
      { table: "auditLog", id: "a1", change: "deleted" },
      { table: "companyProfileVersions", id: "v1", change: "changed" },
    ]);
  });

  test("AUD-028 E-AUD-17 abort message and migration names", () => {
    expect(migrationAbortMessage("2026-11-add-unit")).toBe(
      "Migration 2026-11-add-unit abgebrochen: geschützte Inhalte würden verändert.",
    );
    expect(validateMigrationName("2026-11-add-unit")).toBe(true);
    expect(validateMigrationName("Drop Table")).toBe(false);
    expect(validateMigrationName("")).toBe(false);
  });
});
