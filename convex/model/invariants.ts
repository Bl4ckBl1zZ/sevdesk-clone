import { checkCash, checkJournal } from "../../src/domain/accounting/invariants";
import { chartAt } from "../../src/domain/accounting/period";
import { canonicalize } from "../../src/domain/audit/canonical";
import { genesisHash, sha256Hex, verifyChainPage } from "../../src/domain/audit/chain";
import { isEncryptedValue } from "../../src/domain/audit/personal";
import { REDACTED } from "../../src/domain/audit/redact";
import { TECHNICAL_TABLES, technicalFields } from "../../src/domain/audit/technical";
import { checkGeschaeftsbriefFooter } from "../../src/domain/company/invariants";
import { type ChainInvariantRow, checkChains } from "../../src/domain/documents/chain-invariants";
import {
  type ArtifactInvariantRow,
  checkDocumentNumbers,
  checkFinalisedDocument,
  checkSentMarks,
  checkTotals,
  type DocumentInvariantRow,
} from "../../src/domain/documents/invariants";
import { type LayoutDocType, SALES_DOC_TYPES } from "../../src/domain/documents/layout";
import { isChainType } from "../../src/domain/documents/relations";
import type { DocumentSnapshot } from "../../src/domain/documents/snapshot";
import { checkEinvoiceDocument } from "../../src/domain/einvoice/invariants";
import { type DocumentedGap, parseDocumentedGap } from "../../src/domain/numbering/gaps";
import { checkCounterSequences } from "../../src/domain/numbering/invariants";
import { checkStockCaches, checkTimeEntryLocks } from "../../src/domain/projects/invariants";
import { ROLE_MAPPING_ROWS, seededAccount } from "../../src/domain/rules/accounting";
import { defaultInterestRateBp } from "../../src/domain/rules/basiszinssatz";
import { groupOverrides, overrideRowId } from "../../src/domain/rules/overrides";
import { checkKleinunternehmerDocument } from "../../src/domain/tax/ku-invariants";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import { checkVoucherBelege } from "../../src/domain/vouchers/invariants";
import type { Doc, TableNames } from "../_generated/dataModel";
import { instanceName } from "../lib/env";
import schema from "../schema";
import { listRuleOverrides } from "./ruleOverrides";
import type { ReadCtx } from "./types";

/**
 * Regulatory invariants (10-edge-cases §2) evaluated over the whole database. P0 implements (P1 adds RI-11/RI-12 below):
 *  - RI-14 audit chain complete: seq contiguous from 1, every hash recomputes, head contains the latest checkpoint.
 *  - RI-15 every state change is audited: replaying the audit diffs of each record reproduces its current state
 *    (detects writes that bypassed the model layer, incl. changes to frozen records, and unaudited inserts).
 * Used by `assertInvariants()` after every Convex/integration test, by the daily `invariants.check` job (02 §7) and by
 * the migration pre-check (AUD-028). Evaluated page by page (see "paged evaluation" below) so the check scales past
 * the per-execution read limits.
 */
export interface InvariantViolation {
  id: `RI-${string}`;
  severity: "ERROR" | "WARN";
  message: string;
}

/**
 * Tables without own audit entries: the log itself, the dev mailbox, contact keys (written with the parent),
 * `companyProfileVersions` — a snapshot written in the same transaction as the audited `companyProfile` change;
 * each row instead must point (`auditSeq`) at that change's audit entry (checked below) — and `journalLines`, the
 * read model of the audited journal entries (RI-12 checks that it mirrors them).
 */
const NOT_REPLAYED = new Set([
  "auditLog",
  "contactKeys",
  "companyProfileVersions",
  "journalLines",
  // technical tables (access log, idempotency records, confirm tokens, dev mailbox): src/domain/audit/technical.ts
  ...TECHNICAL_TABLES,
]);

export function replayedTables(): TableNames[] {
  return (Object.keys(schema.tables) as TableNames[]).filter((t) => !NOT_REPLAYED.has(t));
}

const withoutSystem = (doc: Record<string, unknown>) => {
  const { _id, _creationTime, ...rest } = doc;
  return rest;
};

/** Replays one entity's audit diffs (seq order) into the state they describe; null = deleted / never created. */
export function replayEntity(entries: Doc<"auditLog">[]): Record<string, unknown> | null {
  let state: Record<string, unknown> | null = null;
  for (const e of entries) {
    const diff = e.diff as { before?: Record<string, unknown>; after?: Record<string, unknown> } | undefined;
    if (!diff) continue;
    if (diff.after === undefined) {
      if (diff.before !== undefined && state !== null && /delete|purge/.test(e.action)) state = null;
      continue;
    }
    if (diff.before === undefined) {
      state = { ...diff.after };
      continue;
    }
    state = { ...(state ?? {}) };
    for (const k of Object.keys(diff.before)) if (!(k in diff.after)) delete state[k];
    Object.assign(state, diff.after);
  }
  return state;
}

/** Fields whose audited value is redacted or encrypted cannot be compared; technical fields are not audited. */
function comparable(audited: Record<string, unknown>, actual: Record<string, unknown>, skip: readonly string[] = []) {
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(audited), ...Object.keys(actual)])) {
    if (skip.includes(k)) continue;
    const v = audited[k];
    if (v === REDACTED || isEncryptedValue(v)) continue;
    const [av, bv] = nestedComparable(v, actual[k]);
    if (av !== undefined) a[k] = av;
    if (bv !== undefined) b[k] = bv;
  }
  return [canonicalize(a), canonicalize(b)] as const;
}

/** Secrets redacted inside nested objects (e.g. `notificationSettings.ntfy.encryptedToken`) are skipped as well. */
function nestedComparable(audited: unknown, actual: unknown): [unknown, unknown] {
  const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
  if (!isObj(audited) || !isObj(actual)) return [audited, actual];
  const a: Record<string, unknown> = {};
  const b: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(audited), ...Object.keys(actual)])) {
    const v = audited[k];
    if (v === REDACTED || isEncryptedValue(v)) continue;
    const [av, bv] = nestedComparable(v, actual[k]);
    if (av !== undefined) a[k] = av;
    if (bv !== undefined) b[k] = bv;
  }
  return [a, b];
}

// ── paged evaluation ─────────────────────────────────────────────────────────────────────────────────
//
// The invariants are evaluated in steps (one per table, in the order of the former single pass). A step reads its
// table page by page through an index cursor; per-row lookups (artifacts, snapshot, send marks, an entity's audit
// entries, …) stay inside the page so every row is checked against a consistent view. Per-row checks emit
// violations right away; cross-row checks (journal, number register, document chains/numbers, vouchers, stock and
// time entries) collect compact rows that `finishInvariants` evaluates with the pure domain functions at the end.
//
// `invariantsPage(ctx, state, budget)` runs steps until the read budget of one function execution is spent and
// returns the continuation state, so `internal.invariants.run` (an action) can drive any data volume with one query
// per page (Convex: 4,096 reads, 16 MiB per execution). `checkInvariants(ctx)` drives the same steps in one
// transaction (unlimited budget) for tests and small datasets.

