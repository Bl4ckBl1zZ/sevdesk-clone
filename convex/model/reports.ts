import { chartAt, fiscalYearOf, fiscalYearStart } from "../../src/domain/accounting/period";
import { resolveRole } from "../../src/domain/accounting/resolve";
import type { OpenItemDocument, SettlementRow } from "../../src/domain/payments/open-items";
import {
  type AccountInfo,
  bwaAmountsFromCash,
  bwaAmountsFromLines,
  computeBwa,
  computeLedger,
  computeSusa,
  type ReportLine,
} from "../../src/domain/reports/ledger-reports";
import { reportMeta } from "../../src/domain/reports/meta";
import { computeOpos, type OposSide } from "../../src/domain/reports/opos";
import {
  computeRevenue,
  type RevenueBasis,
  type RevenueDocument,
  type RevenueGroupBy,
} from "../../src/domain/reports/revenue";
import { chartAccounts } from "../../src/domain/rules/accounting";
import { cashBasisItems } from "../../src/domain/tax/euer";
import { calendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { getCompanyProfile } from "./companyProfile";
import { euerContext } from "./euer";
import { resolveContextAt } from "./journal";
import { ledgerAccountsOf } from "./ledgerAccounts";
import { openItemsAsOf, settlesOf } from "./payments";
import { periodRows } from "./periodLock";
import { sourceHref } from "./taxFilings";
import type { ReadCtx } from "./types";

/**
 * Report read models (F08 RPT-001…RPT-007): load the journal, accounts, documents and payments and hand them to the
 * pure report functions in src/domain/reports. Every result carries the RPT-001 meta (parameters, generation time,
 * rule versions, lock status → „vorläufig“) and drill-down ids (entry → source document).
 */

type Profile = Doc<"companyProfile">;

function requireDate(d: string, label: string): string {
  if (!isCalendarDate(d)) throw appError("invalid_input", `Ungültiges Datum (${label}).`);
  return d;
}

async function profileOf(ctx: ReadCtx): Promise<Profile> {
  const p = await getCompanyProfile(ctx);
  if (!p) throw appError("setup_incomplete");
  return p;
}

/** Account master data of the chart valid on `at`: seed, custom accounts and bank ledger accounts. */
export async function accountMap(ctx: ReadCtx, profile: Profile, at: string) {
  const chart = chartAt(profile.chartOfAccounts, profile.fiscalYearStartMonth ?? 1, at);
  const map = new Map<string, AccountInfo>();
  const seed = chartAccounts(chart, calendarDate(at));
  for (const a of seed.ok ? seed.value : []) {
    map.set(a.number, { number: a.number, name: a.name, type: a.type, bwaGroup: a.bwaGroup });
  }
  for (const a of (await ledgerAccountsOf(ctx, chart)).custom) {
    map.set(a.number, { number: a.number, name: a.name, type: a.type, bwaGroup: a.bwaGroup });
  }
  for (const b of await ctx.db.query("bankAccounts").collect()) {
    const existing = map.get(b.ledgerAccount);
    map.set(b.ledgerAccount, {
      number: b.ledgerAccount,
      name: existing ? `${existing.name} – ${b.name}` : b.name,
      type: existing?.type ?? "bank",
      bwaGroup: existing?.bwaGroup ?? "NONE",
    });
  }
  return { chart, accounts: map, ruleVersion: `chart-${chart.toLowerCase()}` };
}

/** Belegfeld 1 per journal source (document / voucher / payment number). */
async function belegfeld(ctx: ReadCtx, source: { kind: string; id: string }, cache: Map<string, string>) {
  const key = `${source.kind}:${source.id}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  let v = "";
  if (source.kind === "salesDocument") {
    const id = ctx.db.normalizeId("salesDocuments", source.id);
    v = (id ? (await ctx.db.get(id))?.number : undefined) ?? "";
  } else if (source.kind === "voucher") {
    const id = ctx.db.normalizeId("vouchers", source.id);
    v = (id ? (await ctx.db.get(id))?.internalNumber : undefined) ?? "";
  } else if (source.kind === "payment") {
    const id = ctx.db.normalizeId("payments", source.id);
    v = (id ? (await ctx.db.get(id))?.number : undefined) ?? "";
  }
  cache.set(key, v);
  return v;
}

/** All journal lines up to `to` as report lines (contra accounts, Belegfeld 1, cost centre). */
export async function reportLines(ctx: ReadCtx, to: string, withBeleg = false): Promise<ReportLine[]> {
  const entries = await ctx.db.query("journalEntries").withIndex("by_seq").collect();
  const cache = new Map<string, string>();
  const out: ReportLine[] = [];
  for (const e of entries) {
    if (e.date > to) continue;
    const beleg = withBeleg ? await belegfeld(ctx, e.source, cache) : "";
    for (const l of e.lines) {
      const contra = e.lines
        .filter((o) => (l.debitCents > 0 ? o.creditCents > 0 : o.debitCents > 0))
        .map((o) => o.account);
      out.push({
        entryId: e._id,
        seq: e.seq,
        date: e.date,
        account: l.account,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        sourceKind: e.source.kind,
        sourceId: e.source.id,
        text: e.text,
        ...(beleg ? { belegfeld1: beleg } : {}),
        contra,
        ...(l.costCenterId ? { costCenterId: l.costCenterId } : {}),
      });
    }
  }
  return out;
}

async function lockedMonths(ctx: ReadCtx): Promise<string[]> {
  return (await periodRows(ctx)).filter((p) => p.status === "locked").map((p) => p.period);
}

async function metaFor(
  ctx: ReadCtx,
  report: string,
  params: Record<string, string | number | boolean | null>,
  range: { from: string; to: string },
  ruleVersions: string[],
  now: number,
) {
  return reportMeta({
    report,
    params,
    generatedAt: now,
    ruleVersions,
    from: range.from,
    to: range.to,
    lockedMonths: await lockedMonths(ctx),
  });
}

// ── SuSa / Kontenblatt / BWA ───────────────────────────────────────────────────────────────────────────

export async function susaView(
  ctx: ReadCtx,
  a: { from: string; to: string; accountClass?: string; includePersonal?: boolean },
  now: number,
) {
  const from = requireDate(a.from, "von");
  const to = requireDate(a.to, "bis");
  const profile = await profileOf(ctx);
  const start = profile.fiscalYearStartMonth ?? 1;
  const fyStart = fiscalYearStart(fiscalYearOf(to, start), start);
  const { accounts, ruleVersion } = await accountMap(ctx, profile, to);
  const susa = computeSusa({
    lines: await reportLines(ctx, to),
    accounts,
    fiscalYearStart: fyStart,
    from: from < fyStart ? fyStart : from,
    to,
    ...(a.accountClass ? { accountClass: a.accountClass } : {}),
    ...(a.includePersonal !== undefined ? { includePersonal: a.includePersonal } : {}),
  });
  const meta = await metaFor(
    ctx,
    "susa",
    { from, to, klasse: a.accountClass ?? null },
    { from, to },
    [ruleVersion],
    now,
  );
  return { meta, ...susa };
}

export async function ledgerView(ctx: ReadCtx, a: { account: string; from: string; to: string }, now: number) {
  const from = requireDate(a.from, "von");
  const to = requireDate(a.to, "bis");
  const profile = await profileOf(ctx);
  const { accounts, ruleVersion } = await accountMap(ctx, profile, to);
  const ledger = computeLedger({
    lines: await reportLines(ctx, to, true),
    account: a.account,
    name: accounts.get(a.account)?.name ?? "",
    from,
    to,
  });
  const meta = await metaFor(ctx, "ledger", { konto: a.account, from, to }, { from, to }, [ruleVersion], now);
  return {
    meta,
    ...ledger,
    rows: ledger.rows.map((r) => ({ ...r, href: sourceHref({ kind: r.sourceKind, id: r.sourceId }) })),
  };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const lastDay = (ym: string) => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return `${ym}-${pad2(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
};

export async function bwaView(
  ctx: ReadCtx,
  a: { month: string; variant: "accrual" | "cash"; costCenterId?: string },
  now: number,
) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(a.month)) throw appError("invalid_input", "Ungültiger Monat (JJJJ-MM).");
  const profile = await profileOf(ctx);
  const start = profile.fiscalYearStartMonth ?? 1;
  const monthFrom = `${a.month}-01`;
  const monthTo = lastDay(a.month);
  const fy = fiscalYearOf(monthTo, start);
  const ytdFrom = fiscalYearStart(fy, start);
  const priorFrom = fiscalYearStart(fy - 1, start);
  const priorTo = `${Number(monthTo.slice(0, 4)) - 1}${monthTo.slice(4, 8)}${pad2(Math.min(Number(monthTo.slice(8)), 28))}`;
  const prior = { from: priorFrom, to: lastDay(priorTo.slice(0, 7)) };
  const { accounts, ruleVersion } = await accountMap(ctx, profile, monthTo);
  let amounts: (r: { from: string; to: string }) => ReturnType<typeof bwaAmountsFromLines>;
  if (a.variant === "cash") {
    const { context, entries } = await euerContext(ctx, profile, Number(monthTo.slice(0, 4)));
    const items = cashBasisItems(entries, context);
    amounts = (r) => bwaAmountsFromCash(items, accounts, r);
  } else {
    const lines = await reportLines(ctx, monthTo);
    amounts = (r) => bwaAmountsFromLines(lines, accounts, r, a.costCenterId);
  }
  const rows = computeBwa(
    amounts({ from: monthFrom, to: monthTo }),
    amounts({ from: ytdFrom, to: monthTo }),
    amounts(prior),
  );
  const meta = await metaFor(
    ctx,
    "bwa",
    { monat: a.month, variante: a.variant, kostenstelle: a.costCenterId ?? null },
    { from: ytdFrom, to: monthTo },
    [ruleVersion, "bwa-2026.1"],
    now,
  );
  return { meta, month: a.month, variant: a.variant, ytdFrom, rows };
}

// ── Offene Posten (RPT-006) ────────────────────────────────────────────────────────────────────────────

export async function oposView(ctx: ReadCtx, a: { side: OposSide; asOf: string }, now: number) {
  const asOf = requireDate(a.asOf, "Stichtag");
  await profileOf(ctx);
  const rctx = await resolveContextAt(ctx, calendarDate(asOf));
  const role = a.side === "debtors" ? "receivable" : "payable";
  const res = resolveRole(role, rctx);
  const account = res.ok ? res.value.account : null;
  const lines = await reportLines(ctx, asOf);
  const own = lines.filter((l) => l.account === account);
  const balance = own.reduce(
    (s, l) => s + (a.side === "debtors" ? l.debitCents - l.creditCents : l.creditCents - l.debitCents),
    0,
  );
  const manualEntries = own
    .filter((l) => l.sourceKind === "manual" || l.sourceKind === "opening_balance")
    .map((l) => ({
      entryId: l.entryId,
      seq: l.seq,
      date: l.date,
      text: l.text,
      cents: a.side === "debtors" ? l.debitCents - l.creditCents : l.creditCents - l.debitCents,
    }));
  let documents: OpenItemDocument[] = [];
  let rows: SettlementRow[] = [];
  const dunningLevels: Record<string, number> = {};
  const contactNames = new Map<string, string>();
  if (a.side === "debtors") {
    const r = await openItemsAsOf(ctx, { asOf });
    documents = r.items.map(({ paidCents: _p, openCents: _o, daysOverdue: _d, overdue: _v, bucket: _b, ...d }) => d);
    // re-run on the open documents only: the settlement rows are already netted into `openCents`
    rows = r.items.map((i) => ({
      targetKind: i.kind,
      targetId: i.id,
      date: asOf,
      settlesCents: i.payableCents - (i.creditedCents ?? 0) - i.openCents,
      amountCents: i.paidCents,
    }));
    // customer credit balances (overpayments) reduce the receivable account like a negative item
    for (const c of r.credits) {
      rows.push({
        targetKind: "contactCredit",
        targetId: c.contactId,
        date: asOf,
        settlesCents: c.balanceCents,
        amountCents: 0,
      });
      contactNames.set(c.contactId, c.contactName);
    }
    for (const c of await ctx.db.query("dunningCases").collect()) {
      if (c.status !== "closed") dunningLevels[c.invoiceId] = c.currentLevel;
    }
  } else {
    for (const v of await ctx.db.query("vouchers").collect()) {
      if (v.direction !== "expense" || v.status === "draft" || v.status === "cancelled") continue;
      if (!v.documentDate || v.documentDate > asOf) continue;
      documents.push({
        id: v._id,
        kind: "salesDocument",
        number: v.internalNumber ?? v.documentNumber ?? "",
        ...(v.supplierContactId ? { contactId: v.supplierContactId } : {}),
        contactName: v.supplierName ?? "",
        documentDate: v.documentDate,
        ...(v.dueDate ? { dueDate: v.dueDate } : {}),
        payableCents: v.totalsEur?.grossCents ?? v.totals.grossCents,
        currency: "EUR",
      });
    }
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_date", (q) => q.lte("date", asOf))
      .collect();
    rows = payments
      .filter((p) => p.target.kind === "voucher")
      .map((p) => ({
        targetKind: "salesDocument" as const,
        targetId: p.target.id,
        date: p.date,
        settlesCents: settlesOf(p),
        amountCents: p.amountCents,
      }));
  }
  const report = computeOpos({
    side: a.side,
    documents,
    rows,
    asOf,
    accountBalanceCents: balance,
    dunningLevels,
    manualEntries,
    contactNames,
  });
  const meta = await metaFor(ctx, "opos", { seite: a.side, stichtag: asOf }, { from: asOf, to: asOf }, [], now);
  return {
    meta,
    account,
    ...report,
    items: report.items.map((i) => ({
      ...i,
      href: a.side === "debtors" ? (i.kind === "salesDocument" ? `/rechnungen/${i.id}` : null) : `/belege/${i.id}`,
    })),
  };
}

// ── Umsatz (RPT-007) ───────────────────────────────────────────────────────────────────────────────────

const REVENUE_TYPES = new Set(["invoice", "partial_invoice", "final_invoice", "cancellation", "correction"]);

const supplyEnd = (s: Doc<"salesDocuments">["supplyDate"]) =>
  !s ? undefined : s.kind === "date" ? s.date : s.kind === "period" ? s.to : lastDay(s.month);

export async function revenueView(
  ctx: ReadCtx,
  a: { groupBy: RevenueGroupBy; basis: RevenueBasis; from: string; to: string },
  now: number,
) {
  const from = requireDate(a.from, "von");
  const to = requireDate(a.to, "bis");
  const docs = (await ctx.db.query("salesDocuments").collect()).filter(
    (d) => REVENUE_TYPES.has(d.type) && d.status !== "draft" && d.number && d.documentDate && d.totals,
  );
  const documents: RevenueDocument[] = [];
  for (const d of docs) {
    // A Storno has no lines of its own (it mirrors the cancelled document's snapshot): it is attributed through the
    // cancelled document's lines (negated below) and inherits its cost centre and project.
    const origin = d.type === "cancellation" && d.correctsId ? await ctx.db.get(d.correctsId) : null;
    const lineSource = origin?._id ?? d._id;
    const costCenterId = d.costCenterId ?? origin?.costCenterId;
    const projectId = d.projectId ?? origin?.projectId;
    // a Rechnungsberichtigung without amount changes (kind rectification, totals 0) adds nothing
    const lines =
      a.groupBy === "product" || a.groupBy === "cost_center" || a.groupBy === "project"
        ? (
            await ctx.db
              .query("documentLines")
              .withIndex("by_document", (q) => q.eq("documentId", lineSource))
              .collect()
          )
            .filter((l) => l.kind === "item" && l.lineNetCents !== undefined)
            .map((l) => ({
              ...(l.productId ? { productId: l.productId as string } : {}),
              productName: l.name ?? "",
              netCents: (l.lineNetCents ?? 0) * (d.totals.netCents < 0 && (l.lineNetCents ?? 0) > 0 ? -1 : 1),
              ...(l.costCenterId ? { costCenterId: l.costCenterId as string } : {}),
              ...(l.projectId ? { projectId: l.projectId as string } : {}),
            }))
        : [];
    const supply = supplyEnd(d.supplyDate);
    documents.push({
      id: d._id,
      number: d.number ?? "",
      type: d.type,
      documentDate: d.documentDate ?? "",
      ...(supply ? { supplyDate: supply } : {}),
      ...(d.contactId ? { contactId: d.contactId } : {}),
      contactName: d.contactName ?? "",
      ...(costCenterId ? { costCenterId } : {}),
      ...(projectId ? { projectId } : {}),
      netCents: d.totals.netCents,
      grossCents: d.totals.grossCents,
      lines,
    });
  }
  const payments =
    a.basis === "cash"
      ? (await ctx.db.query("payments").collect())
          .filter((p) => p.target.kind === "salesDocument")
          .map((p) => ({ documentId: p.target.id, date: p.date, settlesCents: settlesOf(p) }))
      : [];
  const costCenters = new Map(
    (await ctx.db.query("costCenters").collect()).map((c) => [c._id as string, (c as { name?: string }).name ?? c._id]),
  );
  const projects =
    a.groupBy === "project"
      ? new Map((await ctx.db.query("projects").collect()).map((p) => [p._id as string, `${p.number} ${p.name}`]))
      : undefined;
  const report = computeRevenue({
    documents,
    payments,
    groupBy: a.groupBy,
    basis: a.basis,
    from,
    to,
    costCenters,
    ...(projects ? { projects } : {}),
  });
  const meta = await metaFor(
    ctx,
    "revenue",
    { gruppierung: a.groupBy, basis: a.basis, from, to },
    { from, to },
    [],
    now,
  );
  return { meta, ...report };
}

export type ReportKind = "susa" | "ledger" | "bwa" | "opos" | "revenue";
