import { canonicalize } from "./canonical";

/**
 * Migration safety (F12 AUD-028, GOBD-23, EC-184). A schema/data migration may add fields with defaults or new
 * rows, but must never rewrite snapshot, artifact or audit content: the runner (`convex/model/migrations.ts`)
 * checks RI-01/04/14 before and after and compares a snapshot of every protected table (immutability matrix).
 * Any difference aborts the migration transaction (E-AUD-17).
 */
export const MIGRATION_CHECKED_INVARIANTS = ["RI-01", "RI-04", "RI-14"] as const;

export interface MigrationViolation {
  id: string;
  severity: "ERROR" | "WARN";
  message: string;
}

export function blockingViolations<V extends MigrationViolation>(violations: readonly V[]): V[] {
  return violations.filter(
    (v) => v.severity === "ERROR" && (MIGRATION_CHECKED_INVARIANTS as readonly string[]).includes(v.id),
  );
}

/** `table:id` → canonical content (system fields excluded) of every row of the protected tables. */
export type ProtectedSnapshot = ReadonlyMap<string, { table: string; id: string; content: string }>;

export function snapshotProtected(
  rows: Readonly<Record<string, readonly Record<string, unknown>[]>>,
): ProtectedSnapshot {
  const out = new Map<string, { table: string; id: string; content: string }>();
  for (const [table, docs] of Object.entries(rows)) {
    for (const doc of docs) {
      const { _id, _creationTime, ...rest } = doc;
      const id = String(_id);
      out.set(`${table}:${id}`, { table, id, content: canonicalize(rest) });
    }
  }
  return out;
}

export interface ProtectedChange {
  table: string;
  id: string;
  change: "changed" | "deleted";
}

/** Rows that existed before and were changed or removed; rows added by the migration are fine. */
export function protectedChanges(before: ProtectedSnapshot, after: ProtectedSnapshot): ProtectedChange[] {
  const out: ProtectedChange[] = [];
  for (const [key, row] of before) {
    const now = after.get(key);
    if (!now) out.push({ table: row.table, id: row.id, change: "deleted" });
    else if (now.content !== row.content) out.push({ table: row.table, id: row.id, change: "changed" });
  }
  return out;
}

/** E-AUD-17 */
export function migrationAbortMessage(name: string): string {
  return `Migration ${name} abgebrochen: geschützte Inhalte würden verändert.`;
}

/** Names become part of the actor `system:migration.<name>` (02 §4.3). */
export function validateMigrationName(name: string): boolean {
  return /^[a-z0-9][a-z0-9-]{2,63}$/.test(name);
}
