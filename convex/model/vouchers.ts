import type { Infer } from "convex/values";
import type { VoucherBookedEvent, VoucherPostingLine } from "../../src/domain/accounting/events";
import { chartAt, supplyEnd } from "../../src/domain/accounting/period";
import { isCorporation } from "../../src/domain/accounting/roles";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import { type AccountContext, accountContextFor } from "../../src/domain/vouchers/accounts";
import { checkBewirtungApproval } from "../../src/domain/vouchers/bewirtung";
import { activeOriginals, checkReplacement, replaceOriginal } from "../../src/domain/vouchers/capture";
import { type DuplicateCandidate, findDuplicates } from "../../src/domain/vouchers/duplicates";
import { checkEigenbelegApproval } from "../../src/domain/vouchers/eigenbeleg";
import { computeLine } from "../../src/domain/vouchers/lines";
import { checkPaymentChoice, type PaymentWarning } from "../../src/domain/vouchers/payment-choice";
import { correctProfile, learnProfile, type SupplierProfileData } from "../../src/domain/vouchers/suggest";
import { supplierKey } from "../../src/domain/vouchers/supplier-key";
import { deductsInputVat, effectiveTaxRule } from "../../src/domain/vouchers/tax-rules";
import { isSelfAssessment, type VoucherLine } from "../../src/domain/vouchers/types";
import {
  unacknowledgedWarnings,
  type ValidationContext,
  type VoucherCheck,
  type VoucherDraft,
  validateVoucher,
} from "../../src/domain/vouchers/validate";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import type {
  vBewirtungInput,
  vEigenbelegInput,
  vOriginalFile,
  vVoucherDraftInput,
  vVoucherLineInput,
  vVoucherPaymentInput,
} from "../voucherValidators";
import { assertVoucherAssetsReversible, createAssetsForVoucher, voidVoucherAssets } from "./assets";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import type { FileRefValue } from "./bankImport";
import { getCompanyProfile } from "./companyProfile";
import { markInboxConverted, releaseInboxDraft } from "./inboxLinks";
import { postJournalEntry, roleOverrides } from "./journal";
import { ledgerAccountsOf } from "./ledgerAccounts";
import { assignCounterNumber } from "./numberRanges";
import { closedPeriods } from "./payments";
import type { ModelCtx, ReadCtx } from "./types";
import { recordVoucherPayment } from "./voucherPayments";
import { refreshVoucher } from "./voucherStatus";

/**
 * Purchase vouchers (F06 VOU-001…065, VOU-120…139; 03 §6) — the only writer of `vouchers`, `voucherLines`,
 * `voucherFileHashes` and `supplierProfiles`. Pure rules live in src/domain/vouchers (validation, tax rules, lines,
 * duplicates, Bewirtung, Eigenbeleg, assets, payment choice); the postings in src/domain/accounting/post-vouchers.ts.
 *
 *   createVoucher / updateVoucherDraft / deleteVoucherDraft   (VOU-001, VOU-007 drafts are deletable)
 *   addVoucherFile                                            (VOU-120…122 versioned originals)
 *   previewVoucher / finalizeVoucher                          (VOU-007 „Buchen“ + „Bezahlt mit“ VOU-136…138)
 *   correctVoucher / cancelVoucher / duplicateVoucher         (VOU-008/009)
 *   approveBewirtung / approveEigenbeleg                      (VOU-060…063, PDF rendered by the calling action)
 */

export type VoucherDoc = Doc<"vouchers">;
export type VoucherLineDoc = Doc<"voucherLines">;
export type DraftInput = Infer<typeof vVoucherDraftInput>;
export type LineInputArg = Infer<typeof vVoucherLineInput>;
export type OriginalFileValue = Infer<typeof vOriginalFile>;
export type PaymentInputArg = Infer<typeof vVoucherPaymentInput>;
export type BewirtungInput = Infer<typeof vBewirtungInput>;
export type EigenbelegInputArg = Infer<typeof vEigenbelegInput>;

export const VOUCHER_ERRORS = {
  notFound: "Der Beleg existiert nicht.",
  notDraft:
    "Nur Entwürfe können bearbeitet oder gelöscht werden. Gebuchte Belege bitte über „Beleg korrigieren“ ändern.",
  notBooked: "Der Beleg ist nicht gebucht.",
  cancelled: "Der Beleg ist storniert.",
  locked:
    "Der Beleg ist festgeschrieben und kann nicht mehr geändert werden. Bitte stornieren und neu erfassen („Duplizieren“).",
  outdated: "Der Beleg wurde inzwischen geändert. Bitte neu laden.",
  reason: "Bitte einen Grund angeben (mindestens 5 Zeichen).",
  activePayments: "Der Beleg hat Zahlungen. Bitte zuerst die Zahlungen stornieren.",
  humanApproval: "Die Freigabe eines Eigenbelegs ist eine persönliche Erklärung und nur in der App möglich.",
  eigenbelegApproved: "Der Eigenbeleg ist freigegeben und unveränderbar.",
  bewirtungReason: "Bitte angeben, warum der freigegebene Bewirtungsbeleg berichtigt wird.",
  kind: (kind: string) => `Dieser Schritt gilt nur für Belege der Art ${kind}.`,
} as const;

const REASON_MIN = 5;

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

export async function requireVoucher(ctx: ReadCtx, id: Id<"vouchers">): Promise<VoucherDoc> {
  const v = await ctx.db.get(id);
  if (!v) throw appError("not_found", VOUCHER_ERRORS.notFound);
  return v;
}

export async function linesOf(ctx: ReadCtx, id: Id<"vouchers">): Promise<VoucherLineDoc[]> {
  return ctx.db
    .query("voucherLines")
    .withIndex("by_voucher", (q) => q.eq("voucherId", id))
    .collect();
}

/** KU on `date` (KU-01, latest row valid on the date). */
export function kuOn(profile: Doc<"companyProfile"> | null, date: string): boolean {
  const row = [...(profile?.kleinunternehmer ?? [])]
    .filter((k) => k.validFrom <= date)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    .at(-1);
  return row?.isKU ?? false;
}

/** The date that governs tax rules and accounts of a voucher: supply end, else document date, else today. */
export function governingDate(v: Pick<VoucherDoc, "supplyDate" | "documentDate">, today: CalendarDate): CalendarDate {
  if (v.supplyDate) {
    try {
      return supplyEnd(v.supplyDate);
    } catch {
      // invalid supply date: reported by the validation
    }
  }
  return v.documentDate && isCalendarDate(v.documentDate) ? v.documentDate : today;
}

const isLocked = (v: VoucherDoc) => v.lockedAt !== undefined;
const label = (v: Pick<VoucherDoc, "internalNumber" | "documentNumber" | "supplierName">) =>
  v.internalNumber ?? v.documentNumber ?? v.supplierName ?? "Beleg";

export async function accountContextAt(ctx: ReadCtx, date: CalendarDate): Promise<AccountContext> {
  const profile = await getCompanyProfile(ctx);
  const chart = chartAt(profile?.chartOfAccounts ?? [], profile?.fiscalYearStartMonth ?? 1, date);
  const overrides: Record<string, string | null> = {};
  for (const o of (await roleOverrides(ctx, chart))
    .filter((o) => o.validFrom <= date)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))) {
    overrides[o.role] = o.account;
  }
  const banks = await ctx.db.query("bankAccounts").collect();
  const ledger = await ledgerAccountsOf(ctx, chart);
  const acc = accountContextFor(chart, date, {
    bankLedgerAccounts: banks.map((b) => b.ledgerAccount).filter((a): a is string => !!a),
    roleOverrides: overrides,
    customAccounts: ledger.custom.filter((a) => !a.archived),
    archivedAccounts: ledger.archived,
  });
  if (!acc) throw appError("posting_rejected", "Für dieses Datum ist kein Kontenrahmen hinterlegt.");
  return acc;
}

