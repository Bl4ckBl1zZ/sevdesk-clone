import { checkCash, checkJournal } from "../../src/domain/accounting/invariants";
import { chartAt } from "../../src/domain/accounting/period";
import { canonicalize } from "../../src/domain/audit/canonical";
import { genesisHash, sha256Hex, verifyChainPage } from "../../src/domain/audit/chain";
import { isEncryptedValue } from "../../src/domain/audit/personal";
import { REDACTED } from "../../src/domain/audit/redact";
import { TECHNICAL_TABLES, technicalFields } from "../../src/domain/audit/technical";
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
import { ROLE_MAPPING_ROWS, seededAccount } from "../../src/domain/rules/accounting";
import { defaultInterestRateBp } from "../../src/domain/rules/basiszinssatz";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
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
  out.push(...(await checkDocumentInvariants(ctx)));
  out.push(...(await checkDunningInvariants(ctx)));
  return out;
}

/**
 * RI-24 (F05 MAHN-02/03): no consumer reminder carries the 40 € flat fee, and every printed interest segment uses
 * the Basiszinssatz + 5/9 points valid at its start.
 */
export async function checkDunningInvariants(ctx: ReadCtx): Promise<InvariantViolation[]> {
  const out: InvariantViolation[] = [];
  for (const r of await ctx.db
    .query("salesDocuments")
    .withIndex("by_type_status_date", (q) => q.eq("type", "reminder"))
    .collect()) {
    if (!r.reminder || r.status === "draft") continue;
    const contact = r.contactId ? await ctx.db.get(r.contactId) : null;
    const consumer = contact?.isConsumer === true;
    const name = r.number ?? String(r._id);
    if (consumer && r.reminder.flatFee40Cents > 0) {
      out.push({ id: "RI-24", severity: "ERROR", message: `${name}: 40-€-Pauschale gegenüber einem Verbraucher.` });
    }
    for (const seg of r.reminder.interestSegments ?? []) {
      if (r.reminder.manual?.interestCents !== undefined) break;
      const rate = defaultInterestRateBp(seg.from as CalendarDate, consumer ? "b2c" : "b2b");
      if (rate.ok && rate.value.rateBp !== seg.rateBp) {
        out.push({
          id: "RI-24",
          severity: "ERROR",
          message: `${name}: Zinssatz ${seg.rateBp} bp ab ${seg.from} entspricht nicht dem Basiszinssatz + Aufschlag (${rate.value.rateBp} bp).`,
        });
      }
    }
  }
  return out;
}

const hexToBase64 = (hex: string): string => {
  let s = "";
  for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16));
  return btoa(s);
};

/**
 * RI-01, RI-02, RI-05, RI-19 and the chain invariants RI-06/07/08 (F04 sales documents); the pure checks live in
 * src/domain/documents/invariants.ts and chain-invariants.ts.
 */
export async function checkDocumentInvariants(ctx: ReadCtx): Promise<InvariantViolation[]> {
  const docs = await ctx.db.query("salesDocuments").collect();
  const register = await ctx.db.query("numberRegister").collect();
  if (docs.length === 0) return [];
  const out: InvariantViolation[] = [];
  const rows = [];
  const chainRows: ChainInvariantRow[] = [];
  for (const d of docs) {
    const artifacts: ArtifactInvariantRow[] = [];
    for (const a of await ctx.db
      .query("documentArtifacts")
      .withIndex("by_document", (q) => q.eq("documentId", d._id))
      .collect()) {
      const file = await ctx.db.system.get(a.storageId);
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
    rows.push(row);
    chainRows.push({
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
    out.push(...checkFinalisedDocument(row));
    if (parsed) {
      const nets = parsed.lines.flatMap((l) => (l.kind === "item" && !l.optional ? [l.netCents] : []));
      out.push(...checkTotals(row.number ?? row.id, nets, parsed.totals));
    }
    const marks = await ctx.db
      .query("sendLog")
      .withIndex("by_document_at", (q) => q.eq("documentId", d._id))
      .collect();
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
  }
  out.push(...checkChains(chainRows));
  const docIds = new Set(rows.map((r) => r.id));
  out.push(
    ...checkDocumentNumbers(
      rows,
      register
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
  );
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
