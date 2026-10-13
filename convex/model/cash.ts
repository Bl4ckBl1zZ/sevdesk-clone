import { resolveRole } from "../../src/domain/accounting/resolve";
import { isCorporation } from "../../src/domain/accounting/roles";
import type { EigenbelegInput } from "../../src/domain/banking/eigenbeleg";
import { checkCashDating } from "../../src/domain/cash/dating";
import {
  type CashJournalLine,
  type CashMovementRow,
  cashMovements,
  projectCash,
} from "../../src/domain/cash/movements";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import type { FileRefValue } from "./bankImport";
import { getCompanyProfile } from "./companyProfile";
import { assertCashOutflowAllowed, cashLines, postJournalEntry, resolveContextAt } from "./journal";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * The one cash account (F07 CSH-020…030): „Bargeld eingezahlt / entnommen“ (CSH-024), reversals (CSH-027) and the
 * movement list derived from the journal (CSH-020/030). Never negative (CSH-026) is enforced by `postJournalEntry`
 * inside the same serialisable mutation. There is no cash sale path (CSH-029, AO-04).
 */

export interface CashTransferArgs {
  kind: "deposit_to_bank" | "private_withdrawal";
  date: string;
  amountCents: number;
  bankAccountId?: Id<"bankAccounts">;
  note?: string;
  backdateReason?: string;
  shareholder?: { name: string; note: string };
}

const KIND_LABEL: Record<Doc<"cashTransfers">["kind"], string> = {
  deposit_to_bank: "Bargeld auf die Bank eingezahlt",
  private_withdrawal: "Privatentnahme aus der Kasse",
  bank_withdrawal_to_cash: "Bargeldabhebung in die Kasse",
};

/** Opening date of the cash account: the cash opening-balance entry or the Buchungsbeginn (EC-CSH-19). */
export async function cashOpeningDate(ctx: ReadCtx): Promise<string | undefined> {
  const opening = (
    await ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "opening_balance"))
      .collect()
  ).filter((e) => e.source.id.endsWith(":cash"));
  if (opening.length > 0) return opening.map((e) => e.date).sort()[0];
  return (await getCompanyProfile(ctx))?.bookkeepingStartDate;
}

/** Validation shared by the action (before rendering the Eigenbeleg) and the mutation. */
export async function checkCashTransfer(ctx: ReadCtx, args: CashTransferArgs, now: number) {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const openingDate = await cashOpeningDate(ctx);
  const dating = checkCashDating({
    date: args.date,
    today: berlinCalendarDate(now),
    amountCents: args.amountCents,
    ...(openingDate ? { openingDate } : {}),
    ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
  });
  if (!dating.ok) throw appError("invalid_input", dating.error.message, { reason: dating.error.code.toUpperCase() });
  let account: Doc<"bankAccounts"> | null = null;
  if (args.kind === "deposit_to_bank") {
    if (!args.bankAccountId) throw appError("invalid_input", "Bitte das Bankkonto angeben.");
    account = await ctx.db.get(args.bankAccountId);
    if (!account || account.archivedAt !== undefined) throw appError("not_found", "Das Bankkonto existiert nicht.");
    if (account.currency !== "EUR")
      throw appError("invalid_input", "Bargeld kann nur auf ein EUR-Konto eingezahlt werden.");
  }
  if (args.kind === "private_withdrawal" && isCorporation(profile.legalForm)) {
    if (!args.shareholder?.name.trim() || !args.shareholder.note.trim()) {
      throw appError(
        "invalid_input",
        "Kapitalgesellschaften haben kein Privatkonto. Bitte ‚Verrechnungskonto Gesellschafter‘ verwenden.",
        { reason: "PRIVATE_WITHDRAWAL_CORPORATION" },
      );
    }
  }
  return { profile, account, warning: dating.value.warning };
}