// ── lines ───────────────────────────────────────────────────────────────────────────────────────────────

/** VOU-002: VAT/gross per price mode and tax rule; position = array order. */
export function computeLines(
  input: readonly LineInputArg[],
  priceMode: "net" | "gross",
  taxRule: VoucherDoc["taxRule"],
): VoucherLine[] {
  return input.map((l) => {
    const c = computeLine(
      {
        amountCents: l.amountCents,
        vatRateBp: l.vatRateBp,
        ...(l.vatCents !== undefined ? { vatCents: l.vatCents } : {}),
      },
      priceMode,
      taxRule,
    );
    return {
      account: l.account.trim(),
      ...(l.description?.trim() ? { description: l.description.trim() } : {}),
      ...(l.quantityMilli !== undefined ? { quantityMilli: l.quantityMilli } : {}),
      netCents: c.netCents,
      vatRateBp: l.vatRateBp,
      vatCents: c.vatCents,
      grossCents: c.grossCents,
      ...(c.selfAssessedVatCents !== undefined ? { selfAssessedVatCents: c.selfAssessedVatCents } : {}),
      ...(l.nonDeductibleShareBp !== undefined ? { nonDeductibleShareBp: l.nonDeductibleShareBp } : {}),
      ...(l.assetDecision ? { assetDecision: l.assetDecision } : {}),
      ...(l.costCenterId ? { costCenterId: l.costCenterId } : {}),
    };
  });
}

/** Stored lines → the editable input (amount in the voucher's price mode). */
export function lineInputOf(l: VoucherLineDoc, priceMode: "net" | "gross"): LineInputArg {
  return {
    account: l.account,
    ...(l.description ? { description: l.description } : {}),
    ...(l.quantityMilli !== undefined ? { quantityMilli: l.quantityMilli } : {}),
    amountCents: priceMode === "gross" ? l.grossCents : l.netCents,
    vatRateBp: l.vatRateBp,
    vatCents: l.vatCents,
    ...(l.nonDeductibleShareBp !== undefined ? { nonDeductibleShareBp: l.nonDeductibleShareBp } : {}),
    ...(l.assetDecision ? { assetDecision: l.assetDecision } : {}),
    ...(l.costCenterId ? { costCenterId: l.costCenterId } : {}),
  };
}

const totalsOf = (lines: readonly VoucherLine[]) => {
  const byRate = new Map<number, { rateBp: number; netCents: number; vatCents: number }>();
  let net = 0;
  let vat = 0;
  let sa = 0;
  for (const l of lines) {
    net += l.netCents;
    vat += l.vatCents;
    sa += l.selfAssessedVatCents ?? 0;
    const r = byRate.get(l.vatRateBp) ?? { rateBp: l.vatRateBp, netCents: 0, vatCents: 0 };
    r.netCents += l.netCents;
    r.vatCents += l.vatCents;
    byRate.set(l.vatRateBp, r);
  }
  return {
    netCents: net,
    vatCents: vat,
    grossCents: net + vat,
    selfAssessedVatCents: sa,
    byRate: [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp),
  };
};

async function replaceLines(ctx: ModelCtx, voucherId: Id<"vouchers">, lines: readonly VoucherLine[], action: string) {
  for (const old of await linesOf(ctx, voucherId)) {
    await auditedDelete(ctx, "voucherLines", old._id, { action });
  }
  for (const [i, l] of lines.entries()) {
    await auditedInsert(ctx, "voucherLines", { voucherId, position: i + 1, ...l }, { action });
  }
}

async function indexFileHashes(ctx: ModelCtx, voucherId: Id<"vouchers">, files: readonly OriginalFileValue[]) {
  const existing = await ctx.db
    .query("voucherFileHashes")
    .withIndex("by_voucher", (q) => q.eq("voucherId", voucherId))
    .collect();
  for (const [i, f] of files.entries()) {
    if (existing.some((e) => e.fileIndex === i)) continue;
    await auditedInsert(
      ctx,
      "voucherFileHashes",
      { sha256: f.sha256, voucherId, fileIndex: i },
      { action: "voucher.file_index" },
    );
  }
}

// ── drafts (VOU-001) ────────────────────────────────────────────────────────────────────────────────────

/** Header fields of the input mapped onto the stored shape (undefined = keep). */
function headerPatch(input: DraftInput): Partial<VoucherDoc> {
  const out: Record<string, unknown> = {};
  const keys = [
    "direction",
    "kind",
    "supplierContactId",
    "supplierName",
    "supplierVatId",
    "supplierTaxNumber",
    "supplierAddress",
    "supplierIban",
    "documentNumber",
    "documentDate",
    "supplyDate",
    "dueDate",
    "currency",
    "fxRateToEur",
    "priceMode",
    "taxRule",
    "statedTotals",
    "skontoTerms",
    "taxPayment",
    "creditNoteOfId",
    "recurringPayment",
    "costCenterId",
    "projectId",
    "internalNote",
  ] as const;
  for (const k of keys) {
    const value = input[k];
    if (value === undefined) continue;
    out[k] = typeof value === "string" ? value.trim() : value;
  }
  if (typeof out.currency === "string") out.currency = (out.currency as string).toUpperCase();
  if (typeof out.supplierVatId === "string") {
    out.supplierVatId = (out.supplierVatId as string).replace(/\s+/g, "").toUpperCase();
  }
  return out as Partial<VoucherDoc>;
}

export async function createVoucher(
  ctx: ModelCtx,
  args: {
    input: DraftInput;
    files?: OriginalFileValue[];
    recurringVoucherId?: Id<"recurringVouchers">;
    receivedAt?: number;
    /** Inbox drafts (F06 INB-028/029/043): link, E-Rechnung verdict, OCR output, payee, input-VAT risks. */
    extra?: Pick<Partial<VoucherDoc>, "inboxItemId" | "einvoice" | "ocr" | "payee" | "inputVatAtRisk" | "renditions">;
  },
): Promise<Id<"vouchers">> {
  const profile = await getCompanyProfile(ctx);
  const today = berlinCalendarDate(ctx.now());
  const direction = args.input.direction ?? "expense";
  const ku = kuOn(profile, args.input.documentDate ?? today);
  const taxRule =
    args.input.taxRule ?? (direction === "income" ? "not_taxable" : ku ? "no_input_vat" : "input_vat_deductible");
  const priceMode = args.input.priceMode ?? "gross";
  const lines = computeLines(args.input.lines ?? [], priceMode, taxRule);
  const header = headerPatch(args.input);
  const id = await auditedInsert(
    ctx,
    "vouchers",
    {
      ...header,
      direction,
      kind: args.input.kind ?? "standard",
      status: "draft",
      receivedAt: args.receivedAt ?? ctx.now(),
      currency: (args.input.currency ?? "EUR").toUpperCase(),
      priceMode,
      taxRule,
      totals: totalsOf(lines),
      openAmountCents: 0,
      originalFiles: args.files ?? [],
      renditions: [],
      duplicateDismissals: [],
      tags: [],
      journalEntryIds: [],
      ...(args.recurringVoucherId ? { recurringVoucherId: args.recurringVoucherId } : {}),
      ...(args.extra ?? {}),
      ...(args.input.bewirtung ? { bewirtung: { ...args.input.bewirtung, versions: [] } } : {}),
      ...(args.input.eigenbeleg ? { eigenbeleg: args.input.eigenbeleg } : {}),
      recordedAt: ctx.now(),
      retentionClass: "vouchers8",
      actor: ctx.actor,
      version: 1,
    },
    { action: "voucher.create", label: args.input.supplierName ?? args.input.documentNumber ?? "Beleg" },
  );
  for (const [i, l] of lines.entries()) {
    await auditedInsert(ctx, "voucherLines", { voucherId: id, position: i + 1, ...l }, { action: "voucher.create" });
  }
  if (args.files?.length) await indexFileHashes(ctx, id, args.files);
  return id;
}

