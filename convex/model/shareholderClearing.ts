import { resolveRole } from "../../src/domain/accounting/resolve";
import {
  planShareholderAccounts,
  SHAREHOLDER_ROLE,
  type ShareholderAccountPlan,
  shareholderClearingApplies,
} from "../../src/domain/accounting/shareholder-clearing";
import { chartAccounts } from "../../src/domain/rules/accounting";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { calendarDate } from "../../src/domain/time/calendar-date";
import { appError } from "../lib/errors";
import { setRoleOverride } from "./accounting";
import { getCompanyProfile } from "./companyProfile";
import { resolveContextAt } from "./journal";
import { createLedgerAccount, ledgerAccountsOf } from "./ledgerAccounts";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * F01 SET-045a: „Verrechnungskonto Gesellschafter“ for corporations — one custom liability account per shareholder
 * and the role `shareholder.clearing` mapped to the first (audited role override). Refused for sole proprietors and
 * partnerships, which keep `private.*` (ACC-028).
 */
export async function setupShareholderClearing(
  ctx: ModelCtx,
  args: { shareholders: { name: string; number?: string }[] },
): Promise<ShareholderAccountPlan[]> {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const today = calendarDate(berlinCalendarDate(ctx.now()));
  const rctx = await resolveContextAt(ctx, today);
  const seed = chartAccounts(rctx.chart, today);
  const ledger = await ledgerAccountsOf(ctx, rctx.chart);
  const taken = new Set<string>([
    ...(seed.ok ? seed.value.map((a) => a.number) : []),
    ...ledger.custom.map((a) => a.number),
    ...(await ctx.db.query("bankAccounts").collect()).map((b) => b.ledgerAccount),
  ]);
  const plan = planShareholderAccounts({
    legalForm: profile.legalForm,
    chart: rctx.chart,
    shareholders: args.shareholders,
    taken,
  });
  if (!plan.ok) throw appError("invalid_input", plan.error.message, { reason: plan.error.code });
  for (const p of plan.value) {
    await createLedgerAccount(ctx, { chart: rctx.chart, number: p.number, name: p.name, type: "liability" });
  }
  const first = plan.value[0] as ShareholderAccountPlan;
  await setRoleOverride(ctx, {
    role: SHAREHOLDER_ROLE,
    account: first.number,
    // The role was unmapped until now, so no earlier posting used it: effective from the bookkeeping start (else 1 Jan).
    validFrom:
      [profile.bookkeepingStartDate, `${today.slice(0, 4)}-01-01`].filter((d): d is string => !!d).sort()[0] ?? today,
    sourceText: `SET-045a Verrechnungskonto Gesellschafter ${first.shareholder}`,
  });
  return plan.value;
}

export interface ShareholderClearingStatus {
  /** Corporation (the step is shown at all). */
  applies: boolean;
  /** Account currently mapped to `shareholder.clearing`, if any. */
  mappedAccount: string | null;
  /** The owner-created shareholder accounts of the current chart. */
  accounts: { number: string; name: string }[];
}

export async function shareholderClearingStatus(ctx: ReadCtx, now: number): Promise<ShareholderClearingStatus> {
  const profile = await getCompanyProfile(ctx);
  if (!profile || !shareholderClearingApplies(profile.legalForm)) {
    return { applies: false, mappedAccount: null, accounts: [] };
  }
  const rctx = await resolveContextAt(ctx, calendarDate(berlinCalendarDate(now)));
  const role = resolveRole(SHAREHOLDER_ROLE, rctx);
  const ledger = await ledgerAccountsOf(ctx, rctx.chart);
  return {
    applies: true,
    mappedAccount: role.ok ? role.value.account : null,
    accounts: ledger.custom
      .filter((a) => !a.archived && a.type === "liability" && /Gesellschafter|Ges\. /.test(a.name))
      .map((a) => ({ number: a.number, name: a.name })),
  };
}