/** Where a violation is reported in the result (keeps the order of the former single pass). */
type Bucket = "chain" | "checkpoint" | "profileVersions" | "deletions" | "tombstones" | "documents" | "dunning";
const BUCKETS: readonly Bucket[] = [
  "chain",
  "checkpoint",
  "profileVersions",
  "deletions",
  "tombstones",
  "documents",
  "dunning",
];

type RegisterRow = {
  number: string;
  normalized: string;
  docType: string;
  rangeId?: string;
  periodKey?: string;
  counter?: number;
  order: number;
  imported?: true;
  documentId?: string;
};
type VoucherRow = {
  id: string;
  label: string;
  status: Doc<"vouchers">["status"];
  kind: Doc<"vouchers">["kind"];
  files: Doc<"vouchers">["originalFiles"];
  eigenbelegApproved: boolean;
  recurringVoucherId?: string;
  ownReference: boolean;
};
type TimeEntryRow = Parameters<typeof checkTimeEntryLocks>[0][number];

/** Compact rows for the cross-row checks; plain arrays so they cross `runQuery` as Convex values. */
export interface InvariantRows {
  meta: {
    chartOfAccounts: Doc<"companyProfile">["chartOfAccounts"];
    fiscalYearStartMonth: number;
    hasProfile: boolean;
  }[];
  bankLedgers: string[];
  customAccounts: string[];
  /** Audit entries of `numberCounters` with their reason (documented gaps, SET-059), seq order. */
  counterReasons: { counterId: string; reason: string }[];
  purgedJournal: { recordId: string; seq?: number }[];
  journalEntries: Parameters<typeof checkJournal>[0][number][];
  journalLines: Parameters<typeof checkJournal>[1][number][];
  register: RegisterRow[];
  ranges: { id: string; name: string; startValue: number }[];
  counters: { id: string; rangeId: string; periodKey: string }[];
  documents: { id: string; status: string; number?: string }[];
  chainRows: ChainInvariantRow[];
  vouchers: VoucherRow[];
  referenceTemplates: string[];
  movements: { id: string; productId: string; quantityMilli: number; reversesId?: string }[];
  products: { id: string; label: string; quantityMilli?: number; hasStock: boolean }[];
  timeEntries: TimeEntryRow[];
  timeEntryLines: { id: string; documentId: string; timeEntryIds: string[] }[];
  timeEntryDocs: { id: string; status: string; retentionUntil?: string; lineEntryIds: string[] }[];
  /** RI-15 findings with their sort key (replayed table, record creation time, id). */
  replayFindings: { table: number; at: number; id: string; v: InvariantViolation }[];
}
const ROW_KEYS: readonly (keyof InvariantRows)[] = [
  "meta",
  "bankLedgers",
  "customAccounts",
  "counterReasons",
  "purgedJournal",
  "journalEntries",
  "journalLines",
  "register",
  "ranges",
  "counters",
  "documents",
  "chainRows",
  "vouchers",
  "referenceTemplates",
  "movements",
  "products",
  "timeEntries",
  "timeEntryLines",
  "timeEntryDocs",
  "replayFindings",
];

export interface InvariantAccumulator {
  violations: Record<Bucket, InvariantViolation[]>;
  rows: InvariantRows;
}

export function emptyAccumulator(): InvariantAccumulator {
  return {
    violations: Object.fromEntries(BUCKETS.map((b) => [b, []])) as unknown as Record<Bucket, InvariantViolation[]>,
    rows: Object.fromEntries(ROW_KEYS.map((k) => [k, []])) as unknown as InvariantRows,
  };
}

/** Appends one page's output to the running accumulator (same order as the pages ran). */
export function mergeAccumulator(into: InvariantAccumulator, page: InvariantAccumulator): void {
  for (const b of BUCKETS) for (const v of page.violations[b] ?? []) into.violations[b].push(v);
  for (const k of ROW_KEYS) for (const r of page.rows[k] ?? []) (into.rows[k] as unknown[]).push(r);
}

/** Index cursor: last key processed and the ids already processed at that key (keys need not be unique). */
interface KeyCursor {
  key: number;
  ids: string[];
}

export interface InvariantState {
  step: number;
  cursor: KeyCursor | null;
  chain: { nextSeq: number; prevHash: string } | null;
  /** Sub-state of a custom step (replay). */
  sub: unknown;
}

/** Per-execution read budget; omitted fields are unlimited. */
export interface InvariantBudget {
  calls?: number;
  docs?: number;
  bytes?: number;
}

/**
 * Per page about a third of the Convex limits (4,096 index ranges, 16 MiB / 32,000 documents read; older backends
 * 8 MiB / 16,384), so the one batch that may run past the budget still fits.
 */
export const DEFAULT_PAGE_BUDGET: Required<InvariantBudget> = { calls: 1300, docs: 5000, bytes: 2_500_000 };

/** First batch of a step (row size still unknown) — bounded so even 100 KB rows stay far below the limits. */
const FIRST_BATCH = 25;

export interface ReadStats {
  calls: number;
  docs: number;
  bytes: number;
  /** Largest single document read (approximate bytes). */
  largestDoc: number;
}

/**
 * Sizes a step's next batch to the remaining budget: calls (estimated lookups per row), documents and bytes — the
 * latter from the largest row seen so far in this step (a row's own size and its lookups' share), FIRST_BATCH while
 * unknown. Steps report each batch with `measured`.
 */
interface BatchSizer {
  /** Size of the next batch; also starts measuring it. */
  batch(key: string, maxBatch: number, cost: number): number;
  /** Records the batch just read (`rows` rows) for the next estimate of `key`. */
  measured(key: string, rows: number): void;
}

export interface InvariantPage {
  acc: InvariantAccumulator;
  state: InvariantState;
  done: boolean;
  reads: ReadStats;
}

const TERMINAL = new Set(["get", "collect", "first", "take", "unique", "paginate"]);
const sizeOf = (doc: unknown) => (doc ? JSON.stringify(doc).length : 0);

/** Counts db calls, documents and (approximate) bytes read through `db` — the page budget and the read report. */
function countingDb<T extends object>(target: T, stats: ReadStats, batch: { largest: number }): T {
  return new Proxy(target, {
    get(t, prop, receiver) {
      const value = Reflect.get(t, prop, receiver);
      if (prop === "system" && value && typeof value === "object") return countingDb(value, stats, batch);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const out = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (TERMINAL.has(String(prop))) {
          stats.calls++;
          return Promise.resolve(out).then((res) => {
            const docs = Array.isArray(res)
              ? res
              : res && typeof res === "object" && "page" in res
                ? (res as { page: unknown[] }).page
                : res
                  ? [res]
                  : [];
            stats.docs += docs.length;
            for (const d of docs) {
              const size = sizeOf(d);
              stats.bytes += size;
              if (size > stats.largestDoc) stats.largestDoc = size;
              if (size > batch.largest) batch.largest = size;
            }
            return res;
          });
        }
        return out && typeof out === "object" && !(out instanceof Promise) ? countingDb(out, stats, batch) : out;
      };
    },
  });
}

