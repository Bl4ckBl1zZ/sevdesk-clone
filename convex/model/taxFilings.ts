import { endOfMonth, periodOf } from "../../src/domain/accounting/period";
import type { LockReason } from "../../src/domain/accounting/period-lock";
import { monthsBetween, planLock } from "../../src/domain/accounting/period-lock";
import { formatCents, roundHalfAway } from "../../src/domain/money";
import { elsterGuideFor } from "../../src/domain/rules/elster";
import { retentionUntilFor } from "../../src/domain/rules/retention";
import { ustvaMappingFor } from "../../src/domain/rules/ustva";
import { buildSvzGuide, buildUstvaGuide, buildZmGuide, type ElsterGuide } from "../../src/domain/tax/elster-guide";
import {
  deadlinesForTaxYear,
  dueNotifications as dueNotificationsOf,
  ustvaDeadline,
  zmDeadline,
} from "../../src/domain/tax/filing-calendar";
import { computeSondervorauszahlung, SVZ_MISSING_NOTICE } from "../../src/domain/tax/sondervorauszahlung";
import {
  type Contribution,
  computeUstva,
  correctionRequiredNotice,
  entryContributions,
  type FilingPeriodKind,
  filingPeriodKind,
  filingPeriodLabel,
  filingPeriodOf,
  isFilingPeriod,
  isLastPeriodOfYear,
  type KzDelta,
  kennzahlDeltas,
  mappingMissingNotice,
  monthsOfFilingPeriod,
  NO_CORRECTION_NEEDED,
  sheetHash,
  sheetValues,
  type TaxJournalEntry,
  type TaxJournalLine,
  type UstvaSheet,
} from "../../src/domain/tax/ustva";
import { computeZm, reconcileZmWithUstva, type ZmSheet, zmContributions, zmCsv } from "../../src/domain/tax/zm";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { notify } from "./notifications";
import { checklistFor, lockMonths, periodRows } from "./periodLock";
import type { ModelCtx, ReadCtx } from "./types";
import { kuOn } from "./vouchers";

/**
 * UStVA, ZM and Sondervorauszahlung read models and submission records (F08 TAX-002…TAX-011, TAX-020, TAX-021).
 * The sheets are recomputed from the journal on demand (drafts are never stored); recording a submission freezes the
 * values, the drill-down and the sheet hash in `taxFilings` and locks the months of the period (ACC-016). Never via
 * MCP (owner-only legal act, F08 §7).
 */

type Filing = Doc<"taxFilings">;
type FilingKind = Filing["kind"];

// ── journal read model (tax points) ─────────────────────────────────────────────────────────────────────

/**
 * Every journal entry as a `TaxJournalEntry`: lines with role/taxKey/taxPointDate, the customer (ZM) and — for Ist
 * VAT transfers of a payment on a sales document — the base share of the payment (pro rata of the document's VAT
 * groups, UVA-06; the allocation view of F08 §4.4 without a stored allocations table).
 */
export async function taxJournalEntries(ctx: ReadCtx): Promise<TaxJournalEntry[]> {
  const entries = await ctx.db.query("journalEntries").withIndex("by_seq").collect();
  const contacts = new Map<string, Doc<"contacts"> | null>();
  const contactOf = async (id: string) => {
    if (!contacts.has(id)) contacts.set(id, await ctx.db.get(id as Id<"contacts">));
    return contacts.get(id) ?? null;
  };
  const out: TaxJournalEntry[] = [];
  for (const e of entries) {
    const hasTaxPoint = e.lines.some((l) => l.taxPointDate);
    if (!hasTaxPoint) continue;
    const istBase = e.source.kind === "payment" ? await istBases(ctx, e) : null;
    const lines: TaxJournalLine[] = e.lines.map((l) => {
      const out: TaxJournalLine = {
        account: l.account,
        debitCents: l.debitCents,
        creditCents: l.creditCents,
        ...(l.role ? { role: l.role } : {}),
        ...(l.taxKey ? { taxKey: l.taxKey } : {}),
        ...(l.taxPointDate ? { taxPointDate: l.taxPointDate } : {}),
      };
      const suffix = l.role === "vat.output.19" ? 1900 : l.role === "vat.output.7" ? 700 : null;
      const base = suffix && istBase ? istBase.get(suffix) : undefined;
      if (base) {
        const vat = l.creditCents - l.debitCents;
        out.baseCents =
          base.vatCents === 0 ? 0 : Number(roundHalfAway(BigInt(base.netCents) * BigInt(vat), BigInt(base.vatCents)));
      }
      return out;
    });
    const contactId = e.lines.find((l) => l.contactId)?.contactId;
    const contact = contactId ? await contactOf(contactId) : null;
    out.push({
      id: e._id,
      seq: e.seq,
      date: e.date,
      recordedAt: e.recordedAt,
      source: e.source,
      text: e.text,
      lines,
      ...(contact
        ? {
            counterparty: {
              contactId: contact._id,
              name: contact.displayName,
              ...(contact.vatId ? { vatId: contact.vatId } : {}),
            },
          }
        : {}),
    });
  }
  return out;
}

