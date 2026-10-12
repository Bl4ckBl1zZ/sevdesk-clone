import { checkCash, checkJournal } from "../../src/domain/accounting/invariants";
import { chartAt } from "../../src/domain/accounting/period";
import { canonicalize } from "../../src/domain/audit/canonical";
import { genesisHash, verifyChainPage } from "../../src/domain/audit/chain";
import { isEncryptedValue } from "../../src/domain/audit/personal";
import { REDACTED } from "../../src/domain/audit/redact";
import { TECHNICAL_TABLES, technicalFields } from "../../src/domain/audit/technical";
import { ROLE_MAPPING_ROWS, seededAccount } from "../../src/domain/rules/accounting";
import { isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, TableNames } from "../_generated/dataModel";
import { instanceName } from "../lib/env";
import schema from "../schema";
import type { ReadCtx } from "./types";

/**
 * Regulatory invariants (10-edge-cases §2) evaluated over the whole database. P0 implements (P1 adds RI-11/RI-12 below):
 *  - RI-14 audit chain complete: seq contiguous from 1, every hash recomputes, head contains the latest checkpoint.
 *  - RI-15 every state change is audited: replaying the audit diffs of each record reproduces its current state
 *    (detects writes that bypassed the model layer, incl. changes to frozen records, and unaudited inserts).
 * Used by `assertInvariants()` after every Convex/integration test and by the `invariants.check` job (02 §7).
 * Reads everything in one transaction — fine for tests and P0 data volumes; the nightly job paginates in P1.
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
    if (v !== undefined) a[k] = v;
    if (actual[k] !== undefined) b[k] = actual[k];
  }
  return [canonicalize(a), canonicalize(b)] as const;
}

export async function checkInvariants(ctx: ReadCtx): Promise<InvariantViolation[]> {
  const out: InvariantViolation[] = [];
  const entries = await ctx.db.query("auditLog").withIndex("by_seq").collect();

  // RI-14 — chain
  const res = await verifyChainPage(entries, { nextSeq: 1, prevHash: await genesisHash(instanceName()) });
  for (const f of res.findings) out.push({ id: "RI-14", severity: "ERROR", message: f.detail });
  const cp = await ctx.db.query("integrityCheckpoints").withIndex("by_at").order("desc").first();
  if (cp && cp.lastSeq > 0) {
    const atCp = entries.find((e) => e.seq === cp.lastSeq);
    if (!atCp || atCp.hash !== cp.lastHash) {
      out.push({
        id: "RI-14",
        severity: "ERROR",
        message: `Kette enthält den Prüfpunkt vom ${cp.date} (seq ${cp.lastSeq}) nicht.`,
      });
    }
  }

  // RI-15 — replay
  const byEntity = new Map<string, Doc<"auditLog">[]>();
  for (const e of entries) {
    const key = `${e.entity.table}\u0000${e.entity.id}`;
    const list = byEntity.get(key) ?? [];
    list.push(e);
    byEntity.set(key, list);
  }
  for (const table of replayedTables()) {
    for (const doc of await ctx.db.query(table).collect()) {
      const id = String(doc._id);
      const audited = replayEntity(byEntity.get(`${table}\u0000${id}`) ?? []);
      if (audited === null) {
        out.push({ id: "RI-15", severity: "ERROR", message: `${table}/${id} existiert ohne Protokolleintrag.` });
        continue;
      }
      const [a, b] = comparable(audited, withoutSystem(doc as Record<string, unknown>), technicalFields(table));
      if (a !== b) {
        out.push({ id: "RI-15", severity: "ERROR", message: `${table}/${id} weicht vom protokollierten Stand ab.` });
      }
    }
  }
  // RI-15 — snapshots: every companyProfileVersions row belongs to an audited companyProfile change.
  const bySeq = new Map(entries.map((e) => [e.seq, e]));
  for (const v of await ctx.db.query("companyProfileVersions").collect()) {
    const e = bySeq.get(v.auditSeq);
    const after = (e?.diff as { after?: { version?: unknown } } | undefined)?.after;
    if (e?.entity.table !== "companyProfile" || after?.version !== v.version) {
      out.push({
        id: "RI-15",
        severity: "ERROR",
        message: `companyProfileVersions/${String(v._id)} (Version ${v.version}) ohne passenden Protokolleintrag.`,
      });
    }
  }
  out.push(...(await checkJournalInvariants(ctx)));
  return out;
}

/** RI-11 and RI-12 (F08 journal) over the whole journal; the pure checks live in src/domain/accounting/invariants.ts. */
export async function checkJournalInvariants(ctx: ReadCtx): Promise<InvariantViolation[]> {
  const entries = await ctx.db.query("journalEntries").collect();
  const lines = await ctx.db.query("journalLines").collect();
  if (entries.length === 0 && lines.length === 0) return [];
  const banks = await ctx.db.query("bankAccounts").collect();
  const bankLedgers = new Set(banks.map((b) => b.ledgerAccount));
  const profile = await ctx.db.query("companyProfile").first();
  const chartOn = (date: string) => chartAt(profile?.chartOfAccounts ?? [], profile?.fiscalYearStartMonth ?? 1, date);
  const accountExists = (account: string, date: string) =>
    bankLedgers.has(account) || (isCalendarDate(date) && seededAccount(chartOn(date), date, account) !== null);
  const out: InvariantViolation[] = checkJournal(
    entries.map((e) => ({
      id: String(e._id),
      seq: e.seq,
      date: e.date,
      period: e.period,
      lines: e.lines,
      source: e.source,
      ...(e.reversalOfId ? { reversalOfId: String(e.reversalOfId) } : {}),
      attachmentsCount: e.attachments?.length ?? 0,
    })),
    lines.map((l) => ({ ...l, entryId: String(l.entryId) })),
    accountExists,
  );
  // RI-11 for the cash account of every chart in use (a chart switch changes the number, EC-116).
  const cashRow = ROLE_MAPPING_ROWS.find((r) => r.role === "cash");
  const cashAccounts = new Set(entries.map((e) => cashRow?.[chartOn(e.date)]).filter((n): n is string => !!n));
  for (const account of cashAccounts) out.push(...checkCash(lines.filter((l) => l.account === account)));
  return out;
}
