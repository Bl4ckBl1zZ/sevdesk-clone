import { isCorporation } from "../../src/domain/accounting/roles";
import { currencyExponent } from "../../src/domain/banking/amount";
import { type EigenbelegInput, markEigenbelegKind } from "../../src/domain/banking/eigenbeleg";
import { outflowCost, type PocketLine, pocketBasis } from "../../src/domain/banking/fx-lots";
import { findReversalCandidates, findTransferCandidates, type LinkRow } from "../../src/domain/banking/links";
import { type LoanSplit, splitLoanPayment } from "../../src/domain/banking/loan";
import {
  cashWithdrawalAmount,
  checkMark,
  type IgnoreReason,
  MARK_MESSAGES,
  type MarkKind,
  statusForMark,
} from "../../src/domain/banking/marking";
import { allocationStatus, openAmountCents, type UnmatchedTransaction } from "../../src/domain/banking/match-types";
import {
  autoDepositPair,
  checkDepositPair,
  type TransitBankRow,
  type TransitCashDeposit,
} from "../../src/domain/banking/transit";
import { suggestTypeDefault } from "../../src/domain/banking/type-defaults";
import { LOAN_ACCOUNT_DEFAULTS } from "../../src/domain/rules/accounting/loan-accounts";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { addDays, type CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { type FileRefValue, insertCandidate } from "./bankImport";
import { getCompanyProfile } from "./companyProfile";
import { postJournalEntry, resolveContextAt } from "./journal";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Booked bank transactions after the import (F07 BNK-060/061/063, BNK-121, BNK-122, CSH-025): marking, unmarking,
 * reversal links, the possible-duplicates review, the import rollback, and the allocation hook of the matching slice.
 * Every write goes through the BNK-122 whitelist (src/domain/audit/immutability.ts) and is audited.
 */

export async function requireTransaction(ctx: ReadCtx, id: Id<"bankTransactions">): Promise<Doc<"bankTransactions">> {
  const tx = await ctx.db.get(id);
  if (!tx) throw appError("not_found", "Der Bankumsatz existiert nicht.");
  return tx;
}

export async function requireAccount(ctx: ReadCtx, id: Id<"bankAccounts">): Promise<Doc<"bankAccounts">> {
  const a = await ctx.db.get(id);
  if (!a) throw appError("not_found", "Das Bankkonto existiert nicht.");
  return a;
}

const feeOf = (tx: Doc<"bankTransactions">) => tx.source.feeCents;
const txLabel = (tx: Doc<"bankTransactions">) => `${tx.bookingDate} ${tx.amountCents} ${tx.currency}`;
export const accountLabel = (a: Doc<"bankAccounts">) => (a.iban ? `${a.name} (${a.iban})` : a.name);

/** FX pockets need the EUR value (BNK-028, P2) before a journal entry can be posted. */
const FX_POSTING_DEFERRED =
  "Umsätze in Fremdwährung können erst mit der EUR-Bewertung (Kurs der EZB) gebucht werden. Bitte vorerst offen lassen.";

export interface MarkArgs {
  transactionId: Id<"bankTransactions">;
  as: MarkKind;
  reason?: IgnoreReason;
  linkId?: Id<"bankTransactions">;
  shareholder?: { name: string; note: string };
  /** `transfer` of a bank credit: the cash deposit (CSH-024) it is the bank side of (E-ACC-31: exact amount). */
  cashTransferId?: Id<"cashTransfers">;
  /** `loan` (BNK-062): the principal or the interest part of a repayment; other chart accounts optional. */
  loan?: { principalCents?: number; interestCents?: number; loanAccount?: string; interestAccount?: string };
  eigenbeleg?: FileRefValue;
}

// ── open Geldtransit (BNK-061, CSH-024, E-ACC-23/31) ───────────────────────────────────────────────────

/** „Bargeld eingezahlt“ transfers (not reversed) and whether a bank credit is already their bank side. */
export async function transitDeposits(ctx: ReadCtx): Promise<TransitCashDeposit[]> {
  const transfers = await ctx.db.query("cashTransfers").collect();
  const reversed = new Set(transfers.flatMap((t) => (t.reversalOfId ? [t.reversalOfId as string] : [])));
  const credits = await ctx.db
    .query("bankTransactions")
    .withIndex("by_status", (q) => q.eq("status", "transfer"))
    .collect();
  const paired = new Set(credits.flatMap((t) => (t.transferCashId ? [t.transferCashId as string] : [])));
  return transfers.flatMap((t) =>
    t.kind === "deposit_to_bank" && !t.reversalOfId && !reversed.has(t._id) && t.bankAccountId
      ? [
          {
            id: t._id,
            date: t.date,
            amountCents: t.amountCents,
            bankAccountId: t.bankAccountId,
            paired: paired.has(t._id) || t.bankTransactionId !== undefined,
          },
        ]
      : [],
  );
}

/** Bank rows marked „Geldtransit“ (ATM withdrawals into the till post both legs themselves and are excluded). */
export async function transitBankRows(ctx: ReadCtx): Promise<TransitBankRow[]> {
  const rows = await ctx.db
    .query("bankTransactions")
    .withIndex("by_status", (q) => q.eq("status", "transfer"))
    .collect();
  const atm = new Set(
    (await ctx.db.query("cashTransfers").collect()).flatMap((c) =>
      c.bankTransactionId ? [c.bankTransactionId as string] : [],
    ),
  );
  return rows
    .filter((r) => !atm.has(r._id))
    .map((r) => ({
      id: r._id,
      accountId: r.accountId,
      bookingDate: r.bookingDate,
      amountCents: r.amountCents,
      currency: r.currency,
      ...(r.source.instructedAmount && r.source.instructedAmount.currency !== r.currency
        ? { instructedCurrency: r.source.instructedAmount.currency }
        : {}),
      paired: r.transferPeerId !== undefined || r.transferCashId !== undefined,
    }));
}

const depositCredit = (tx: Doc<"bankTransactions">) => ({
  accountId: tx.accountId,
  bookingDate: tx.bookingDate,
  amountCents: tx.amountCents,
  currency: tx.currency,
});

/** The other leg of a Geldtransit pair (BNK-061): the unique unpaired `transfer` row that fits. */
async function transferPeer(ctx: ReadCtx, tx: Doc<"bankTransactions">): Promise<Doc<"bankTransactions"> | null> {
  const marked = (
    await ctx.db
      .query("bankTransactions")
      .withIndex("by_status", (q) => q.eq("status", "transfer").eq("bookingDate", tx.bookingDate))
      .collect()
  ).filter((r) => r.transferPeerId === undefined && r.transferCashId === undefined);
  if (marked.length === 0) return null;
  const accounts = (await ctx.db.query("bankAccounts").collect()).map((a) => ({
    id: a._id as string,
    currency: a.currency,
    ...(a.iban ? { iban: a.iban } : {}),
  }));
  const hits = findTransferCandidates(linkRow(tx), marked.map(linkRow), accounts);
  if (hits.length !== 1) return null;
  return marked.find((r) => r._id === hits[0]?.peerId) ?? null;
}

/** Validation shared by the action (before rendering the Eigenbeleg) and the mutation. */
export async function checkMarkFor(ctx: ReadCtx, args: Omit<MarkArgs, "eigenbeleg">) {
  const tx = await requireTransaction(ctx, args.transactionId);
  const account = await requireAccount(ctx, tx.accountId);
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const link = args.linkId ? await requireTransaction(ctx, args.linkId) : undefined;
  const markable = (t: Doc<"bankTransactions">) => ({
    amountCents: t.amountCents,
    currency: t.currency,
    status: t.status,
    allocatedCents: t.allocatedCents,
    ...(t.source.feeCents !== undefined ? { feeCents: t.source.feeCents } : {}),
  });
  const problem = checkMark(
    markable(tx),
    {
      as: args.as,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(link ? { link: { ...markable(link), id: link._id, accountId: link.accountId } } : {}),
      ...(args.shareholder ? { shareholder: args.shareholder } : {}),
    },
    profile.legalForm,
  );
  if (problem) throw appError("invalid_input", problem.message, { reason: "MARK_REJECTED" });
  let fx: FxValuation | undefined;
  if (args.as !== "ignored" && tx.currency !== "EUR") {
    // BNK-028: only the Geldtransit side of an exchange can be valued today — at the paired EUR side (R1) or at
    // the pocket's moving-average cost (R2). Everything else needs an ECB rate source (LEGAL-OPEN BNK-028).
    if (args.as !== "transfer" || tx.source.feeCents) {
      throw appError("invalid_input", FX_POSTING_DEFERRED, { reason: "FX_POSTING_DEFERRED" });
    }
    fx = await fxTransferValuation(ctx, tx, account);
  }
  if (args.as === "ignored" && link && link._id === tx._id) {
    throw appError("invalid_input", MARK_MESSAGES.ignoreRestricted, { reason: "MARK_REJECTED" });
  }
  let deposit: TransitCashDeposit | undefined;
  if (args.cashTransferId) {
    deposit = (await transitDeposits(ctx)).find((d) => d.id === args.cashTransferId);
    const problem =
      args.as !== "transfer" || !deposit
        ? "Diese Bareinzahlung ist bereits zugeordnet oder gehört zu einem anderen Konto."
        : checkDepositPair(depositCredit(tx), deposit);
    if (problem) throw appError("invalid_input", problem, { reason: "DEPOSIT_PAIR_REJECTED" });
  }
  let loan: (LoanSplit & { loanAccount: string; interestAccount: string }) | undefined;
  if (args.as === "loan") {
    const split = splitLoanPayment({
      amountCents: tx.amountCents,
      ...(tx.source.feeCents ? { feeCents: tx.source.feeCents } : {}),
      ...(args.loan?.principalCents !== undefined ? { principalCents: args.loan.principalCents } : {}),
      ...(args.loan?.interestCents !== undefined ? { interestCents: args.loan.interestCents } : {}),
    });
    if (!split.ok) throw appError("invalid_input", split.error.message, { reason: "LOAN_SPLIT_INVALID" });
    const { chart } = await resolveContextAt(ctx, tx.bookingDate as CalendarDate);
    const defaults = LOAN_ACCOUNT_DEFAULTS[chart];
    loan = {
      ...split.value,
      loanAccount: args.loan?.loanAccount?.trim() || defaults.loan,
      interestAccount: args.loan?.interestAccount?.trim() || defaults.interest,
    };
  }
  return { tx, account, profile, link, deposit, loan, fx };
}

interface FxValuation {
  peerId: Id<"bankTransactions">;
  currency: string;
  eurCents: number;
  costCents: number;
  rate: { rate: string; source: "transaction"; date: string };
}

const FX_PEER_REQUIRED =
  "Umsätze in Fremdwährung werden über die EUR-Seite bewertet: bitte zuerst die EUR-Seite des Umtauschs als Geldtransit markieren.";

/** EUR principal of a marked EUR row (what reached/left the transit account, the fee is booked separately). */
const eurPrincipal = (t: Doc<"bankTransactions">) =>
  t.amountCents < 0 ? -t.amountCents - (t.source.feeCents ?? 0) : t.amountCents + (t.source.feeCents ?? 0);

/** The pocket's EUR basis from its ledger lines up to `date` (moving average, BNK-028). */
async function pocketLines(ctx: ReadCtx, ledgerAccount: string, currency: string, date: string): Promise<PocketLine[]> {
  const lines = await ctx.db
    .query("journalLines")
    .withIndex("by_account_date_seq", (q) => q.eq("account", ledgerAccount).lte("date", date))
    .collect();
  const entries = new Map<string, Doc<"journalEntries"> | null>();
  const out: PocketLine[] = [];
  for (const l of lines) {
    if (!entries.has(l.entryId)) entries.set(l.entryId, await ctx.db.get(l.entryId));
    const src = entries.get(l.entryId)?.lines[l.lineIndex];
    const eurCents = l.debitCents - l.creditCents;
    const fxMinor =
      src?.currency === currency && src.amountFx !== undefined ? (l.debitCents > 0 ? 1 : -1) * src.amountFx : undefined;
    out.push({ eurCents, ...(fxMinor !== undefined ? { fxMinor } : {}) });
  }
  return out;
}

/** BNK-028 / F08 R1–R2 valuation of the foreign-currency side of a Geldtransit pair (EC-BNK-26, EC-BNK-69). */
async function fxTransferValuation(
  ctx: ReadCtx,
  tx: Doc<"bankTransactions">,
  account: Doc<"bankAccounts">,
): Promise<FxValuation> {
  const peer = await transferPeer(ctx, tx);
  const eurPeer = peer?.currency === "EUR" ? peer : null;
  if (!eurPeer) throw appError("invalid_input", FX_PEER_REQUIRED, { reason: "FX_PEER_REQUIRED" });
  const eurCents = eurPrincipal(eurPeer);
  let costCents = eurCents;
  if (tx.amountCents < 0) {
    const basis = pocketBasis(await pocketLines(ctx, account.ledgerAccount, tx.currency, tx.bookingDate));
    const cost = outflowCost(basis, -tx.amountCents);
    if (!cost.ok) throw appError("invalid_input", cost.error.message, { reason: "FX_BASIS" });
    costCents = cost.value;
  }
  // Implicit rate of the exchange (EUR per unit), a memo on the journal line (ACC-023); 6 decimals, half-up.
  const fxUnits = BigInt(Math.abs(tx.amountCents)) * 100n;
  const scaled =
    (BigInt(eurCents) * 10n ** BigInt(currencyExponent(tx.currency)) * 1_000_000n + fxUnits / 2n) / fxUnits;
  const rate = `${scaled / 1_000_000n}.${String(scaled % 1_000_000n).padStart(6, "0")}`;
  return {
    peerId: eurPeer._id,
    currency: tx.currency,
    eurCents,
    costCents,
    rate: { rate, source: "transaction", date: tx.bookingDate },
  };
}

/** Data for the Eigenbeleg of a mark (BNK-060/061, CSH-025). */
export async function markEigenbelegInput(
  ctx: ReadCtx,
  args: Omit<MarkArgs, "eigenbeleg">,
  createdBy: string,
  now: number,
): Promise<EigenbelegInput | null> {
  if (args.as === "ignored") return null;
  const { tx, account, profile, loan } = await checkMarkFor(ctx, args);
  const a = profile.address;
  return {
    kind: markEigenbelegKind(args.as, tx.amountCents, isCorporation(profile.legalForm)),
    date: tx.bookingDate,
    amountCents: tx.amountCents,
    currency: tx.currency,
    ...(feeOf(tx) ? { feeCents: feeOf(tx) } : {}),
    company: {
      name: profile.name,
      address: a ? [a.street, `${a.postalCode} ${a.city}`].filter(Boolean).join(", ") : "",
    },
    account: accountLabel(account),
    ...(tx.counterpartyName ? { counterpartyName: tx.counterpartyName } : {}),
    ...(tx.purpose ? { purpose: tx.purpose } : {}),
    reference: tx.source.entryReference ?? tx.source.providerTransactionId ?? tx._id,
    ...(args.shareholder && args.as === "private" ? { shareholder: args.shareholder } : {}),
    ...(loan ? { loan: { principalCents: loan.principalCents, interestCents: loan.interestCents } } : {}),
    createdOn: berlinCalendarDate(now),
    createdBy,
  };
}

export async function markTransaction(ctx: ModelCtx, args: MarkArgs): Promise<{ status: string }> {
  const { tx, account, link, deposit, loan, fx } = await checkMarkFor(ctx, args);
  const status = statusForMark(args.as);
  const attachments = args.eigenbeleg ? [args.eigenbeleg] : [];
  // BNK-061 / CSH-024: find the other side before this row is marked (it must not pair with itself).
  let cashId: Id<"cashTransfers"> | undefined = deposit ? (deposit.id as Id<"cashTransfers">) : undefined;
  let peer: Doc<"bankTransactions"> | null = null;
  if (args.as === "transfer" && !cashId) {
    const auto = tx.amountCents > 0 ? autoDepositPair(depositCredit(tx), await transitDeposits(ctx)) : null;
    if (auto) cashId = auto as Id<"cashTransfers">;
    else peer = await transferPeer(ctx, tx);
  }
  if (args.as === "private" || args.as === "transfer" || args.as === "loan") {
    const fee = feeOf(tx);
    await postJournalEntry(
      ctx,
      {
        kind: "bank_transaction_marked",
        transactionId: tx._id,
        mark: args.as,
        date: tx.bookingDate,
        amountCents: tx.amountCents,
        ...(fee ? { feeCents: fee } : {}),
        bankAccountId: account._id,
        ...(args.as === "private" && args.shareholder ? { shareholder: args.shareholder } : {}),
        ...(loan
          ? {
              loan: {
                principalCents: loan.principalCents,
                interestCents: loan.interestCents,
                loanAccount: loan.loanAccount,
                interestAccount: loan.interestAccount,
              },
            }
          : {}),
        ...(fx ? { fx: { currency: fx.currency, eurCents: fx.eurCents, costCents: fx.costCents, rate: fx.rate } } : {}),
      },
      { attachments },
    );
  } else if (args.as === "cash_withdrawal") {
    const fee = feeOf(tx);
    const transferId = await auditedInsert(
      ctx,
      "cashTransfers",
      {
        date: tx.bookingDate,
        kind: "bank_withdrawal_to_cash",
        amountCents: cashWithdrawalAmount({ amountCents: tx.amountCents, ...(fee ? { feeCents: fee } : {}) }),
        bankAccountId: account._id,
        bankTransactionId: tx._id,
        ...(args.eigenbeleg ? { eigenbelegFile: args.eigenbeleg } : {}),
        journalEntryIds: [],
        recordedAt: ctx.now(),
        actor: ctx.actor,
      },
      { action: "cash.transfer", label: `Bargeldabhebung ${tx.bookingDate}` },
    );
    const r = await postJournalEntry(
      ctx,
      {
        kind: "cash_transfer",
        cashTransferId: transferId,
        transferKind: "bank_withdrawal_to_cash",
        date: tx.bookingDate,
        amountCents: cashWithdrawalAmount({ amountCents: tx.amountCents, ...(fee ? { feeCents: fee } : {}) }),
        ...(fee ? { feeCents: fee } : {}),
        bankAccountId: account._id,
      },
      { attachments },
    );
    if (r.status === "posted") {
      await auditedPatch(
        ctx,
        "cashTransfers",
        transferId,
        { journalEntryIds: r.entryIds },
        { action: "cash.transfer" },
      );
    }
  }
  const patch: Partial<Doc<"bankTransactions">> = { status };
  if (args.as === "ignored") {
    patch.ignoredReason = args.reason;
    if (link) patch.ignoredLinkId = link._id;
  }
  if (cashId) patch.transferCashId = cashId;
  if (peer) patch.transferPeerId = peer._id;
  await auditedPatch(ctx, "bankTransactions", tx._id, patch, { action: "bank.mark", label: txLabel(tx) });
  if (peer) {
    await auditedPatch(
      ctx,
      "bankTransactions",
      peer._id,
      { transferPeerId: tx._id },
      { action: "bank.mark", label: `Geldtransit-Paar ${txLabel(peer)}` },
    );
  }
  // A neutralised pair (BNK-063) ignores both halves, linked to each other.
  if (args.as === "ignored" && args.reason === "neutralised_pair" && link) {
    await auditedPatch(
      ctx,
      "bankTransactions",
      link._id,
      { status: "ignored", ignoredReason: "neutralised_pair", ignoredLinkId: tx._id },
      { action: "bank.mark", label: txLabel(link) },
    );
  }
  return { status };
}

/** „Markierung aufheben“: Generalumkehr of the posting (ACC-004) and back to `open`. */
export async function unmarkTransaction(
  ctx: ModelCtx,
  args: { transactionId: Id<"bankTransactions">; reason: string },
): Promise<void> {
  const tx = await requireTransaction(ctx, args.transactionId);
  const reason = args.reason.trim();
  if (reason.length < 5) throw appError("invalid_input", "Bitte einen Grund angeben (mindestens 5 Zeichen).");
  const today = berlinCalendarDate(ctx.now());
  if (tx.status === "private" || tx.status === "transfer" || tx.status === "booked") {
    const cash = (
      await ctx.db
        .query("cashTransfers")
        .withIndex("by_bankTransaction", (q) => q.eq("bankTransactionId", tx._id))
        .collect()
    ).filter((c) => c.reversalOfId === undefined);
    let open: Doc<"cashTransfers"> | undefined;
    for (const c of cash) {
      const reversed = await ctx.db
        .query("cashTransfers")
        .withIndex("by_reversalOf", (q) => q.eq("reversalOfId", c._id))
        .first();
      if (!reversed) open = c;
    }
    if (open) {
      const reversalId = await auditedInsert(
        ctx,
        "cashTransfers",
        {
          date: today,
          kind: open.kind,
          amountCents: open.amountCents,
          ...(open.bankAccountId ? { bankAccountId: open.bankAccountId } : {}),
          reversalOfId: open._id,
          reason,
          journalEntryIds: [],
          recordedAt: ctx.now(),
          actor: ctx.actor,
        },
        { action: "cash.transfer_reverse", reason },
      );
      const r = await postJournalEntry(ctx, {
        kind: "cash_transfer_reversed",
        cashTransferId: reversalId,
        originalCashTransferId: open._id,
        date: today,
        reason,
      });
      if (r.status === "posted") {
        await auditedPatch(
          ctx,
          "cashTransfers",
          reversalId,
          { journalEntryIds: r.entryIds },
          { action: "cash.transfer_reverse" },
        );
      }
    } else {
      await postJournalEntry(ctx, {
        kind: "bank_transaction_mark_reversed",
        transactionId: tx._id,
        date: today,
        reason,
      });
    }
  } else if (tx.status === "ignored") {
    if (tx.ignoredReason === "import_rolled_back") {
      throw appError("invalid_input", "Zurückgenommene Importe können nicht wieder geöffnet werden.");
    }
    if (tx.ignoredReason === "neutralised_pair" && tx.ignoredLinkId) {
      const peer = await requireTransaction(ctx, tx.ignoredLinkId);
      if (peer.status === "ignored" && peer.ignoredReason === "neutralised_pair") {
        await auditedPatch(
          ctx,
          "bankTransactions",
          peer._id,
          { status: "open", ignoredReason: undefined, ignoredLinkId: undefined },
          { action: "bank.unmark", label: txLabel(peer), reason },
        );
      }
    }
  } else {
    throw appError("invalid_input", "Der Umsatz ist nicht markiert.");
  }
  // The Geldtransit pair (BNK-061) comes apart: the other side stays marked and is open transit again.
  if (tx.transferPeerId) {
    const peer = await ctx.db.get(tx.transferPeerId);
    if (peer?.transferPeerId === tx._id) {
      await auditedPatch(
        ctx,
        "bankTransactions",
        peer._id,
        { transferPeerId: undefined },
        { action: "bank.unmark", label: `Geldtransit-Paar ${txLabel(peer)}`, reason },
      );
    }
  }
  await auditedPatch(
    ctx,
    "bankTransactions",
    tx._id,
    {
      status: "open",
      ignoredReason: undefined,
      ignoredLinkId: undefined,
      transferPeerId: undefined,
      transferCashId: undefined,
    },
    { action: "bank.unmark", label: txLabel(tx), reason },
  );
}

// ── bank reversals (BNK-121) ────────────────────────────────────────────────────────────────────────────

export const linkRow = (t: Doc<"bankTransactions">): LinkRow => ({
  id: t._id,
  accountId: t.accountId,
  bookingDate: t.bookingDate,
  amountCents: t.amountCents,
  currency: t.currency,
  purpose: t.purpose,
  ...(t.reference ? { reference: t.reference } : {}),
  ...(t.endToEndId ? { endToEndId: t.endToEndId } : {}),
  ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
  ...(t.source.instructedAmount ? { instructedAmount: t.source.instructedAmount } : {}),
  ...(t.source.merchantName ? { merchantName: t.source.merchantName } : {}),
  ...(t.reversal ? { reversal: true } : {}),
  ...(t.reversalOfId ? { reversalOfId: t.reversalOfId } : {}),
  status: t.status,
});

export async function reversalCandidates(ctx: ReadCtx, counterId: Id<"bankTransactions">) {
  const counter = await requireTransaction(ctx, counterId);
  const rows = await ctx.db
    .query("bankTransactions")
    .withIndex("by_account_bookingDate", (q) =>
      q
        .eq("accountId", counter.accountId)
        .gte("bookingDate", addDays(counter.bookingDate as CalendarDate, -60))
        .lte("bookingDate", counter.bookingDate),
    )
    .collect();
  return findReversalCandidates(linkRow(counter), rows.map(linkRow));
}

/**
 * Links a bank counter-entry to its original (BNK-121, EC-141): both stay booked (no deletion); when both are open
 * they neutralise each other (BNK-063 `neutralised_pair`), so neither is matched to a document.
 */
export async function linkReversal(
  ctx: ModelCtx,
  args: { counterId: Id<"bankTransactions">; originalId: Id<"bankTransactions"> },
): Promise<void> {
  const counter = await requireTransaction(ctx, args.counterId);
  const original = await requireTransaction(ctx, args.originalId);
  const ok = (await reversalCandidates(ctx, counter._id)).some((c) => c.originalId === original._id);
  if (!ok) {
    throw appError(
      "invalid_input",
      "Die Rückbuchung passt nicht zum gewählten Umsatz (gleiches Konto, umgekehrter Betrag, Referenz, höchstens 60 Tage).",
      { reason: "REVERSAL_MISMATCH" },
    );
  }
  await auditedPatch(
    ctx,
    "bankTransactions",
    counter._id,
    { reversalOfId: original._id },
    { action: "bank.reversal_link", label: txLabel(counter) },
  );
  if (
    counter.status === "open" &&
    original.status === "open" &&
    counter.allocatedCents === 0 &&
    original.allocatedCents === 0
  ) {
    await markTransaction(ctx, {
      transactionId: counter._id,
      as: "ignored",
      reason: "neutralised_pair",
      linkId: original._id,
    });
  }
}

// ── possible duplicates (BNK-034/110, RI-29) ───────────────────────────────────────────────────────────

export async function resolvePossibleDuplicate(
  ctx: ModelCtx,
  args: { id: Id<"possibleDuplicates">; decision: "same" | "separate" },
): Promise<Id<"bankTransactions"> | null> {
  const row = await ctx.db.get(args.id);
  if (!row) throw appError("not_found");
  if (row.status !== "open") throw appError("conflict", "Diese Dublette wurde bereits geprüft.");
  const c = row.candidate as Record<string, unknown> & {
    dedupeKey: string;
    kind: Doc<"bankTransactions">["source"]["kind"];
    rawSha256: string;
    raw: string;
    line: number;
    entryReference?: string;
    providerTransactionId?: string;
  };
  const now = ctx.now();
  let txId: Id<"bankTransactions"> | null = null;
  if (args.decision === "same") {
    // Same booking delivered twice: record the delivery on the existing row (append-only), never a second row.
    const existing = await requireTransaction(ctx, row.existingIds[0] as Id<"bankTransactions">);
    await auditedPatch(
      ctx,
      "bankTransactions",
      existing._id,
      {
        sources: [
          ...existing.sources,
          {
            kind: c.kind,
            ...(row.importId ? { importId: row.importId } : {}),
            ...(c.entryReference ? { entryReference: c.entryReference } : {}),
            ...(c.providerTransactionId ? { providerTransactionId: c.providerTransactionId } : {}),
            rawSha256: c.rawSha256,
            at: now,
          },
        ],
      },
      { action: "bank.duplicate_resolve", label: txLabel(existing) },
    );
    txId = existing._id;
  } else {
    const account = await requireAccount(ctx, row.accountId);
    // „Getrennt“: a genuine second booking. The key gets a suffix so it never collides with the existing row.
    txId = await insertCandidate(
      ctx,
      account,
      c as never,
      `${c.dedupeKey}:sep:${String(row._id)}`,
      row.importId,
      c.kind,
    );
  }
  await auditedPatch(
    ctx,
    "possibleDuplicates",
    row._id,
    { status: args.decision, resolvedAt: now, resolvedTransactionId: txId, actor: ctx.actor },
    { action: "bank.duplicate_resolve", label: args.decision === "same" ? "gleicher Umsatz" : "getrennte Umsätze" },
  );
  return txId;
}

// ── import rollback (BNK-036) ──────────────────────────────────────────────────────────────────────────

export async function rollbackImport(ctx: ModelCtx, args: { importId: Id<"bankImports">; reason: string }) {
  const imp = await ctx.db.get(args.importId);
  if (!imp) throw appError("not_found");
  if (imp.rolledBackAt !== undefined) throw appError("conflict", "Der Import wurde bereits zurückgenommen.");
  const reason = args.reason.trim();
  if (reason.length < 5) throw appError("invalid_input", "Bitte einen Grund angeben (mindestens 5 Zeichen).");
  const rows = await ctx.db
    .query("bankTransactions")
    .withIndex("by_import", (q) => q.eq("importId", imp._id))
    .collect();
  // EC-BNK-50: blocked as soon as one row is allocated or marked.
  if (rows.some((r) => r.status !== "open" || r.allocatedCents !== 0)) {
    throw appError(
      "invalid_input",
      "Der Import kann nicht zurückgenommen werden: Mindestens ein Umsatz ist bereits zugeordnet oder markiert.",
      { reason: "ROLLBACK_BLOCKED" },
    );
  }
  for (const r of rows) {
    await auditedPatch(
      ctx,
      "bankTransactions",
      r._id,
      { status: "ignored", ignoredReason: "import_rolled_back" },
      { action: "bank.rollback", label: txLabel(r), reason },
    );
  }
  for (const d of await ctx.db
    .query("possibleDuplicates")
    .withIndex("by_account_status", (q) => q.eq("accountId", imp.accountId).eq("status", "open"))
    .collect()) {
    if (d.importId === imp._id) {
      await auditedPatch(
        ctx,
        "possibleDuplicates",
        d._id,
        { status: "same", resolvedAt: ctx.now(), actor: ctx.actor },
        { action: "bank.rollback", reason },
      );
    }
  }
  await auditedPatch(ctx, "bankImports", imp._id, { rolledBackAt: ctx.now() }, { action: "bank.rollback", reason });
  if (imp.statementId) {
    await auditedPatch(
      ctx,
      "bankStatements",
      imp.statementId,
      { rolledBack: true },
      { action: "bank.rollback", reason },
    );
  }
  return { rows: rows.length };
}

// ── allocation hook for the matching slice (BNK-122) ───────────────────────────────────────────────────

/**
 * The only write path for `allocatedCents`/allocation status (the matching slice and F05 `payments.record` with
 * `source.kind = "bank"` call it inside their mutation). `deltaCents` > 0 allocates, < 0 releases (reversal).
 */
export async function applyAllocation(
  ctx: ModelCtx,
  args: { transactionId: Id<"bankTransactions">; deltaCents: number; label?: string },
): Promise<Doc<"bankTransactions">["status"]> {
  const tx = await requireTransaction(ctx, args.transactionId);
  if (!Number.isSafeInteger(args.deltaCents)) throw appError("invalid_input", "Ungültiger Betrag.");
  if (!["open", "partially_matched", "matched"].includes(tx.status)) {
    throw appError("invalid_input", MARK_MESSAGES.notOpen, { reason: "TX_NOT_ALLOCATABLE" });
  }
  const allocated = tx.allocatedCents + args.deltaCents;
  let status: ReturnType<typeof allocationStatus>;
  try {
    status = allocationStatus(tx, allocated);
  } catch {
    throw appError("invalid_input", "Die Zuordnung übersteigt den Umsatzbetrag.", { reason: "ALLOCATION_EXCEEDS" });
  }
  await auditedPatch(
    ctx,
    "bankTransactions",
    tx._id,
    { allocatedCents: allocated, status },
    { action: args.deltaCents >= 0 ? "bank.match" : "bank.unmatch", label: args.label ?? txLabel(tx) },
  );
  return status;
}

// ── reads ──────────────────────────────────────────────────────────────────────────────────────────────

export async function unmatchedTransactions(
  ctx: ReadCtx,
  args: { accountId?: Id<"bankAccounts">; limit?: number },
): Promise<UnmatchedTransaction[]> {
  const accounts = new Map((await ctx.db.query("bankAccounts").collect()).map((a) => [a._id as string, a]));
  const ownIbans = [...accounts.values()].flatMap((a) => (a.iban ? [a.iban] : []));
  const out: UnmatchedTransaction[] = [];
  for (const status of ["open", "partially_matched"] as const) {
    const rows = args.accountId
      ? await ctx.db
          .query("bankTransactions")
          .withIndex("by_account_status", (q) =>
            q.eq("accountId", args.accountId as Id<"bankAccounts">).eq("status", status),
          )
          .order("desc")
          .take(args.limit ?? 500)
      : await ctx.db
          .query("bankTransactions")
          .withIndex("by_status", (q) => q.eq("status", status))
          .order("desc")
          .take(args.limit ?? 500);
    for (const t of rows) {
      const open = openAmountCents(t);
      if (open <= 0) continue;
      const a = accounts.get(t.accountId);
      const typeDefault = suggestTypeDefault(
        {
          amountCents: t.amountCents,
          purpose: t.purpose,
          ...(t.counterpartyName ? { counterpartyName: t.counterpartyName } : {}),
          ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
          ...(t.source.bankTransactionCode ? { bankTransactionCode: t.source.bankTransactionCode } : {}),
          ...(t.source.proprietaryCode ? { proprietaryCode: t.source.proprietaryCode } : {}),
        },
        ownIbans,
      );
      out.push({
        id: t._id,
        accountId: t.accountId,
        accountName: a?.name ?? "",
        bookingDate: t.bookingDate,
        ...(t.valueDate ? { valueDate: t.valueDate } : {}),
        amountCents: t.amountCents,
        currency: t.currency,
        ...(t.amountEurCents !== undefined ? { amountEurCents: t.amountEurCents } : {}),
        openCents: open,
        direction: t.amountCents >= 0 ? "in" : "out",
        ...(t.counterpartyName ? { counterpartyName: t.counterpartyName } : {}),
        ...(t.counterpartyIban ? { counterpartyIban: t.counterpartyIban } : {}),
        purpose: t.purpose,
        ...(t.reference ? { reference: t.reference } : {}),
        ...(t.endToEndId ? { endToEndId: t.endToEndId } : {}),
        ...(t.mandateRef ? { mandateRef: t.mandateRef } : {}),
        ...(t.source.merchantName ? { merchantName: t.source.merchantName } : {}),
        ...(t.source.instructedAmount ? { instructedAmount: t.source.instructedAmount } : {}),
        ...(t.source.feeCents ? { feeCents: t.source.feeCents } : {}),
        ...(typeDefault ? { typeDefault } : {}),
      });
    }
  }
  return out.sort((x, y) => y.bookingDate.localeCompare(x.bookingDate));
}