/** Net and VAT per rate of the document a payment settles (Ist base share). */
async function istBases(ctx: ReadCtx, e: Doc<"journalEntries">) {
  const pid = ctx.db.normalizeId("payments", e.source.id);
  const payment = pid ? await ctx.db.get(pid) : null;
  if (!payment || payment.target.kind !== "salesDocument") return null;
  const did = ctx.db.normalizeId("salesDocuments", payment.target.id);
  const doc = did ? await ctx.db.get(did) : null;
  if (!doc?.totals) return null;
  const map = new Map<number, { netCents: number; vatCents: number }>();
  for (const g of doc.totals.byGroup) {
    if (g.category !== "S") continue;
    const cur = map.get(g.rateBp) ?? { netCents: 0, vatCents: 0 };
    map.set(g.rateBp, { netCents: cur.netCents + g.netCents, vatCents: cur.vatCents + g.vatCents });
  }
  return map;
}

// ── period context ──────────────────────────────────────────────────────────────────────────────────────

export interface PeriodContext {
  period: string;
  year: number;
  months: string[];
  kind: FilingPeriodKind;
  dauerfrist: boolean;
  ku: boolean;
  state: string | undefined;
  ended: boolean;
}

export async function periodContext(ctx: ReadCtx, period: string, now: number): Promise<PeriodContext> {
  if (!isFilingPeriod(period)) throw appError("invalid_input", "Ungültiger Zeitraum (JJJJ-MM, JJJJ-Qn oder JJJJ).");
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const year = Number(period.slice(0, 4));
  const row = profile.ustvaPeriod.find((p) => p.year === year);
  const months = monthsOfFilingPeriod(period);
  const last = endOfMonth(months.at(-1) as string);
  return {
    period,
    year,
    months,
    kind: filingPeriodKind(period),
    dauerfrist: row?.dauerfrist ?? false,
    ku: kuOn(profile, last),
    state: profile.taxNumberState,
    ended: berlinCalendarDate(now) > last,
  };
}

const inMonths = (c: { taxPointDate: string }, months: readonly string[]) =>
  months.includes(c.taxPointDate.slice(0, 7));

// ── filings ─────────────────────────────────────────────────────────────────────────────────────────────

const FAMILY: Record<"ustva" | "zm" | "sondervorauszahlung", FilingKind[]> = {
  ustva: ["ustva", "ustva_correction"],
  zm: ["zm", "zm_correction"],
  sondervorauszahlung: ["sondervorauszahlung"],
};

export async function filingsOf(ctx: ReadCtx, form: keyof typeof FAMILY, period: string): Promise<Filing[]> {
  const rows = await ctx.db
    .query("taxFilings")
    .withIndex("by_period", (q) => q.eq("period", period))
    .collect();
  return rows.filter((f) => FAMILY[form].includes(f.kind)).sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
}

/** The filing in force: the latest `submitted_manually` (a correction supersedes the previous one). */
export const activeFiling = (filings: readonly Filing[]) =>
  filings.filter((f) => f.status === "submitted_manually").at(-1) ?? null;

const valuesRecord = (f: Pick<Filing, "values">) => Object.fromEntries(f.values.map((v) => [v.kz, v.cents]));
const valuesArray = (r: Record<string, number>) => Object.entries(r).map(([kz, cents]) => ({ kz, cents }));

