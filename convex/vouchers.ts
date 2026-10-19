import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { resolveRole } from "../src/domain/accounting/resolve";
import { isCorporation } from "../src/domain/accounting/roles";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { allowedAccounts } from "../src/domain/vouchers/accounts";
import { bewirtungEigenbelegContent } from "../src/domain/vouchers/bewirtung";
import { checkUpload, pageCount } from "../src/domain/vouchers/capture";
import { voucherEigenbelegContent } from "../src/domain/vouchers/eigenbeleg";
import { upcomingVoucherDates } from "../src/domain/vouchers/recurring";
import { suggestAccount } from "../src/domain/vouchers/suggest";
import { supplierKeys } from "../src/domain/vouchers/supplier-key";
import { rulesFor, suggestTaxRule, TAX_RULE_HELP_DE, TAX_RULE_LABEL_DE } from "../src/domain/vouchers/tax-rules";
import { renderEigenbeleg } from "../src/pdf/eigenbeleg";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  action,
  actorMutation,
  mutation,
  query,
  systemAction,
  systemMutation,
  systemQuery,
  vConfirmToken,
} from "./functions";
import { isTest } from "./lib/env";
import { appError, errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import type { FileRefValue } from "./model/bankImport";
import { getCompanyProfile } from "./model/companyProfile";
import { assertCashOutflowAllowed, cashLines, previewJournal, resolveContextAt } from "./model/journal";
import {
  createRecurringVoucher,
  generateDueRecurringVouchers,
  updateRecurringVoucher,
} from "./model/recurringVouchers";
import { rebookVoucherPayment, recordVoucherPayment, voucherBankSuggestions } from "./model/voucherPayments";
import {
  accountContextAt,
  addVoucherFile,
  approveBewirtung,
  approveEigenbeleg,
  cancelVoucher,
  checkBewirtungFor,
  checkEigenbelegFor,
  correctVoucher,
  createVoucher,
  deleteVoucherDraft,
  dismissDuplicate,
  duplicateVoucher,
  finalizeVoucher,
  kuOn,
  markCheckedComplete,
  previewVoucher,
  requireVoucher,
  updateVoucherDraft,
} from "./model/vouchers";
import {
  listRow,
  missingReceipts,
  tabMatches,
  unbookedVouchers,
  VOUCHER_TABS,
  type VoucherTab,
  voucherDetail,
} from "./model/voucherViews";
import { vFileRef } from "./validators";
import {
  vBewirtungInput,
  vEigenbelegInput,
  vRecurringTemplate,
  vVoucherDraftInput,
  vVoucherPaymentInput,
} from "./voucherValidators";

/**
 * Ausgaben / Belege (F06 P2 voucher core): thin public functions over convex/model/vouchers.ts,
 * voucherPayments.ts, recurringVouchers.ts and voucherViews.ts. ⚠ acts: `finalize` (`voucher_finalize`) and the
 * later payments (`payment_record`) need a confirm token for `mcp:` actors (06 §2.3).
 */

// ── views ───────────────────────────────────────────────────────────────────────────────────────────────

export const list = query({
  permission: "vouchers.read",
  args: { paginationOpts: paginationOptsValidator, tab: v.optional(v.string()), q: v.optional(v.string()) },
  handler: async (ctx, { paginationOpts, tab, q }) => {
    const now = ctx.now();
    const today = berlinCalendarDate(now);
    const t: VoucherTab = (VOUCHER_TABS as readonly string[]).includes(tab ?? "") ? (tab as VoucherTab) : "all";
    const needle = q?.trim().toLowerCase() ?? "";
    const matches = (d: Doc<"vouchers">) =>
      !needle ||
      [d.supplierName, d.documentNumber, d.internalNumber, d.internalNote]
        .filter((s): s is string => !!s)
        .some((s) => s.toLowerCase().includes(needle));
    const page = await filter(
      ctx.db.query("vouchers").withIndex("by_documentDate").order("desc"),
      (d) => tabMatches(d, t, now) && matches(d),
    ).paginate(paginationOpts);
    return { ...page, page: page.page.map((d) => listRow(d, today)) };
  },
});

export const counts = query({
  permission: "vouchers.read",
  args: {},
  handler: async (ctx) => {
    const now = ctx.now();
    const all = await ctx.db.query("vouchers").collect();
    const out = Object.fromEntries(VOUCHER_TABS.map((t) => [t, 0])) as Record<VoucherTab, number>;
    for (const d of all) for (const t of VOUCHER_TABS) if (tabMatches(d, t, now)) out[t]++;
    return out;
  },
});

export const get = query({
  permission: "vouchers.read",
  args: { id: v.id("vouchers") },
  // null for an unknown id (the page shows „nicht gefunden“; REST answers 404).
  handler: async (ctx, { id }) => ((await ctx.db.get(id)) ? voucherDetail(ctx, id, ctx.now()) : null),
});

/** „Buchen“ dialog / REST + MCP preview: validation, payment plan, journal lines (no writes). */
export const preview = query({
  permission: "vouchers.read",
  args: { id: v.id("vouchers"), payment: v.optional(vVoucherPaymentInput) },
  handler: async (ctx, args) => {
    const p = await previewVoucher(ctx, args, ctx.now());
    const journal = await previewJournal(ctx, p.event);
    const v0 = await requireVoucher(ctx, args.id);
    const errors = p.check.errors.map((e) => ({ code: e.code, message: e.message }));
    // 06 §3 voucher_finalize: the preview shows the resulting cash balance; CSH-026 is dry-run like the act.
    let cash: { balanceCents: number; balanceAfterCents: number } | null = null;
    if (p.payment.method === "cash" && p.payment.date && p.payment.amountCents) {
      const role = resolveRole("cash", await resolveContextAt(ctx, p.payment.date as CalendarDate));
      if (role.ok && role.value.account) {
        const rows = await cashLines(ctx, role.value.account);
        const balanceCents = rows.reduce((sum, l) => sum + l.debitCents - l.creditCents, 0);
        cash = { balanceCents, balanceAfterCents: balanceCents - p.payment.amountCents };
      }
      try {
        await assertCashOutflowAllowed(ctx, p.payment.date, p.payment.amountCents);
      } catch (e) {
        if (errorCode(e) !== "cash_negative") throw e;
        const data = (e as { data?: { message?: string } }).data;
        errors.push({ code: "cash_negative", message: data?.message ?? "Der Kassenbestand würde negativ." });
      }
    }
    return {
      id: args.id,
      version: v0.version,
      errors,
      cash,
      warnings: [...p.check.warnings, ...p.payment.warnings],
      infos: p.check.infos.map((i) => ({ code: i.code, message: i.message })),
      effectiveTaxRule: p.check.effectiveTaxRule,
      effectiveTaxRuleLabel: TAX_RULE_LABEL_DE[p.check.effectiveTaxRule],
      totals: p.check.totals,
      totalsEur: p.check.totalsEur,
      inputVatAtRisk: p.check.inputVatAtRisk,
      payment: { method: p.payment.method, date: p.payment.date, amountCents: p.payment.amountCents },
      corporation: p.context.corporation,
      journal,
    };
  },
});

export const missing = query({
  permission: "vouchers.read",
  args: {},
  handler: async (ctx) => missingReceipts(ctx, ctx.now()),
});

export const unbooked = query({
  permission: "vouchers.read",
  args: {},
  handler: async (ctx) => unbookedVouchers(ctx, ctx.now()),
});

/** VOU-041/043: account and tax-rule suggestion for the editor. */
export const suggest = query({
  permission: "vouchers.read",
  args: {
    direction: v.union(v.literal("expense"), v.literal("income")),
    taxRule: v.optional(v.string()),
    date: v.optional(v.string()),
    supplierName: v.optional(v.string()),
    supplierVatId: v.optional(v.string()),
    supplierIban: v.optional(v.string()),
    supplierCountry: v.optional(v.string()),
    vatShown: v.optional(v.boolean()),
    text: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const date = (args.date ?? berlinCalendarDate(ctx.now())) as CalendarDate;
    const accounts = await accountContextAt(ctx, date);
    const profile = await getCompanyProfile(ctx);
    const keys = supplierKeys({
      ...(args.supplierVatId ? { vatId: args.supplierVatId } : {}),
      ...(args.supplierIban ? { iban: args.supplierIban } : {}),
      ...(args.supplierName ? { name: args.supplierName } : {}),
    });
    let profileRow: Doc<"supplierProfiles"> | null = null;
    for (const k of keys) {
      profileRow = await ctx.db
        .query("supplierProfiles")
        .withIndex("by_key", (q) => q.eq("key", k))
        .first();
      if (profileRow) break;
    }
    const taxRule = suggestTaxRule({
      ...(args.supplierVatId ? { supplierVatId: args.supplierVatId } : {}),
      ...(args.supplierCountry ? { supplierCountry: args.supplierCountry } : {}),
      vatShown: args.vatShown ?? true,
    });
    const rule = (args.taxRule ?? profileRow?.lastTaxRule ?? taxRule.rule) as Parameters<
      typeof allowedAccounts
    >[0]["taxRule"];
    const allowed = new Set(
      allowedAccounts({ direction: args.direction, taxRule: rule }, accounts).map((a) => a.number),
    );
    const account = suggestAccount({
      ...(profileRow
        ? {
            profile: {
              ...(profileRow.lastAccount ? { lastAccount: profileRow.lastAccount } : {}),
              uses: profileRow.uses,
              accountStreak: profileRow.accountStreak,
            },
          }
        : {}),
      text: `${args.supplierName ?? ""} ${args.text ?? ""}`,
      chart: accounts.chart,
      allowed,
    });
    return {
      account,
      taxRule: profileRow?.lastTaxRule
        ? { rule: profileRow.lastTaxRule, reason: "gelernt" }
        : { rule: taxRule.rule, reason: taxRule.reason ?? null },
      ku: kuOn(profile, date),
    };
  },
});

/** Account combobox + tax rules for a direction (VOU-002, VOU-010, EC-VOU-37/38). */
export const options = query({
  permission: "vouchers.read",
  args: {
    direction: v.union(v.literal("expense"), v.literal("income")),
    taxRule: v.string(),
    date: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const date = (args.date ?? berlinCalendarDate(ctx.now())) as CalendarDate;
    const accounts = await accountContextAt(ctx, date);
    const profile = await getCompanyProfile(ctx);
    return {
      chart: accounts.chart,
      ku: kuOn(profile, date),
      corporation: profile ? isCorporation(profile.legalForm) : false,
      accounts: allowedAccounts(
        { direction: args.direction, taxRule: args.taxRule as Parameters<typeof allowedAccounts>[0]["taxRule"] },
        accounts,
      ).map((a) => ({ number: a.number, name: a.name, type: a.type })),
      taxRules: rulesFor(args.direction).map((r) => ({
        value: r,
        label: TAX_RULE_LABEL_DE[r],
        help: TAX_RULE_HELP_DE[r],
      })),
      vatImportAccount: accounts.roleAccounts["vat.import"] ?? null,
    };
  },
});

export const bankSuggestions = query({
  permission: "vouchers.read",
  args: { id: v.id("vouchers") },
  handler: async (ctx, { id }) => voucherBankSuggestions(ctx, id),
});

// ── drafts ──────────────────────────────────────────────────────────────────────────────────────────────

export const generateUploadUrl = mutation({
  permission: "vouchers.write",
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

export const create = mutation({
  permission: "vouchers.write",
  args: { input: vVoucherDraftInput },
  handler: async (ctx, { input }) => createVoucher(ctx, { input }),
});

export const updateDraft = mutation({
  permission: "vouchers.write",
  args: { id: v.id("vouchers"), version: v.optional(v.number()), input: vVoucherDraftInput },
  handler: async (ctx, args) => updateVoucherDraft(ctx, args),
});

export const deleteDraft = mutation({
  permission: "vouchers.write",
  args: { id: v.id("vouchers") },
  handler: async (ctx, { id }) => deleteVoucherDraft(ctx, id),
});

const CHANNEL: Record<string, "upload" | "api" | "mcp" | "app" | "email"> = {
  ui: "upload",
  api: "api",
  mcp: "mcp",
};

export const attachFileInternal = actorMutation({
  permission: "vouchers.write",
  args: {
    voucherId: v.optional(v.id("vouchers")),
    file: v.object({
      storageId: v.id("_storage"),
      sha256: v.string(),
      bytes: v.number(),
      mime: v.string(),
      name: v.string(),
      pages: v.number(),
      clientCapturedAt: v.optional(v.number()),
    }),
    replaceIndex: v.optional(v.number()),
    reason: v.optional(v.string()),
    via: v.optional(v.union(v.literal("upload"), v.literal("app"))),
  },
  handler: async (ctx, args): Promise<{ voucherId: Id<"vouchers">; index: number }> => {
    const { clientCapturedAt, ...f } = args.file;
    const original = {
      ...f,
      role:
        f.mime === "application/xml"
          ? ("extracted_xml" as const)
          : f.mime === "message/rfc822"
            ? ("eml" as const)
            : ("original" as const),
      capturedAt: ctx.now(),
      ...(clientCapturedAt ? { clientCapturedAt } : {}),
      capturedBy: ctx.actor,
      capturedVia: args.via ?? CHANNEL[ctx.actorContext.channel] ?? "upload",
    };
    if (!args.voucherId) {
      const voucherId = await createVoucher(ctx, { input: {}, files: [original] });
      return { voucherId, index: 0 };
    }
    const r = await addVoucherFile(ctx, {
      id: args.voucherId,
      file: original,
      ...(args.replaceIndex !== undefined ? { replaceIndex: args.replaceIndex } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
    return { voucherId: args.voucherId, index: r.index };
  },
});

const sha256Hex = async (bytes: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/**
 * VOU-120…122 upload: the stored bytes are the original (never altered); MIME sniffed from the bytes, SHA-256, size
 * and page count recorded with the capture time and actor. Without `voucherId` a new draft is created („Beleg
 * hochladen“). Rejected files are deleted from storage again.
 */
export const attachFile = action({
  permission: "vouchers.write",
  args: {
    voucherId: v.optional(v.id("vouchers")),
    storageId: v.id("_storage"),
    name: v.string(),
    clientCapturedAt: v.optional(v.number()),
    replaceIndex: v.optional(v.number()),
    reason: v.optional(v.string()),
    via: v.optional(v.union(v.literal("upload"), v.literal("app"))),
  },
  handler: async (ctx, args): Promise<{ voucherId: Id<"vouchers">; index: number }> => {
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw appError("not_found", "Die hochgeladene Datei wurde nicht gefunden.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const checked = checkUpload(bytes);
    if (!checked.ok) {
      await ctx.storage.delete(args.storageId);
      throw appError("invalid_input", checked.error.message, { reason: checked.error.code.toUpperCase() });
    }
    try {
      return await ctx.runMutation(internal.vouchers.attachFileInternal, {
        actorContext: ctx.actorContext,
        ...(args.voucherId ? { voucherId: args.voucherId } : {}),
        file: {
          storageId: args.storageId,
          sha256: await sha256Hex(bytes),
          bytes: bytes.byteLength,
          mime: checked.value.mime,
          name: args.name.trim() || "beleg",
          pages: pageCount(bytes, checked.value.mime),
          ...(args.clientCapturedAt ? { clientCapturedAt: args.clientCapturedAt } : {}),
        },
        ...(args.replaceIndex !== undefined ? { replaceIndex: args.replaceIndex } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.via ? { via: args.via } : {}),
      });
    } catch (e) {
      await ctx.storage.delete(args.storageId); // never referenced: the mutation failed
      throw e;
    }
  },
});

export const checkedComplete = mutation({
  permission: "vouchers.write",
  args: { id: v.id("vouchers") },
  handler: async (ctx, { id }) => markCheckedComplete(ctx, id),
});

export const dismissDuplicateOf = mutation({
  permission: "vouchers.write",
  args: { id: v.id("vouchers"), otherId: v.id("vouchers") },
  handler: async (ctx, args) => dismissDuplicate(ctx, args),
});

// ── booking, correction, cancellation ───────────────────────────────────────────────────────────────────

/** ⚠ VOU-007 „Buchen“ with „Bezahlt mit“ (VOU-136…138). The confirm token binds id, version, warnings and payment. */
export const finalize = mutation({
  permission: "vouchers.finalize",
  args: {
    id: v.id("vouchers"),
    version: v.optional(v.number()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
    payment: v.optional(vVoucherPaymentInput),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, args) => finalizeVoucher(ctx, args),
});

export const correct = mutation({
  permission: "vouchers.correct",
  args: {
    id: v.id("vouchers"),
    version: v.optional(v.number()),
    input: vVoucherDraftInput,
    reason: v.string(),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => correctVoucher(ctx, args),
});

export const cancel = mutation({
  permission: "vouchers.correct",
  args: { id: v.id("vouchers"), reason: v.string() },
  handler: async (ctx, args) => cancelVoucher(ctx, args),
});

export const duplicate = mutation({
  permission: "vouchers.write",
  args: { id: v.id("vouchers") },
  handler: async (ctx, { id }) => duplicateVoucher(ctx, id),
});

// ── payments (VOU-131…139) ──────────────────────────────────────────────────────────────────────────────

const vDifference = v.object({
  reason: v.union(v.literal("skonto"), v.literal("bank_fees"), v.literal("other")),
  amountCents: v.number(),
  account: v.optional(v.string()),
});

/** ⚠ Later „Bar/Privat bezahlt“ or linking a bank debit on an open voucher. */
export const recordPayment = mutation({
  permission: "vouchers.pay",
  args: {
    id: v.id("vouchers"),
    method: v.union(v.literal("bank"), v.literal("cash"), v.literal("private")),
    date: v.optional(v.string()),
    amountCents: v.optional(v.number()),
    transactionId: v.optional(v.id("bankTransactions")),
    backdateReason: v.optional(v.string()),
    note: v.optional(v.string()),
    differences: v.optional(v.array(vDifference)),
    acknowledgeWarnings: v.optional(v.array(v.string())),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, { id, ...args }) => recordVoucherPayment(ctx, { voucherId: id, ...args }),
});

/** ⚠ VOU-139 „Zahlung umbuchen“: reverse the cash/private payment and match the bank debit in one step. */
export const rebookPayment = mutation({
  permission: "vouchers.pay",
  args: {
    id: v.id("vouchers"),
    transactionId: v.id("bankTransactions"),
    reason: v.string(),
    confirmToken: vConfirmToken,
  },
  handler: async (ctx, { id, ...args }) => rebookVoucherPayment(ctx, { voucherId: id, ...args }),
});

/** VOU-110 „Beleg nicht erforderlich“ on a bank transaction (reason required). */
export const waiveReceipt = mutation({
  permission: "vouchers.write",
  args: { transactionId: v.id("bankTransactions"), reason: v.string() },
  handler: async (ctx, { transactionId, reason }) => {
    const text = reason.trim();
    if (text.length < 5) throw appError("invalid_input", "Bitte einen Grund angeben (mindestens 5 Zeichen).");
    const tx = await ctx.db.get(transactionId);
    if (!tx) throw appError("not_found", "Der Bankumsatz existiert nicht.");
    const existing = await ctx.db
      .query("receiptWaivers")
      .withIndex("by_transaction", (q) => q.eq("bankTransactionId", transactionId))
      .first();
    if (existing) return existing._id;
    return auditedInsert(
      ctx,
      "receiptWaivers",
      { bankTransactionId: transactionId, reason: text, actor: ctx.actor, at: ctx.now() },
      { action: "voucher.receipt_waive", label: `${tx.bookingDate} ${tx.amountCents}`, reason: text },
    );
  },
});

// ── Bewirtung / Eigenbeleg approval (VOU-060…063) ───────────────────────────────────────────────────────

export const bewirtungContext = query({
  permission: "vouchers.approve",
  args: {
    id: v.id("vouchers"),
    data: vBewirtungInput,
    reason: v.optional(v.string()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const c = await checkBewirtungFor(ctx, args);
    const sha = c.voucher.originalFiles.find((f) => f.replacedBy === undefined)?.sha256;
    return {
      content: bewirtungEigenbelegContent({
        data: args.data,
        grossCents: c.voucher.totals.grossCents,
        currency: c.voucher.currency,
        receipt: {
          ...(c.voucher.documentNumber ? { number: c.voucher.documentNumber } : {}),
          ...(c.voucher.supplierName ? { supplierName: c.voucher.supplierName } : {}),
          ...(sha ? { sha256: sha } : {}),
        },
        company: c.company,
        createdOn: berlinCalendarDate(ctx.now()),
        createdBy: ctx.actorContext.label ?? ctx.actor,
        version: c.version,
        ...(args.reason?.trim() ? { supersedesReason: args.reason.trim() } : {}),
      }),
      company: c.company,
    };
  },
});

export const approveBewirtungInternal = actorMutation({
  permission: "vouchers.approve",
  args: {
    id: v.id("vouchers"),
    data: vBewirtungInput,
    file: vFileRef,
    reason: v.optional(v.string()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => approveBewirtung(ctx, args),
});

async function storePdf(
  ctx: { storage: { store: (b: Blob) => Promise<Id<"_storage">> } },
  bytes: Uint8Array,
  name: string,
): Promise<FileRefValue> {
  const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  return { storageId, sha256: await sha256Hex(bytes), bytes: bytes.byteLength, mime: "application/pdf", name };
}

/** VOU-060/062 „Bewirtungsbeleg freigeben“: PDF (SHA-256) rendered and frozen; a re-approval supersedes (reason). */
export const approveBewirtungBeleg = action({
  permission: "vouchers.approve",
  args: {
    id: v.id("vouchers"),
    data: vBewirtungInput,
    reason: v.optional(v.string()),
    acknowledgeWarnings: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args): Promise<null> => {
    if (!ctx.actor.startsWith("user:")) {
      throw appError(
        "forbidden_role",
        "Die Freigabe eines Eigenbelegs ist eine persönliche Erklärung und nur in der App möglich.",
      );
    }
    const c = await ctx.runQuery(api.vouchers.bewirtungContext, args);
    const bytes = await renderEigenbeleg(c.content, c.company, ctx.now());
    const file = await storePdf(ctx, bytes, c.content.fileName);
    try {
      await ctx.runMutation(internal.vouchers.approveBewirtungInternal, {
        actorContext: ctx.actorContext,
        ...args,
        file,
      });
    } catch (e) {
      await ctx.storage.delete(file.storageId);
      throw e;
    }
    return null;
  },
});

export const eigenbelegContext = query({
  permission: "vouchers.approve",
  args: { id: v.id("vouchers"), data: vEigenbelegInput },
  handler: async (ctx, args) => {
    const c = await checkEigenbelegFor(ctx, args);
    return {
      content: voucherEigenbelegContent({
        data: args.data,
        date: c.voucher.documentDate as string,
        grossCents: c.gross,
        currency: c.voucher.currency,
        company: c.company,
        createdOn: berlinCalendarDate(ctx.now()),
        createdBy: ctx.actorContext.label ?? ctx.actor,
      }),
      company: c.company,
    };
  },
});

export const approveEigenbelegInternal = actorMutation({
  permission: "vouchers.approve",
  args: { id: v.id("vouchers"), data: vEigenbelegInput, file: vFileRef },
  handler: async (ctx, args) => approveEigenbeleg(ctx, args),
});

/** VOU-063 „Eigenbeleg freigeben“: renders the PDF (SHA-256), which becomes the Beleg; immutable afterwards. */
export const approveEigenbelegBeleg = action({
  permission: "vouchers.approve",
  args: { id: v.id("vouchers"), data: vEigenbelegInput },
  handler: async (ctx, args): Promise<null> => {
    if (!ctx.actor.startsWith("user:")) {
      throw appError(
        "forbidden_role",
        "Die Freigabe eines Eigenbelegs ist eine persönliche Erklärung und nur in der App möglich.",
      );
    }
    const c = await ctx.runQuery(api.vouchers.eigenbelegContext, args);
    const bytes = await renderEigenbeleg(c.content, c.company, ctx.now());
    const file = await storePdf(ctx, bytes, c.content.fileName);
    try {
      await ctx.runMutation(internal.vouchers.approveEigenbelegInternal, {
        actorContext: ctx.actorContext,
        ...args,
        file,
      });
    } catch (e) {
      await ctx.storage.delete(file.storageId);
      throw e;
    }
    return null;
  },
});

// ── recurring vouchers (VOU-064) ────────────────────────────────────────────────────────────────────────

const vInterval = v.union(
  v.literal("P1W"),
  v.literal("P2W"),
  v.literal("P1M"),
  v.literal("P2M"),
  v.literal("P3M"),
  v.literal("P6M"),
  v.literal("P1Y"),
  v.literal("P2Y"),
  v.literal("P3Y"),
  v.literal("P4Y"),
  v.literal("P5Y"),
);

const recurringArgs = {
  name: v.string(),
  template: vRecurringTemplate,
  interval: vInterval,
  firstDate: v.string(),
  endDate: v.optional(v.string()),
  createAs: v.union(v.literal("open"), v.literal("draft")),
  expectedMandateRef: v.optional(v.string()),
  expectedIban: v.optional(v.string()),
  referenceFile: v.optional(vFileRef),
  recurringPayment: v.optional(v.boolean()),
};

export const recurringList = query({
  permission: "vouchers.read",
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("recurringVouchers").collect();
    return rows.map((r) => ({
      ...r,
      upcoming: r.active ? upcomingVoucherDates(r, 3) : [],
    }));
  },
});

export const createRecurring = mutation({
  permission: "vouchers.write",
  args: recurringArgs,
  handler: async (ctx, args) => createRecurringVoucher(ctx, args),
});

export const updateRecurring = mutation({
  permission: "vouchers.write",
  args: {
    id: v.id("recurringVouchers"),
    version: v.optional(v.number()),
    patch: v.object({
      name: v.optional(v.string()),
      template: v.optional(vRecurringTemplate),
      interval: v.optional(vInterval),
      firstDate: v.optional(v.string()),
      endDate: v.optional(v.string()),
      createAs: v.optional(v.union(v.literal("open"), v.literal("draft"))),
      expectedMandateRef: v.optional(v.string()),
      expectedIban: v.optional(v.string()),
      referenceFile: v.optional(vFileRef),
      recurringPayment: v.optional(v.boolean()),
      active: v.optional(v.boolean()),
    }),
  },
  handler: async (ctx, args) => updateRecurringVoucher(ctx, args),
});

/** „Jetzt erzeugen“ for one template (same idempotent path as the cron). */
export const generateRecurringNow = mutation({
  permission: "vouchers.write",
  args: { id: v.id("recurringVouchers") },
  handler: async (ctx, { id }) => generateDueRecurringVouchers(ctx, ctx.now(), id),
});

export const dueRecurring = systemQuery({
  job: "cron.recurringVouchers.generate",
  args: { today: v.string() },
  handler: async (ctx, { today }): Promise<Id<"recurringVouchers">[]> =>
    (
      await ctx.db
        .query("recurringVouchers")
        .withIndex("by_active_next", (q) => q.eq("active", true).lte("nextDate", today))
        .collect()
    ).map((r) => r._id),
});

export const generateRecurringFor = systemMutation({
  job: "cron.recurringVouchers.generate",
  args: { id: v.id("recurringVouchers") },
  handler: async (ctx, { id }) => generateDueRecurringVouchers(ctx, ctx.now(), id),
});

/** 02 §7 recurringVouchers.generate (daily 06:15 Europe/Berlin); one transaction per template (failures isolated). */
export const generateRecurringCron = systemAction({
  job: "cron.recurringVouchers.generate",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<{ templates: number; created: number; failed: number }> => {
    if (isTest() && !force) return { templates: 0, created: 0, failed: 0 };
    const ids: Id<"recurringVouchers">[] = await ctx.runQuery(internal.vouchers.dueRecurring, {
      today: berlinCalendarDate(Date.now()),
    });
    let created = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        const r = await ctx.runMutation(internal.vouchers.generateRecurringFor, { id });
        created += r.created.length;
      } catch {
        failed++;
      }
    }
    return { templates: ids.length, created, failed };
  },
});