/** Applies the editable input to a voucher (draft update and correction share it). */
async function applyInput(ctx: ModelCtx, v: VoucherDoc, input: DraftInput, action: string, reason?: string) {
  const priceMode = input.priceMode ?? v.priceMode;
  const taxRule = input.taxRule ?? v.taxRule;
  const lines = input.lines
    ? computeLines(input.lines, priceMode, taxRule)
    : computeLines(
        (await linesOf(ctx, v._id)).map((l) => lineInputOf(l, v.priceMode)),
        priceMode,
        taxRule,
      );
  const patch: Partial<VoucherDoc> = { ...headerPatch(input), totals: totalsOf(lines), version: v.version + 1 };
  if (input.bewirtung) {
    if (v.bewirtung?.approvedAt)
      throw appError("invalid_input", "Der Bewirtungsbeleg ist freigegeben. Bitte eine berichtigte Fassung freigeben.");
    patch.bewirtung = { ...input.bewirtung, versions: v.bewirtung?.versions ?? [] };
  }
  if (input.eigenbeleg) {
    if (v.eigenbeleg?.approvedAt) throw appError("invalid_input", VOUCHER_ERRORS.eigenbelegApproved);
    patch.eigenbeleg = input.eigenbeleg;
  }
  await auditedPatch(ctx, "vouchers", v._id, patch, { action, label: label(v), ...(reason ? { reason } : {}) });
  await replaceLines(ctx, v._id, lines, action);
}

function checkVersion(v: VoucherDoc, version: number | undefined) {
  if (version !== undefined && version !== v.version) {
    throw appError("conflict", VOUCHER_ERRORS.outdated, { reason: "VERSION_CONFLICT", version: v.version });
  }
}

export async function updateVoucherDraft(
  ctx: ModelCtx,
  args: { id: Id<"vouchers">; version?: number; input: DraftInput },
): Promise<{ version: number }> {
  const v = await requireVoucher(ctx, args.id);
  if (v.status !== "draft") throw appError("invalid_input", VOUCHER_ERRORS.notDraft, { reason: "NOT_DRAFT" });
  checkVersion(v, args.version);
  await applyInput(ctx, v, args.input, "voucher.update_draft");
  return { version: v.version + 1 };
}

/** VOU-007: drafts can be deleted; the deletion is audited with the content (03 §11). */
export async function deleteVoucherDraft(ctx: ModelCtx, id: Id<"vouchers">): Promise<void> {
  const v = await requireVoucher(ctx, id);
  if (v.status !== "draft") throw appError("invalid_input", VOUCHER_ERRORS.notDraft, { reason: "NOT_DRAFT" });
  for (const l of await linesOf(ctx, id))
    await auditedDelete(ctx, "voucherLines", l._id, { action: "voucher.delete_draft" });
  for (const h of await ctx.db
    .query("voucherFileHashes")
    .withIndex("by_voucher", (q) => q.eq("voucherId", id))
    .collect()) {
    await auditedDelete(ctx, "voucherFileHashes", h._id, { action: "voucher.delete_draft" });
  }
  await auditedDelete(ctx, "vouchers", id, { action: "voucher.delete_draft", label: label(v) });
  // VOU-007 / EC-VOU-36: the original files stay on the inbox item, which goes back to „Zu prüfen“.
  if (v.inboxItemId) await releaseInboxDraft(ctx, v.inboxItemId, id);
}

// ── files (VOU-120…122, GOBD-08) ────────────────────────────────────────────────────────────────────────

/** Adds an original or replaces one by versioning (`replacedBy` on the old entry; the old file stays). */
export async function addVoucherFile(
  ctx: ModelCtx,
  args: { id: Id<"vouchers">; file: OriginalFileValue; replaceIndex?: number; reason?: string },
): Promise<{ index: number }> {
  const v = await requireVoucher(ctx, args.id);
  if (v.status === "cancelled") throw appError("invalid_input", VOUCHER_ERRORS.cancelled);
  const reason = args.reason?.trim();
  let files: OriginalFileValue[];
  if (args.replaceIndex !== undefined) {
    const check = checkReplacement({
      files: v.originalFiles,
      index: args.replaceIndex,
      booked: v.status !== "draft",
      locked: isLocked(v),
      ...(reason ? { reason } : {}),
    });
    if (!check.ok) throw appError("invalid_input", check.error.message, { reason: check.error.code.toUpperCase() });
    files = replaceOriginal(v.originalFiles, args.replaceIndex, {
      ...args.file,
      ...(reason ? { replaceReason: reason } : {}),
    });
  } else {
    files = [...v.originalFiles, args.file];
  }
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    { originalFiles: files },
    {
      action: args.replaceIndex !== undefined ? "voucher.replace_file" : "voucher.add_file",
      label: label(v),
      ...(reason ? { reason } : {}),
    },
  );
  await indexFileHashes(ctx, v._id, files);
  return { index: files.length - 1 };
}

/** VOU-123 „Vollständig geprüft“ (once). */
export async function markCheckedComplete(ctx: ModelCtx, id: Id<"vouchers">): Promise<void> {
  const v = await requireVoucher(ctx, id);
  if (v.checkedComplete) return;
  await auditedPatch(
    ctx,
    "vouchers",
    id,
    { checkedComplete: { at: ctx.now(), actor: ctx.actor } },
    { action: "voucher.checked_complete", label: label(v) },
  );
}

// ── validation context ──────────────────────────────────────────────────────────────────────────────────

async function duplicateCandidates(ctx: ReadCtx, v: VoucherDoc, lines: readonly VoucherLine[]) {
  const date = v.documentDate ?? "";
  const around = new Map<string, VoucherDoc>();
  if (isCalendarDate(date)) {
    const from = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
    const to = `${Number(date.slice(0, 4)) + 1}${date.slice(4)}`;
    for (const o of await ctx.db
      .query("vouchers")
      .withIndex("by_documentDate", (q) => q.gte("documentDate", from).lte("documentDate", to))
      .collect()) {
      around.set(o._id, o);
    }
  }
  const hashes = activeOriginals(v.originalFiles).map((f) => f.sha256);
  for (const h of hashes) {
    for (const row of await ctx.db
      .query("voucherFileHashes")
      .withIndex("by_sha256", (q) => q.eq("sha256", h))
      .collect()) {
      const o = await ctx.db.get(row.voucherId);
      if (o) around.set(o._id, o);
    }
  }
  const toCandidate = (o: VoucherDoc, gross: number): DuplicateCandidate => ({
    id: o._id,
    ...(o.internalNumber || o.documentNumber ? { label: o.internalNumber ?? o.documentNumber } : {}),
    ...(o.supplierName ? { supplierName: o.supplierName } : {}),
    ...(o.supplierVatId ? { supplierVatId: o.supplierVatId } : {}),
    ...(o.supplierIban ? { supplierIban: o.supplierIban } : {}),
    ...(o.documentNumber ? { documentNumber: o.documentNumber } : {}),
    documentDate: o.documentDate ?? "",
    grossCents: gross,
    duplicateDismissals: o.duplicateDismissals,
    sha256s: activeOriginals(o.originalFiles).map((f) => f.sha256),
  });
  const self = toCandidate(
    v,
    lines.reduce((s, l) => s + l.grossCents, 0),
  );
  const others = [...around.values()]
    .filter((o) => o._id !== v._id && o.status !== "cancelled" && o.duplicateOfId !== v._id)
    .map((o) => toCandidate(o, o.totals.grossCents));
  return findDuplicates(self, others);
}