interface StepBase {
  name: string;
}
interface OnceStep extends StepBase {
  kind: "once";
  run: (ctx: ReadCtx, acc: InvariantAccumulator, state: InvariantState) => Promise<void>;
}
interface TableStep<T extends TableNames> extends StepBase {
  kind: "table";
  table: T;
  /** Index whose first field is `key` (numeric): `by_creation_time`/`_creationTime` or `by_seq`/`seq`. */
  index: string;
  key: "_creationTime" | "seq";
  /** Estimated db calls per row (lookups inside the page) — sizes the batch to the remaining budget. */
  cost: number;
  maxBatch: number;
  handle: (ctx: ReadCtx, docs: Doc<T>[], acc: InvariantAccumulator, state: InvariantState) => Promise<void>;
}
/** A step that manages its own paging in `state.sub` and sizes its batches with `sizer`; true when done. */
interface CustomStep extends StepBase {
  kind: "custom";
  run: (ctx: ReadCtx, acc: InvariantAccumulator, state: InvariantState, sizer: BatchSizer) => Promise<boolean>;
}
type Step = OnceStep | TableStep<TableNames> | CustomStep;

const tableStep = <T extends TableNames>(s: Omit<TableStep<T>, "kind">): Step =>
  ({ kind: "table", ...s }) as unknown as Step;

async function keyPage(
  ctx: ReadCtx,
  step: TableStep<TableNames>,
  cursor: KeyCursor | null,
  n: number,
): Promise<{ docs: Doc<TableNames>[]; cursor: KeyCursor | null; done: boolean }> {
  const seen = new Set(cursor?.ids ?? []);
  // biome-ignore lint/suspicious/noExplicitAny: generic index cursor over the table's numeric key
  const q = (ctx.db.query(step.table) as any).withIndex(step.index, (r: any) =>
    cursor ? r.gte(step.key, cursor.key) : r,
  );
  const raw = (await q.take(n + seen.size)) as Doc<TableNames>[];
  const keyOf = (d: Doc<TableNames>) => (d as unknown as Record<string, number>)[step.key] as number;
  const fresh = raw.filter((d) => !(cursor && keyOf(d) === cursor.key && seen.has(String(d._id))));
  const docs = fresh.slice(0, n);
  const done = raw.length < n + seen.size && fresh.length <= n;
  const last = docs.at(-1);
  if (!last) return { docs, cursor, done };
  const key = keyOf(last);
  const ids = docs.filter((d) => keyOf(d) === key).map((d) => String(d._id));
  return { docs, cursor: { key, ids: cursor && cursor.key === key ? [...cursor.ids, ...ids] : ids }, done };
}

