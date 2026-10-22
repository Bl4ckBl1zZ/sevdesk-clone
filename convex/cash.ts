import { v } from "convex/values";
import { eigenbelegContent } from "../src/domain/banking/eigenbeleg";
import { CASH_BELEG_REQUIRED, CASH_CHANGED } from "../src/domain/cash/check";
import { cashPeriod, cashReportCsv } from "../src/domain/cash/movements";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { renderEigenbeleg } from "../src/pdf/eigenbeleg";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, actorMutation, mutation, query, vConfirmToken } from "./functions";
import { appError, errorCode } from "./lib/errors";
import type { FileRefValue } from "./model/bankImport";
import {
  cashMovementRows,
  cashTransferEigenbelegInput,
  listCashTransfers,
  projectCashOutflow,
  recordCashTransfer,
  reverseCashTransfer,
} from "./model/cash";
import { vFileRef } from "./validators";

/**
 * Kasse (F07 CSH-020…030): balance and movements derived from the journal, „Bargeld eingezahlt / entnommen“ with an
 * archived Eigenbeleg, reversals, the cash report. No cash income without an invoice exists here (CSH-029, AO-04).
 */

const transferArgs = {
  kind: v.union(v.literal("deposit_to_bank"), v.literal("private_withdrawal")),
  date: v.string(),
  amountCents: v.number(),
  bankAccountId: v.optional(v.id("bankAccounts")),
  note: v.optional(v.string()),
  backdateReason: v.optional(v.string()),
  shareholder: v.optional(v.object({ name: v.string(), note: v.string() })),
};

export const overview = query({
  permission: "banking.read",
  args: {},
  handler: async (ctx) => {
    const m = await cashMovementRows(ctx, ctx.now());
    const transfers = await listCashTransfers(ctx);
    return {
      account: m.account,
      balanceCents: m.balanceCents,
      today: berlinCalendarDate(ctx.now()),
      rows: m.rows.slice(-500).reverse(),
      transfers: await Promise.all(
        transfers.map(async (t) => ({
          id: t._id,
          date: t.date,
          kind: t.kind,
          amountCents: t.amountCents,
          note: t.note ?? null,
          reversalOfId: t.reversalOfId ?? null,
          reversed: t.reversed,
          fromBank: t.bankTransactionId !== undefined,
          eigenbeleg: t.eigenbelegFile
            ? {
                name: t.eigenbelegFile.name,
                sha256: t.eigenbelegFile.sha256,
                url: await ctx.storage.getUrl(t.eigenbelegFile.storageId),
              }
            : null,
        })),
      ),
      bankAccounts: (await ctx.db.query("bankAccounts").collect())
        .filter((a) => a.archivedAt === undefined && a.currency === "EUR")
        .map((a) => ({ id: a._id, name: a.name })),
    };
  },
});

/** Live projection in the dialog (CSH-026): lowest balance from the planned date on. */
export const project = query({
  permission: "banking.read",
  args: { date: v.string(), amountCents: v.number() },
  handler: async (ctx, args) => projectCashOutflow(ctx, ctx.now(), args),
});

/** CSH-030 Kassenbericht as CSV for a period. */
export const reportCsv = query({
  permission: "banking.read",
  args: { from: v.string(), to: v.string() },
  handler: async (ctx, { from, to }) => {
    const m = await cashMovementRows(ctx, ctx.now());
    const p = cashPeriod(m.rows, from, to);
    return { csv: cashReportCsv(m.rows, from, to), openingCents: p.openingCents, closingCents: p.closingCents };
  },
});

export const transferContext = query({
  permission: "cash.write",
  args: transferArgs,
  handler: async (ctx, args) => cashTransferEigenbelegInput(ctx, args, ctx.actorContext.label ?? ctx.actor, ctx.now()),
});

export const recordTransferInternal = actorMutation({
  permission: "cash.write",
  args: { ...transferArgs, eigenbeleg: v.optional(vFileRef), confirmToken: vConfirmToken },
  // The token binds what the caller chose; the Eigenbeleg is rendered by the server after the preview.
  confirmArgs: Object.keys(transferArgs),
  handler: async (ctx, args) => {
    // EC-CSH-09: the transfer's Beleg is its Eigenbeleg; no path records a cash movement without one.
    if (!args.eigenbeleg) throw appError("invalid_input", CASH_BELEG_REQUIRED, { reason: "BELEG_REQUIRED" });
    return recordCashTransfer(ctx, args);
  },
});

const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** ⚠ CSH-024 „Bargeld eingezahlt / entnommen“: Eigenbeleg PDF (sha256) + journal entry T5/T8 in one mutation. */
export const recordTransfer = action({
  permission: "cash.write",
  args: { ...transferArgs, confirmToken: vConfirmToken },
  handler: async (ctx, { confirmToken, ...args }): Promise<{ id: Id<"cashTransfers">; warning?: string }> => {
    const input = await ctx.runQuery(api.cash.transferContext, args);
    const content = eigenbelegContent(input);
    const bytes = await renderEigenbeleg(content, input.company, ctx.now());
    const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const eigenbeleg: FileRefValue = {
      storageId,
      sha256: await sha256Hex(bytes),
      bytes: bytes.byteLength,
      mime: "application/pdf",
      name: content.fileName,
    };
    try {
      return await ctx.runMutation(internal.cash.recordTransferInternal, {
        actorContext: ctx.actorContext,
        ...args,
        eigenbeleg,
        ...(confirmToken ? { confirmToken } : {}),
      });
    } catch (e) {
      await ctx.storage.delete(storageId);
      // EC-CSH-08 / EC-151: the pre-check above passed, so a concurrent movement changed the till meanwhile; the
      // serialisable posting re-checked and aborted this one.
      if (errorCode(e) === "cash_negative") throw appError("cash_negative", CASH_CHANGED, { reason: "CASH_CHANGED" });
      throw e;
    }
  },
});

/** CSH-027 reversal (dated today, never-negative applies). */
export const reverseTransfer = mutation({
  permission: "cash.write",
  args: { id: v.id("cashTransfers"), reason: v.string(), confirmToken: vConfirmToken },
  handler: async (ctx, args) => reverseCashTransfer(ctx, args),
});
