import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import { activeOriginals } from "../../src/domain/vouchers/capture";
import { IMAGE_QUALITY_MESSAGE } from "../../src/domain/vouchers/image-quality";
import { VOUCHER_STATUS_DE } from "../../src/domain/vouchers/lifecycle";
import {
  overdueVouchers,
  receiptSuggestions,
  recurringWithoutDebit,
  transactionsWithoutReceipt,
  UNBOOKED_DAYS,
  unbookedOlderThan,
} from "../../src/domain/vouchers/missing-receipts";
import { PAYMENT_METHOD_DE } from "../../src/domain/vouchers/payment-choice";
import { paperDestructible, scanningProcedureReleased } from "../../src/domain/vouchers/scanning";
import { TAX_RULE_LABEL_DE } from "../../src/domain/vouchers/tax-rules";
import type { Doc, Id } from "../_generated/dataModel";
import { journalEntryView } from "./accounting";
import type { ReadCtx } from "./types";
import { linesOf, previewVoucher, requireVoucher } from "./vouchers";

/** Read models of the „Ausgaben“ pages (F06 §6): list rows, detail, missing receipts, unbooked items. */

/** F06 §6.2 tabs Entwurf · Offen · Fällig · Teilbezahlt · Bezahlt · Storniert, plus „Unbearbeitet > 10 Tage“ (VOU-111). */
export const VOUCHER_TABS = [
  "all",
  "draft",
  "open",
  "overdue",
  "partially_paid",
  "paid",
  "cancelled",
  "unbooked",
  "paper_destructible",
] as const;
export type VoucherTab = (typeof VOUCHER_TABS)[number];

const DAY_MS = 86_400_000;

/** VOU-123: a released Verfahrensdokumentation documents the scanning procedure (gate of „Papier vernichtbar“). */
export async function scanningReleased(ctx: ReadCtx): Promise<boolean> {
  const latest = await ctx.db.query("verfahrensdokuVersions").withIndex("by_version").order("desc").first();
  return !!latest && latest.supersededAt === undefined && scanningProcedureReleased(latest.sourceJson);
}

export function tabMatches(
  v: Doc<"vouchers">,
  tab: VoucherTab,
  now: number,
  opts: { scanningReleased?: boolean } = {},
): boolean {
  switch (tab) {
    case "all":
      return true;
    case "draft":
      return v.status === "draft";
    case "open":
      return v.status === "open" || v.status === "scheduled" || v.status === "partially_paid";
    case "overdue":
      return (
        (v.status === "open" || v.status === "scheduled" || v.status === "partially_paid") &&
        !!v.dueDate &&
        v.dueDate < berlinCalendarDate(now)
      );
    case "partially_paid":
      return v.status === "partially_paid";
    case "paid":
      return v.status === "paid";
    case "cancelled":
      return v.status === "cancelled";
    case "unbooked":
      return v.status === "draft" && now - v.receivedAt > UNBOOKED_DAYS * DAY_MS;
    case "paper_destructible":
      return paperDestructible(v, opts.scanningReleased ?? false);
  }
}

export function listRow(v: Doc<"vouchers">, today: string) {
  const gross = v.totalsEur?.grossCents ?? v.totals.grossCents;
  return {
    _id: v._id,
    status: v.status,
    statusLabel: VOUCHER_STATUS_DE[v.status],
    direction: v.direction,
    kind: v.kind,
    internalNumber: v.internalNumber ?? null,
    documentNumber: v.documentNumber ?? null,
    supplierName: v.supplierName ?? null,
    documentDate: v.documentDate ?? null,
    dueDate: v.dueDate ?? null,
    overdue: !!v.dueDate && v.dueDate < today && (v.status === "open" || v.status === "partially_paid"),
    currency: v.currency,
    grossCents: v.totals.grossCents,
    grossEurCents: gross,
    openAmountCents: v.openAmountCents,
    taxRule: v.taxRule,
    taxRuleLabel: TAX_RULE_LABEL_DE[v.taxRule],
    hasFile: activeOriginals(v.originalFiles).length > 0 || !!v.eigenbeleg?.approvedAt,
    checkedComplete: !!v.checkedComplete,
    receivedAt: v.receivedAt,
  };
}