export async function cashTransferEigenbelegInput(
  ctx: ReadCtx,
  args: CashTransferArgs,
  createdBy: string,
  now: number,
): Promise<EigenbelegInput> {
  const { profile, account } = await checkCashTransfer(ctx, args, now);
  // Fail before the Eigenbeleg is rendered (and in MCP previews); the posting re-checks in its transaction.
  await assertCashOutflowAllowed(ctx, args.date, args.amountCents);
  const corp = isCorporation(profile.legalForm);
  const a = profile.address;
  return {
    kind:
      args.kind === "deposit_to_bank"
        ? "cash_deposit_to_bank"
        : corp
          ? "cash_shareholder_withdrawal"
          : "cash_private_withdrawal",
    date: args.date,
    amountCents: args.amountCents,
    currency: "EUR",
    company: {
      name: profile.name,
      address: a ? [a.street, `${a.postalCode} ${a.city}`].filter(Boolean).join(", ") : "",
    },
    ...(account ? { account: account.iban ? `${account.name} (${account.iban})` : account.name } : {}),
    reference: `Kasse ${args.date} ${args.amountCents}`,
    ...(args.shareholder && corp ? { shareholder: args.shareholder } : {}),
    ...(args.note ? { note: args.note } : {}),
    ...(args.backdateReason ? { backdateReason: args.backdateReason } : {}),
    createdOn: berlinCalendarDate(now),
    createdBy,
  };
}

export async function recordCashTransfer(
  ctx: ModelCtx,
  args: CashTransferArgs & { eigenbeleg?: FileRefValue },
): Promise<{ id: Id<"cashTransfers">; warning?: string }> {
  const { account, warning } = await checkCashTransfer(ctx, args, ctx.now());
  const id = await auditedInsert(
    ctx,
    "cashTransfers",
    {
      date: args.date,
      kind: args.kind,
      amountCents: args.amountCents,
      ...(account ? { bankAccountId: account._id } : {}),
      ...(args.note?.trim() ? { note: args.note.trim() } : {}),
      ...(args.backdateReason?.trim() ? { backdateReason: args.backdateReason.trim() } : {}),
      ...(args.shareholder ? { shareholder: args.shareholder } : {}),
      ...(args.eigenbeleg ? { eigenbelegFile: args.eigenbeleg } : {}),
      journalEntryIds: [],
      recordedAt: ctx.now(),
      actor: ctx.actor,
    },
    {
      action: "cash.transfer",
      label: KIND_LABEL[args.kind],
      ...(args.backdateReason ? { reason: args.backdateReason } : {}),
    },
  );
  const r = await postJournalEntry(
    ctx,
    {
      kind: "cash_transfer",
      cashTransferId: id,
      transferKind: args.kind,
      ...(args.kind === "deposit_to_bank" ? { leg: "cash" as const } : {}),
      date: args.date,
      amountCents: args.amountCents,
      ...(account ? { bankAccountId: account._id } : {}),
      ...(args.shareholder ? { shareholder: args.shareholder } : {}),
    },
    { attachments: args.eigenbeleg ? [args.eigenbeleg] : [] },
  );
  if (r.status === "posted") {
    await auditedPatch(ctx, "cashTransfers", id, { journalEntryIds: r.entryIds }, { action: "cash.transfer" });
  }
  return { id, ...(warning ? { warning } : {}) };
}

