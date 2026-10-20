import { chartAt } from "../../src/domain/accounting/period";
import { planLock } from "../../src/domain/accounting/period-lock";
import { resolveRole } from "../../src/domain/accounting/resolve";
import { formatCents } from "../../src/domain/money";
import type { EuerKey } from "../../src/domain/rules/accounting";
import { seededAccount } from "../../src/domain/rules/accounting";
import { euerMappingFor } from "../../src/domain/rules/euer";
import { retentionUntilFor } from "../../src/domain/rules/retention";
import {
  type AveuerGroupInput,
  type AveuerPoolInput,
  buildEuerGuide,
  cashBasisItems,
  computeAveuer,
  computeEuer,
  type EuerContext,
  type EuerJournalEntry,
  type EuerPaymentInfo,
  type TenDayInfo,
} from "../../src/domain/tax/euer";
import { ustvaDeadline } from "../../src/domain/tax/filing-calendar";
import { filingPeriodLabel, sheetHash } from "../../src/domain/tax/ustva";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { calendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { anlagenspiegelOf } from "./assets";
import { auditedInsert } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { resolveContextAt } from "./journal";
import { ledgerAccountsOf } from "./ledgerAccounts";
import { checklistFor, lockMonths, periodRows } from "./periodLock";
import { sourceHref, taxDeadlines } from "./taxFilings";
import type { ModelCtx, ReadCtx } from "./types";
import { kuOn } from "./vouchers";

/**
 * EÜR read model (F08 TAX-015, TAX-016, TAX-022; AO-02): loads the journal, payments, opening items, assets and the
 * 10-day-rule data and hands them to the pure engine (`src/domain/tax/euer.ts`). Recomputed on demand; the
 * submission record (TAX-021) freezes the values in `taxFilings` (kind `euer`, period `YYYY`).
 */

type Profile = Doc<"companyProfile">;

export const BILANZ_NOTICE = "Ihre Gewinnermittlung ist Bilanzierung – EÜR nicht verfügbar.";
export const euerNotReadyNotice = (year: number) =>
  `Die EÜR ${year} kann erst erfasst werden, wenn das Jahr abgeschlossen und alle Voranmeldungen ${year} übermittelt sind.`;

export function isBilanz(profile: Profile | null, year: number): boolean {
  const row = [...(profile?.profitMethod ?? [])]
    .filter((p) => p.validFromFiscalYear <= year)
    .sort((a, b) => a.validFromFiscalYear - b.validFromFiscalYear)
    .at(-1);
  return row?.method === "bilanz";
}

const supplyEnd = (s: Doc<"vouchers">["supplyDate"]): string | undefined =>
  !s ? undefined : s.kind === "date" ? s.date : s.kind === "period" ? s.to : `${s.month}-28`;

/** Everything the engine needs, for the chart valid in `year`. */
export async function euerContext(
  ctx: ReadCtx,
  profile: Profile,
  year: number,
): Promise<{
  context: EuerContext;
  entries: EuerJournalEntry[];
  manualOpenItemEntries: number;
  openingWithoutSplit: number;
}> {
  const at = calendarDate(`${year}-12-31`);
  const chart = chartAt(profile.chartOfAccounts, profile.fiscalYearStartMonth ?? 1, at);
  const custom = await ledgerAccountsOf(ctx, chart);
  const customKeys = new Map(custom.custom.map((a) => [a.number, a.euerKey]));
  const keyCache = new Map<string, EuerKey>();
  const euerKeyOf = (account: string): EuerKey => {
    let k = keyCache.get(account);
    if (!k) {
      k = customKeys.get(account) ?? seededAccount(chart, at, account)?.euerKey ?? "NONE";
      keyCache.set(account, k);
    }
    return k;
  };
  const rctx = await resolveContextAt(ctx, at);
  const openItemAccounts = new Set<string>();
  for (const role of ["receivable", "payable"]) {
    const r = resolveRole(role, rctx);
    if (r.ok && r.value.account) openItemAccounts.add(r.value.account);
  }

  const rows = await ctx.db.query("journalEntries").withIndex("by_seq").collect();
  let manualOpenItemEntries = 0;
  const entries: EuerJournalEntry[] = rows.map((e) => {
    if (
      e.source.kind === "manual" &&
      e.date.startsWith(String(year)) &&
      e.lines.some((l) => openItemAccounts.has(l.account))
    ) {
      manualOpenItemEntries++;
    }
    return {
      id: e._id,
      seq: e.seq,
      date: e.date,
      source: e.source,
      text: e.text,
      recordedAt: e.recordedAt,
      lines: e.lines.map((l) => ({
        account: l.account,
        ...(l.role ? { role: l.role } : {}),
        debitCents: l.debitCents,
        creditCents: l.creditCents,
      })),
    };
  });

  const payments: Record<string, EuerPaymentInfo> = {};
  for (const p of await ctx.db.query("payments").collect()) {
    const writeOffs = p.differences.filter((d) => d.reason === "write_off");
    payments[p._id] = {
      target: p.target,
      ...(p.source.kind === "credit" ? { creditClearedCents: p.amountCents } : {}),
      ...(writeOffs.length > 0
        ? {
            writeOff: {
              grossCents: writeOffs.reduce((s, d) => s + d.amountCents, 0),
              vatCents: writeOffs.reduce((s, d) => s + (d.vatCorrection ?? []).reduce((t, c) => t + c.vatCents, 0), 0),
            },
          }
        : {}),
    };
  }

  // opening receivables (ACC-013): VAT split from the archived document, the Ist not-due VAT, or KU
  const openingItems: Record<string, { grossCents: number; parts: { key: EuerKey; cents: number }[] }> = {};
  let openingWithoutSplit = 0;
  for (const o of await ctx.db.query("openingItems").collect()) {
    const doc = o.documentId ? await ctx.db.get(o.documentId) : null;
    const parts: { key: EuerKey; cents: number }[] = [];
    if (o.taxedAs === "ist" && o.notDueVat) {
      const vat = o.notDueVat.reduce((s, x) => s + x.vatCents, 0);
      // the VAT is recognised by the payment's Ist transfer line (vat.output.notdue → vat.output)
      parts.push({ key: "BE.STPFL", cents: o.grossCents - vat }, { key: "NONE", cents: vat });
    } else if (doc?.totals && doc.totals.grossCents > 0) {
      const net = doc.totals.byGroup.reduce((s, g) => s + g.netCents, 0);
      const vat = doc.totals.byGroup.reduce((s, g) => s + g.vatCents, 0);
      const ku = kuOn(profile, o.documentDate);
      parts.push(
        { key: ku ? "BE.KU" : vat > 0 ? "BE.STPFL" : "BE.STFREI", cents: net },
        { key: "BE.UST_VEREINNAHMT", cents: vat },
      );
      // scale to the gross of the opening item (a part may have been paid before the Buchungsbeginn)
      if (net + vat !== o.grossCents) {
        const f = o.grossCents / (net + vat);
        parts[0] = { key: parts[0]?.key ?? "BE.STPFL", cents: Math.round(net * f) };
        parts[1] = { key: "BE.UST_VEREINNAHMT", cents: o.grossCents - Math.round(net * f) };
      }
    } else if (kuOn(profile, o.documentDate)) {
      parts.push({ key: "BE.KU", cents: o.grossCents });
    } else {
      parts.push({ key: "BE.STPFL", cents: o.grossCents });
      if (o.fiscalYear === year) openingWithoutSplit++;
    }
    openingItems[o._id] = { grossCents: o.grossCents, parts };
  }

  const assets: Record<string, { assetClass: "movable" | "immovable" | "intangible"; method: string }> = {};
  for (const a of await ctx.db.query("assets").collect()) {
    assets[a._id] = { assetClass: a.assetClass, method: a.method };
  }

  // 10-day rule (TAX-016): UStVA payments by period (statutory due date incl. Dauerfrist), recurring vouchers
  const tenDay: Record<string, TenDayInfo> = {};
  for (const v of await ctx.db.query("vouchers").collect()) {
    if (v.status === "draft" || v.status === "cancelled") continue;
    const tp = v.taxPayment;
    if (tp?.subtype === "ust_prepayment" && tp.period) {
      const py = Number(tp.period.slice(0, 4));
      const dauerfrist = profile.ustvaPeriod.find((r) => r.year === py)?.dauerfrist ?? false;
      const due = ustvaDeadline(tp.period, dauerfrist, profile.taxNumberState).statutory;
      tenDay[v._id] = { dueDate: due, economicYear: py, reason: `UStVA ${filingPeriodLabel(tp.period)}` };
    } else if (v.recurringPayment && v.dueDate) {
      const eco = supplyEnd(v.supplyDate) ?? v.documentDate;
      if (eco) {
        tenDay[v._id] = {
          dueDate: v.dueDate,
          economicYear: Number(eco.slice(0, 4)),
          reason: "regelmäßig wiederkehrende Zahlung",
        };
      }
    }
  }

  return {
    context: {
      euerKeyOf,
      openItemAccounts,
      payments,
      openingItems,
      assets,
      tenDay,
      kuOn: (d) => kuOn(profile, d),
    },
    entries,
    manualOpenItemEntries,
    openingWithoutSplit,
  };
}

/** AVEÜR inputs from the Anlagenspiegel (AST-012): groups by account role / class, Sammelposten per pool year. */
async function aveuerInputs(ctx: ReadCtx, year: number) {
  const spiegel = await anlagenspiegelOf(ctx, year);
  const assets = new Map((await ctx.db.query("assets").collect()).map((a) => [a._id as string, a]));
  const at = calendarDate(`${year}-12-31`);
  const rctx = await resolveContextAt(ctx, at);
  const accountOf = (role: string) => {
    const r = resolveRole(role, rctx);
    return r.ok ? r.value.account : null;
  };
  const vehicle = accountOf("asset.vehicle");
  const office = accountOf("asset.office");
  const groups: AveuerGroupInput[] = [];
  const pools = new Map<number, AveuerPoolInput>();
  for (const row of spiegel.assets) {
    const a = assets.get(row.id);
    if (!a || a.method === "gwg") continue;
    if (a.method === "pool") {
      const y = a.poolYear ?? Number(a.acquisitionDate.slice(0, 4));
      const p = pools.get(y) ?? {
        poolYear: y,
        akCents: 0,
        bookValueStartCents: 0,
        releaseCents: 0,
        bookValueEndCents: 0,
      };
      p.akCents += row.akEndCents;
      p.bookValueStartCents += row.bookValueStartCents;
      p.releaseCents += row.afaYearCents;
      p.bookValueEndCents += row.bookValueEndCents;
      pools.set(y, p);
      continue;
    }
    const group: AveuerGroupInput["group"] =
      a.assetClass === "intangible"
        ? "immateriell"
        : a.assetClass === "immovable"
          ? "gebaeude"
          : a.account === vehicle
            ? "kfz"
            : a.account === office
              ? "buero"
              : "andere";
    groups.push({
      group,
      akCents: row.akEndCents,
      bookValueStartCents: row.bookValueStartCents,
      additionsCents: row.additionsCents,
      afaCents: row.afaYearCents,
      disposalsCents: row.rbwYearCents,
      bookValueEndCents: row.bookValueEndCents,
    });
  }
  return { groups, pools: [...pools.values()] };
}

/** The EÜR filing (kind `euer`) in force for a year. */
export async function euerFilings(ctx: ReadCtx, year: number) {
  const rows = await ctx.db
    .query("taxFilings")
    .withIndex("by_kind_period", (q) => q.eq("kind", "euer").eq("period", String(year)))
    .collect();
  return rows.sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
}

/** E-UVA-21 / TAX-022 preconditions besides the sheet's own blockers. */
async function euerPreconditions(ctx: ReadCtx, year: number, now: number): Promise<string[]> {
  const out: string[] = [];
  const today = berlinCalendarDate(now);
  const openUstva = (await taxDeadlines(ctx, year)).filter((d) => d.kind === "ustva" && !d.done);
  if (today <= `${year}-12-31` || openUstva.length > 0) out.push(euerNotReadyNotice(year));
  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const cl = await checklistFor(ctx, months, now);
  for (const b of cl.blockers) {
    out.push(
      b.code === "drafts"
        ? `Es gibt ${b.count ?? 0} Entwürfe mit Leistungsdatum im Zeitraum. Bitte fertigstellen oder löschen.`
        : b.message,
    );
  }
  return out;
}

const valuesWithAveuer = (values: Record<string, number>, aveuer: ReturnType<typeof computeAveuer>) => {
  const v: Record<string, number> = { ...values };
  for (const f of aveuer?.fields ?? []) if (f.valueCents !== 0) v[`AV${f.kz}`] = f.valueCents;
  return v;
};

export async function euerView(ctx: ReadCtx, year: number, now: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw appError("invalid_input", "Ungültiges Jahr.");
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  if (isBilanz(profile, year)) throw appError("conflict", BILANZ_NOTICE);
  const mapping = euerMappingFor(year);
  const { context, entries, manualOpenItemEntries, openingWithoutSplit } = await euerContext(ctx, profile, year);
  const items = cashBasisItems(entries, context);
  const ku = kuOn(profile, `${year}-12-31`);
  const sheet = computeEuer(year, items, mapping, {
    ku,
    manualOpenItemEntries,
    openingItemsWithoutSplit: openingWithoutSplit,
  });
  const av = await aveuerInputs(ctx, year);
  const aveuer = computeAveuer(mapping?.aveuer ?? null, year, av.groups, av.pools);
  const filings = await euerFilings(ctx, year);
  const active = filings.filter((f) => f.status === "submitted_manually").at(-1) ?? null;
  const preconditions = await euerPreconditions(ctx, year, now);
  if (active) preconditions.push(`Die EÜR ${year} ist bereits als übermittelt erfasst.`);
  const values = valuesWithAveuer(sheet.values, aveuer);
  const hash = await sheetHash({
    form: "euer",
    period: String(year),
    ruleVersions: [mapping?.version ?? "", `elster-euer-${year}`],
    values,
  });
  const guide = buildEuerGuide(sheet, aveuer, {
    legalForm: profile.legalForm,
    today: berlinCalendarDate(now),
    sheetHash: hash,
    blockers: preconditions,
  });
  // TAX-022: postings with an original date in the year recorded after the submission
  const late = active
    ? (await ctx.db.query("journalEntries").withIndex("by_seq").collect())
        .filter((e) => (e.originalDate ?? e.date).startsWith(String(year)) && e.recordedAt > (active.submittedAt ?? 0))
        .map((e) => ({
          entryId: e._id,
          seq: e.seq,
          date: e.date,
          originalDate: e.originalDate ?? e.date,
          text: e.text,
          href: sourceHref(e.source),
        }))
    : [];
  const periods = await periodRows(ctx);
  const lockedMonths = periods.filter((p) => p.period.startsWith(String(year)) && p.status === "locked").length;
  const sourceIds = new Set(sheet.lines.flatMap((l) => l.drillDown.map((d) => d.entryId)));
  const texts = new Map<string, { text: string }>();
  for (const id of sourceIds) {
    const e = await ctx.db.get(id as Id<"journalEntries">);
    if (e) texts.set(id, { text: e.text });
  }
  return {
    year,
    ku,
    sheet: {
      ...sheet,
      lines: sheet.lines.map((l) => ({
        ...l,
        drillDown: l.drillDown.map((d) => ({
          ...d,
          text: texts.get(d.entryId)?.text ?? "",
          href: sourceHref(d.via ?? d.source),
        })),
      })),
    },
    aveuer,
    guide,
    blockers: guide.blockers,
    values,
    filing: active
      ? {
          id: active._id,
          submittedOn: active.submittedOn ?? null,
          transmissionTicket: active.transmissionTicket ?? null,
          submittedValuesDiffer: active.submittedValuesDiffer ?? false,
          values: Object.fromEntries(active.values.map((x) => [x.kz, x.cents])),
          actor: active.actor,
        }
      : null,
    lateEntries: late,
    status: { lockedMonths, provisional: lockedMonths < 12 },
    ruleVersions: [mapping?.version ?? null, `elster-euer-${year}`].filter(Boolean),
    generatedAt: now,
  };
}

// ── submission record (TAX-021/TAX-022) ─────────────────────────────────────────────────────────────────

export interface EuerSubmissionInput {
  year: number;
  submittedOn: string;
  transferTicket: string;
  protocolStorageId?: Id<"_storage">;
  /** Gewinn/Verlust laut ELSTER (cents). */
  crossCheckCents: number;
  sheetHash: string;
  valuesDifferReason?: string;
}

/**
 * Records the manual EÜR submission: preconditions (E-UVA-21, ACC-017, verified mapping E-UVA-20), sheet hash
 * (E-UVA-18), Transferticket (E-UVA-01), Gewinn/Verlust cross-check (E-UVA-19); freezes values and drill-down and
 * locks all months of the year (`euer_submitted`). No correction kind in v1.1: a berichtigte Erklärung is filed in
 * ELSTER directly.
 */
export async function recordEuerSubmission(ctx: ModelCtx, input: EuerSubmissionInput) {
  const now = ctx.now();
  const ticket = input.transferTicket.trim();
  if (ticket.length === 0) {
    throw appError(
      "transfer_ticket_required",
      "Bitte das Transferticket aus dem ELSTER-Übermittlungsprotokoll eintragen. Es steht auch in Mein ELSTER bei den übermittelten Formularen.",
    );
  }
  const today = berlinCalendarDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.submittedOn) || input.submittedOn > today) {
    throw appError("invalid_input", "Das Übermittlungsdatum darf nicht in der Zukunft liegen.");
  }
  if (input.submittedOn <= `${input.year}-12-31`) {
    throw appError("filing_blocked", euerNotReadyNotice(input.year), { reason: "fiscal_year_not_ended" });
  }
  const view = await euerView(ctx, input.year, now);
  if (view.guide.blocked) {
    const notReady = view.guide.blockers.includes(euerNotReadyNotice(input.year));
    throw appError("filing_blocked", view.guide.blockers.join(" "), {
      reason: notReady ? (today <= `${input.year}-12-31` ? "fiscal_year_not_ended" : "ustva_missing") : "blocked",
    });
  }
  if (view.guide.sheetHash !== input.sheetHash) {
    throw appError(
      "sheet_changed",
      "Die Werte haben sich seit dem Öffnen der Ausfüllhilfe geändert. Bitte prüfen, welche Werte an ELSTER übermittelt wurden.",
    );
  }
  const appTotal = view.sheet.sums.gewinnCents;
  const reason = input.valuesDifferReason?.trim() ?? "";
  const differs = input.crossCheckCents !== appTotal;
  if (differs && reason.length < 5) {
    throw appError(
      "cross_check_mismatch",
      `ELSTER weist einen Gewinn/Verlust von ${formatCents(input.crossCheckCents)} € aus, die Buchhaltung ${formatCents(appTotal)} €. Bitte Eingaben vergleichen.`,
      { elsterCents: input.crossCheckCents, appCents: appTotal },
    );
  }
  const profile = await getCompanyProfile(ctx);
  const plan = planLock({
    target: `${input.year}-12`,
    fiscalYearStartMonth: profile?.fiscalYearStartMonth ?? 1,
    bookkeepingStartDate: profile?.bookkeepingStartDate,
    periods: await periodRows(ctx),
  });
  const lockPlan = plan.ok ? plan.value.months : [];
  let protocolSha256: string | undefined;
  if (input.protocolStorageId) {
    const meta = await ctx.db.system.get(input.protocolStorageId);
    if (!meta) throw appError("invalid_input", "Das Übermittlungsprotokoll wurde nicht gefunden.");
    protocolSha256 = meta.sha256;
  }
  const id = await auditedInsert(
    ctx,
    "taxFilings",
    {
      kind: "euer",
      period: String(input.year),
      ruleVersion: view.sheet.mappingVersion ?? `euer-${input.year}`,
      guideVersion: view.guide.id,
      values: Object.entries(view.values).map(([kz, cents]) => ({ kz, cents })),
      drillDown: view.sheet.lines
        .filter((l) => l.drillDown.length > 0)
        .map((l) => ({
          kz: l.kz,
          refs: l.drillDown.map((d) => ({ source: (d.via ?? d.source).kind, id: (d.via ?? d.source).id })),
        })),
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
      retentionUntil: retentionUntilFor("books10", `${input.year}-12-31`) ?? undefined,
      actor: ctx.actor,
    },
    { action: "tax_filing.submit", label: `euer ${input.year}`, ...(differs ? { reason } : {}) },
  );
  const locked = lockPlan.length > 0 ? await lockMonths(ctx, lockPlan, "euer_submitted") : { months: [] };
  return { id, kind: "euer" as const, lockedMonths: locked.months, submittedValuesDiffer: differs };
}