export async function voucherDetail(ctx: ReadCtx, id: Id<"vouchers">, now: number) {
  const v = await requireVoucher(ctx, id);
  const lines = await linesOf(ctx, id);
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_target", (q) => q.eq("target.kind", "voucher").eq("target.id", id))
    .collect();
  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", id))
    .collect();
  const paymentEntries = [];
  for (const p of payments) {
    for (const e of await ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", p._id))
      .collect()) {
      paymentEntries.push(e);
    }
  }
  let check: Awaited<ReturnType<typeof previewVoucher>>["check"] | null = null;
  if (v.status === "draft") {
    try {
      check = (await previewVoucher(ctx, { id }, now)).check;
    } catch {
      check = null; // setup incomplete: the editor shows the setup hint
    }
  }
  const fileUrl = async (storageId: Id<"_storage">) => ctx.storage.getUrl(storageId);
  return {
    voucher: {
      ...v,
      statusLabel: VOUCHER_STATUS_DE[v.status],
      taxRuleLabel: TAX_RULE_LABEL_DE[v.taxRule],
    },
    lines,
    files: await Promise.all(
      v.originalFiles.map(async (f, index) => ({
        index,
        name: f.name,
        mime: f.mime,
        bytes: f.bytes,
        sha256: f.sha256,
        pages: f.pages ?? null,
        capturedAt: f.capturedAt,
        capturedBy: f.capturedBy,
        capturedVia: f.capturedVia,
        replacedBy: f.replacedBy ?? null,
        replaceReason: f.replaceReason ?? null,
        // VOU-124: „Bildqualität niedrig“ with „Neu aufnehmen“ for a low-resolution capture.
        qualityWarning: f.image?.low ? IMAGE_QUALITY_MESSAGE(f.image) : null,
        url: await fileUrl(f.storageId),
      })),
    ),
    renditions: v.renditions.map((r) => ({ kind: r.kind, ofFileIndex: r.ofFileIndex, mime: r.mime })),
    eigenbelegFile: v.eigenbeleg?.file
      ? {
          name: v.eigenbeleg.file.name,
          sha256: v.eigenbeleg.file.sha256,
          url: await fileUrl(v.eigenbeleg.file.storageId),
        }
      : null,
    bewirtungFile: v.bewirtung?.eigenbelegFile
      ? {
          name: v.bewirtung.eigenbelegFile.name,
          sha256: v.bewirtung.eigenbelegFile.sha256,
          url: await fileUrl(v.bewirtung.eigenbelegFile.storageId),
        }
      : null,
    payments: payments
      .sort((a, b) => a.recordedAt - b.recordedAt)
      .map((p) => ({
        id: p._id,
        date: p.date,
        amountCents: p.amountCents,
        source: p.source.kind,
        sourceLabel:
          p.source.kind === "cash"
            ? PAYMENT_METHOD_DE.cash
            : p.source.kind === "private"
              ? PAYMENT_METHOD_DE.private
              : p.source.kind === "bank"
                ? "Bank"
                : p.source.kind,
        differences: p.differences,
        reversed: !!p.reversedById,
        reversalOf: p.reversalOfId ?? null,
        reason: p.reason ?? null,
        backdateReason: p.backdateReason ?? null,
      })),
    journal: await Promise.all(
      [...entries, ...paymentEntries].sort((a, b) => a.seq - b.seq).map((e) => journalEntryView(ctx, e)),
    ),
    check: check
      ? {
          errors: check.errors.map((e) => ({ code: e.code, message: e.message })),
          warnings: check.warnings,
          infos: check.infos.map((i) => ({ code: i.code, message: i.message })),
          totals: check.totals,
          totalsEur: check.totalsEur,
          inputVatAtRisk: check.inputVatAtRisk,
        }
      : null,
  };
}

/** VOU-110 „Fehlende Belege“: (a) bank transactions without voucher, (b) overdue vouchers, (c) recurring without debit. */
export async function missingReceipts(ctx: ReadCtx, now: number) {
  const today = berlinCalendarDate(now) as CalendarDate;
  const waived = new Set((await ctx.db.query("receiptWaivers").collect()).map((w) => w.bankTransactionId as string));
  const withVoucher = new Set(
    (await ctx.db.query("payments").collect())
      .filter((p) => p.target.kind === "voucher" && p.bankTransactionId && !p.reversedById && !p.reversalOfId)
      .map((p) => p.bankTransactionId as string),
  );
  const txs = [];
  for (const status of ["open", "partially_matched"] as const) {
    txs.push(
      ...(await ctx.db
        .query("bankTransactions")
        .withIndex("by_status", (q) => q.eq("status", status))
        .collect()),
    );
  }
  const rows = transactionsWithoutReceipt(
    txs.map((t) => ({
      id: t._id,
      bookingDate: t.bookingDate,
      amountCents: t.amountCents,
      ...(t.counterpartyName ? { counterpartyName: t.counterpartyName } : {}),
      purpose: t.purpose,
      status: t.status,
      allocatedCents: t.allocatedCents,
      hasVoucher: withVoucher.has(t._id),
      waived: waived.has(t._id),
    })),
  );
  const drafts = (
    await ctx.db
      .query("vouchers")
      .withIndex("by_status_date", (q) => q.eq("status", "draft"))
      .collect()
  ).map((d) => ({
    id: d._id as string,
    kind: "draft" as const,
    grossCents: d.totals.grossCents,
    ...(d.documentDate ? { date: d.documentDate } : {}),
    ...(d.supplierName ? { name: d.supplierName } : {}),
  }));
  const open = [];
  for (const status of ["open", "partially_paid", "scheduled"] as const) {
    open.push(
      ...(await ctx.db
        .query("vouchers")
        .withIndex("by_status_date", (q) => q.eq("status", status))
        .collect()),
    );
  }
  const refs = open.map((v) => ({
    id: v._id as string,
    status: v.status,
    ...(v.dueDate ? { dueDate: v.dueDate } : {}),
    documentDate: v.documentDate ?? "",
    openAmountCents: v.openAmountCents,
    ...(v.recurringVoucherId ? { recurringVoucherId: v.recurringVoucherId as string } : {}),
  }));
  const byId = new Map(open.map((v) => [v._id as string, v]));
  return {
    transactions: rows.slice(0, 200).map((t) => ({ ...t, suggestions: receiptSuggestions(t, drafts).slice(0, 3) })),
    overdue: overdueVouchers(refs, today).map((r) => listRow(byId.get(r.id) as Doc<"vouchers">, today)),
    recurringWithoutDebit: recurringWithoutDebit(refs, today).map((r) =>
      listRow(byId.get(r.id) as Doc<"vouchers">, today),
    ),
  };
}

/** VOU-111: drafts received more than 10 days ago (dashboard to-do and list filter). */
export async function unbookedVouchers(ctx: ReadCtx, now: number) {
  const drafts = await ctx.db
    .query("vouchers")
    .withIndex("by_status_date", (q) => q.eq("status", "draft"))
    .collect();
  return unbookedOlderThan(drafts, now).map((d) => listRow(d, berlinCalendarDate(now)));
}