function filingView(f: Filing) {
  return {
    id: f._id,
    kind: f.kind,
    period: f.period,
    status: f.status,
    submittedOn: f.submittedOn ?? null,
    transmissionTicket: f.transmissionTicket ?? null,
    values: valuesRecord(f),
    submittedValuesDiffer: f.submittedValuesDiffer ?? false,
    elsterReportedTotalCents: f.elsterReportedTotalCents ?? null,
    valuesDifferReason: f.valuesDifferReason ?? null,
    hasProtocol: f.protocolStorageId !== undefined,
    actor: f.actor,
    submittedAt: f.submittedAt ?? null,
  };
}

// ── UStVA ───────────────────────────────────────────────────────────────────────────────────────────────

/** Kz 39: the Sondervorauszahlung of the year, deducted in December/Q4 only (E-UVA-08). */
async function sondervorauszahlungOf(ctx: ReadCtx, year: number): Promise<number | null> {
  const active = activeFiling(await filingsOf(ctx, "sondervorauszahlung", String(year)));
  return active ? (valuesRecord(active)["38"] ?? 0) : null;
}

export async function computeUstvaFor(
  ctx: ReadCtx,
  pc: PeriodContext,
): Promise<{ sheet: UstvaSheet; contributions: Contribution[]; entries: TaxJournalEntry[] } | null> {
  const mapping = ustvaMappingFor(pc.year);
  if (!mapping) return null;
  const entries = await taxJournalEntries(ctx);
  const contributions = entries.flatMap((e) => entryContributions(e, mapping)).filter((c) => inMonths(c, pc.months));
  const svz = pc.dauerfrist && isLastPeriodOfYear(pc.period) ? await sondervorauszahlungOf(ctx, pc.year) : null;
  const sheet = computeUstva(pc.period, contributions, mapping, {
    ku: pc.ku,
    ...(svz ? { sondervorauszahlungCents: svz } : {}),
  });
  if (pc.dauerfrist && pc.kind === "monthly" && pc.period.endsWith("-12") && svz === null) {
    sheet.notices.push(SVZ_MISSING_NOTICE);
  }
  return { sheet, contributions, entries };
}

/** E-UVA-03 blockers (drafts/pending artifacts with tax point in the period, ACC-017 (2a)). */
async function filingBlockers(ctx: ReadCtx, months: readonly string[], now: number): Promise<string[]> {
  const cl = await checklistFor(ctx, months, now);
  return cl.blockers.map((b) =>
    b.code === "drafts"
      ? `Es gibt ${b.count ?? 0} Entwürfe mit Leistungsdatum im Zeitraum. Bitte fertigstellen oder löschen.`
      : b.message,
  );
}

export interface CorrectionState {
  required: boolean;
  deltas: KzDelta[];
  notice: string | null;
}

function correctionState(active: Filing | null, values: Record<string, number>): CorrectionState | null {
  if (!active) return null;
  const deltas = kennzahlDeltas(valuesRecord(active), values);
  // E-UVA-19: „abweichend übermittelt“ — ELSTER has a different Kz 83 than the stored app values
  if (active.submittedValuesDiffer && active.elsterReportedTotalCents !== undefined) {
    const app = values["83"] ?? 0;
    if (!deltas.some((d) => d.kz === "83") && app !== active.elsterReportedTotalCents) {
      deltas.push({
        kz: "83",
        beforeCents: active.elsterReportedTotalCents,
        afterCents: app,
        deltaCents: app - active.elsterReportedTotalCents,
      });
    }
  }
  return { required: deltas.length > 0, deltas, notice: null };
}

const refsOf = (drill: UstvaSheet["drillDown"]) =>
  Object.entries(drill).map(([kz, list]) => ({
    kz,
    refs: list.map((d) => ({ source: d.source.kind, id: d.source.id })),
  }));