async function chainAnchor(ctx: ReadCtx) {
  return ctx.db.query("chainAnchors").withIndex("by_seq").order("desc").first();
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────────────

/** Settings the cross-row checks need (profile, bank ledgers, custom accounts) — small tables, read once. */
const metaStep: OnceStep = {
  kind: "once",
  name: "meta",
  run: async (ctx, acc) => {
    const profile = await ctx.db.query("companyProfile").first();
    acc.rows.meta.push({
      chartOfAccounts: profile?.chartOfAccounts ?? [],
      fiscalYearStartMonth: profile?.fiscalYearStartMonth ?? 1,
      hasProfile: profile !== null,
    });
    for (const b of await ctx.db.query("bankAccounts").collect()) acc.rows.bankLedgers.push(b.ledgerAccount);
    // ACC-009: custom accounts (archived ones included — their old postings stay valid).
    for (const a of await ctx.db.query("ledgerAccounts").collect())
      acc.rows.customAccounts.push(`${a.chart}:${a.number}`);
  },
};

/**
 * RI-14 — chain, verified page by page with the rolling cursor (after an audit-log prefix purge, PRV-008, from the
 * latest signed anchor). The same pages feed RI-20 (no deletion within retention, PRV-002) and the documented counter
 * gaps of RI-03 (SET-059).
 */
const chainStep = tableStep<"auditLog">({
  name: "chain",
  table: "auditLog",
  index: "by_seq",
  key: "seq",
  cost: 0,
  maxBatch: 500,
  handle: async (ctx, entries, acc, state) => {
    if (!state.chain) {
      const anchor = await chainAnchor(ctx);
      state.chain =
        anchor && (entries[0]?.seq ?? 0) > 1
          ? { nextSeq: anchor.seq + 1, prevHash: anchor.hash }
          : { nextSeq: 1, prevHash: await genesisHash(instanceName()) };
    }
    const res = await verifyChainPage(entries, state.chain);
    state.chain = res.cursor;
    for (const f of res.findings) acc.violations.chain.push({ id: "RI-14", severity: "ERROR", message: f.detail });
    for (const e of entries) {
      if (e.entity.table === "numberCounters" && typeof e.reason === "string") {
        acc.rows.counterReasons.push({ counterId: e.entity.id, reason: e.reason });
      }
      // RI-20 (F12 PRV-002) — every audited deletion of a record that still was within retention is a violation.
      const diff = e.diff as { before?: { retentionUntil?: unknown }; after?: unknown } | undefined;
      const until = diff?.before?.retentionUntil;
      if (!diff?.before || diff.after !== undefined || typeof until !== "string") continue;
      if (berlinCalendarDate(e.at) <= until) {
        acc.violations.deletions.push({
          id: "RI-20",
          severity: "ERROR",
          message: `${e.entity.table}/${e.entity.id} wurde vor Ablauf der Aufbewahrungsfrist (${until}) gelöscht (seq ${e.seq}).`,
        });
      }
    }
  },
});

/** RI-14 — the head contains the latest checkpoint (also the migration after-check, AUD-028). */
export async function checkpointViolations(ctx: ReadCtx): Promise<InvariantViolation[]> {
  const anchor = await chainAnchor(ctx);
  const cp = await ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").first();
  if (!cp || cp.lastSeq <= 0 || (anchor && cp.lastSeq <= anchor.seq)) return [];
  const atCp = await ctx.db
    .query("auditLog")
    .withIndex("by_seq", (q) => q.eq("seq", cp.lastSeq))
    .first();
  if (atCp && atCp.hash === cp.lastHash) return [];
  return [
    {
      id: "RI-14",
      severity: "ERROR",
      message: `Kette enthält den Prüfpunkt vom ${cp.date} (seq ${cp.lastSeq}) nicht.`,
    },
  ];
}

const checkpointStep: OnceStep = {
  kind: "once",
  name: "checkpoint",
  run: async (ctx, acc) => {
    acc.violations.checkpoint.push(...(await checkpointViolations(ctx)));
  },
};

/** RI-15 for one record: its audit entries (seq order) replay to its current state. */
function replayFinding(
  table: TableNames,
  doc: Doc<TableNames>,
  list: Doc<"auditLog">[],
  anchor: Doc<"chainAnchors"> | null,
): InvariantViolation | null {
  const id = String(doc._id);
  const audited = replayEntity(list);
  // PRV-008: records created before the anchored (purged) prefix lost their creation entry — not replayable.
  const first = list[0]?.diff as { before?: unknown } | undefined;
  if (anchor && (doc._creationTime as number) <= anchor.createdAt && (!first || first.before !== undefined))
    return null;
  if (audited === null) {
    return { id: "RI-15", severity: "ERROR", message: `${table}/${id} existiert ohne Protokolleintrag.` };
  }
  const [a, b] = comparable(audited, withoutSystem(doc as Record<string, unknown>), technicalFields(table));
  return a === b
    ? null
    : { id: "RI-15", severity: "ERROR", message: `${table}/${id} weicht vom protokollierten Stand ab.` };
}

interface ReplayState {
  phase: "audit" | "count" | "unaudited";
  /** audit phase: last entity id whose entries were processed completely. */
  afterId: string | null;
  /** Records of the table found through their audit entries / records in the table. */
  audited: number;
  total: number;
  cursor: KeyCursor | null;
}

/**
 * RI-15 — replay, merged over the `by_entity` index instead of one index lookup per record: (1) the table's audit
 * entries in entity order, grouped per record, each group replayed against its record (one `get`); (2) the table's
 * records are counted; (3) only if there are more records than records with entries, the records are scanned once
 * more for the unaudited ones. Findings are reported in record creation order, like the former per-table scan.
 */
const replayStep = (table: TableNames, tableIndex: number): CustomStep => ({
  kind: "custom",
  name: `replay:${table}`,
  run: async (ctx, acc, st, sizer) => {
    const sub: ReplayState = (st.sub as ReplayState | null) ?? {
      phase: "audit",
      afterId: null,
      audited: 0,
      total: 0,
      cursor: null,
    };
    st.sub = sub;
    const report = (doc: Doc<TableNames>, v: InvariantViolation | null) => {
      if (v) acc.rows.replayFindings.push({ table: tableIndex, at: doc._creationTime, id: String(doc._id), v });
    };
    if (sub.phase === "audit") {
      const key = `${table}:audit`;
      const n = Math.max(2, sizer.batch(key, 500, 1));
      const entries = await ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => {
          const r = q.eq("entity.table", table);
          return sub.afterId === null ? r : r.gt("entity.id", sub.afterId);
        })
        .take(n);
      const groups: Doc<"auditLog">[][] = [];
      for (const e of entries) {
        const last = groups.at(-1);
        if (last && last[0]?.entity.id === e.entity.id) last.push(e);
        else groups.push([e]);
      }
      const complete = entries.length < n;
      if (!complete) {
        // The last group may continue on the next page: it is read next time — or completely now if it is the only one.
        const tail = groups.pop() ?? [];
        const id = tail[0]?.entity.id;
        if (groups.length === 0 && id !== undefined) {
          groups.push(
            await ctx.db
              .query("auditLog")
              .withIndex("by_entity", (q) => q.eq("entity.table", table).eq("entity.id", id))
              .collect(),
          );
        }
      }
      const anchor = groups.length > 0 ? await chainAnchor(ctx) : null;
      for (const group of groups) {
        const id = group[0]?.entity.id as string;
        sub.afterId = id;
        const nid = ctx.db.normalizeId(table, id);
        const doc = (nid ? await ctx.db.get(nid) : null) as Doc<TableNames> | null;
        if (!doc) continue; // deleted (audited deletion) or not a record of this table
        sub.audited++;
        report(
          doc,
          replayFinding(
            table,
            doc,
            [...group].sort((a, b) => a.seq - b.seq),
            anchor,
          ),
        );
      }
      sizer.measured(key, entries.length);
      if (complete) sub.phase = "count";
      return false;
    }
    const counting = sub.phase === "count";
    const step = {
      kind: "table",
      name: `replay:${table}`,
      table,
      index: "by_creation_time",
      key: "_creationTime",
      cost: counting ? 0 : 1,
      maxBatch: counting ? 1000 : 200,
      handle: async () => {},
    } satisfies TableStep<TableNames>;
    const key = `${table}:${sub.phase}`;
    const page = await keyPage(ctx, step, sub.cursor, sizer.batch(key, step.maxBatch, step.cost));
    sub.cursor = page.cursor;
    if (counting) {
      sizer.measured(key, page.docs.length);
      sub.total += page.docs.length;
      if (!page.done) return false;
      if (sub.total <= sub.audited) return true;
      sub.phase = "unaudited";
      sub.cursor = null;
      return false;
    }
    const anchor = page.docs.length > 0 ? await chainAnchor(ctx) : null;
    for (const doc of page.docs) {
      const id = String(doc._id);
      const entry = await ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", table).eq("entity.id", id))
        .first();
      if (!entry) report(doc, replayFinding(table, doc, [], anchor));
    }
    sizer.measured(key, page.docs.length);
    return page.done;
  },
});

/** RI-15 — snapshots: every companyProfileVersions row belongs to an audited companyProfile change. */
const profileVersionsStep = tableStep<"companyProfileVersions">({
  name: "profileVersions",
  table: "companyProfileVersions",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 1,
  maxBatch: 500,
  handle: async (ctx, versions, acc) => {
    if (versions.length === 0) return;
    const anchor = await chainAnchor(ctx);
    for (const v of versions) {
      if (anchor && v.auditSeq <= anchor.seq) continue; // its entry lies in the purged, anchored prefix (PRV-008)
      const e = (
        await ctx.db
          .query("auditLog")
          .withIndex("by_seq", (q) => q.eq("seq", v.auditSeq))
          .collect()
      ).at(-1);
      const after = (e?.diff as { after?: { version?: unknown } } | undefined)?.after;
      if (e?.entity.table !== "companyProfile" || after?.version !== v.version) {
        acc.violations.profileVersions.push({
          id: "RI-15",
          severity: "ERROR",
          message: `companyProfileVersions/${String(v._id)} (Version ${v.version}) ohne passenden Protokolleintrag.`,
        });
      }
    }
  },
});

/**
 * RI-20 (F12 PRV-006) — every tombstone stands for a record that is gone (contacts: anonymised, key shredded) and was
 * purged only after its retention ended. Journal tombstones also feed RI-12 (purged numbers count as present).
 */
const tombstonesStep = tableStep<"purgeTombstones">({
  name: "tombstones",
  table: "purgeTombstones",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 2,
  maxBatch: 500,
  handle: async (ctx, tombstones, acc) => {
    for (const t of tombstones) {
      if (t.table === "journalEntries") {
        acc.rows.purgedJournal.push({ recordId: t.recordId, ...(t.seq !== undefined ? { seq: t.seq } : {}) });
      }
      const day = berlinCalendarDate(t.purgedAt);
      if (day <= t.retentionUntil) {
        acc.violations.tombstones.push({
          id: "RI-20",
          severity: "ERROR",
          message: `${t.table}/${t.recordId} wurde vor Ablauf der Aufbewahrungsfrist (${t.retentionUntil}) gelöscht.`,
        });
      }
      if (t.table === "auditLog") continue;
      if (t.table === "contacts") {
        const key = await ctx.db
          .query("contactKeys")
          .withIndex("by_contact", (q) => q.eq("contactId", t.recordId))
          .first();
        if (key && key.shreddedAt === undefined) {
          acc.violations.tombstones.push({
            id: "RI-20",
            severity: "ERROR",
            message: `contacts/${t.recordId}: Schlüssel nach Löschung nicht vernichtet.`,
          });
        }
        continue;
      }
      const nid = ctx.db.normalizeId(t.table as TableNames, t.recordId);
      if (nid && (await ctx.db.get(nid))) {
        acc.violations.tombstones.push({
          id: "RI-20",
          severity: "ERROR",
          message: `${t.table}/${t.recordId} besteht trotz Löschvermerk.`,
        });
      }
    }
  },
});

