import { canonicalize } from "./canonical";

/**
 * Immutability matrix (03 §11, F12 AUD-005/AUD-010, GOBD-06) as data, and the guard every model-layer write
 * passes through (`convex/model/db.ts`). Tables not listed here are unprotected (freely mutable, audited).
 *
 * Field rules (apply once the record is frozen; append-only tables are frozen from insert):
 *   "mutable"      may change (still audited)
 *   "once"         may be set once (absent → value), never changed or removed afterwards
 *   "removeOnce"   may be removed once (value → absent), never set again (contactKeys.wrappedKey)
 *   transitions    allowed value changes, e.g. numberRegister.status issued → cancelled_by_storno
 *
 * Tables owned by later features (vouchers, bankTransactions, taxFilings, assets, timeEntries, …) add their rows
 * together with their state machines.
 */
export type FieldRule =
  | "mutable"
  | "once"
  | "removeOnce"
  /** arrays that may only grow; existing elements never change (bankTransactions.sources, F07 BNK-122) */
  | "append"
  | { transitions: Readonly<Record<string, readonly string[]>> };

export interface TableRule {
  kind: "append_only" | "guarded";
  /** guarded tables: the fields that may change after the record is frozen. */
  fields?: Readonly<Record<string, FieldRule>>;
  /** guarded tables: when is the record frozen? Default: from insert. */
  frozenWhen?: (doc: Record<string, unknown>) => boolean;
  /** German message for violations (E-AUD-02 for the audit log). */
  message?: string;
}

const APPEND_ONLY: TableRule = { kind: "append_only" };