export interface VoucherContext {
  draft: VoucherDraft;
  vctx: ValidationContext;
  lines: VoucherLine[];
  profile: Doc<"companyProfile">;
  ku: boolean;
  corporation: boolean;
  today: CalendarDate;
  date: CalendarDate;
}

export async function voucherContext(
  ctx: ReadCtx,
  v: VoucherDoc,
  now: number,
  override?: { input?: DraftInput },
): Promise<VoucherContext> {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const today = berlinCalendarDate(now);
  const merged: VoucherDoc = override?.input ? ({ ...v, ...headerPatch(override.input) } as VoucherDoc) : v;
  const lines = override?.input?.lines
    ? computeLines(override.input.lines, merged.priceMode, merged.taxRule)
    : (await linesOf(ctx, v._id)).map(({ _id, _creationTime, voucherId: _v, position: _p, ...l }) => l as VoucherLine);
  const date = governingDate(merged, today);
  const ku = kuOn(profile, date);
  const corporation = isCorporation(profile.legalForm);
  const month = (merged.documentDate ?? "").slice(0, 7);
  const eigenbelege =
    merged.kind === "eigenbeleg" && month.length === 7
      ? (
          await ctx.db
            .query("vouchers")
            .withIndex("by_documentDate", (q) =>
              q.gte("documentDate", `${month}-01`).lte("documentDate", `${month}-31`),
            )
            .collect()
        ).filter((o) => o.kind === "eigenbeleg" && o.status !== "cancelled" && o._id !== v._id).length + 1
      : undefined;
  const bewirtung = merged.bewirtung;
  const draft: VoucherDraft = {
    direction: merged.direction,
    kind: merged.kind,
    taxRule: merged.taxRule,
    ...(merged.supplierName ? { supplierName: merged.supplierName } : {}),
    ...(merged.supplierContactId ? { supplierContactId: merged.supplierContactId } : {}),
    ...(merged.supplierVatId ? { supplierVatId: merged.supplierVatId } : {}),
    ...(merged.supplierTaxNumber ? { supplierTaxNumber: merged.supplierTaxNumber } : {}),
    supplierHasAddress: !!merged.supplierAddress?.trim() || !!merged.supplierContactId,
    ...(merged.documentNumber ? { documentNumber: merged.documentNumber } : {}),
    ...(merged.documentDate ? { documentDate: merged.documentDate } : {}),
    ...(merged.supplyDate ? { supplyDate: merged.supplyDate } : {}),
    currency: merged.currency,
    ...(merged.fxRateToEur ? { fxRateToEur: { rate: merged.fxRateToEur.rate } } : {}),
    lines,
    ...(merged.statedTotals ? { statedTotals: merged.statedTotals } : {}),
    originalFiles: merged.originalFiles,
    ...(bewirtung
      ? {
          bewirtung: {
            occasionType: bewirtung.occasionType,
            occasion: bewirtung.occasion,
            participants: bewirtung.participants,
            host: bewirtung.host,
            place: bewirtung.place,
            date: bewirtung.date,
            ...(bewirtung.tipCents !== undefined ? { tipCents: bewirtung.tipCents } : {}),
            tseConfirmed: bewirtung.tseConfirmed,
            ...(bewirtung.hostOnInvoiceConfirmed !== undefined
              ? { hostOnInvoiceConfirmed: bewirtung.hostOnInvoiceConfirmed }
              : {}),
            ...(bewirtung.approvedAt ? { approvedAt: bewirtung.approvedAt } : {}),
          },
        }
      : {}),
    ...(merged.eigenbeleg ? { eigenbeleg: merged.eigenbeleg } : {}),
    ...(merged.taxPayment ? { taxPayment: merged.taxPayment } : {}),
    ...(merged.creditNoteOfId ? { creditNoteOfId: merged.creditNoteOfId } : {}),
    ...(merged.recurringVoucherId
      ? { recurringReference: await hasReferenceFile(ctx, merged.recurringVoucherId) }
      : {}),
    // F07 BNK-052: a rule „Kontoauszug genügt als Beleg“ — the bank statement of the linked transaction is the Beleg.
    ...(merged.statementIsBeleg && merged.bankTransactionId ? { statementIsBeleg: true } : {}),
  };
  const vctx: ValidationContext = {
    today,
    companyIsKu: ku,
    ...(profile.vatId ? { ownVatId: profile.vatId } : {}),
    corporation,
    accounts: await accountContextAt(ctx, date),
    duplicates: await duplicateCandidates(ctx, merged, lines),
    ...(eigenbelege !== undefined ? { eigenbelegCountInMonth: eigenbelege } : {}),
    closedPeriods: await closedPeriods(ctx),
  };
  return { draft, vctx, lines, profile, ku, corporation, today, date };
}

async function hasReferenceFile(ctx: ReadCtx, id: Id<"recurringVouchers">): Promise<boolean> {
  const r = await ctx.db.get(id);
  return r?.referenceFile !== undefined;
}

// ── preview and booking (VOU-007, VOU-136…138) ──────────────────────────────────────────────────────────

export interface PaymentPlanResult {
  method: PaymentInputArg["method"];
  date: string;
  amountCents: number;
  warnings: PaymentWarning[];
  settles: boolean;
}

function paymentPlan(
  v: VoucherDoc,
  payment: PaymentInputArg | undefined,
  payableCents: number,
  c: Pick<VoucherContext, "today" | "corporation" | "vctx">,
): PaymentPlanResult {
  const method = payment?.method ?? "bank";
  const date = payment?.date ?? v.documentDate ?? c.today;
  const amountCents = payment?.amountCents ?? Math.abs(payableCents);
  const r = checkPaymentChoice({
    method,
    direction: v.direction,
    date,
    amountCents,
    openCents: payableCents,
    today: c.today,
    closedPeriods: c.vctx.closedPeriods ?? new Set(),
    ...(payment?.backdateReason ? { backdateReason: payment.backdateReason } : {}),
    corporation: c.corporation,
  });
  if (!r.ok) throw appError("invalid_input", r.error.message, { reason: r.error.code.toUpperCase() });
  return { method, date, amountCents, warnings: r.value.warnings, settles: r.value.settles };
}

function blockOnErrors(check: VoucherCheck) {
  if (check.errors.length === 0) return;
  throw appError("invalid_input", check.errors.map((e) => e.message).join(" "), {
    reason: (check.errors[0]?.code ?? "invalid").toUpperCase(),
    codes: check.errors.map((e) => e.code).join(","),
  });
}

function blockOnWarnings(
  warnings: readonly { code: string; message: string; acknowledge: boolean }[],
  acknowledged: readonly string[],
) {
  const missing = unacknowledgedWarnings({ warnings: [...warnings] }, acknowledged);
  if (missing.length === 0) return;
  throw appError("invalid_input", missing.map((w) => w.message).join(" "), {
    reason: "WARNINGS_UNACKNOWLEDGED",
    warnings: missing.map((w) => w.code).join(","),
  });
}

