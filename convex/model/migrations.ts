import { PROTECTED_TABLES } from "../../src/domain/audit/immutability";
import {
  blockingViolations,
  migrationAbortMessage,
  type ProtectedSnapshot,
  protectedChanges,
  snapshotProtected,
  validateMigrationName,
} from "../../src/domain/audit/migration";
import type { TableNames } from "../_generated/dataModel";
import { appError, errorCode } from "../lib/errors";
import schema from "../schema";
import { appendAudit } from "./audit";
import { checkInvariants, type InvariantViolation } from "./invariants";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Migration runner (F12 AUD-028, GOBD-23, EC-184). Every data migration is a registered `Migration` run inside
 * one transaction as `system:migration.<name>`:
 *
 *  1. RI-01/04/14 must hold before (otherwise the migration does not start — fix the data first); `migrations:run`
 *     does this pre-check with the paged action `invariants.run` (any data volume) and then calls `migrations:apply`
 *     with `prechecked`, other callers check in this transaction;
 *  2. a snapshot of every protected table (immutability matrix) is taken;
 *  3. the migration runs on the guarded db (writes to frozen records already fail with `immutable_record`);
 *  4. existing protected rows must be unchanged and RI-01/04/14 must still hold — otherwise E-AUD-17 and the
 *     whole transaction rolls back;
 *  5. a `system.migration` audit entry records the name and the counts.
 *
 * Reads the protected tables in one transaction — fine at P0/P1 volumes; large backfills page with one
 * runner call per batch (each batch is checked the same way).
 */
export interface MigrationCounts {
  scanned: number;
  changed: number;
}

export interface Migration {
  name: string;
  description: string;
  run: (ctx: ModelCtx) => Promise<MigrationCounts>;
}

/** Registered migrations, oldest first. Schema changes that need a backfill add an entry here (none yet). */
export const MIGRATIONS: readonly Migration[] = [];

async function protectedSnapshot(ctx: ReadCtx): Promise<ProtectedSnapshot> {
  const tables = PROTECTED_TABLES.filter((t) => t in schema.tables) as TableNames[];
  const rows: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables) rows[t] = await ctx.db.query(t).collect();
  return snapshotProtected(rows);
}

/** Step 1: the migration does not start while RI-01/04/14 are violated (E-AUD-17 precondition). */
export function assertMigrationPrecondition(name: string, violations: readonly InvariantViolation[]): void {
  const blocking = blockingViolations(violations);
  if (blocking.length === 0) return;
  throw appError("conflict", `Migration ${name} nicht gestartet: Prüfregeln vorher verletzt.`, {
    reason: "MIGRATION_PRECONDITION",
    violations: blocking.map((v) => `${v.id}: ${v.message}`),
  });
}

async function assertInvariantsFor(ctx: ReadCtx, name: string, phase: "vorher" | "nachher") {
  const violations = await checkInvariants(ctx);
  if (phase === "vorher") return assertMigrationPrecondition(name, violations);
  const blocking = blockingViolations(violations);
  if (blocking.length > 0) {
    throw appError("immutable_record", migrationAbortMessage(name), {
      reason: "MIGRATION_PROTECTED_CONTENT",
      violations: blocking.map((v) => `${v.id}: ${v.message}`),
    });
  }
}

export async function runMigration(
  ctx: ModelCtx,
  migration: Migration,
  /** `prechecked`: step 1 already ran (paged) in the calling action, see `migrations:run`. */
  opts: { prechecked?: boolean } = {},
): Promise<MigrationCounts> {
  const { name } = migration;
  if (!validateMigrationName(name)) {
    throw appError("invalid_input", `Ungültiger Migrationsname: ${name}`, { reason: "MIGRATION_NAME" });
  }
  const actor = `system:migration.${name}` as const;
  const mctx: ModelCtx = { ...ctx, actor, role: undefined, actorContext: { actor, channel: "system" } };

  if (!opts.prechecked) await assertInvariantsFor(mctx, name, "vorher");
  const before = await protectedSnapshot(mctx);
  let counts: MigrationCounts;
  try {
    counts = await migration.run(mctx);
  } catch (e) {
    if (errorCode(e) === "immutable_record") {
      throw appError("immutable_record", migrationAbortMessage(name), { reason: "MIGRATION_PROTECTED_CONTENT" });
    }
    throw e;
  }
  const changes = protectedChanges(before, await protectedSnapshot(mctx));
  if (changes.length > 0) {
    throw appError("immutable_record", migrationAbortMessage(name), {
      reason: "MIGRATION_PROTECTED_CONTENT",
      changes: changes.slice(0, 20).map((c) => `${c.table}:${c.id} ${c.change}`),
    });
  }
  await assertInvariantsFor(mctx, name, "nachher");
  await appendAudit(mctx, {
    action: "system.migration",
    entity: { table: "migrations", id: name, label: migration.description },
    diff: { after: { name, scanned: counts.scanned, changed: counts.changed } },
  });
  return counts;
}

export function findMigration(name: string): Migration {
  const m = MIGRATIONS.find((x) => x.name === name);
  if (!m) throw appError("not_found", `Unbekannte Migration: ${name}`);
  return m;
}
