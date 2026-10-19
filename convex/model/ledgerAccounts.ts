import { type CustomAccountInput, removalOf, validateCustomAccount } from "../../src/domain/accounting/custom-accounts";
import { resolveRole } from "../../src/domain/accounting/resolve";
import { STATIC_ROLES } from "../../src/domain/accounting/roles";
import type { BwaGroup, Chart, ChartAccount, EuerKey } from "../../src/domain/rules/accounting";
import { chartAccounts, seededAccount } from "../../src/domain/rules/accounting";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { calendarDate } from "../../src/domain/time/calendar-date";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Custom Sachkonten and archiving (F08 ACC-009, GOBD-02, E-ACC-06/07). The seeded charts stay rule data; this table
 * holds the owner's additional accounts and archive markers. Every posting path reads it through
 * `ledgerAccountsOf` (journal resolution, voucher account choice, chart view).
 */

type Row = Doc<"ledgerAccounts">;

export interface LedgerAccountsOfChart {
  custom: (ChartAccount & { taxKeyDefault?: string; archived: boolean })[];
  archived: Set<string>;
}

const asChartAccount = (r: Row): ChartAccount & { taxKeyDefault?: string } => ({
  number: r.number,
  name: r.name,
  type: r.type,
  euerKey: r.euerKey as EuerKey,
  bwaGroup: r.bwaGroup as BwaGroup,
  verified: true,
  ...(r.taxKeyDefault ? { taxKeyDefault: r.taxKeyDefault } : {}),
});

export async function ledgerAccountsOf(ctx: ReadCtx, chart: Chart): Promise<LedgerAccountsOfChart> {
  const rows = await ctx.db
    .query("ledgerAccounts")
    .withIndex("by_chart_number", (q) => q.eq("chart", chart))
    .collect();
  return {
    custom: rows
      .filter((r) => !r.isSystem)
      .map((r) => ({ ...asChartAccount(r), archived: r.archivedAt !== undefined })),
    archived: new Set(rows.filter((r) => r.archivedAt !== undefined).map((r) => r.number)),
  };
}

async function rowOf(ctx: ReadCtx, chart: Chart, number: string): Promise<Row | null> {
  return ctx.db
    .query("ledgerAccounts")
    .withIndex("by_chart_number", (q) => q.eq("chart", chart).eq("number", number))
    .first();
}

export async function createLedgerAccount(ctx: ModelCtx, input: CustomAccountInput): Promise<void> {
  const today = calendarDate(berlinCalendarDate(ctx.now()));
  const seed = chartAccounts(input.chart, today);
  const taken = new Set<string>([
    ...(seed.ok ? seed.value.map((a) => a.number) : []),
    ...(await ctx.db.query("bankAccounts").collect()).map((b) => b.ledgerAccount),
    ...(
      await ctx.db
        .query("ledgerAccounts")
        .withIndex("by_chart_number", (q) => q.eq("chart", input.chart))
        .collect()
    ).map((r) => r.number),
  ]);
  const r = validateCustomAccount(input, taken);
  if (!r.ok) throw appError("invalid_input", r.error.message, { reason: r.error.code });
  const a = r.value;
  await auditedInsert(
    ctx,
    "ledgerAccounts",
    {
      chart: input.chart,
      number: a.number,
      name: a.name,
      type: a.type,
      euerKey: a.euerKey,
      bwaGroup: a.bwaGroup,
      ...(a.taxKeyDefault ? { taxKeyDefault: a.taxKeyDefault } : {}),
      isSystem: false,
      recordedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "ledger_account.create", label: `${a.number} ${a.name}` },
  );
}

/** Where an account is still assigned (a role of the mapping valid today or a bank account), for E-ACC-06 safety. */
async function assignmentOf(ctx: ReadCtx, chart: Chart, number: string, overrides: Parameters<typeof resolveRole>[1]) {
  const bank = (await ctx.db.query("bankAccounts").collect()).find(
    (b) => b.ledgerAccount === number && b.archivedAt === undefined,
  );
  if (bank) return `dem Bankkonto „${bank.name}“`;
  for (const role of STATIC_ROLES) {
    const r = resolveRole(role, { ...overrides, chart });
    if (r.ok && r.value.account === number) return `der Kontenrolle „${role}“`;
  }
  return undefined;
}

/** ACC-009 „Entfernen“: unused custom accounts are deleted, everything else is archived (never deleted). */
export async function removeLedgerAccount(
  ctx: ModelCtx,
  args: { chart: Chart; number: string; resolve: Parameters<typeof resolveRole>[1] },
): Promise<{ action: "delete" | "archive" }> {
  const today = calendarDate(berlinCalendarDate(ctx.now()));
  const row = await rowOf(ctx, args.chart, args.number);
  const seeded = seededAccount(args.chart, today, args.number);
  if (!row && !seeded) throw appError("not_found", `Konto ${args.number} ist nicht vorhanden.`);
  if (row?.archivedAt !== undefined) throw appError("invalid_input", `Konto ${args.number} ist bereits archiviert.`);
  const used =
    (await ctx.db
      .query("journalLines")
      .withIndex("by_account_date_seq", (q) => q.eq("account", args.number))
      .first()) !== null;
  const decision = removalOf({
    number: args.number,
    isSystem: !row || row.isSystem,
    used,
    ...(await assignmentOf(ctx, args.chart, args.number, args.resolve).then((a) => (a ? { assignedTo: a } : {}))),
  });
  if (!decision.ok) throw appError("invalid_input", decision.error.message, { reason: decision.error.code });
  if (decision.value.action === "delete" && row) {
    await auditedDelete(ctx, "ledgerAccounts", row._id, { action: "ledger_account.archive", label: args.number });
    return { action: "delete" };
  }
  if (row) {
    await auditedPatch(
      ctx,
      "ledgerAccounts",
      row._id,
      { archivedAt: ctx.now() },
      {
        action: "ledger_account.archive",
        label: args.number,
      },
    );
  } else if (seeded) {
    await auditedInsert(
      ctx,
      "ledgerAccounts",
      {
        chart: args.chart,
        number: seeded.number,
        name: seeded.name,
        type: seeded.type,
        euerKey: seeded.euerKey,
        bwaGroup: seeded.bwaGroup,
        isSystem: true,
        archivedAt: ctx.now(),
        recordedAt: ctx.now(),
        actor: ctx.actor,
      },
      { action: "ledger_account.archive", label: args.number },
    );
  }
  return { action: "archive" };
}