const journalEntriesStep = tableStep<"journalEntries">({
  name: "journalEntries",
  table: "journalEntries",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 1000,
  handle: async (_ctx, entries, acc) => {
    for (const e of entries) {
      acc.rows.journalEntries.push({
        id: String(e._id),
        seq: e.seq,
        date: e.date,
        period: e.period,
        lines: e.lines,
        source: e.source,
        ...(e.reversalOfId ? { reversalOfId: String(e.reversalOfId) } : {}),
        attachmentsCount: e.attachments?.length ?? 0,
      });
    }
  },
});

const journalLinesStep = tableStep<"journalLines">({
  name: "journalLines",
  table: "journalLines",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 2000,
  handle: async (_ctx, lines, acc) => {
    for (const l of lines) {
      acc.rows.journalLines.push({
        entryId: String(l.entryId),
        lineIndex: l.lineIndex,
        seq: l.seq,
        date: l.date,
        account: l.account,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      });
    }
  },
});

const registerStep = tableStep<"numberRegister">({
  name: "numberRegister",
  table: "numberRegister",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 2000,
  handle: async (_ctx, register, acc) => {
    for (const r of register) {
      acc.rows.register.push({
        number: r.number,
        normalized: r.normalized,
        docType: r.docType,
        ...(r.rangeId ? { rangeId: String(r.rangeId) } : {}),
        ...(r.periodKey !== undefined ? { periodKey: r.periodKey } : {}),
        ...(r.counter !== undefined ? { counter: r.counter } : {}),
        order: r._creationTime,
        ...(r.imported ? { imported: true as const } : {}),
        ...(r.documentId ? { documentId: r.documentId } : {}),
      });
    }
  },
});

const rangesStep = tableStep<"numberRanges">({
  name: "numberRanges",
  table: "numberRanges",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 2000,
  handle: async (_ctx, ranges, acc) => {
    for (const r of ranges) acc.rows.ranges.push({ id: String(r._id), name: r.name, startValue: r.startValue });
  },
});

const countersStep = tableStep<"numberCounters">({
  name: "numberCounters",
  table: "numberCounters",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 2000,
  handle: async (_ctx, counters, acc) => {
    for (const c of counters) {
      acc.rows.counters.push({ id: String(c._id), rangeId: String(c.rangeId), periodKey: c.periodKey });
    }
  },
});

const hexToBase64 = (hex: string): string => {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(s);
};

/**
 * RI-01, RI-02, RI-05, RI-19 and the chain invariants RI-06/07/08 (F04 sales documents); the pure checks live in
 * src/domain/documents/invariants.ts and chain-invariants.ts. On the frozen snapshots also RI-17 (KU, src/domain/tax/
 * ku-invariants.ts), RI-18/RI-25 (E-Rechnung, Leitweg-ID: src/domain/einvoice/invariants.ts) and RI-26 (Geschäftsbrief
 * footer: src/domain/company/invariants.ts). Reminders also get RI-24 (dunning, below) from the same page.
 */
const documentsStep = tableStep<"salesDocuments">({
  name: "salesDocuments",
  table: "salesDocuments",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 8,
  maxBatch: 50,
  handle: (ctx, docs, acc) => handleDocuments(ctx, docs, acc),
});

/**
 * The per-document findings for a chosen set of documents (the migration after-check re-checks only the documents a
 * migration window touched, AUD-028); cross-row checks (RI-02, chains) need all rows and are not included.
 */
export async function documentViolations(ctx: ReadCtx, docs: Doc<"salesDocuments">[]): Promise<InvariantViolation[]> {
  const acc = emptyAccumulator();
  await handleDocuments(ctx, docs, acc);
  return [...acc.violations.documents, ...acc.violations.dunning];
}

