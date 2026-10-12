import { type Chart, defaultBankLedgerAccount } from "../../src/domain/accounting/bank-ledger";
import type { BankValues } from "../../src/domain/schemas/settings";
import type { Doc } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Invoice bank accounts (03 §1 `bankAccounts`, F01 SET-050…053). P0: one manually entered account per currency
 * that is printed on invoices; synced accounts (Enable Banking) arrive with F07 (P2).
 */
export async function listBankAccounts(ctx: ReadCtx): Promise<Doc<"bankAccounts">[]> {
  return (await ctx.db.query("bankAccounts").collect()).filter((a) => a.archivedAt === undefined);
}

export async function defaultInvoiceAccount(ctx: ReadCtx, currency = "EUR"): Promise<Doc<"bankAccounts"> | null> {
  return (
    (
      await ctx.db
        .query("bankAccounts")
        .withIndex("by_currency_default", (q) => q.eq("currency", currency).eq("isDefaultForInvoices", true))
        .collect()
    ).find((a) => a.archivedAt === undefined) ?? null
  );
}

/** Creates or updates the default EUR invoice account (wizard step 8 / Einstellungen › Bank). */
export async function saveDefaultInvoiceAccount(ctx: ModelCtx, values: BankValues, chart: Chart): Promise<void> {
  const all = await ctx.db.query("bankAccounts").collect();
  const current = await defaultInvoiceAccount(ctx, values.currency);
  if (all.some((a) => a.iban === values.iban && a._id !== current?._id && a.archivedAt === undefined)) {
    throw appError("invalid_input", "Diese IBAN ist bereits angelegt.", { reason: "IBAN_DUPLICATE" });
  }
  const fields = {
    iban: values.iban,
    bic: values.bic || undefined,
    accountHolder: values.accountHolder,
  };
  if (current) {
    await auditedPatch(ctx, "bankAccounts", current._id, fields, {
      action: "settings.bank_account.update",
      label: current.name,
    });
    return;
  }
  const ledgerAccount = defaultBankLedgerAccount(
    chart,
    all.map((a) => a.ledgerAccount),
  );
  if (!ledgerAccount) throw appError("invalid_input", "Kein freies Bankkonto im Kontenrahmen.");
  await auditedInsert(
    ctx,
    "bankAccounts",
    {
      kind: "bank",
      name: "Geschäftskonto",
      currency: values.currency,
      iban: values.iban,
      ...(values.bic ? { bic: values.bic } : {}),
      accountHolder: values.accountHolder,
      ledgerAccount,
      showOnInvoices: true,
      isDefaultForInvoices: true,
      autoApplyMatches: true,
    },
    { action: "settings.bank_account.create", label: "Geschäftskonto" },
  );
}