export async function ustvaView(ctx: ReadCtx, period: string, now: number) {
  const pc = await periodContext(ctx, period, now);
  const label = filingPeriodLabel(period);
  const filings = await filingsOf(ctx, "ustva", period);
  const active = activeFiling(filings);
  const computed = await computeUstvaFor(ctx, pc);
  const deadline = ustvaDeadline(period, pc.dauerfrist, pc.state);
  if (!computed) {
    return {
      period,
      label,
      deadline,
      ended: pc.ended,
      sheet: null,
      guide: null,
      blockers: [mappingMissingNotice(pc.year)],
      filings: filings.map(filingView),
      correction: null,
      drillDown: {} as Awaited<ReturnType<typeof drillDownLabels>>,
    };
  }
  const { sheet, contributions } = computed;
  const values = sheetValues(sheet);
  const correction = correctionState(active, values);
  const lateCount = active
    ? new Set(
        computed.entries
          .filter((e) => e.recordedAt > (active.submittedAt ?? 0))
          .filter((e) => contributions.some((c) => c.entryId === e.id))
          .map((e) => e.id),
      ).size
    : 0;
  if (correction?.required) correction.notice = correctionRequiredNotice(Math.max(1, lateCount), label);
  const isCorrection = active !== null;
  const blockers = await filingBlockers(ctx, pc.months, now);
  const mapping = ustvaMappingFor(pc.year);
  const guideData = elsterGuideFor("ustva", pc.year);
  const hash = await sheetHash({
    form: isCorrection ? "ustva_correction" : "ustva",
    period,
    ruleVersions: [mapping?.version ?? "", guideData?.id ?? ""],
    values,
  });
  const guide = buildUstvaGuide(sheet, guideData, {
    correction: isCorrection,
    blockers,
    today: berlinCalendarDate(now),
    sheetHash: hash,
  });
  return {
    period,
    label,
    deadline,
    ended: pc.ended,
    sheet,
    guide,
    blockers: guide.blockers,
    filings: filings.map(filingView),
    correction,
    drillDown: await drillDownLabels(ctx, sheet.drillDown),
  };
}

/** TAX-005: per Kennzahl the contributing entries with seq, date, text and a link to the source document. */
async function drillDownLabels(ctx: ReadCtx, drill: UstvaSheet["drillDown"]) {
  const out: Record<
    string,
    {
      entryId: string;
      seq: number;
      date: string;
      text: string;
      cents: number;
      source: { kind: string; id: string };
      href: string | null;
    }[]
  > = {};
  for (const [kz, list] of Object.entries(drill)) {
    out[kz] = [];
    for (const d of list) {
      const e = await ctx.db.get(d.entryId as Id<"journalEntries">);
      out[kz].push({
        entryId: d.entryId,
        seq: d.seq,
        date: e?.date ?? "",
        text: e?.text ?? "",
        cents: d.cents,
        source: d.source,
        href: sourceHref(d.source),
      });
    }
  }
  return out;
}

export function sourceHref(source: { kind: string; id: string }): string | null {
  if (source.kind === "salesDocument") return `/rechnungen/${source.id}`;
  if (source.kind === "voucher") return `/belege/${source.id}`;
  return null;
}

/** TAX-005 back-link: the UStVA periods and Kennzahlen a source document contributes to („UStVA 2026-09 Kz 81“). */
export async function kennzahlenOfSource(ctx: ReadCtx, source: { kind: string; id: string }) {
  const profile = await getCompanyProfile(ctx);
  const entries = (await taxJournalEntries(ctx)).filter(
    (e) => e.source.kind === source.kind && e.source.id === source.id,
  );
  const out = new Map<string, { period: string; kz: string }>();
  for (const e of entries) {
    const year = Number(e.date.slice(0, 4));
    const mapping = ustvaMappingFor(year) ?? ustvaMappingFor(year - 1);
    if (!mapping) continue;
    for (const c of entryContributions(e, mapping)) {
      const y = Number(c.taxPointDate.slice(0, 4));
      const kind = profile?.ustvaPeriod.find((p) => p.year === y)?.period ?? "quarterly";
      const p = filingPeriodOf(c.taxPointDate, kind);
      out.set(`${p}|${c.kz}`, { period: p, kz: c.kz });
    }
  }
  return [...out.values()].sort((a, b) => a.period.localeCompare(b.period) || Number(a.kz) - Number(b.kz));
}

// ── ZM ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function computeZmFor(ctx: ReadCtx, pc: PeriodContext): Promise<ZmSheet> {
  const entries = await taxJournalEntries(ctx);
  const contributions = entries.flatMap(zmContributions).filter((c) => inMonths(c, pc.months));
  const quarterMonths = monthsOfFilingPeriod(
    `${pc.year}-Q${Math.ceil(Number((pc.months.at(-1) as string).slice(5, 7)) / 3)}`,
  );
  const quarterGoods = entries
    .flatMap(zmContributions)
    .filter((c) => c.type === "L" && inMonths(c, quarterMonths))
    .reduce((s, c) => s + c.cents, 0);
  return computeZm(pc.period, contributions, { quarterGoodsCents: quarterGoods, date: `${pc.year}-01-01` });
}