async function handleDocuments(ctx: ReadCtx, docs: Doc<"salesDocuments">[], acc: InvariantAccumulator) {
  if (docs.length === 0) return;
  const kuHistory = (await ctx.db.query("companyProfile").first())?.kleinunternehmer ?? [];
  const dunning = dunningChecker(ctx);
  for (const d of docs) {
    const artifacts: ArtifactInvariantRow[] = [];
    const artifactKinds: { id: string; kind: string }[] = [];
    for (const a of await ctx.db
      .query("documentArtifacts")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .collect()) {
      const file = await ctx.db.system.get(a.storageId);
      artifactKinds.push({ id: String(a._id), kind: a.kind });
      artifacts.push({
        id: String(a._id),
        sha256: a.sha256,
        storedSha256: file ? (file.sha256 === hexToBase64(a.sha256) ? a.sha256 : file.sha256) : null,
      });
    }
    const snap = d.snapshotId ? await ctx.db.get(d.snapshotId) : null;
    let parsed: DocumentSnapshot | null = null;
    if (snap) parsed = JSON.parse(snap.json) as DocumentSnapshot;
    const row: DocumentInvariantRow = {
      id: String(d._id),
      type: d.type,
      status: d.status,
      ...(d.number ? { number: d.number } : {}),
      ...(d.documentDate ? { documentDate: d.documentDate } : {}),
      hasSupplyDate: d.supplyDate !== undefined,
      ...(d.retentionUntil ? { retentionUntil: d.retentionUntil } : {}),
      ...(d.artifactStatus ? { artifactStatus: d.artifactStatus } : {}),
      ...(d.imported ? { imported: true } : {}),
      ...(d.status === "draft"
        ? {}
        : {
            snapshot: snap
              ? {
                  present: true,
                  hashMatches: (await sha256Hex(snap.json)) === snap.snapshotHash,
                  ...(parsed ? { number: parsed.number } : {}),
                }
              : { present: false, hashMatches: false },
          }),
      artifacts,
    };
    acc.rows.documents.push({ id: row.id, status: row.status, ...(row.number ? { number: row.number } : {}) });
    acc.rows.chainRows.push({
      id: String(d._id),
      type: d.type,
      status: d.status,
      ...(d.number ? { number: d.number } : {}),
      ...(d.correctsId ? { originalId: String(d.correctsId) } : {}),
      ...(d.correctionKind ? { correctionKind: d.correctionKind } : {}),
      groups: (parsed?.totals.byGroup ?? []).map((g) => ({
        category: g.category,
        rateBp: g.rateBp,
        netCents: g.baseCents,
        vatCents: g.vatCents,
      })),
      ...(parsed?.deductions
        ? {
            deductions: parsed.deductions.map((x) => ({
              advanceNumber: x.advanceNumber,
              byGroup: x.byGroup.map((g) => ({
                category: g.category,
                rateBp: g.rateBp,
                netCents: g.netCents,
                vatCents: g.vatCents,
              })),
            })),
          }
        : {}),
      // A standalone chain's root is its first advance (no chainRootId on the root itself).
      ...(isChainType(d.type) ? { chainRootId: String(d.chainRootId ?? d._id) } : {}),
      ...(d.deductedInId ? { deductedInId: String(d.deductedInId) } : {}),
    });
    const out = acc.violations.documents;
    out.push(...checkFinalisedDocument(row));
    if (parsed) {
      const nets = parsed.lines.flatMap((l) => (l.kind === "item" && !l.optional ? [l.netCents] : []));
      out.push(...checkTotals(row.number ?? row.id, nets, parsed.totals));
    }
    const marks = await ctx.db
      .query("sendLog")
      .withIndex("by_document_at", (q) => q.eq("documentId", d._id))
      .collect();
    if (parsed) {
      const name = d.number ?? String(d._id);
      out.push(
        ...checkKleinunternehmerDocument(
          { name, type: d.type, ...(d.imported ? { imported: true } : {}), snapshot: parsed },
          kuHistory,
        ),
      );
      out.push(
        ...checkEinvoiceDocument({
          name,
          type: d.type,
          status: d.status,
          ...(d.imported ? { imported: true } : {}),
          decision: d.einvoice?.decision,
          validation: d.einvoice?.validation,
          artifactStatus: d.artifactStatus,
          snapshot: parsed,
          artifacts: artifactKinds,
          marks: [...marks]
            .sort((a, b) => a.at - b.at)
            .map((m) => ({
              id: String(m._id),
              kind: m.kind,
              ...(m.retractsId ? { retractsId: String(m.retractsId) } : {}),
              channel: m.channel,
              artifactIds: m.artifacts.map((a) => String(a.artifactId)),
              ...(m.einvoiceHandedOverElectronically ? { einvoiceHandedOverElectronically: true } : {}),
            })),
        }),
      );
      out.push(...checkGeschaeftsbriefFooter(name, parsed.issuer ?? parsed.seller));
    }
    out.push(
      ...checkSentMarks(
        {
          id: row.id,
          status: d.status,
          ...(d.number ? { number: d.number } : {}),
          ...(d.finalizedAt ? { finalizedOn: berlinCalendarDate(d.finalizedAt) } : {}),
          ...(d.imported ? { imported: true } : {}),
        },
        marks.map((m) => ({
          id: String(m._id),
          kind: m.kind,
          ...(m.retractsId ? { retractsId: String(m.retractsId) } : {}),
          sentOn: m.sentOn,
          recordedOn: berlinCalendarDate(m.at),
          at: m.at,
          artifacts: m.artifacts.map((a) => ({ artifactId: String(a.artifactId), sha256: a.sha256 })),
        })),
        artifacts,
      ),
    );
    if (d.type === "reminder") acc.violations.dunning.push(...(await dunning(d, snap)));
  }
}

/**
 * RI-24 (F05 MAHN-02/03): no consumer reminder carries the 40 € flat fee, and every printed interest segment uses
 * the Basiszinssatz + 5/9 points valid at its start — the shipped row, or the owner override the reminder recorded in
 * its `ruleVersions` (SET-122; reminders without the entry predate overrides and used the shipped table). Overrides
 * and contacts are read once per page.
 */
function dunningChecker(ctx: ReadCtx) {
  let overrides: Map<string, Awaited<ReturnType<typeof listRuleOverrides>>[number]> | undefined;
  const contacts = new Map<string, Doc<"contacts"> | null>();
  return async (r: Doc<"salesDocuments">, snap: Doc<"documentSnapshots"> | null): Promise<InvariantViolation[]> => {
    if (!r.reminder || r.status === "draft") return [];
    const out: InvariantViolation[] = [];
    overrides ??= new Map((await listRuleOverrides(ctx)).map((o) => [overrideRowId(o.id), o]));
    let contact: Doc<"contacts"> | null = null;
    if (r.contactId) {
      const key = String(r.contactId);
      if (!contacts.has(key)) contacts.set(key, await ctx.db.get(r.contactId));
      contact = contacts.get(key) ?? null;
    }
    const consumer = contact?.isConsumer === true;
    const name = r.number ?? String(r._id);
    if (consumer && r.reminder.flatFee40Cents > 0) {
      out.push({ id: "RI-24", severity: "ERROR", message: `${name}: 40-€-Pauschale gegenüber einem Verbraucher.` });
    }
    const segments = r.reminder.interestSegments ?? [];
    const versions =
      segments.length > 0
        ? ((snap?.documentId === r._id
            ? snap
            : await ctx.db
                .query("documentSnapshots")
                .withIndex("by_document", (q) => q.eq("documentId", r._id))
                .first()
          )?.ruleVersions ?? {})
        : {};
    for (const seg of segments) {
      if (r.reminder.manual?.interestCents !== undefined) break;
      const used = overrides.get(versions[`basiszins:${seg.from}`] ?? "");
      const rate = defaultInterestRateBp(
        seg.from as CalendarDate,
        consumer ? "b2c" : "b2b",
        used ? groupOverrides([used]).basiszinssatz : [],
      );
      if (rate.ok && rate.value.rateBp !== seg.rateBp) {
        out.push({
          id: "RI-24",
          severity: "ERROR",
          message: `${name}: Zinssatz ${seg.rateBp} bp ab ${seg.from} entspricht nicht dem Basiszinssatz + Aufschlag (${rate.value.rateBp} bp).`,
        });
      }
    }
    return out;
  };
}

const vouchersStep = tableStep<"vouchers">({
  name: "vouchers",
  table: "vouchers",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 1000,
  handle: async (_ctx, vouchers, acc) => {
    for (const v of vouchers) {
      acc.rows.vouchers.push({
        id: String(v._id),
        label: v.internalNumber ?? v.documentNumber ?? String(v._id),
        status: v.status,
        kind: v.kind,
        files: v.originalFiles,
        eigenbelegApproved: v.eigenbeleg?.approvedAt !== undefined,
        ...(v.recurringVoucherId !== undefined ? { recurringVoucherId: String(v.recurringVoucherId) } : {}),
        ownReference:
          // F07 BNK-052: the bank statement is the Beleg of a rule voucher „Kontoauszug genügt als Beleg“.
          (v.statementIsBeleg === true && v.bankTransactionId !== undefined) ||
          // F04 §4.9: the self-billing Gutschrift (archived sales document) is the Beleg of its voucher.
          v.selfBillingDocumentId !== undefined,
      });
    }
  },
});

const recurringVouchersStep = tableStep<"recurringVouchers">({
  name: "recurringVouchers",
  table: "recurringVouchers",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 1000,
  handle: async (_ctx, templates, acc) => {
    for (const r of templates) if (r.referenceFile) acc.rows.referenceTemplates.push(String(r._id));
  },
});

