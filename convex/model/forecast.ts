import { resolveRole } from "../../src/domain/accounting/resolve";
import { vatCents } from "../../src/domain/money";
import { upcoming } from "../../src/domain/recurring/schedule";
import {
  computeForecast,
  FORECAST_DAYS,
  type ForecastItemInput,
  type PaidInvoice,
} from "../../src/domain/reports/forecast";
import { monthsOfFilingPeriod } from "../../src/domain/tax/ustva";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../../src/domain/time/calendar-date";
import { accountsOverview } from "./bankViews";
import { getCompanyProfile } from "./companyProfile";
import { resolveContextAt } from "./journal";
import { openItemsAsOf, settlesOf } from "./payments";
import { reportLines } from "./reports";
import { taxDeadlines } from "./taxFilings";
import { vatAccountSet } from "./taxReserve";
import type { ReadCtx } from "./types";
import { kuOn } from "./vouchers";

/**
 * Liquiditätsvorschau read model (F08 RPT-012): loads the opening balance, open receivables (with dunning level),
 * open payables, recurring invoices and vouchers, tax payments at their deadlines and the paid-invoice history, then
 * hands them to `computeForecast` (pure). EUR only — accounts in other currencies are listed as a notice.
 */

const OPEN_VOUCHER = new Set(["open", "partially_paid", "scheduled"]);
const WEEKLY: Record<string, string> = { P1W: "P7D", P2W: "P14D" };

function balanceOf(lines: Awaited<ReturnType<typeof reportLines>>, account: string) {
  return lines.filter((l) => l.account === account).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
}

