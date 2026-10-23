import { genesisHash, verifyChainPage } from "../../src/domain/audit/chain";
import { PROTECTED_TABLES } from "../../src/domain/audit/immutability";
import {
  blockingViolations,
  migrationAbortMessage,
  protectedChanges,
  snapshotProtected,
  validateMigrationName,
} from "../../src/domain/audit/migration";
import type { Doc, Id, TableNames } from "../_generated/dataModel";
import type { DatabaseWriter } from "../_generated/server";
import { instanceName } from "../lib/env";
import { appError, errorCode } from "../lib/errors";
import schema from "../schema";
import { appendAudit } from "./audit";
import { checkInvariants, checkpointViolations, documentViolations, type InvariantViolation } from "./invariants";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Migration runner (F12 AUD-028, GOBD-23, EC-184). Every data migration is a registered `Migration` run inside
 * one transaction as `system:migration.<name>`:
 *
 *  1. RI-01/04/14 must hold before (otherwise the migration does not start — fix the data first); `migrations:run`
 *     notes the audit-chain head and the time (`MigrationStart`), does this pre-check with the paged action
 *     `invariants.run` (any data volume) and then calls `migrations:apply` with that start; other callers check
 *     everything in this transaction and take the start from it;
 *  2. the migration runs on the guarded db (writes to frozen records already fail with `immutable_record`); a
 *     recording layer keeps the pre-image of every protected row it patches, replaces or deletes, and file deletions
 *     are refused (the file behind an archived artifact is protected content);
 *  3. after-check, in the same transaction and bounded by what changed since the start, not by the data volume:
 *     - the touched protected rows must be unchanged (same comparison as a full snapshot: rows that existed before
 *       may not change or disappear; new rows are fine);
 *     - RI-14: the chain head of the start still carries its hash, every entry from it on verifies, and the head
 *       contains the latest checkpoint;
 *     - RI-01: re-checked for every document the window could have affected — created since the start, named by an
 *       audit entry after the start head (document, snapshot, artifact, line or send mark), or touched by the
 *       migration;
 *     otherwise E-AUD-17 and the whole transaction rolls back. Unaudited out-of-band edits of other documents during
 *     the window are left to the nightly `invariants.check` (02 §7); RI-04 has no separate runtime check yet;
 *  4. a `system.migration` audit entry records the name and the counts.
 *
 * Large backfills still page with one runner call per batch (each batch is checked the same way), because the
 * migration's own writes and their audit entries count against the transaction limits.
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

/** What the pre-check covered: the audit-chain head (`null`: empty log) and the time it started. */
export interface MigrationStart {
  since: number;
  head: { seq: number; hash: string } | null;
}

