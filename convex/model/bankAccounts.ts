import { type Chart, defaultBankLedgerAccount } from "../../src/domain/accounting/bank-ledger";
import { checkArchiveAccount } from "../../src/domain/banking/accounts";
import type { StatementAccountValues } from "../../src/domain/schemas/banking";
import type { BankValues } from "../../src/domain/schemas/settings";
import type { Doc, Id } from "../_generated/dataModel";
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

/** All accounts incl. archived (Einstellungen › Bank list). */
export async function allBankAccounts(ctx: ReadCtx): Promise<Doc<"bankAccounts">[]> {
  return ctx.db.query("bankAccounts").collect();
}

const accountRef = (a: Doc<"bankAccounts">) => ({
  id: a._id as string,
  currency: a.currency,
  showOnInvoices: a.showOnInvoices,
  isDefaultForInvoices: a.isDefaultForInvoices,
  ...(a.archivedAt !== undefined ? { archivedAt: a.archivedAt } : {}),
});

/** SET-050: a further manual invoice account (not the default; the first account of a currency becomes default). */
export async function addInvoiceAccount(
  ctx: ModelCtx,
  values: BankValues & { name: string },
  chart: Chart,
): Promise<Id<"bankAccounts">> {
  const all = await allBankAccounts(ctx);
  if (all.some((a) => a.iban === values.iban && a.archivedAt === undefined)) {
    throw appError("invalid_input", "Diese IBAN ist bereits angelegt.", { reason: "IBAN_DUPLICATE" });
  }
  const ledgerAccount = defaultBankLedgerAccount(
    chart,
    all.map((a) => a.ledgerAccount),
  );
  if (!ledgerAccount) throw appError("invalid_input", "Kein freies Bankkonto im Kontenrahmen.");
  const first = !(await defaultInvoiceAccount(ctx, values.currency));
  return auditedInsert(
    ctx,
    "bankAccounts",
    {
      kind: "bank",
      name: values.name,
      currency: values.currency,
      iban: values.iban,
      ...(values.bic ? { bic: values.bic } : {}),
      accountHolder: values.accountHolder,
      ledgerAccount,
      showOnInvoices: true,
      isDefaultForInvoices: first,
      autoApplyMatches: true,
    },
    { action: "settings.bank_account.create", label: values.name },
  );
}

/** SET-051: one default per currency; the previous default loses the flag. */
export async function setDefaultInvoiceAccount(ctx: ModelCtx, accountId: Id<"bankAccounts">): Promise<void> {
  const account = await ctx.db.get(accountId);
  if (!account || account.archivedAt !== undefined) throw appError("not_found");
  if (!account.iban) {
    throw appError("invalid_input", "Konten ohne eigene IBAN können nicht auf Rechnungen angegeben werden.", {
      reason: "IBAN_REQUIRED_FOR_INVOICES",
    });
  }
  const previous = await defaultInvoiceAccount(ctx, account.currency);
  if (previous && previous._id !== accountId) {
    await auditedPatch(
      ctx,
      "bankAccounts",
      previous._id,
      { isDefaultForInvoices: false },
      { action: "settings.bank_account.update", label: previous.name },
    );
  }
  await auditedPatch(
    ctx,
    "bankAccounts",
    accountId,
    { isDefaultForInvoices: true, showOnInvoices: true },
    { action: "settings.bank_account.update", label: account.name },
  );
}

/** SET-054: archive (sets `archivedAt`); never the default while it is the only invoice account. */
export async function archiveInvoiceAccount(ctx: ModelCtx, accountId: Id<"bankAccounts">): Promise<void> {
  const account = await ctx.db.get(accountId);
  if (!account) throw appError("not_found");
  const e = checkArchiveAccount(accountRef(account), (await allBankAccounts(ctx)).map(accountRef));
  if (e) throw appError("invalid_input", e.message, { reason: e.code.toUpperCase() });
  await auditedPatch(
    ctx,
    "bankAccounts",
    accountId,
    { archivedAt: ctx.now(), showOnInvoices: false },
    { action: "settings.bank_account.archive", label: account.name },
  );
}

/**
 * F07 BNK-020 (P1 statement accounts): one account per currency pocket. Revolut pockets share one IBAN, so the IBAN
 * is unique per currency (03 §7 `bankAccounts.by_iban` is not unique). An account with an IBAN may be printed on
 * invoices; the first of its currency becomes the default (SET-050/051).
 */
export async function addStatementAccount(
  ctx: ModelCtx,
  values: StatementAccountValues,
  chart: Chart,
): Promise<Id<"bankAccounts">> {
  const all = await allBankAccounts(ctx);
  if (
    values.iban &&
    all.some((a) => a.iban === values.iban && a.currency === values.currency && a.archivedAt === undefined)
  ) {
    throw appError("invalid_input", "Für diese IBAN und Währung ist bereits ein Konto angelegt.", {
      reason: "IBAN_DUPLICATE",
    });
  }
  const ledgerAccount = defaultBankLedgerAccount(
    chart,
    all.map((a) => a.ledgerAccount),
  );
  if (!ledgerAccount) throw appError("invalid_input", "Kein freies Bankkonto im Kontenrahmen.");
  const showOnInvoices = values.showOnInvoices && values.iban !== "";
  const first = showOnInvoices && !(await defaultInvoiceAccount(ctx, values.currency));
  return auditedInsert(
    ctx,
    "bankAccounts",
    {
      kind: "bank",
      name: values.name,
      currency: values.currency,
      ...(values.iban ? { iban: values.iban } : {}),
      ...(values.bic ? { bic: values.bic } : {}),
      accountHolder: values.accountHolder,
      ledgerAccount,
      showOnInvoices,
      isDefaultForInvoices: first,
      autoApplyMatches: true,
    },
    { action: "settings.bank_account.create", label: values.name },
  );
}