/** CSH-027: a reversal row (negated entry) dated today; subject to CSH-026 (EC-CSH-04). */
export async function reverseCashTransfer(
  ctx: ModelCtx,
  args: { id: Id<"cashTransfers">; reason: string },
): Promise<Id<"cashTransfers">> {
  const original = await ctx.db.get(args.id);
  if (!original) throw appError("not_found");
  if (original.reversalOfId) throw appError("invalid_input", "Eine Stornobuchung kann nicht storniert werden.");
  if (original.bankTransactionId) {
    throw appError(
      "invalid_input",
      "Bargeldabhebungen werden über „Markierung aufheben“ am Bankumsatz zurückgenommen.",
      { reason: "CASH_TRANSFER_FROM_BANK" },
    );
  }
  const reason = args.reason.trim();
  if (reason.length < 5) throw appError("invalid_input", "Bitte einen Grund angeben (mindestens 5 Zeichen).");
  const already = await ctx.db
    .query("cashTransfers")
    .withIndex("by_reversalOf", (q) => q.eq("reversalOfId", original._id))
    .first();
  if (already) throw appError("already_reversed");
  const today = berlinCalendarDate(ctx.now());
  const id = await auditedInsert(
    ctx,
    "cashTransfers",
    {
      date: today,
      kind: original.kind,
      amountCents: original.amountCents,
      ...(original.bankAccountId ? { bankAccountId: original.bankAccountId } : {}),
      reversalOfId: original._id,
      reason,
      journalEntryIds: [],
      recordedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "cash.transfer_reverse", label: `Storno ${KIND_LABEL[original.kind]}`, reason },
  );
  const r = await postJournalEntry(ctx, {
    kind: "cash_transfer_reversed",
    cashTransferId: id,
    originalCashTransferId: original._id,
    date: today,
    reason,
  });
  if (r.status === "posted") {
    await auditedPatch(ctx, "cashTransfers", id, { journalEntryIds: r.entryIds }, { action: "cash.transfer_reverse" });
  }
  return id;
}

// ── reads (CSH-020/030) ────────────────────────────────────────────────────────────────────────────────

export async function cashAccountNumber(ctx: ReadCtx, now: number): Promise<string | null> {
  const r = resolveRole("cash", await resolveContextAt(ctx, berlinCalendarDate(now) as CalendarDate));
  return r.ok ? r.value.account : null;
}

/** Movement rows of the cash account with running balance (derived from the journal, CSH-020). */
export async function cashMovementRows(
  ctx: ReadCtx,
  now: number,
): Promise<{ account: string | null; rows: CashMovementRow[]; balanceCents: number }> {
  const account = await cashAccountNumber(ctx, now);
  if (!account) return { account: null, rows: [], balanceCents: 0 };
  const lines = await cashLines(ctx, account);
  const entries = new Map<string, Doc<"journalEntries">>();
  for (const l of lines) {
    if (!entries.has(l.entryId)) {
      const e = await ctx.db.get(l.entryId);
      if (e) entries.set(l.entryId, e);
    }
  }
  const input: CashJournalLine[] = lines.map((l) => {
    const e = entries.get(l.entryId);
    return {
      date: l.date,
      seq: l.seq,
      debitCents: l.debitCents,
      creditCents: l.creditCents,
      text: e?.text ?? "",
      voucher: e?.attachments?.length ? `Eigenbeleg ${e.seq}` : `Buchung ${e?.seq ?? l.seq}`,
      counterAccounts: [...new Set((e?.lines ?? []).map((x) => x.account).filter((acc) => acc !== account))],
      entryId: l.entryId,
    };
  });
  const m = cashMovements(input);
  return { account, rows: m.rows, balanceCents: m.balanceCents };
}

/** Live projection for the transfer dialog (CSH-026 hint before submitting). */
export async function projectCashOutflow(ctx: ReadCtx, now: number, planned: { date: string; amountCents: number }) {
  const account = await cashAccountNumber(ctx, now);
  if (!account) return { minBalanceCents: 0, minDate: planned.date, ok: false };
  const lines = await cashLines(ctx, account);
  return projectCash(lines, { date: planned.date, amountCents: -planned.amountCents });
}

export async function listCashTransfers(ctx: ReadCtx) {
  const rows = await ctx.db.query("cashTransfers").withIndex("by_date").order("desc").take(500);
  const reversed = new Set(rows.flatMap((r) => (r.reversalOfId ? [r.reversalOfId as string] : [])));
  return rows.map((r) => ({ ...r, reversed: reversed.has(r._id) }));
}
