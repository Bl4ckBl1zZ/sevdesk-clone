import { canDo } from "../../src/domain/access/permissions";
import { recentActivity } from "../../src/domain/audit/describe";
import {
  bankSummary,
  DASHBOARD_LATEST_TRANSACTIONS,
  greetingName,
  kuProgress,
  matchedShare,
  monthlyResult,
  monthWindow,
  receivablesSummary,
  subtractMonths,
  TOP_CUSTOMERS_MONTHS,
  topCustomers,
} from "../../src/domain/reports/dashboard";
import { type AccountType, chartAccounts } from "../../src/domain/rules/accounting";
import type { MemberRole } from "../../src/domain/schemas/actor";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc } from "../_generated/dataModel";
import { accountsOverview } from "./bankViews";
import { getCompanyProfile } from "./companyProfile";
import { resolveContextAt } from "./journal";
import { getMemberByAuthUserId } from "./members";
import { openItemsAsOf } from "./payments";
import type { ReadCtx } from "./types";

/**
 * Übersicht view model (04 §4.7, DASH-001…011). Loads plain rows; the arithmetic lives in
 * `src/domain/reports/dashboard.ts` and `src/domain/audit/describe.ts`. Every widget is gated by the read permission
 * of its data; a widget the role may not read is `null`.
 */

const PAYABLE_TYPES = ["invoice", "advance_invoice", "partial_invoice", "final_invoice"] as const;
const FINAL_STATUSES = ["finalized", "sent"] as const;
const BANK_STATUSES = ["open", "partially_matched", "matched", "booked", "private", "transfer", "ignored"] as const;
/** Audit rows scanned for the five „Verlauf“ lines (technical entries are skipped). */
const AUDIT_SCAN = 200;

const allowed = (role: MemberRole | undefined, p: Parameters<typeof canDo>[1]) => role !== undefined && canDo(role, p);

export async function dashboardOverview(
  ctx: ReadCtx,
  args: { now: number; actor: string; role: MemberRole | undefined },
) {
  const today = berlinCalendarDate(args.now);
  const role = args.role;
  const member = args.actor.startsWith("user:")
    ? await getMemberByAuthUserId(ctx, args.actor.slice("user:".length))
    : null;
  const profile = await getCompanyProfile(ctx);

  // DASH-003 Gewinn vor Steuern (journal by entry date; account types from the chart seed rule data)
  let result = null;
  if (allowed(role, "accounting.read")) {
    const from = `${monthWindow(today)[0]?.period ?? today.slice(0, 7)}-01`;
    const rctx = await resolveContextAt(ctx, today);
    const seed = chartAccounts(rctx.chart, today);
    const types = new Map<string, AccountType>((seed.ok ? seed.value : []).map((a) => [a.number, a.type]));
    const lines = await ctx.db
      .query("journalLines")
      .withIndex("by_date", (q) => q.gte("date", from).lte("date", today))
      .collect();
    result = monthlyResult(lines, types, today);
  }

  // DASH-004 Ausstehende Rechnungen
  const receivables = allowed(role, "payments.read")
    ? receivablesSummary((await openItemsAsOf(ctx, { asOf: today })).items)
    : null;

  // DASH-005 Kleinunternehmergrenze + DASH-008 Top 5 Kunden (finalised invoices)
  let ku = null;
  let customers = null;
  if (allowed(role, "documents.read")) {
    const since = subtractMonths(today, TOP_CUSTOMERS_MONTHS);
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const from = since < yearStart ? since : yearStart;
    const docs: Doc<"salesDocuments">[] = [];
    for (const type of PAYABLE_TYPES) {
      for (const status of FINAL_STATUSES) {
        docs.push(
          ...(await ctx.db
            .query("salesDocuments")
            .withIndex("by_type_status_date", (q) =>
              q.eq("type", type).eq("status", status).gte("documentDate", from).lte("documentDate", today),
            )
            .collect()),
        );
      }
    }
    const dated = docs.filter((d): d is Doc<"salesDocuments"> & { documentDate: string } => !!d.documentDate);
    ku = kuProgress({
      today,
      kleinunternehmer: profile?.kleinunternehmer ?? [],
      foundedOn: profile?.foundedOn,
      invoices: dated.map((d) => ({
        documentDate: d.documentDate,
        grossCents: d.totals.grossCents,
        status: d.status,
        type: d.type,
      })),
    });
    customers = topCustomers(
      dated.map((d) => ({
        contactId: d.contactId,
        contactName: d.contactName ?? "",
        documentDate: d.documentDate,
        payableCents: d.totals.payableCents,
        type: d.type,
        status: d.status,
        currency: d.currency,
      })),
      today,
    );
  }

  // DASH-006 Bank + DASH-007 Zuordnungsquote
  let bank = null;
  let matching = matchedShare({});
  if (allowed(role, "banking.read")) {
    const accounts = (await accountsOverview(ctx)).filter((a) => a.kind === "bank" && a.currency === "EUR");
    const txs = [];
    for (const a of accounts) {
      const rows = await ctx.db
        .query("bankTransactions")
        .withIndex("by_account_bookingDate", (q) => q.eq("accountId", a.id))
        .order("desc")
        .take(DASHBOARD_LATEST_TRANSACTIONS * 3);
      txs.push(
        ...rows.map((t) => ({
          id: t._id as string,
          bookingDate: t.bookingDate,
          amountCents: t.amountCents,
          status: t.status,
          counterpartyName: t.counterpartyName ?? null,
          purpose: t.purpose,
        })),
      );
    }
    bank = bankSummary(
      accounts.map((a) => ({
        kind: a.kind,
        currency: a.currency,
        closingBalanceCents: a.lastStatement?.closingBalanceCents ?? null,
      })),
      txs,
    );
    const counts: Record<string, number> = {};
    for (const status of BANK_STATUSES) {
      counts[status] = (
        await ctx.db
          .query("bankTransactions")
          .withIndex("by_status", (q) => q.eq("status", status))
          .collect()
      ).length;
    }
    matching = matchedShare(counts);
  }

  // DASH-009 Verlauf (audit log readers only)
  const activity = allowed(role, "audit.read")
    ? recentActivity(
        (await ctx.db.query("auditLog").withIndex("by_seq").order("desc").take(AUDIT_SCAN)).map((e) => ({
          at: e.at,
          actor: e.actor,
          actorRole: e.actorRole,
          action: e.action,
          entity: { table: e.entity.table, id: e.entity.id, label: e.entity.label },
        })),
      )
    : null;

  return {
    today,
    /** Hides the write quick actions for read-only roles (the pages enforce the role themselves). */
    role: role ?? null,
    greetingName: member ? greetingName({ name: member.name, email: member.email }) : null,
    result,
    receivables,
    ku,
    bank,
    matching,
    topCustomers: customers,
    activity,
  };
}