/** The current chain head, read before the pre-check (`migrations:start`). */
export async function migrationStart(ctx: ReadCtx, since: number): Promise<MigrationStart> {
  const head = await ctx.db.query("auditLog").withIndex("by_seq").order("desc").first();
  return { since, head: head ? { seq: head.seq, hash: head.hash } : null };
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

const ALL_TABLES = Object.keys(schema.tables);
const PROTECTED = new Set<string>(PROTECTED_TABLES.filter((t) => t in schema.tables));
/** Tables whose rows belong to one sales document (`documentId`) — a change can affect its RI-01. */
const DOCUMENT_CHILDREN = new Set(["documentSnapshots", "documentArtifacts", "documentLines", "sendLog"]);

/** What the migration wrote: pre-images of the protected rows it changed, the rows it inserted, the documents. */
interface WriteRecord {
  pre: Map<string, { table: string; id: string; doc: Record<string, unknown> | null }>;
  inserted: Set<string>;
  documents: Set<string>;
}

type AnyDb = Record<string, (...args: unknown[]) => Promise<unknown>> & {
  normalizeId: (table: string, id: string) => string | null;
  get: (id: string) => Promise<Record<string, unknown> | null>;
};

function noteDocument(rec: WriteRecord, table: string, id: string, row: Record<string, unknown> | null | undefined) {
  if (table === "salesDocuments") rec.documents.add(id);
  else if (DOCUMENT_CHILDREN.has(table) && typeof row?.documentId === "string") rec.documents.add(row.documentId);
}

/** Wraps the guarded db: records every write (see `WriteRecord`) before passing it on unchanged. */
function recordingDb(db: DatabaseWriter, rec: WriteRecord): DatabaseWriter {
  const raw = db as unknown as AnyDb;
  const before = async (args: unknown[], arity: number) => {
    const legacy = args.length === arity;
    const id = String(legacy ? args[0] : args[1]);
    const table = legacy ? ALL_TABLES.find((t) => raw.normalizeId(t, id) !== null) : (args[0] as string);
    if (table === undefined) return;
    const key = `${table}:${id}`;
    if (rec.inserted.has(key)) return;
    const doc = await raw.get(id);
    noteDocument(rec, table, id, doc);
    if (PROTECTED.has(table) && !rec.pre.has(key)) rec.pre.set(key, { table, id, doc });
  };
  const wrapped = {
    insert: async (table: string, value: Record<string, unknown>) => {
      const id = String(await raw.insert?.call(db, table, value));
      rec.inserted.add(`${table}:${id}`);
      noteDocument(rec, table, id, value);
      return id;
    },
    patch: async (...args: unknown[]) => {
      await before(args, 2);
      return raw.patch?.apply(db, args);
    },
    replace: async (...args: unknown[]) => {
      await before(args, 2);
      return raw.replace?.apply(db, args);
    },
    delete: async (...args: unknown[]) => {
      await before(args, 1);
      return raw.delete?.apply(db, args);
    },
  };
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop in wrapped) return wrapped[prop as keyof typeof wrapped];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Protected rows that existed before the migration and were changed or removed by it. */
async function touchedChanges(ctx: ReadCtx, rec: WriteRecord) {
  const beforeRows: Record<string, Record<string, unknown>[]> = {};
  const afterRows: Record<string, Record<string, unknown>[]> = {};
  for (const { table, id, doc } of rec.pre.values()) {
    if (!doc) continue;
    beforeRows[table] = [...(beforeRows[table] ?? []), doc];
    const now = await ctx.db.get(id as Id<TableNames>);
    if (now) afterRows[table] = [...(afterRows[table] ?? []), now];
  }
  return protectedChanges(snapshotProtected(beforeRows), snapshotProtected(afterRows));
}

/** RI-14 from the start head on; adds the documents named by the audit entries after the head to `documents`. */
async function chainSince(ctx: ReadCtx, start: MigrationStart, documents: Set<string>) {
  const out: InvariantViolation[] = [];
  const head = start.head;
  const entries = await ctx.db
    .query("auditLog")
    .withIndex("by_seq", (q) => (head ? q.gte("seq", head.seq) : q))
    .collect();
  let cursor: { nextSeq: number; prevHash: string };
  if (head) {
    const first = entries[0];
    const atHead = first?.seq === head.seq ? first : undefined;
    if (!atHead || atHead.hash !== head.hash) {
      out.push({
        id: "RI-14",
        severity: "ERROR",
        message: `Protokolleintrag seq ${head.seq} hat sich seit der Vorprüfung verändert.`,
      });
    }
    // the head entry is recomputed too; its link to seq − 1 was verified by the pre-check
    cursor = atHead ? { nextSeq: head.seq, prevHash: atHead.prevHash } : { nextSeq: head.seq + 1, prevHash: head.hash };
  } else {
    const anchor = await ctx.db.query("chainAnchors").withIndex("by_seq").order("desc").first();
    cursor =
      anchor && (entries[0]?.seq ?? 0) > 1
        ? { nextSeq: anchor.seq + 1, prevHash: anchor.hash }
        : { nextSeq: 1, prevHash: await genesisHash(instanceName()) };
  }
  const res = await verifyChainPage(entries, cursor);
  for (const f of res.findings) out.push({ id: "RI-14", severity: "ERROR", message: f.detail });
  for (const e of entries) {
    if (head && e.seq <= head.seq) continue;
    const { table, id } = e.entity;
    if (table === "salesDocuments") documents.add(id);
    else if (DOCUMENT_CHILDREN.has(table)) {
      const nid = ctx.db.normalizeId(table as TableNames, id);
      const row = nid ? ((await ctx.db.get(nid)) as Record<string, unknown> | null) : null;
      if (typeof row?.documentId === "string") documents.add(row.documentId);
    }
  }
  return out;
}

/** Step 3: the after-check (see the module comment); throws E-AUD-17. */
async function assertAfterCheck(ctx: ReadCtx, name: string, start: MigrationStart, rec: WriteRecord) {
  const changes = await touchedChanges(ctx, rec);
  if (changes.length > 0) {
    throw appError("immutable_record", migrationAbortMessage(name), {
      reason: "MIGRATION_PROTECTED_CONTENT",
      changes: changes.slice(0, 20).map((c) => `${c.table}:${c.id} ${c.change}`),
    });
  }
  const documents = new Set(rec.documents);
  const violations = [...(await chainSince(ctx, start, documents)), ...(await checkpointViolations(ctx))];
  for (const d of await ctx.db
    .query("salesDocuments")
    .withIndex("by_creation_time", (q) => q.gt("_creationTime", start.since))
    .collect()) {
    documents.add(String(d._id));
  }
  const docs: Doc<"salesDocuments">[] = [];
  for (const id of documents) {
    const nid = ctx.db.normalizeId("salesDocuments", id);
    const doc = nid ? await ctx.db.get(nid) : null;
    if (doc) docs.push(doc);
  }
  violations.push(...(await documentViolations(ctx, docs)));
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
  /** `start`: step 1 already ran (paged) in the calling action from this start, see `migrations:run`. */
  opts: { start?: MigrationStart } = {},
): Promise<MigrationCounts> {
  const { name } = migration;
  if (!validateMigrationName(name)) {
    throw appError("invalid_input", `Ungültiger Migrationsname: ${name}`, { reason: "MIGRATION_NAME" });
  }
  const actor = `system:migration.${name}` as const;
  const base: ModelCtx = { ...ctx, actor, role: undefined, actorContext: { actor, channel: "system" } };

  let start = opts.start;
  if (!start) {
    assertMigrationPrecondition(name, await checkInvariants(base));
    start = await migrationStart(base, Date.now());
  }
  const rec: WriteRecord = { pre: new Map(), inserted: new Set(), documents: new Set() };
  const storage = new Proxy(ctx.storage, {
    get(target, prop, receiver) {
      if (prop === "delete") {
        return async () => {
          throw appError("immutable_record", migrationAbortMessage(name), { reason: "MIGRATION_PROTECTED_CONTENT" });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const mctx: ModelCtx = { ...base, db: recordingDb(base.db, rec), storage };
  let counts: MigrationCounts;
  try {
    counts = await migration.run(mctx);
  } catch (e) {
    if (errorCode(e) === "immutable_record") {
      throw appError("immutable_record", migrationAbortMessage(name), { reason: "MIGRATION_PROTECTED_CONTENT" });
    }
    throw e;
  }
  await assertAfterCheck(base, name, start, rec);
  await appendAudit(base, {
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
