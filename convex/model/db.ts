import type { GenericId } from "convex/values";
import {
  assertMutable,
  ImmutableRecordError,
  PROTECTED_TABLES,
  type WriteChange,
} from "../../src/domain/audit/immutability";
import type { DatabaseWriter } from "../_generated/server";
import { appError } from "../lib/errors";

/**
 * The guarded database writer (GOBD-06, F12 AUD-001/AUD-010/AUD-011). Every mutation built with the wrappers in
 * convex/functions.ts — and every Better Auth trigger — sees this db instead of the raw one:
 *
 *  - patch/replace/delete of a record in a protected table (03 §11 matrix) is checked by `assertMutable` and
 *    rejected with `immutable_record` (E-AUD-02) before it reaches the database;
 *  - inserts/updates/deletes are counted, and so are audit entries, so the wrapper can abort with
 *    `audit_missing` when a transaction wrote without an audit entry (E-AUD-01).
 *
 * Both call forms of Convex 1.46 are supported: `patch(table, id, value)` and the legacy `patch(id, value)`.
 */
export interface WriteStats {
  writes: number;
  audits: number;
  tables: Set<string>;
}

export function newWriteStats(): WriteStats {
  return { writes: 0, audits: 0, tables: new Set() };
}

type AnyId = GenericId<string>;

/** Technical tables whose writes need no audit entry (not business data, never exported). */
const AUDIT_EXEMPT = new Set(["devMailbox"]);

export function guardedDb(db: DatabaseWriter, stats: WriteStats): DatabaseWriter {
  const raw = db as unknown as Record<string, (...args: unknown[]) => Promise<unknown>> & {
    normalizeId: (table: string, id: string) => AnyId | null;
    get: (...args: unknown[]) => Promise<Record<string, unknown> | null>;
  };

  /** Splits `(table, id, …rest)` / `(id, …rest)` and finds the table of a legacy-form id among protected tables. */
  const split = (args: unknown[], arity: number): { table: string | undefined; id: AnyId; rest: unknown[] } => {
    if (args.length === arity + 1) {
      return { table: args[0] as string, id: args[1] as AnyId, rest: args.slice(2) };
    }
    const id = args[0] as AnyId;
    const table = PROTECTED_TABLES.find((t) => raw.normalizeId(t, id) !== null);
    return { table, id, rest: args.slice(1) };
  };

  const guard = async (table: string | undefined, id: AnyId, change: WriteChange) => {
    if (table === undefined || !PROTECTED_TABLES.includes(table)) return;
    const stored = await raw.get(table, id);
    if (!stored) return; // the underlying call reports the missing document
    // documentLines are frozen with their parent (03 §11): the matrix sees the parent's status.
    let before = stored;
    if (table === "documentLines" && typeof stored.documentId === "string") {
      const parent = await raw.get("salesDocuments", stored.documentId as AnyId);
      before = { ...stored, parentStatus: parent?.status ?? "draft" };
    }
    try {
      assertMutable(table, before, change);
    } catch (e) {
      if (e instanceof ImmutableRecordError) {
        throw appError("immutable_record", e.messageDe, { table, detail: e.detail });
      }
      throw e;
    }
  };

  const count = (table: string | undefined) => {
    if (table !== undefined && AUDIT_EXEMPT.has(table)) return;
    stats.writes++;
    if (table) stats.tables.add(table);
  };

  const wrapped = {
    insert: async (table: string, value: Record<string, unknown>) => {
      if (table === "auditLog") stats.audits++;
      else count(table);
      return raw.insert?.call(db, table, value);
    },
    patch: async (...args: unknown[]) => {
      const { table, id, rest } = split(args, 2);
      await guard(table, id, { op: "patch", patch: rest[0] as Record<string, unknown> });
      count(table);
      return raw.patch?.apply(db, args);
    },
    replace: async (...args: unknown[]) => {
      const { table, id, rest } = split(args, 2);
      await guard(table, id, { op: "replace", next: rest[0] as Record<string, unknown> });
      count(table);
      return raw.replace?.apply(db, args);
    },
    delete: async (...args: unknown[]) => {
      const { table, id } = split(args, 1);
      await guard(table, id, { op: "delete" });
      count(table);
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