/** The posting event of a voucher from its EUR lines (journal amounts are EUR, MISC-08). */
export function bookedEvent(
  v: VoucherDoc,
  number: string,
  lines: readonly VoucherLine[],
  check: Pick<VoucherCheck, "eurLines" | "effectiveTaxRule">,
  c: { ku: boolean; date: string; vatImportAccount: string | null },
): VoucherBookedEvent {
  const postingLines: VoucherPostingLine[] = lines.map((l, i) => {
    const eur = check.eurLines[i];
    return {
      account: l.account,
      ...(c.vatImportAccount && l.account === c.vatImportAccount && v.direction === "expense"
        ? { role: "vat.import" }
        : {}),
      netCents: eur?.netEurCents ?? l.netCents,
      vatCents: eur?.vatEurCents ?? l.vatCents,
      vatRateBp: l.vatRateBp,
      ...(isSelfAssessment(check.effectiveTaxRule)
        ? { selfAssessedVatCents: eur?.selfAssessedVatEurCents ?? l.selfAssessedVatCents ?? 0 }
        : {}),
      ...(l.nonDeductibleShareBp !== undefined ? { nonDeductibleShareBp: l.nonDeductibleShareBp } : {}),
      ...(l.assetDecision ? { assetDecision: l.assetDecision } : {}),
    };
  });
  return {
    kind: "voucher_booked",
    voucherId: v._id,
    number,
    direction: v.direction,
    voucherKind: v.kind,
    taxRule: check.effectiveTaxRule,
    companyIsKu: c.ku,
    date: v.documentDate ?? c.date,
    supplyDate: v.supplyDate ?? { kind: "date", date: v.documentDate ?? c.date },
    receivedDate: berlinCalendarDate(v.receivedAt),
    ...(v.supplierContactId ? { contactId: v.supplierContactId } : {}),
    ...(v.supplierName ? { counterpartyName: v.supplierName } : {}),
    lines: postingLines,
    ...(v.bewirtung ? { bewirtungOccasion: v.bewirtung.occasionType } : {}),
    ...(v.taxPayment ? { taxPaymentSubtype: v.taxPayment.subtype } : {}),
    // ACC-023: the EUR posting keeps the source currency, gross amount and rate on the open item.
    ...(v.currency !== "EUR" && v.fxRateToEur
      ? {
          fx: {
            currency: v.currency,
            grossFxCents: lines.reduce((s, l) => s + l.netCents + l.vatCents, 0),
            fxRate: {
              rate: v.fxRateToEur.rate,
              source: v.fxRateToEur.source,
              ...(v.fxRateToEur.sourceText ? { sourceText: v.fxRateToEur.sourceText } : {}),
              date: v.fxRateToEur.date,
            },
          },
        }
      : {}),
  };
}

/**
 * F06 inbox findings that travel with the draft (EC-INB-08 addressee, EC-INB-10/11 E-Rechnung, EC-INB-31 sender not
 * verified, …): ⚑ items must be acknowledged at booking like the voucher's own warnings; E-Rechnung findings mark the
 * input VAT at risk (F06 Q-02: booking is never blocked).
 */
async function inboxWarningsFor(ctx: ReadCtx, v: VoucherDoc) {
  if (!v.inboxItemId) return [];
  const item = await ctx.db.get(v.inboxItemId);
  return (item?.warnings ?? []).map((w) => ({ code: w.code, message: w.message, acknowledge: w.acknowledge === true }));
}

const INPUT_VAT_RISK_CODES = new Set([
  "einvoice_wrong_addressee",
  "einvoice_required_from_supplier",
  "einvoice_faulty",
]);

function withInboxWarnings(
  check: ReturnType<typeof validateVoucher>,
  extra: readonly { code: string; message: string; acknowledge: boolean }[],
): ReturnType<typeof validateVoucher> {
  if (extra.length === 0) return check;
  const known = new Set(check.warnings.map((w) => w.code));
  const risks = extra.filter((w) => INPUT_VAT_RISK_CODES.has(w.code)).map((w) => w.code);
  return {
    ...check,
    warnings: [...check.warnings, ...extra.filter((w) => !known.has(w.code))],
    inputVatAtRisk: [...check.inputVatAtRisk, ...risks.filter((r) => !check.inputVatAtRisk.includes(r))],
  };
}

export interface VoucherPreview {
  check: VoucherCheck;
  payment: PaymentPlanResult;
  event: VoucherBookedEvent;
  context: VoucherContext;
}

/** Validation + payment plan + posting event without writing (UI dialog, REST/MCP preview). */
export async function previewVoucher(
  ctx: ReadCtx,
  args: { id: Id<"vouchers">; payment?: PaymentInputArg; input?: DraftInput },
  now: number,
): Promise<VoucherPreview> {
  const v = await requireVoucher(ctx, args.id);
  const c = await voucherContext(ctx, v, now, args.input ? { input: args.input } : undefined);
  const check = withInboxWarnings(validateVoucher(c.draft, c.vctx), await inboxWarningsFor(ctx, v));
  const payable = check.totalsEur.grossCents;
  const merged = args.input ? ({ ...v, ...headerPatch(args.input) } as VoucherDoc) : v;
  const payment = paymentPlan(merged, args.payment, payable, c);
  const event = bookedEvent(
    { ...merged, taxRule: check.effectiveTaxRule },
    v.internalNumber ?? "(neu)",
    c.lines,
    check,
    {
      ku: c.ku,
      date: c.today,
      vatImportAccount: c.vctx.accounts.roleAccounts["vat.import"] ?? null,
    },
  );
  return { check, payment, event, context: c };
}

async function learnSupplier(
  ctx: ModelCtx,
  v: VoucherDoc,
  lines: readonly VoucherLine[],
  taxRule: string,
  mode: "learn" | "correct",
) {
  const key = supplierKey({
    ...(v.supplierVatId ? { vatId: v.supplierVatId } : {}),
    ...(v.supplierIban ? { iban: v.supplierIban } : {}),
    ...(v.supplierName ? { name: v.supplierName } : {}),
  });
  const first = lines[0];
  if (!key || !first) return;
  const row = await ctx.db
    .query("supplierProfiles")
    .withIndex("by_key", (q) => q.eq("key", key))
    .first();
  const before: SupplierProfileData | null = row
    ? {
        ...(row.lastAccount ? { lastAccount: row.lastAccount } : {}),
        ...(row.lastTaxRule ? { lastTaxRule: row.lastTaxRule } : {}),
        ...(row.lastCostCenterId ? { lastCostCenterId: row.lastCostCenterId } : {}),
        uses: row.uses,
        accountStreak: row.accountStreak,
      }
    : null;
  const choice = {
    account: first.account,
    taxRule,
    ...(first.costCenterId ? { costCenterId: first.costCenterId } : {}),
  };
  const next = mode === "learn" || !before ? learnProfile(before, choice) : correctProfile(before, choice);
  const value = {
    ...(next.lastAccount ? { lastAccount: next.lastAccount } : {}),
    ...(next.lastTaxRule ? { lastTaxRule: next.lastTaxRule } : {}),
    ...(next.lastCostCenterId ? { lastCostCenterId: next.lastCostCenterId } : {}),
    uses: next.uses,
    accountStreak: next.accountStreak ?? 1,
    updatedAt: ctx.now(),
  };
  if (row) {
    await auditedPatch(ctx, "supplierProfiles", row._id, value, { action: "voucher.profile_learn", label: key });
  } else {
    await auditedInsert(
      ctx,
      "supplierProfiles",
      { key, ...(v.supplierContactId ? { contactId: v.supplierContactId } : {}), ...value },
      { action: "voucher.profile_learn", label: key },
    );
  }
}