export async function zmView(ctx: ReadCtx, period: string, now: number) {
  const pc = await periodContext(ctx, period, now);
  const label = filingPeriodLabel(period);
  const zm = await computeZmFor(ctx, pc);
  const filings = await filingsOf(ctx, "zm", period);
  const active = activeFiling(filings);
  const blockers = await filingBlockers(ctx, pc.months, now);
  if (pc.ku) blockers.push("Als Kleinunternehmer (§ 19 UStG) ist keine Zusammenfassende Meldung abzugeben.");
  // TAX-010: reconciliation with the UStVA Kz 41/21 of the same months
  const ustva = pc.ku ? null : await computeUstvaFor(ctx, pc);
  const kz = (k: string) => Math.trunc((ustva?.sheet.fields.find((f) => f.kz === k)?.valueCents ?? 0) / 100);
  const reconciliation = ustva ? reconcileZmWithUstva(zm, kz("41"), kz("21")) : [];
  const guideData = elsterGuideFor("zm", pc.year);
  const values = zmValues(zm);
  const hash = await sheetHash({
    form: active ? "zm_correction" : "zm",
    period,
    ruleVersions: [guideData?.id ?? ""],
    values,
  });
  const guide = buildZmGuide(zm, pc.year, guideData, {
    correction: active !== null,
    blockers,
    today: berlinCalendarDate(now),
    sheetHash: hash,
  });
  const deltas = active ? kennzahlDeltas(valuesRecord(active), values) : [];
  return {
    period,
    label,
    deadline: zmDeadline(period, pc.state),
    ended: pc.ended,
    zm,
    csv: zmCsv(zm),
    reconciliation,
    guide,
    blockers: guide.blockers,
    filings: filings.map(filingView),
    correction: active ? { required: deltas.length > 0, deltas, notice: null } : null,
  };
}

/** ZM values as „<vatId>|<type>“ → whole euros × 100, plus the total under "sum". */
function zmValues(zm: ZmSheet): Record<string, number> {
  const v: Record<string, number> = {};
  for (const r of zm.rows) v[`${r.vatId}|${r.type}`] = r.euros * 100;
  v.sum = zm.totalEuros * 100;
  return v;
}

// ── Sondervorauszahlung ─────────────────────────────────────────────────────────────────────────────────

export async function svzView(ctx: ReadCtx, year: number, now: number) {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const row = profile.ustvaPeriod.find((p) => p.year === year);
  const prior: number[] = [];
  let priorSvz = 0;
  for (const m of monthsBetween(`${year - 1}-01`, `${year - 1}-12`)) {
    const active = activeFiling(await filingsOf(ctx, "ustva", m));
    if (!active) continue;
    const v = valuesRecord(active);
    prior.push(v["83"] ?? 0);
    if (m.endsWith("-12")) priorSvz = v["39"] ?? 0;
  }
  const r = computeSondervorauszahlung({
    year,
    period: row?.period ?? "quarterly",
    dauerfrist: row?.dauerfrist ?? false,
    priorYearKz83Cents: prior,
    priorYearSondervorauszahlungCents: priorSvz,
  });
  const filings = await filingsOf(ctx, "sondervorauszahlung", String(year));
  const guideData = elsterGuideFor("ust1h", year);
  const amount = r.ok ? r.value.amountCents : 0;
  const hash = await sheetHash({
    form: "sondervorauszahlung",
    period: String(year),
    ruleVersions: [guideData?.id ?? ""],
    values: { "38": amount },
  });
  const guide = r.ok
    ? buildSvzGuide(amount, year, guideData, { today: berlinCalendarDate(now), sheetHash: hash })
    : null;
  return {
    year,
    applicable: r.ok,
    reason: r.ok ? r.value.explanation : r.error.message,
    priorMonthsFiled: prior.length,
    amountCents: amount,
    guide,
    blockers: guide?.blockers ?? [r.ok ? "" : r.error.message].filter(Boolean),
    filings: filings.map(filingView),
  };
}

// ── deadlines (TAX-019) ─────────────────────────────────────────────────────────────────────────────────