export async function forecastView(ctx: ReadCtx, now: number, a: { thresholdCents?: number }) {
  const today = berlinCalendarDate(now);
  const end = addDays(today, FORECAST_DAYS - 1);
  const notices: string[] = [];
  const lines = await reportLines(ctx, today);

  // opening: bank-reported balance (latest statement) or the ledger balance, plus the cash account
  let opening = 0;
  const openingParts: { label: string; cents: number; reported: boolean }[] = [];
  for (const acc of await accountsOverview(ctx)) {
    if (acc.currency !== "EUR") {
      notices.push(`Konto „${acc.name}“ (${acc.currency}) ist nicht in der Vorschau enthalten.`);
      continue;
    }
    const reported = acc.lastStatement?.closingBalanceCents ?? null;
    const cents = reported ?? balanceOf(lines, acc.ledgerAccount);
    opening += cents;
    openingParts.push({ label: acc.name, cents, reported: reported !== null });
  }
  const cashRole = resolveRole("cash", await resolveContextAt(ctx, today));
  const cashAccount = cashRole.ok ? cashRole.value.account : null;
  if (cashAccount) {
    const cents = balanceOf(lines, cashAccount);
    if (cents !== 0) {
      opening += cents;
      openingParts.push({ label: "Kasse", cents, reported: false });
    }
  }

  const items: ForecastItemInput[] = [];
  // receivables (incl. opening items) with dunning level
  const dunning = new Map<string, number>();
  for (const c of await ctx.db.query("dunningCases").collect()) {
    if (c.status !== "closed") dunning.set(c.invoiceId, c.currentLevel);
  }
  const open = await openItemsAsOf(ctx, { asOf: today });
  for (const i of open.items) {
    if (i.openCents === 0 || i.currency !== "EUR") continue;
    items.push({
      id: i.id,
      source: "receivable",
      label: `${i.number} · ${i.contactName}`,
      cents: i.openCents,
      date: i.dueDate ?? i.documentDate,
      ...(i.contactId ? { contactId: i.contactId } : {}),
      ...(dunning.has(i.id) ? { dunningLevel: dunning.get(i.id) } : {}),
      href: i.kind === "salesDocument" ? `/rechnungen/${i.id}` : null,
    });
  }
  // payables
  for (const v of await ctx.db.query("vouchers").collect()) {
    if (v.direction !== "expense" || !OPEN_VOUCHER.has(v.status)) continue;
    const openCents = v.openAmountCents ?? v.totalsEur?.grossCents ?? v.totals.grossCents;
    if (!openCents) continue;
    items.push({
      id: v._id,
      source: v.taxPayment ? "tax" : "payable",
      label: `${v.internalNumber ?? v.documentNumber ?? ""} · ${v.supplierName ?? ""}`.trim(),
      cents: -openCents,
      date: v.dueDate ?? v.documentDate ?? today,
      href: `/belege/${v._id}`,
    });
  }
  // recurring invoices (next runs; due date from the template's payment terms)
  for (const tpl of await ctx.db.query("recurringTemplates").collect()) {
    if (tpl.status !== "active" || tpl.archivedAt !== undefined || !tpl.amount || tpl.amount.currency !== "EUR") {
      continue;
    }
    const dueDays = Number((tpl.draft as { paymentTerms?: { dueDays?: number } })?.paymentTerms?.dueDays ?? 0);
    for (const o of upcoming(tpl.schedule as never, tpl.generatedCount, { until: end })) {
      items.push({
        id: `${tpl._id}:${o.date}`,
        source: "recurring_invoice",
        label: tpl.name,
        cents: tpl.amount.grossCents,
        date: addDays(o.date, dueDays),
        ...(tpl.contactId ? { contactId: tpl.contactId } : {}),
        href: `/rechnungen/wiederkehrend/${tpl._id}`,
      });
    }
  }
  // recurring vouchers
  for (const r of await ctx.db.query("recurringVouchers").collect()) {
    if (!r.active || r.template.currency !== "EUR" || r.template.direction !== "expense") continue;
    const gross = r.template.lines.reduce(
      (s, l) =>
        s +
        (r.template.priceMode === "net" ? l.amountCents + vatCents(l.amountCents, l.vatRateBp ?? 0) : l.amountCents),
      0,
    );
    const interval = (WEEKLY[r.interval] ?? r.interval) as never;
    const occurrences = upcoming(
      {
        firstDate: r.firstDate,
        nextDate: r.nextDate,
        interval,
        billing: "in_advance",
        ...(r.endDate ? { endDate: r.endDate } : {}),
      } as never,
      0,
      { until: end },
    );
    for (const o of occurrences) {
      items.push({
        id: `${r._id}:${o.date}`,
        source: "recurring_voucher",
        label: r.name,
        cents: -gross,
        date: o.date,
        href: "/belege/wiederkehrend",
      });
    }
  }
  // taxes: the next open UStVA gets the open USt liability; ESt/GewSt prepayments as last recorded
  const year = Number(today.slice(0, 4));
  const deadlinesAll = [...(await taxDeadlines(ctx, year)), ...(await taxDeadlines(ctx, year + 1))];
  const deadlines = deadlinesAll.filter((d) => !d.done && d.due >= today && d.due <= end);
  // UStVA: the VAT movements of the period's months so far (Umsatzsteuer − Vorsteuer), due at the deadline
  const profile = await getCompanyProfile(ctx);
  if (profile && !kuOn(profile, today)) {
    // Zahllast of a period = Umsatzsteuer − Vorsteuer posted in its months (prepayment accounts excluded)
    const vat = await vatAccountSet(ctx, profile, today, { withPrepayments: false });
    const byMonth = new Map<string, number>();
    for (const l of lines) {
      if (!vat.has(l.account)) continue;
      const m = l.date.slice(0, 7);
      byMonth.set(m, (byMonth.get(m) ?? 0) + l.creditCents - l.debitCents);
    }
    const ustva = [...(await taxDeadlines(ctx, year - 1)), ...deadlinesAll].filter(
      (d) => d.kind === "ustva" && !d.done && d.period && d.due <= end,
    );
    // a period with a recorded UStVA payment voucher (open → listed above, paid → already out) is not estimated
    const recorded = new Set(
      (await ctx.db.query("vouchers").collect())
        .filter(
          (v) =>
            v.taxPayment?.subtype === "ust_prepayment" &&
            v.taxPayment.period &&
            v.status !== "draft" &&
            v.status !== "cancelled",
        )
        .map((v) => v.taxPayment?.period),
    );
    for (const d of ustva) {
      if (recorded.has(d.period)) continue;
      const cents = monthsOfFilingPeriod(d.period ?? "").reduce((s, m) => s + (byMonth.get(m) ?? 0), 0);
      if (cents <= 0) continue;
      items.push({
        id: `ustva:${d.period}`,
        source: "tax",
        label: `${d.label} (geschätzt)`,
        cents: -cents,
        date: d.due,
        href: "/steuern/ustva",
      });
    }
  }
  const lastPrepayment = async (subtype: "est_private" | "gewerbesteuer") => {
    const vs = (await ctx.db.query("vouchers").collect())
      .filter((v) => v.taxPayment?.subtype === subtype && v.status !== "draft" && v.status !== "cancelled")
      .sort((x, y) => (y.documentDate ?? "").localeCompare(x.documentDate ?? ""));
    const v = vs[0];
    return v ? (v.totalsEur?.grossCents ?? v.totals.grossCents) : 0;
  };
  const est = await lastPrepayment("est_private");
  const gew = await lastPrepayment("gewerbesteuer");
  for (const d of deadlines) {
    const cents = d.kind === "est_prepayment" ? est : d.kind === "gewst_prepayment" ? gew : 0;
    if (cents <= 0) continue;
    items.push({
      id: `${d.kind}:${d.due}`,
      source: "tax",
      label: `${d.label} (wie zuletzt)`,
      cents: -cents,
      date: d.due,
    });
  }

  // payment history: fully paid invoices with a due date (date of the last settling payment)
  const paidDate = new Map<string, string>();
  for (const p of await ctx.db.query("payments").collect()) {
    if (p.target.kind !== "salesDocument" || settlesOf(p) <= 0) continue;
    const prev = paidDate.get(p.target.id);
    if (!prev || p.date > prev) paidDate.set(p.target.id, p.date);
  }
  const history: PaidInvoice[] = [];
  const paidDocs = await ctx.db
    .query("salesDocuments")
    .withIndex("by_paymentStatus_due", (q) => q.eq("paymentStatus", "paid"))
    .collect();
  for (const d of paidDocs) {
    const date = paidDate.get(d._id);
    if (d.dueDate && d.contactId && date) history.push({ contactId: d.contactId, dueDate: d.dueDate, paidDate: date });
  }

  const forecast = computeForecast({
    today,
    openingCents: opening,
    items,
    history,
    ...(a.thresholdCents !== undefined ? { thresholdCents: a.thresholdCents } : {}),
    notices,
  });
  return { ...forecast, openingParts, end: end as CalendarDate };
}