export const IMMUTABILITY_MATRIX: Readonly<Record<string, TableRule>> = {
  // ── append-only (03 §11: "none") ────────────────────────────────────────────
  auditLog: { kind: "append_only", message: "Protokolleinträge sind unveränderlich." },
  companyProfileVersions: APPEND_ONLY,
  layoutVersions: APPEND_ONLY,
  accountRoleMappings: APPEND_ONLY,
  documentSnapshots: APPEND_ONLY,
  documentArtifacts: APPEND_ONLY,
  sendLog: APPEND_ONLY,
  vatIdChecks: APPEND_ONLY,
  chainAnchors: APPEND_ONLY,
  restoreDrills: APPEND_ONLY,
  purgeTombstones: APPEND_ONLY,
  datevExports: APPEND_ONLY,
  dunningRuns: APPEND_ONLY,
  datevAcceptance: APPEND_ONLY,
  allocations: APPEND_ONLY,
  depreciationRuns: APPEND_ONLY,
  bankTransactionRevisions: APPEND_ONLY,
  // F08 read model of journal lines: written with its entry, never changed (03 §8, RI-12 consistency check).
  journalLines: APPEND_ONLY,

  // ── guarded from insert ─────────────────────────────────────────────────────
  integrityCheckpoints: {
    kind: "guarded",
    // 03 §11 amended (P0): the upload result is recorded after the signed row exists (AUD-016 retries).
    fields: {
      uploadStatus: { transitions: { pending: ["uploaded", "failed"], failed: ["uploaded", "failed"] } },
      exportedTo: "once",
    },
  },
  integrityRuns: {
    kind: "guarded",
    fields: { acknowledgedAt: "once", acknowledgedNote: "once", acknowledgedBy: "once" },
  },
  contactKeys: { kind: "guarded", fields: { wrappedKey: "removeOnce", shreddedAt: "once" } },
  numberRegister: {
    kind: "guarded",
    fields: { status: { transitions: { issued: ["cancelled_by_storno", "corrected"] } } },
  },
  verfahrensdokuVersions: { kind: "guarded", fields: { supersededAt: "once", retentionUntil: "once" } },
  purgeBatches: {
    kind: "guarded",
    fields: { status: "mutable", counts: "mutable", offHostLogKey: "once", finishedAt: "once" },
  },
  // journalEntryIds grows: the entry is posted after the row exists (it references the row as its source).
  payments: {
    kind: "guarded",
    fields: {
      reversedById: "once",
      lockedAt: "once",
      reconciledTransactionId: "once",
      receiptFile: "once",
      journalEntryIds: "append",
    },
  },
  journalEntries: { kind: "guarded", fields: { lockedAt: "once" } },
  // F08 ACC-013 opening items: the reference data is frozen; payments maintain the open amount (like salesDocuments).
  openingItems: { kind: "guarded", fields: { openAmountCents: "mutable", lockedAt: "once" } },
  // journalEntryIds grows: the entry is posted after the row exists (it references the row), and the T5 bank leg of a
  // deposit is posted when the bank credit is matched (03 §11 amended, F07 P1).
  cashTransfers: { kind: "guarded", fields: { bankTransactionId: "once", journalEntryIds: "append" } },
  // F07 BNK-122: booked bank data never changes; only the allocation/marking state, the source list (append) and a
  // one-time fill of empty counterparty fields (BNK-031).
  bankTransactions: {
    kind: "guarded",
    fields: {
      status: "mutable",
      ignoredReason: "mutable",
      ignoredLinkId: "mutable",
      allocatedCents: "mutable",
      transferPeerId: "mutable",
      bookedAt: "once",
      lockedAt: "once",
      sources: "append",
      reversalOfId: "once",
      counterpartyName: "once",
      counterpartyIban: "once",
      counterpartyBic: "once",
      counterpartySource: "once",
    },
    message: "Gebuchte Bankumsätze sind unveränderbar (GoBD). Änderungen der Bank werden als Revision gespeichert.",
  },
  // F07 BNK-030/036: the official statement is archived as imported; the signed PDF can be attached once, a rolled
  // back import flags its statement once (03 §11 amended).
  bankStatements: { kind: "guarded", fields: { pdf: "once", rolledBack: "once" } },
  // ── F04 sales documents (03 §11 row "salesDocuments", DOC-29) ───────────────────────────────────────────────
  // Frozen from finalisation; `status` moves only along the lifecycle tables (src/domain/documents/lifecycle.ts —
  // the model layer checks the per-type table, this row is the union of all allowed non-draft moves).
  salesDocuments: {
    kind: "guarded",
    frozenWhen: (doc) => doc.status !== "draft",
    fields: {
      status: {
        transitions: {
          finalized: [
            "sent",
            "cancelled",
            "accepted",
            "rejected",
            "expired",
            "superseded",
            "partially_invoiced",
            "invoiced",
          ],
          sent: [
            "finalized",
            "cancelled",
            "accepted",
            "rejected",
            "expired",
            "superseded",
            "partially_invoiced",
            "invoiced",
          ],
          expired: ["accepted", "rejected", "superseded"],
          rejected: ["sent", "superseded"],
          accepted: ["cancelled", "partially_invoiced", "invoiced", "withdrawn"],
          partially_invoiced: ["invoiced", "accepted", "sent", "finalized"],
          invoiced: ["partially_invoiced", "accepted", "sent", "finalized"],
        },
      },
      paymentStatus: "mutable",
      openAmountCents: "mutable",
      sentAt: "mutable",
      sentOn: "mutable",
      firstExportedAt: "once",
      viewedAt: "mutable",
      artifactStatus: { transitions: { pending: ["ready", "blocked"], blocked: ["pending", "ready"] } },
      // Pipeline bookkeeping of step 3 (02 §6): attempt counter and last error of the artifact rendering.
      artifactAttempts: "mutable",
      artifactError: "mutable",
      lockedAt: "once",
      tags: "mutable",
      internalNote: "mutable",
      deductedInId: "mutable",
      coverage: "mutable",
      dunningBlocked: "mutable",
      disputed: "mutable",
      zugang: "mutable",
      overdueNotifiedAt: "mutable",
      collection: "mutable",
      // INV-30: proofs are appended after finalisation; existing entries never change (03 §4).
      evidence: "append",
      acceptance: "once",
      rejection: "once",
      received: "once",
      cancellation: "once",
      objection: "once",
      datevBelegnummer: "once",
    },
  },
  // Frozen with the parent: the guarded db passes the parent's status as `parentStatus` (convex/model/db.ts).
  documentLines: {
    kind: "guarded",
    frozenWhen: (doc) => doc.parentStatus !== undefined && doc.parentStatus !== "draft",
    fields: { invoicedQtyMilli: "mutable", deliveredQtyMilli: "mutable" },
  },
  periods: {
    kind: "guarded",
    fields: {
      status: { transitions: { open: ["locking"], locking: ["locked"] } },
      lockedAt: "once",
      lockedBy: "once",
      reason: "once",
    },
  },
  // ── F09 imports ─────────────────────────────────────────────────────────────
  // IMP-006: the idempotency keys of imported records are never changed or removed.
  importedRecords: APPEND_ONLY,
  // IMP-023/IMP-024: a committed import is migration evidence (files, mapping, decisions, protocol) and a discarded
  // one is closed; only the protocol file can still be attached once. Before that the project is a mutable workspace.
  imports: {
    kind: "guarded",
    frozenWhen: (doc) => doc.status === "done" || doc.status === "discarded",
    fields: { protocolFile: "once" },
    message: "Ein übernommener oder verworfener Import kann nicht mehr geändert werden.",
  },
};