export interface FinalizeArgs {
  id: Id<"vouchers">;
  version?: number;
  acknowledgeWarnings?: string[];
  payment?: PaymentInputArg;
}

export interface FinalizeResult {
  id: Id<"vouchers">;
  number: string;
  status: VoucherDoc["status"];
  warnings: { code: string; message: string }[];
  infos: { code: string; message: string }[];
  paymentId?: Id<"payments">;
}

/**
 * VOU-007 „Buchen“: validate, gapless `BE-…` number, journal entry (posting date = voucher date; a locked period
 * moves it to the first open period, EC-VOU-09/EC-162), supplier profile, and the payment choice (VOU-136…138) — all
 * in this one transaction, so a failed cash check (CSH-026) books nothing.
 */
export async function finalizeVoucher(ctx: ModelCtx, args: FinalizeArgs): Promise<FinalizeResult> {
  const v = await requireVoucher(ctx, args.id);
  if (v.status !== "draft")
    throw appError("invalid_input", "Der Beleg ist bereits gebucht.", { reason: "ALREADY_BOOKED" });
  checkVersion(v, args.version);
  const p = await previewVoucher(ctx, { id: v._id, ...(args.payment ? { payment: args.payment } : {}) }, ctx.now());
  const { check, payment, context: c } = p;
  blockOnErrors(check);
  blockOnWarnings([...check.warnings, ...payment.warnings], args.acknowledgeWarnings ?? []);
  const today = berlinCalendarDate(ctx.now());
  const { number } = await assignCounterNumber(ctx, {
    docType: "voucherInternal",
    date: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
    documentId: v._id,
    action: "voucher.finalize",
  });
  const effective = check.effectiveTaxRule;
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    {
      status: payment.method === "card_pending" ? "scheduled" : "open",
      internalNumber: number,
      bookedAt: ctx.now(),
      taxRule: effective,
      totals: check.totals,
      totalsEur: check.totalsEur,
      openAmountCents: check.totalsEur.grossCents,
      ...(v.supplyDate ? {} : v.documentDate ? { supplyDate: { kind: "date" as const, date: v.documentDate } } : {}),
      ...(check.inputVatAtRisk.length > 0 ? { inputVatAtRisk: check.inputVatAtRisk } : {}),
      ...(args.acknowledgeWarnings?.length ? { acknowledgedWarnings: args.acknowledgeWarnings } : {}),
    },
    { action: "voucher.finalize", label: number },
  );
  if (v.currency !== "EUR") {
    const stored = await linesOf(ctx, v._id);
    for (const [i, l] of stored.entries()) {
      const eur = check.eurLines[i];
      if (!eur) continue;
      await auditedPatch(
        ctx,
        "voucherLines",
        l._id,
        { netEurCents: eur.netEurCents, vatEurCents: eur.vatEurCents },
        { action: "voucher.finalize" },
      );
    }
  }
  const booked = await requireVoucher(ctx, v._id);
  const posted = await postJournalEntry(
    ctx,
    bookedEvent(booked, number, c.lines, check, {
      ku: c.ku,
      date: today,
      vatImportAccount: c.vctx.accounts.roleAccounts["vat.import"] ?? null,
    }),
  );
  if (posted.status === "posted") {
    await auditedPatch(
      ctx,
      "vouchers",
      v._id,
      { journalEntryIds: posted.entryIds },
      { action: "voucher.finalize", label: number },
    );
  }
  // F08 AST-002: asset records for the lines with an „Anlagegut?“ decision, in the booking transaction.
  await createAssetsForVoucher(ctx, {
    voucher: booked,
    number,
    eurLines: check.eurLines,
    ku: c.ku,
    accounts: {
      gwg: c.vctx.accounts.roleAccounts["asset.gwg"] ?? null,
      pool: c.vctx.accounts.roleAccounts["asset.pool"] ?? null,
    },
  });
  await learnSupplier(ctx, booked, c.lines, effective, "learn");
  let paymentId: Id<"payments"> | undefined;
  if (payment.settles) {
    const r = await recordVoucherPayment(ctx, {
      voucherId: v._id,
      method: payment.method as "cash" | "private",
      date: payment.date,
      amountCents: payment.amountCents,
      ...(args.payment?.backdateReason ? { backdateReason: args.payment.backdateReason } : {}),
      ...(args.payment?.note ? { note: args.payment.note } : {}),
      acknowledgeWarnings: args.acknowledgeWarnings ?? [],
    });
    paymentId = r.paymentId;
  }
  if (v.inboxItemId) await markInboxConverted(ctx, v.inboxItemId, v._id);
  const infos = check.infos.map((i) => ({ code: i.code, message: i.message }));
  // F07 BNK-065/052: a voucher created from a bank transaction is allocated to it on finalisation.
  if (!paymentId && v.bankTransactionId) {
    const allocated = await allocateFromTransaction(ctx, v._id, v.bankTransactionId);
    if (allocated.paymentId) paymentId = allocated.paymentId;
    else if (allocated.info) infos.push(allocated.info);
  }
  const after = await requireVoucher(ctx, v._id);
  return {
    id: v._id,
    number,
    status: after.status,
    warnings: [...check.warnings, ...payment.warnings].map((w) => ({ code: w.code, message: w.message })),
    infos,
    ...(paymentId ? { paymentId } : {}),
  };
}

/**
 * BNK-065: allocates the booked voucher to the bank transaction it was created from (F06 bank payment, VOU-131).
 * Skipped with an info when the transaction is no longer open or is in a foreign currency (FX posting deferred, §4.10).
 */
async function allocateFromTransaction(
  ctx: ModelCtx,
  voucherId: Id<"vouchers">,
  transactionId: Id<"bankTransactions">,
): Promise<{ paymentId?: Id<"payments">; info?: { code: string; message: string } }> {
  const tx = await ctx.db.get(transactionId);
  const free = tx ? Math.abs(tx.amountCents) - tx.allocatedCents : 0;
  if (!tx || free <= 0 || (tx.status !== "open" && tx.status !== "partially_matched")) {
    return {
      info: {
        code: "bank_allocation_skipped",
        message: "Der Bankumsatz ist bereits zugeordnet – bitte die Zahlung prüfen.",
      },
    };
  }
  if (tx.currency !== "EUR") {
    return {
      info: {
        code: "bank_allocation_skipped",
        message: "Fremdwährungsumsätze werden noch nicht zugeordnet – bitte die Zahlung später zuordnen.",
      },
    };
  }
  const r = await recordVoucherPayment(ctx, { voucherId, method: "bank", transactionId });
  return { paymentId: r.paymentId };
}

// ── correction and cancellation (VOU-008/009) ───────────────────────────────────────────────────────────

async function activeBookingEntries(ctx: ReadCtx, v: VoucherDoc) {
  const entries = await ctx.db
    .query("journalEntries")
    .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", v._id))
    .collect();
  const reversed = new Set(entries.flatMap((e) => (e.reversalOfId ? [e.reversalOfId as string] : [])));
  return entries.filter((e) => e.reversalOfId === undefined && !reversed.has(e._id));
}