const movementsStep = tableStep<"stockMovements">({
  name: "stockMovements",
  table: "stockMovements",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 2000,
  handle: async (_ctx, movements, acc) => {
    for (const m of movements) {
      acc.rows.movements.push({
        id: String(m._id),
        productId: String(m.productId),
        quantityMilli: m.quantityMilli,
        ...(m.reversesId ? { reversesId: String(m.reversesId) } : {}),
      });
    }
  },
});

const productsStep = tableStep<"products">({
  name: "products",
  table: "products",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 0,
  maxBatch: 1000,
  handle: async (_ctx, products, acc) => {
    for (const p of products) {
      acc.rows.products.push({
        id: String(p._id),
        label: p.number,
        ...(p.stock?.quantityMilli !== undefined ? { quantityMilli: p.stock.quantityMilli } : {}),
        hasStock: p.stock !== undefined,
      });
    }
  },
});

/** RI-31 rows: settled time entries with the documents (and their lines) they are locked by; cached per page. */
const timeEntriesStep = tableStep<"timeEntries">({
  name: "timeEntries",
  table: "timeEntries",
  index: "by_creation_time",
  key: "_creationTime",
  cost: 2,
  maxBatch: 500,
  handle: async (ctx, all, acc) => {
    const fetched = new Set<string>();
    for (const e of all) {
      if (e.status === "open") continue;
      acc.rows.timeEntries.push({
        id: String(e._id),
        status: e.status,
        ...(e.draftDocumentId ? { draftDocumentId: String(e.draftDocumentId) } : {}),
        ...(e.invoicedLineId ? { invoicedLineId: String(e.invoicedLineId) } : {}),
        ...(e.invoicedDocumentId ? { invoicedDocumentId: String(e.invoicedDocumentId) } : {}),
        ...(e.lockedAt !== undefined ? { lockedAt: e.lockedAt } : {}),
        ...(e.retentionUntil ? { retentionUntil: e.retentionUntil } : {}),
      });
      const id = e.draftDocumentId ?? e.invoicedDocumentId;
      if (id === undefined || fetched.has(String(id))) continue;
      fetched.add(String(id));
      const d = await ctx.db.get(id);
      if (!d) continue;
      const lineEntryIds = new Set<string>();
      for (const l of await ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect()) {
        const timeEntryIds = (l.timeEntryIds ?? []).map(String);
        acc.rows.timeEntryLines.push({ id: String(l._id), documentId: String(id), timeEntryIds });
        for (const t of timeEntryIds) lineEntryIds.add(t);
      }
      acc.rows.timeEntryDocs.push({
        id: String(id),
        status: d.status,
        ...(d.retentionUntil ? { retentionUntil: d.retentionUntil } : {}),
        lineEntryIds: [...lineEntryIds],
      });
    }
  },
});

/** Step order = report order of the former single pass. */
const STEPS: readonly Step[] = [
  metaStep,
  chainStep,
  checkpointStep,
  ...replayedTables().map((table, i) => replayStep(table, i)),
  profileVersionsStep,
  tombstonesStep,
  journalEntriesStep,
  journalLinesStep,
  registerStep,
  rangesStep,
  countersStep,
  documentsStep,
  vouchersStep,
  recurringVouchersStep,
  movementsStep,
  productsStep,
  timeEntriesStep,
];

export const INITIAL_STATE: InvariantState = { step: 0, cursor: null, chain: null, sub: null };

/**
 * Runs steps from `state` until the budget is spent (at least one batch always runs) and returns the page's output
 * with the continuation state. Each row costs its step's estimated lookups; a batch never exceeds the remaining budget.
 */
export async function invariantsPage(
  ctx: ReadCtx,
  state: InvariantState | null,
  budget: InvariantBudget = {},
): Promise<InvariantPage> {
  const reads: ReadStats = { calls: 0, docs: 0, bytes: 0, largestDoc: 0 };
  const current = { largest: 0, bytesBefore: 0 };
  const rctx = { ...ctx, db: countingDb(ctx.db, reads, current) } as ReadCtx;
  const acc = emptyAccumulator();
  const st: InvariantState = state ? { ...state } : { ...INITIAL_STATE };
  const calls = budget.calls ?? Number.POSITIVE_INFINITY;
  const docs = budget.docs ?? Number.POSITIVE_INFINITY;
  const bytes = budget.bytes ?? Number.POSITIVE_INFINITY;
  const rowBytes = new Map<string, number>();
  const sizer: BatchSizer = {
    batch: (key, maxBatch, cost) => {
      current.largest = 0;
      current.bytesBefore = reads.bytes;
      let n = maxBatch;
      if (cost > 0) n = Math.min(n, Math.floor((calls - reads.calls) / cost));
      n = Math.min(n, Math.floor((docs - reads.docs) / (1 + cost)));
      const size = rowBytes.get(key);
      n = Math.min(n, size === undefined ? FIRST_BATCH : Math.floor((bytes - reads.bytes) / Math.max(1, size)));
      return Math.max(1, n);
    },
    measured: (key, rows) => {
      if (rows === 0) return;
      // a row's share of the batch (incl. its lookups) or the largest document read in it, whichever is larger
      const size = Math.max((reads.bytes - current.bytesBefore) / rows, current.largest);
      rowBytes.set(key, Math.max(rowBytes.get(key) ?? 0, size));
    },
  };
  let ran = false;
  while (st.step < STEPS.length) {
    if (ran && (reads.calls >= calls || reads.docs >= docs || reads.bytes >= bytes)) break;
    const step = STEPS[st.step] as Step;
    if (step.kind === "once") {
      await step.run(rctx, acc, st);
      st.step++;
      st.cursor = null;
      ran = true;
      continue;
    }
    const left = calls - reads.calls;
    if (step.kind === "custom") {
      if (ran && left < 1) break;
      const done = await step.run(rctx, acc, st, sizer);
      ran = true;
      if (done) {
        st.step++;
        st.cursor = null;
        st.sub = null;
      }
      continue;
    }
    if (ran && step.cost > 0 && left < step.cost) break;
    const key = String(st.step);
    const page = await keyPage(rctx, step, st.cursor, sizer.batch(key, step.maxBatch, step.cost));
    await step.handle(rctx, page.docs, acc, st);
    sizer.measured(key, page.docs.length);
    ran = true;
    if (page.done) {
      st.step++;
      st.cursor = null;
    } else {
      st.cursor = page.cursor;
    }
  }
  return { acc, state: st, done: st.step >= STEPS.length, reads };
}

/** Cross-row checks over the accumulated rows, assembled in the order of the former single pass. */
export function finishInvariants(acc: InvariantAccumulator): InvariantViolation[] {
  const { violations: v, rows } = acc;
  return [
    ...v.chain,
    ...v.checkpoint,
    ...[...rows.replayFindings]
      .sort((a, b) => a.table - b.table || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => r.v),
    ...v.profileVersions,
    ...v.deletions,
    ...v.tombstones,
    ...journalFindings(rows),
    ...numberingFindings(rows),
    ...v.documents,
    ...documentFindings(rows),
    ...v.dunning,
    ...voucherFindings(rows),
    ...projectFindings(rows),
  ];
}