export const PROTECTED_TABLES: readonly string[] = Object.keys(IMMUTABILITY_MATRIX);
export const APPEND_ONLY_TABLES: readonly string[] = PROTECTED_TABLES.filter(
  (t) => IMMUTABILITY_MATRIX[t]?.kind === "append_only",
);

export class ImmutableRecordError extends Error {
  readonly code = "immutable_record";
  constructor(
    readonly table: string,
    readonly detail: string,
    readonly messageDe: string,
  ) {
    super(`immutable_record: ${table}: ${detail}`);
    this.name = "ImmutableRecordError";
  }
}

export type WriteChange =
  | { op: "patch"; patch: Record<string, unknown> }
  | { op: "replace"; next: Record<string, unknown> }
  | { op: "delete" };

const SYSTEM_FIELDS = new Set(["_id", "_creationTime"]);
const GENERIC_DE = "Dieser Datensatz ist unveränderlich (GoBD). Korrekturen erfolgen über einen neuen Beleg.";

function same(a: unknown, b: unknown): boolean {
  if (a === undefined || b === undefined) return a === b;
  return canonicalize(a) === canonicalize(b);
}

/** Fields whose value differs between `before` and the state after `change`. */
export function changedFields(before: Record<string, unknown>, change: WriteChange): Map<string, [unknown, unknown]> {
  const out = new Map<string, [unknown, unknown]>();
  if (change.op === "delete") return out;
  const after: Record<string, unknown> =
    change.op === "patch"
      ? { ...before, ...change.patch }
      : { _id: before._id, _creationTime: before._creationTime, ...change.next };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (SYSTEM_FIELDS.has(k)) continue;
    if (!same(before[k], after[k])) out.set(k, [before[k], after[k]]);
  }
  return out;
}

/**
 * Throws `ImmutableRecordError` if `change` to `before` (a stored document of `table`) violates the matrix.
 * Pure; the model layer calls it before every patch/replace/delete.
 */
export function assertMutable(table: string, before: Record<string, unknown>, change: WriteChange): void {
  const rule = IMMUTABILITY_MATRIX[table];
  if (!rule) return;
  const fail = (detail: string): never => {
    throw new ImmutableRecordError(table, detail, rule.message ?? GENERIC_DE);
  };
  if (rule.kind === "guarded" && rule.frozenWhen && !rule.frozenWhen(before)) return;
  if (change.op === "delete") fail("delete");
  if (rule.kind === "append_only") {
    if (changedFields(before, change).size > 0) fail("update");
    return;
  }
  for (const [field, [from, to]] of changedFields(before, change)) {
    const fieldRule = rule.fields?.[field];
    if (fieldRule === undefined) fail(`field ${field} is frozen`);
    else if (fieldRule === "mutable") continue;
    else if (fieldRule === "once") {
      if (from !== undefined) fail(`field ${field} may be set only once`);
    } else if (fieldRule === "removeOnce") {
      if (to !== undefined) fail(`field ${field} may only be removed`);
    } else if (fieldRule === "append") {
      const prev = Array.isArray(from) ? from : from === undefined ? [] : null;
      if (prev === null || !Array.isArray(to) || to.length < prev.length || !same(to.slice(0, prev.length), prev)) {
        fail(`field ${field} may only be appended to`);
      }
    } else {
      const allowed = typeof from === "string" ? fieldRule.transitions[from] : undefined;
      if (typeof to !== "string" || !allowed?.includes(to)) fail(`transition ${field} ${String(from)} → ${String(to)}`);
    }
  }
}