async function assertUnlocked(ctx: ReadCtx, v: VoucherDoc) {
  if (v.status === "cancelled") throw appError("invalid_input", VOUCHER_ERRORS.cancelled);
  if (isLocked(v)) throw appError("immutable_record", VOUCHER_ERRORS.locked, { reason: "VOUCHER_LOCKED" });
  const closed = await closedPeriods(ctx);
  for (const e of await activeBookingEntries(ctx, v)) {
    if (closed.has(e.period)) throw appError("period_locked", VOUCHER_ERRORS.locked, { reason: "PERIOD_LOCKED" });
  }
}

const activePayments = async (ctx: ReadCtx, id: Id<"vouchers">) =>
  (
    await ctx.db
      .query("payments")
      .withIndex("by_target", (q) => q.eq("target.kind", "voucher").eq("target.id", id))
      .collect()
  ).filter((p) => !p.reversedById && !p.reversalOfId);

/**
 * VOU-008 „Beleg korrigieren“: a booked, unlocked voucher is edited; the booking is reversed (Generalumkehr on the
 * original date with the original tax points) and posted again; `version + 1`; the audit keeps before/after and the
 * reason. Payments stay; the status is re-derived (a correction below the paid amount is refused).
 */
export async function correctVoucher(
  ctx: ModelCtx,
  args: { id: Id<"vouchers">; version?: number; input: DraftInput; reason: string; acknowledgeWarnings?: string[] },
): Promise<{ version: number; warnings: { code: string; message: string }[] }> {
  const v = await requireVoucher(ctx, args.id);
  if (v.status === "draft") throw appError("invalid_input", VOUCHER_ERRORS.notBooked);
  checkVersion(v, args.version);
  await assertUnlocked(ctx, v);
  const reason = args.reason.trim();
  if (reason.length < REASON_MIN) throw appError("invalid_input", VOUCHER_ERRORS.reason);
  const p = await previewVoucher(ctx, { id: v._id, input: args.input }, ctx.now());
  blockOnErrors(p.check);
  // Duplicate findings of the booked voucher itself were decided at booking.
  const warnings = p.check.warnings.filter((w) => !w.code.startsWith("duplicate_"));
  blockOnWarnings(warnings, [...(args.acknowledgeWarnings ?? []), ...(v.acknowledgedWarnings ?? [])]);
  await assertVoucherAssetsReversible(ctx, v._id);
  const entries = await activeBookingEntries(ctx, v);
  const originalDate = entries.map((e) => e.date).sort()[0] ?? v.documentDate ?? berlinCalendarDate(ctx.now());
  const number = v.internalNumber as string;
  const rev = await postJournalEntry(
    ctx,
    { kind: "voucher_reversed", voucherId: v._id, number, date: originalDate, reason, mode: "correction" },
    { dating: "user" },
  );
  await applyInput(ctx, v, args.input, "voucher.correct", reason);
  const effective = p.check.effectiveTaxRule;
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    {
      taxRule: effective,
      totals: p.check.totals,
      totalsEur: p.check.totalsEur,
      inputVatAtRisk: p.check.inputVatAtRisk,
      ...(args.acknowledgeWarnings?.length
        ? { acknowledgedWarnings: [...new Set([...(v.acknowledgedWarnings ?? []), ...args.acknowledgeWarnings])] }
        : {}),
    },
    { action: "voucher.correct", label: number, reason },
  );
  const corrected = await requireVoucher(ctx, v._id);
  const posted = await postJournalEntry(
    ctx,
    bookedEvent(corrected, number, p.context.lines, p.check, {
      ku: p.context.ku,
      date: berlinCalendarDate(ctx.now()),
      vatImportAccount: p.context.vctx.accounts.roleAccounts["vat.import"] ?? null,
    }),
  );
  const ids = [
    ...(rev.status === "posted" ? rev.entryIds : []),
    ...(posted.status === "posted" ? posted.entryIds : []),
  ];
  if (ids.length > 0) {
    await auditedPatch(
      ctx,
      "vouchers",
      v._id,
      { journalEntryIds: [...corrected.journalEntryIds, ...ids] },
      { action: "voucher.correct", label: number },
    );
  }
  await voidVoucherAssets(ctx, v._id, reason);
  await createAssetsForVoucher(ctx, {
    voucher: corrected,
    number,
    eurLines: p.check.eurLines,
    ku: p.context.ku,
    accounts: {
      gwg: p.context.vctx.accounts.roleAccounts["asset.gwg"] ?? null,
      pool: p.context.vctx.accounts.roleAccounts["asset.pool"] ?? null,
    },
  });
  if (p.context.lines.length > 0) await learnSupplier(ctx, corrected, p.context.lines, effective, "correct");
  // The payable may have changed: re-derive the status from the payments (refused if overpaid).
  await refreshVoucher(ctx, v._id, "voucher.correct");
  return { version: corrected.version, warnings: warnings.map((w) => ({ code: w.code, message: w.message })) };
}

/** VOU-009 „Stornieren“: reversal dated today (first open period), status `cancelled`. Payments must be reversed first. */
export async function cancelVoucher(ctx: ModelCtx, args: { id: Id<"vouchers">; reason: string }): Promise<void> {
  const v = await requireVoucher(ctx, args.id);
  if (v.status === "draft") throw appError("invalid_input", VOUCHER_ERRORS.notBooked);
  if (v.status === "cancelled") throw appError("already_reversed", VOUCHER_ERRORS.cancelled);
  const reason = args.reason.trim();
  if (reason.length < REASON_MIN) throw appError("invalid_input", VOUCHER_ERRORS.reason);
  if ((await activePayments(ctx, v._id)).length > 0) {
    throw appError("invalid_input", VOUCHER_ERRORS.activePayments, { reason: "ACTIVE_PAYMENTS" });
  }
  await assertVoucherAssetsReversible(ctx, v._id);
  await voidVoucherAssets(ctx, v._id, reason);
  const today = berlinCalendarDate(ctx.now());
  const number = v.internalNumber ?? "";
  const rev = await postJournalEntry(ctx, {
    kind: "voucher_reversed",
    voucherId: v._id,
    number,
    date: today,
    reason,
    mode: "cancel",
  });
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    {
      status: "cancelled",
      openAmountCents: 0,
      cancelledAt: ctx.now(),
      cancelReason: reason,
      ...(rev.status === "posted" ? { journalEntryIds: [...v.journalEntryIds, ...rev.entryIds] } : {}),
    },
    { action: "voucher.cancel", label: number, reason },
  );
}

/** VOU-009 „Duplizieren“: a new draft with the same header, lines and original files (e.g. after a Storno). */
export async function duplicateVoucher(ctx: ModelCtx, id: Id<"vouchers">): Promise<Id<"vouchers">> {
  const v = await requireVoucher(ctx, id);
  const lines = await linesOf(ctx, id);
  const input: DraftInput = {
    direction: v.direction,
    kind: v.kind,
    ...(v.supplierContactId ? { supplierContactId: v.supplierContactId } : {}),
    ...(v.supplierName ? { supplierName: v.supplierName } : {}),
    ...(v.supplierVatId ? { supplierVatId: v.supplierVatId } : {}),
    ...(v.supplierTaxNumber ? { supplierTaxNumber: v.supplierTaxNumber } : {}),
    ...(v.supplierAddress ? { supplierAddress: v.supplierAddress } : {}),
    ...(v.supplierIban ? { supplierIban: v.supplierIban } : {}),
    ...(v.documentNumber ? { documentNumber: v.documentNumber } : {}),
    ...(v.documentDate ? { documentDate: v.documentDate } : {}),
    ...(v.supplyDate ? { supplyDate: v.supplyDate } : {}),
    ...(v.dueDate ? { dueDate: v.dueDate } : {}),
    currency: v.currency,
    ...(v.fxRateToEur ? { fxRateToEur: v.fxRateToEur } : {}),
    priceMode: v.priceMode,
    taxRule: v.taxRule,
    lines: lines.map((l) => lineInputOf(l, v.priceMode)),
    ...(v.internalNote ? { internalNote: v.internalNote } : {}),
  };
  const copy = await createVoucher(ctx, {
    input,
    files: activeOriginals(v.originalFiles).map(({ replacedBy: _r, replaceReason: _x, ...f }) => f),
  });
  // The copy of a cancelled voucher shares its files: not a duplicate of it (VOU-053).
  await auditedPatch(
    ctx,
    "vouchers",
    copy,
    { duplicateDismissals: [v._id] },
    { action: "voucher.duplicate", label: label(v) },
  );
  return copy;
}