/** RI-11 and RI-12 (F08 journal) over the whole journal; the pure checks live in src/domain/accounting/invariants.ts. */
function journalFindings(rows: InvariantRows): InvariantViolation[] {
  const { journalEntries: entries, journalLines: lines } = rows;
  if (entries.length === 0 && lines.length === 0) return [];
  const meta = rows.meta[0];
  const bankLedgers = new Set(rows.bankLedgers);
  const custom = new Set(rows.customAccounts);
  const chartOn = (date: string) => chartAt(meta?.chartOfAccounts ?? [], meta?.fiscalYearStartMonth ?? 1, date);
  const accountExists = (account: string, date: string) =>
    bankLedgers.has(account) ||
    (isCalendarDate(date) &&
      (custom.has(`${chartOn(date)}:${account}`) || seededAccount(chartOn(date), date, account) !== null));
  const purged = { seqs: new Set<number>(), ids: new Set<string>() };
  for (const t of rows.purgedJournal) {
    purged.ids.add(t.recordId);
    if (t.seq !== undefined) purged.seqs.add(t.seq);
  }
  const out: InvariantViolation[] = checkJournal(entries, lines, accountExists, purged);
  // RI-11 for the cash account of every chart in use (a chart switch changes the number, EC-116).
  const cashRow = ROLE_MAPPING_ROWS.find((r) => r.role === "cash");
  const cashAccounts = new Set(entries.map((e) => cashRow?.[chartOn(e.date)]).filter((n): n is string => !!n));
  for (const account of cashAccounts) out.push(...checkCash(lines.filter((l) => l.account === account)));
  return out;
}

/**
 * RI-03 (GOBD-02): per counter (range + period) the issued values increase in finalisation order and gaps exist only
 * where an audited counter change documented them (SET-059); the pure check lives in src/domain/numbering/invariants.ts.
 */
function numberingFindings(rows: InvariantRows): InvariantViolation[] {
  if (rows.register.length === 0) return [];
  const ranges = new Map(rows.ranges.map((r) => [r.id, { name: r.name, startValue: r.startValue }]));
  const counters = new Map(rows.counters.map((c) => [c.id, c]));
  const documented = new Map<string, DocumentedGap[]>();
  for (const e of rows.counterReasons) {
    const c = counters.get(e.counterId);
    const gap = c ? parseDocumentedGap(e.reason) : null;
    if (!c || !gap) continue;
    documented.set(c.rangeId, [...(documented.get(c.rangeId) ?? []), { periodKey: c.periodKey, ...gap }]);
  }
  return checkCounterSequences(
    rows.register.map((r) => ({
      number: r.number,
      ...(r.rangeId ? { rangeId: r.rangeId } : {}),
      ...(r.periodKey !== undefined ? { periodKey: r.periodKey } : {}),
      ...(r.counter !== undefined ? { counter: r.counter } : {}),
      order: r.order,
      ...(r.imported ? { imported: true } : {}),
    })),
    ranges,
    documented,
  );
}

/** RI-06/07/08 (chains) and RI-02 (numbers vs register) across all documents. */
function documentFindings(rows: InvariantRows): InvariantViolation[] {
  if (rows.documents.length === 0) return [];
  const docIds = new Set(rows.documents.map((r) => r.id));
  return [
    ...checkChains(rows.chainRows),
    ...checkDocumentNumbers(
      rows.documents,
      rows.register
        .filter(
          (r) => SALES_DOC_TYPES.includes(r.docType as LayoutDocType) || (r.documentId && docIds.has(r.documentId)),
        )
        .map((r) => ({
          number: r.number,
          normalized: r.normalized,
          ...(r.documentId ? { documentId: r.documentId } : {}),
          ...(r.imported ? { imported: true } : {}),
        })),
    ),
  ];
}

/** RI-21 (F06 vouchers): booked vouchers have a Beleg; the pure check lives in src/domain/vouchers/invariants.ts. */
function voucherFindings(rows: InvariantRows): InvariantViolation[] {
  if (rows.vouchers.length === 0) return [];
  const withReference = new Set(rows.referenceTemplates);
  return checkVoucherBelege(
    rows.vouchers.map(({ recurringVoucherId, ownReference, ...v }) => ({
      ...v,
      recurringReference: (recurringVoucherId !== undefined && withReference.has(recurringVoucherId)) || ownReference,
    })),
  );
}

/** RI-30 (stock cache) and RI-31 (time entry locks); the pure checks live in src/domain/projects/invariants.ts. */
function projectFindings(rows: InvariantRows): InvariantViolation[] {
  const moved = new Set(rows.movements.map((m) => m.productId));
  const out: InvariantViolation[] = checkStockCaches(
    rows.products
      .filter((p) => p.hasStock || moved.has(p.id))
      .map((p) => ({ id: p.id, label: p.label, quantityMilli: p.quantityMilli })),
    rows.movements,
  );
  if (rows.timeEntries.length === 0) return out;
  const lines = new Map(
    rows.timeEntryLines.map((l) => [l.id, { documentId: l.documentId, timeEntryIds: l.timeEntryIds }]),
  );
  const docs = new Map(
    rows.timeEntryDocs.map((d) => [
      d.id,
      {
        status: d.status,
        ...(d.retentionUntil ? { retentionUntil: d.retentionUntil } : {}),
        lineEntryIds: new Set(d.lineEntryIds),
      },
    ]),
  );
  out.push(...checkTimeEntryLocks(rows.timeEntries, lines, docs));
  return out;
}

/** Drives the pages to completion; `runPage` is in-process (`checkInvariants`) or `runQuery` (the action). */
export async function driveInvariants(
  runPage: (state: InvariantState | null) => Promise<InvariantPage>,
): Promise<{ violations: InvariantViolation[]; pages: number; maxReads: ReadStats }> {
  const acc = emptyAccumulator();
  const maxReads: ReadStats = { calls: 0, docs: 0, bytes: 0, largestDoc: 0 };
  let state: InvariantState | null = null;
  let pages = 0;
  for (;;) {
    const page = await runPage(state);
    pages++;
    mergeAccumulator(acc, page.acc);
    maxReads.calls = Math.max(maxReads.calls, page.reads.calls);
    maxReads.docs = Math.max(maxReads.docs, page.reads.docs);
    maxReads.bytes = Math.max(maxReads.bytes, page.reads.bytes);
    maxReads.largestDoc = Math.max(maxReads.largestDoc, page.reads.largestDoc);
    if (page.done) break;
    state = page.state;
  }
  return { violations: finishInvariants(acc), pages, maxReads };
}

/**
 * All invariants in the current transaction (unlimited budget). For tests, `migrations` and small datasets; on a
 * production-sized database use the action `internal.invariants.run`, which pages.
 */
export async function checkInvariants(ctx: ReadCtx): Promise<InvariantViolation[]> {
  return (await driveInvariants((state) => invariantsPage(ctx, state))).violations;
}
