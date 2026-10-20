import type { GenericId } from "convex/values";
import { canonicalize } from "../../src/domain/audit/canonical";
import {
  assertMutable,
  changedFields,
  ImmutableRecordError,
  PROTECTED_TABLES,
  type WriteChange,
} from "../../src/domain/audit/immutability";
import { isTechnicalPatch, TECHNICAL_TABLES } from "../../src/domain/audit/technical";
import { auditRetentionUntil, isPurgeEligible } from "../../src/domain/privacy/purge";
import { isRetained, retentionMessage } from "../../src/domain/rules/retention";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
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
  /**
   * F12 PRV-006/PRV-008 sanctioned purge path: tombstones inserted in this transaction (`table:id` → retentionUntil)
   * and the highest chain anchor inserted in it. Only these records may leave a protected table.
   */
  tombstoned: Map<string, string>;
  anchorSeq: number;
}

export function newWriteStats(): WriteStats {
  return { writes: 0, audits: 0, tables: new Set(), tombstoned: new Map(), anchorSeq: 0 };
}

type AnyId = GenericId<string>;

/** Technical tables/fields whose writes need no audit entry (src/domain/audit/technical.ts). */
const AUDIT_EXEMPT = new Set(TECHNICAL_TABLES);

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

  const today = () => berlinCalendarDate(Date.now());

  /**
   * GOBD-21 purge (PRV-006…008): a protected record may be deleted only after its retention ended AND with a
   * tombstone inserted in the same transaction; audit entries only as a prefix behind a chain anchor (seq ≤ anchor)
   * whose own 10-year retention ended. PRV-007: journal lines may lose the `contactId` of a contact anonymised (and
   * tombstoned) in the same transaction — nothing else changes.
   */
  const purgeAllowed = async (
    table: string,
    id: AnyId,
    stored: Record<string, unknown>,
    change: WriteChange,
  ): Promise<boolean> => {
    if (change.op === "delete") {
      if (table === "auditLog") {
        const seq = stored.seq as number;
        let anchor = stats.anchorSeq;
        if (seq > anchor) {
          const top = await db.query("chainAnchors").withIndex("by_seq").order("desc").first();
          anchor = Math.max(anchor, top?.seq ?? 0);
        }
        return seq <= anchor && isPurgeEligible(auditRetentionUntil(stored.at as number), today());
      }
      const until = stats.tombstoned.get(`${table}:${id}`);
      return until !== undefined && isPurgeEligible(until, today());
    }
    if (change.op !== "patch" || (table !== "journalEntries" && table !== "journalLines")) return false;
    const changed = [...changedFields(stored, change).keys()];
    const shredded = (cid: unknown) => typeof cid === "string" && stats.tombstoned.has(`contacts:${cid}`);
    if (table === "journalLines") {
      return (
        changed.length === 1 &&
        changed[0] === "contactId" &&
        change.patch.contactId === undefined &&
        shredded(stored.contactId)
      );
    }
    if (changed.length !== 1 || changed[0] !== "lines") return false;
    const before = stored.lines as Record<string, unknown>[];
    const after = change.patch.lines as Record<string, unknown>[] | undefined;
    if (!Array.isArray(after) || after.length !== before.length) return false;
    return before.every((b, i) => {
      const a = after[i] as Record<string, unknown>;
      const { contactId: bc, ...bRest } = b;
      const { contactId: ac, ...aRest } = a;
      if (canonicalize(bRest) !== canonicalize(aRest)) return false;
      return ac === bc || (ac === undefined && shredded(bc));
    });
  };

  const guard = async (table: string | undefined, id: AnyId, change: WriteChange) => {
    if (table === undefined || !PROTECTED_TABLES.includes(table)) return;
    const stored = await raw.get(table, id);
    if (!stored) return; // the underlying call reports the missing document
    if (await purgeAllowed(table, id, stored, change)) return;
    // documentLines are frozen with their parent (03 §11): the matrix sees the parent's status.
    let before = stored;
    if (table === "documentLines" && typeof stored.documentId === "string") {
      const parent = await raw.get("salesDocuments", stored.documentId as AnyId);
      before = { ...stored, parentStatus: parent?.status ?? "draft" };
    }
    // voucherLines are frozen once the parent voucher is locked or cancelled (03 §11, VOU-009).
    if (table === "voucherLines" && typeof stored.voucherId === "string") {
      const parent = await raw.get("vouchers", stored.voucherId as AnyId);
      const frozen = parent ? parent.lockedAt !== undefined || parent.status === "cancelled" : false;
      before = { ...stored, parentFrozen: frozen };
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

  /**
   * F12 PRV-002 / RI-20: no record that carries `retentionUntil` is deleted before that date, on any path and for any
   * table (protected or not). Class `none` records (drafts, notifications) carry no `retentionUntil`.
   */
  const retentionGuard = async (table: string | undefined, id: AnyId) => {
    const stored = table ? await raw.get(table, id) : await raw.get(id);
    const until = stored?.retentionUntil;
    if (typeof until !== "string") return;
    const today = berlinCalendarDate(Date.now());
    if (!isRetained(until, today)) return;
    const label = typeof stored?.number === "string" ? stored.number : "Dieser Datensatz";
    throw appError("immutable_record", retentionMessage(label, until), {
      reason: "RETENTION_ACTIVE",
      table: table ?? "",
      retentionUntil: until,
    });
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
      if (table === "purgeTombstones") {
        stats.tombstoned.set(`${value.table as string}:${value.recordId as string}`, value.retentionUntil as string);
      }
      if (table === "chainAnchors") stats.anchorSeq = Math.max(stats.anchorSeq, value.seq as number);
      return raw.insert?.call(db, table, value);
    },
    patch: async (...args: unknown[]) => {
      const { table, id, rest } = split(args, 2);
      await guard(table, id, { op: "patch", patch: rest[0] as Record<string, unknown> });
      if (!(table !== undefined && isTechnicalPatch(table, rest[0] as Record<string, unknown>))) count(table);
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
      await retentionGuard(table, id);
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