export async function taxDeadlines(ctx: ReadCtx, year: number) {
  const profile = await getCompanyProfile(ctx);
  if (!profile) return [];
  const row = profile.ustvaPeriod.find((p) => p.year === year);
  const ku = kuOn(profile, `${year}-12-31`);
  const entries = ku ? await taxJournalEntries(ctx) : [];
  const mapping = ustvaMappingFor(year);
  // KU: UStVA deadlines only for periods with §13b/igE liabilities (TAX-011)
  const kuNeedsUstva =
    ku &&
    mapping !== null &&
    entries.some((e) =>
      entryContributions(e, mapping).some((c) => ["46", "47", "84", "85", "89", "93"].includes(c.kz)),
    );
  const legal = profile.legalForm;
  const bilanz = (profile.profitMethod.at(-1)?.method ?? "euer") === "bilanz";
  const list = deadlinesForTaxYear(year, {
    ustvaPeriod: ku && !kuNeedsUstva ? null : (row?.period ?? "quarterly"),
    dauerfrist: row?.dauerfrist ?? false,
    zm: ku ? null : (await hasEuSupplies(ctx)) ? "quarterly" : null,
    state: profile.taxNumberState,
    estPrepayments: !["gmbh", "ug", "ag"].includes(legal),
    gewstPrepayments: legal !== "freiberufler",
    euServices: !ku && (await hasEuSupplies(ctx)),
    euer: !bilanz,
    gewerbe: legal !== "freiberufler",
  });
  const filed = new Set<string>();
  for (const f of await ctx.db.query("taxFilings").collect()) {
    if (f.status !== "draft") filed.add(`${f.kind.replace("_correction", "")}|${f.period}`);
  }
  return list.map((d) => ({ ...d, done: d.period ? filed.has(`${d.kind}|${d.period}`) : false }));
}

async function hasEuSupplies(ctx: ReadCtx): Promise<boolean> {
  const entries = await taxJournalEntries(ctx);
  return entries.some((e) => e.lines.some((l) => l.taxKey === "igL" || l.taxKey === "EU-RC"));
}

// ── submission record (TAX-021) ─────────────────────────────────────────────────────────────────────────

export interface SubmissionInput {
  form: "ustva" | "zm" | "sondervorauszahlung";
  period: string;
  submittedOn: string;
  transferTicket: string;
  protocolStorageId?: Id<"_storage">;
  /** Cross-check value from the ELSTER protocol/preview: Kz 83 / Σ ZM / Kz 38 (cents). */
  crossCheckCents: number;
  sheetHash: string;
  /** „abweichend übermittelt“ (E-UVA-19). */
  valuesDifferReason?: string;
}

const formatEur = (c: number) => formatCents(c);

/**
 * Records the manual Mein ELSTER submission: validates (E-UVA-01/02/03/04/05/18/19/20), freezes values and
 * drill-down, supersedes the previous filing of a correction and locks the months (`ustva_submitted` /
 * `zm_submitted`; the Sondervorauszahlung locks nothing).
 */