// ── duplicates (VOU-052/053) ────────────────────────────────────────────────────────────────────────────

export async function dismissDuplicate(ctx: ModelCtx, args: { id: Id<"vouchers">; otherId: Id<"vouchers"> }) {
  const v = await requireVoucher(ctx, args.id);
  await requireVoucher(ctx, args.otherId);
  if (v.duplicateDismissals.includes(args.otherId)) return;
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    { duplicateDismissals: [...v.duplicateDismissals, args.otherId] },
    { action: "voucher.duplicate_dismiss", label: label(v) },
  );
}

// ── Bewirtung and Eigenbeleg approval (VOU-060…063) ─────────────────────────────────────────────────────

function requireHuman(ctx: ModelCtx) {
  if (!ctx.actor.startsWith("user:")) {
    throw appError("forbidden_role", VOUCHER_ERRORS.humanApproval, { reason: "HUMAN_APPROVAL_REQUIRED" });
  }
}

/** Shared by the action (before rendering) and the mutation. Returns the gross in EUR used for the 250 € rule. */
export async function checkBewirtungFor(
  ctx: ReadCtx,
  args: { id: Id<"vouchers">; data: BewirtungInput; reason?: string; acknowledgeWarnings?: string[] },
) {
  const v = await requireVoucher(ctx, args.id);
  if (v.kind !== "bewirtung") throw appError("invalid_input", VOUCHER_ERRORS.kind("Bewirtung"));
  if (v.status === "cancelled") throw appError("invalid_input", VOUCHER_ERRORS.cancelled);
  if (isLocked(v)) throw appError("immutable_record", VOUCHER_ERRORS.locked);
  if (v.bewirtung?.approvedAt && (args.reason?.trim().length ?? 0) < REASON_MIN) {
    throw appError("invalid_input", VOUCHER_ERRORS.bewirtungReason, { reason: "REASON_REQUIRED" });
  }
  const gross = v.totalsEur?.grossCents ?? v.totals.grossCents;
  const date = (
    v.documentDate && isCalendarDate(v.documentDate) ? v.documentDate : berlinCalendarDate(Date.now())
  ) as CalendarDate;
  const r = checkBewirtungApproval(args.data, gross, date);
  if (r.errors.length > 0) {
    throw appError("invalid_input", r.errors.map((e) => e.message).join(" "), {
      reason: (r.errors[0]?.code ?? "invalid").toUpperCase(),
    });
  }
  blockOnWarnings(
    r.warnings.map((w) => ({ code: w.code, message: w.message, acknowledge: true })),
    args.acknowledgeWarnings ?? [],
  );
  const profile = await getCompanyProfile(ctx);
  return {
    voucher: v,
    gross,
    version: (v.bewirtung?.versions.length ?? 0) + (v.bewirtung?.approvedAt ? 2 : 1),
    company: { name: profile?.name ?? "" },
  };
}

/** VOU-062: approval freezes the data; a later approval supersedes the earlier version (kept in `versions`). */
export async function approveBewirtung(
  ctx: ModelCtx,
  args: {
    id: Id<"vouchers">;
    data: BewirtungInput;
    file: FileRefValue;
    reason?: string;
    acknowledgeWarnings?: string[];
  },
): Promise<void> {
  requireHuman(ctx);
  const { voucher: v } = await checkBewirtungFor(ctx, args);
  const prev = v.bewirtung;
  const versions =
    prev?.approvedAt && prev.eigenbelegFile
      ? [
          ...prev.versions,
          {
            data: {
              occasionType: prev.occasionType,
              occasion: prev.occasion,
              participants: prev.participants,
              host: prev.host,
              place: prev.place,
              date: prev.date,
              ...(prev.tipCents !== undefined ? { tipCents: prev.tipCents } : {}),
              tseConfirmed: prev.tseConfirmed,
              ...(prev.hostOnInvoiceConfirmed !== undefined
                ? { hostOnInvoiceConfirmed: prev.hostOnInvoiceConfirmed }
                : {}),
            },
            eigenbelegFile: prev.eigenbelegFile,
            approvedAt: prev.approvedAt,
            supersededAt: ctx.now(),
            reason: args.reason?.trim() ?? "",
          },
        ]
      : (prev?.versions ?? []);
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    {
      bewirtung: { ...args.data, approvedAt: ctx.now(), approvedBy: ctx.actor, eigenbelegFile: args.file, versions },
      version: v.version + 1,
    },
    {
      action: "voucher.bewirtung_approve",
      label: label(v),
      ...(args.reason?.trim() ? { reason: args.reason.trim() } : {}),
    },
  );
}

export async function checkEigenbelegFor(ctx: ReadCtx, args: { id: Id<"vouchers">; data: EigenbelegInputArg }) {
  const v = await requireVoucher(ctx, args.id);
  if (v.kind !== "eigenbeleg") throw appError("invalid_input", VOUCHER_ERRORS.kind("Eigenbeleg"));
  if (v.status !== "draft") throw appError("invalid_input", VOUCHER_ERRORS.notDraft, { reason: "NOT_DRAFT" });
  if (v.eigenbeleg?.approvedAt)
    throw appError("invalid_input", VOUCHER_ERRORS.eigenbelegApproved, { reason: "ALREADY_APPROVED" });
  const issueFound = checkEigenbelegApproval(args.data);
  if (issueFound) throw appError("invalid_input", issueFound.message, { reason: issueFound.code.toUpperCase() });
  if (!v.documentDate || !isCalendarDate(v.documentDate)) {
    throw appError("invalid_input", "Bitte zuerst das Datum der Ausgabe angeben.");
  }
  const profile = await getCompanyProfile(ctx);
  return { voucher: v, gross: v.totals.grossCents, company: { name: profile?.name ?? "" } };
}

/** VOU-063: the approved Eigenbeleg (PDF + SHA-256) is the Beleg; it is immutable from then on (EC-EIG-04). */
export async function approveEigenbeleg(
  ctx: ModelCtx,
  args: { id: Id<"vouchers">; data: EigenbelegInputArg; file: FileRefValue },
): Promise<void> {
  requireHuman(ctx);
  const { voucher: v } = await checkEigenbelegFor(ctx, args);
  await auditedPatch(
    ctx,
    "vouchers",
    v._id,
    {
      eigenbeleg: { ...args.data, approvedAt: ctx.now(), approvedBy: ctx.actor, file: args.file },
      taxRule: "no_input_vat",
      version: v.version + 1,
    },
    { action: "voucher.eigenbeleg_approve", label: label(v) },
  );
}

/** Input-VAT deduction of a booked voucher (Skonto VAT correction, VOU-132). */
export function voucherDeductsInputVat(v: Pick<VoucherDoc, "taxRule">, ku: boolean): boolean {
  return deductsInputVat(effectiveTaxRule(v.taxRule, ku).rule, ku);
}