export async function recordSubmission(ctx: ModelCtx, input: SubmissionInput) {
  const now = ctx.now();
  const today = berlinCalendarDate(now);
  const ticket = input.transferTicket.trim();
  if (ticket.length === 0) {
    throw appError(
      "transfer_ticket_required",
      "Bitte das Transferticket aus dem ELSTER-Übermittlungsprotokoll eintragen. Es steht auch in Mein ELSTER bei den übermittelten Formularen.",
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.submittedOn) || input.submittedOn > today) {
    throw appError("invalid_input", "Das Übermittlungsdatum darf nicht in der Zukunft liegen.");
  }

  let values: Record<string, number>;
  let drill: { kz: string; refs: { source: string; id: string }[] }[] = [];
  let guide: ElsterGuide | null;
  let appTotal: number;
  let ruleVersion: string;
  let zmRows: Filing["zmRows"];
  let months: string[] = [];
  let label: string;
  let lock: LockReason | null = null;
  const filings = await filingsOf(ctx, input.form, input.period);
  const active = activeFiling(filings);

  if (input.form === "sondervorauszahlung") {
    const year = Number(input.period);
    const view = await svzView(ctx, year, now);
    if (!view.applicable || !view.guide) throw appError("filing_blocked", view.reason);
    guide = view.guide;
    values = { "38": view.amountCents };
    appTotal = view.amountCents;
    ruleVersion = guide.id ?? `ust1h-${year}`;
    label = String(year);
    if (active) throw appError("filing_blocked", `Für ${year} ist die Sondervorauszahlung bereits erfasst.`);
  } else {
    const pc = await periodContext(ctx, input.period, now);
    label = filingPeriodLabel(input.period);
    if (!pc.ended) throw appError("filing_blocked", `Der Zeitraum ${label} ist noch nicht abgeschlossen.`);
    if (input.submittedOn <= endOfMonth(pc.months.at(-1) as string)) {
      throw appError("filing_blocked", `Der Zeitraum ${label} ist noch nicht abgeschlossen.`);
    }
    months = pc.months;
    if (input.form === "ustva") {
      const view = await ustvaView(ctx, input.period, now);
      if (!view.sheet || !view.guide) throw appError("filing_blocked", view.blockers.join(" "));
      guide = view.guide;
      values = sheetValues(view.sheet);
      drill = refsOf(view.sheet.drillDown);
      appTotal = view.sheet.totalCents;
      ruleVersion = view.sheet.mappingVersion;
      lock = "ustva_submitted";
      if (active && view.correction && !view.correction.required)
        throw appError("filing_blocked", NO_CORRECTION_NEEDED);
    } else {
      const view = await zmView(ctx, input.period, now);
      guide = view.guide;
      values = zmValues(view.zm);
      drill = view.zm.rows.map((r) => ({
        kz: `${r.vatId}|${r.type}`,
        refs: r.contributors.map((c) => ({ source: c.source.kind, id: c.source.id })),
      }));
      zmRows = view.zm.rows.map((r) => ({ vatId: r.vatId, type: r.type, euros: r.euros }));
      appTotal = view.zm.totalEuros * 100;
      ruleVersion = guide.id ?? `zm-${pc.year}`;
      lock = "zm_submitted";
      if (active && view.correction && !view.correction.required) {
        throw appError(
          "filing_blocked",
          "Die berichtigten Werte entsprechen der letzten Meldung – keine Berichtigung nötig.",
        );
      }
    }
  }
  if (guide.blocked) throw appError("filing_blocked", guide.blockers.join(" "));
  if (guide.sheetHash !== input.sheetHash) {
    const before = active ? valuesRecord(active) : {};
    const n = kennzahlDeltas(before, values).length;
    throw appError(
      "sheet_changed",
      `Die Werte haben sich seit dem Öffnen der Ausfüllhilfe geändert (${n} Kennzahlen). Bitte prüfen, welche Werte an ELSTER übermittelt wurden.`,
    );
  }
  const reason = input.valuesDifferReason?.trim() ?? "";
  const differs = input.crossCheckCents !== appTotal;
  if (differs && reason.length < 5) {
    throw appError(
      "cross_check_mismatch",
      `ELSTER weist ${formatEur(input.crossCheckCents)} € aus, die Buchhaltung ${formatEur(appTotal)} €. Bitte Eingaben vergleichen. Wurde bereits so übermittelt, ist eine Berichtigung erforderlich.`,
      { elsterCents: input.crossCheckCents, appCents: appTotal },
    );
  }
  // months to lock: the period plus every open earlier month of the fiscal year (ACC-016 „lückenlos“)
  let lockPlan: string[] = [];
  if (lock && months.length > 0) {
    const profile = await getCompanyProfile(ctx);
    const plan = planLock({
      target: months.at(-1) as string,
      fiscalYearStartMonth: profile?.fiscalYearStartMonth ?? 1,
      bookkeepingStartDate: profile?.bookkeepingStartDate,
      periods: await periodRows(ctx),
    });
    lockPlan = plan.ok ? plan.value.months : [];
    const blockers = (await checklistFor(ctx, lockPlan, now)).blockers;
    if (blockers.length > 0) throw appError("filing_blocked", blockers.map((b) => b.message).join(" "));
  }
  let protocolSha256: string | undefined;
  if (input.protocolStorageId) {
    const meta = await ctx.db.system.get(input.protocolStorageId);
    if (!meta) throw appError("invalid_input", "Das Übermittlungsprotokoll wurde nicht gefunden.");
    protocolSha256 = meta.sha256;
  }
  const kind: FilingKind =
    input.form === "sondervorauszahlung" ? "sondervorauszahlung" : active ? `${input.form}_correction` : input.form;
  const id = await auditedInsert(
    ctx,
    "taxFilings",
    {
      kind,
      period: input.period,
      ruleVersion,
      ...(guide.id ? { guideVersion: guide.id } : {}),
      values: valuesArray(values),
      ...(zmRows ? { zmRows } : {}),
      drillDown: drill,
      ...(active ? { supersedesId: active._id } : {}),
      status: "submitted_manually",
      submittedVia: "mein_elster_manual",
      submittedOn: input.submittedOn,
      sheetHash: input.sheetHash,
      ...(differs
        ? { elsterReportedTotalCents: input.crossCheckCents, submittedValuesDiffer: true, valuesDifferReason: reason }
        : {}),
      submittedAt: now,
      transmissionTicket: ticket,
      ...(input.protocolStorageId ? { protocolStorageId: input.protocolStorageId } : {}),
      ...(protocolSha256 ? { protocolSha256 } : {}),
      retentionUntil: retentionUntilFor("books10", `${input.period.slice(0, 4)}-12-31`) ?? undefined,
      actor: ctx.actor,
    },
    { action: "tax_filing.submit", label: `${kind} ${label}`, ...(differs ? { reason } : {}) },
  );
  if (active) {
    await auditedPatch(
      ctx,
      "taxFilings",
      active._id,
      { status: "superseded" },
      {
        action: "tax_filing.supersede",
        label: `${active.kind} ${label}`,
      },
    );
  }
  const locked = lock && lockPlan.length > 0 ? await lockMonths(ctx, lockPlan, lock) : { months: [], lockedRecords: 0 };
  return { id, kind, lockedMonths: locked.months, submittedValuesDiffer: differs };
}

export async function filingsOfYear(ctx: ReadCtx, year: number) {
  const rows = (await ctx.db.query("taxFilings").collect()).filter((f) => f.period.startsWith(String(year)));
  return rows
    .sort((a, b) => a.period.localeCompare(b.period) || (a.submittedAt ?? 0) - (b.submittedAt ?? 0))
    .map(filingView);
}

export const periodOfDate = periodOf;

// ── deadlines.notify (TAX-019) ──────────────────────────────────────────────────────────────────────────

const NOTIFY_KIND: Record<string, string> = {
  ustva: "deadline.ustva",
  zm: "deadline.zm",
  einvoice_eu_service: "deadline.14a",
  sondervorauszahlung: "deadline.vorauszahlung",
  est_prepayment: "deadline.vorauszahlung",
  gewst_prepayment: "deadline.vorauszahlung",
  annual_euer: "deadline.annual_return",
  annual_ust: "deadline.annual_return",
  annual_gewst: "deadline.annual_return",
};

const LINK: Record<string, string> = {
  ustva: "/steuern/ustva",
  zm: "/steuern/zm",
  sondervorauszahlung: "/steuern/ustva",
};

/** Daily run: reminders and due-day notifications for open deadlines (idempotent per deadline and day kind). */
export async function notifyTaxDeadlines(ctx: ModelCtx): Promise<number> {
  const today = berlinCalendarDate(ctx.now());
  const year = Number(today.slice(0, 4));
  let n = 0;
  for (const y of [year - 1, year]) {
    const list = await taxDeadlines(ctx, y);
    for (const { deadline, when } of dueNotificationsOf(list, today)) {
      if ((deadline as { done?: boolean }).done) continue;
      const kind = NOTIFY_KIND[deadline.kind] ?? "deadline.vorauszahlung";
      const due = `${deadline.due.slice(8, 10)}.${deadline.due.slice(5, 7)}.${deadline.due.slice(0, 4)}`;
      await notify(ctx, {
        kind,
        severity: "warning",
        title: when === "due" ? `Heute fällig: ${deadline.label}` : `${deadline.label} – fällig am ${due}`,
        body: `Frist ${deadline.label}: ${due}${deadline.due !== deadline.statutory ? " (verschoben nach § 108 Abs. 3 AO)" : ""}.`,
        ...(LINK[deadline.kind] ? { link: LINK[deadline.kind] } : {}),
        dedupeKey: `tax_deadline|${deadline.kind}|${deadline.period ?? ""}|${when}`,
      });
      n++;
    }
  }
  return n;
}
