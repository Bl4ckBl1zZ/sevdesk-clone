import { type AssetDepreciationEvent, assetDisposalSourceId } from "../../src/domain/accounting/events";
import {
  chartAt,
  endOfMonth,
  fiscalYearEnd,
  fiscalYearOf,
  fiscalYearStart,
  supplyEnd,
} from "../../src/domain/accounting/period";
import { voucherInputVatDeducted, voucherLineBaseCents } from "../../src/domain/accounting/post-vouchers";
import { type DisposalKind, POOL_DISPOSAL_INFO, planDisposal } from "../../src/domain/assets/disposal";
import { assetDraftsFromVoucher } from "../../src/domain/assets/from-voucher";
import {
  ASSET_MESSAGES,
  type AssetMethod,
  afaRoleFor,
  allowedMethods,
  assetClassOf,
  type MethodOption,
  validateAssetSetup,
  type YearChoice,
} from "../../src/domain/assets/methods";
import { anlagenspiegel, gwgList, type Movement, poolSummary } from "../../src/domain/assets/report";
import { afaForecast, depreciationPlan, type PlanRow } from "../../src/domain/assets/schedule";
import { roundHalfAway } from "../../src/domain/money";
import { seedRange } from "../../src/domain/numbering/format";
import { lookupAssetThresholds } from "../../src/domain/rules/thresholds";
import { lookupVatRate } from "../../src/domain/rules/vat-rates";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { calendarDate, isCalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { type CompanyProfile, getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import { postJournalEntry } from "./journal";
import { assignCounterNumber, listDefaultRanges, saveRanges } from "./numberRanges";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Asset register and depreciation (F08 AST-001…AST-012, AO-03). Assets are created from booked voucher lines with an
 * „Anlagegut?“ decision (AST-002, in the booking transaction) or manually (e.g. assets acquired before the
 * Buchungsbeginn). The plan is derived from the stored method parameters (src/domain/assets); the monthly run posts
 * one entry per (asset, month) with the journal source `asset_depreciation:<assetId>:<YYYY-MM>` — the idempotency
 * key (AST-009, TST-AST-09). Disposals post the catch-up AfA and the RBW entry (AST-010).
 */

type Asset = Doc<"assets">;

const fyStartOf = (p: CompanyProfile) => p.fiscalYearStartMonth ?? 1;
const mmYyyy = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

async function profileOrThrow(ctx: ReadCtx): Promise<CompanyProfile> {
  const p = await getCompanyProfile(ctx);
  if (!p) throw appError("setup_incomplete");
  return p;
}

function kuAt(profile: CompanyProfile, date: string): boolean {
  const row = [...profile.kleinunternehmer]
    .filter((k) => k.validFrom <= date)
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    .at(-1);
  return row?.isKU ?? false;
}

export async function requireAsset(ctx: ReadCtx, id: Id<"assets">): Promise<Asset> {
  const a = await ctx.db.get(id);
  if (!a) throw appError("not_found", "Die Anlage existiert nicht.");
  return a;
}

// ── plan and posted AfA ─────────────────────────────────────────────────────────────────────────────────

/** Planned AfA rows (disposed non-pool assets: through the disposal month; incomplete/voided: none). */
export function planOf(asset: Asset, fyStart: number): PlanRow[] {
  if (asset.voidedAt !== undefined || asset.setupRequired) return [];
  const r = depreciationPlan({
    acquisitionDate: asset.acquisitionDate,
    costCents: asset.costCents,
    method: asset.method,
    ...(asset.usefulLifeMonths !== undefined ? { usefulLifeMonths: asset.usefulLifeMonths } : {}),
    ...(asset.degressiveRateBp !== undefined ? { degressiveRateBp: asset.degressiveRateBp } : {}),
    ...(asset.evScheduleBp ? { evScheduleBp: asset.evScheduleBp } : {}),
    erinnerungswert: asset.erinnerungswert,
    fiscalYearStartMonth: fyStart,
  });
  if (!r.ok) return [];
  const disposal = asset.disposal;
  if (disposal && asset.method !== "pool") return r.value.filter((x) => x.period <= disposal.date.slice(0, 7));
  return r.value;
}

/** All journal entries of the asset (AfA per month and the disposal entry). */
async function entriesOfAsset(ctx: ReadCtx, assetId: Id<"assets">): Promise<Doc<"journalEntries">[]> {
  return ctx.db
    .query("journalEntries")
    .withIndex("by_source", (q) =>
      q.eq("source.kind", "asset_depreciation").gte("source.id", `${assetId}:`).lt("source.id", `${assetId};`),
    )
    .collect();
}

interface PostedAfa {
  period: string;
  entry: Doc<"journalEntries">;
  amountCents: number;
}

function creditOn(entry: Doc<"journalEntries">, account: string): number {
  return entry.lines.filter((l) => l.account === account).reduce((s, l) => s + l.creditCents - l.debitCents, 0);
}

async function postedOf(ctx: ReadCtx, asset: Asset): Promise<{ afa: PostedAfa[]; disposal?: Doc<"journalEntries"> }> {
  const entries = await entriesOfAsset(ctx, asset._id);
  const reversed = new Set(entries.flatMap((e) => (e.reversalOfId ? [e.reversalOfId as string] : [])));
  const active = entries.filter((e) => !e.reversalOfId && !reversed.has(e._id));
  const disposalId = assetDisposalSourceId(asset._id);
  return {
    afa: active
      .filter((e) => e.source.id !== disposalId)
      .map((e) => ({
        period: e.source.id.slice(e.source.id.indexOf(":") + 1),
        entry: e,
        amountCents: creditOn(e, asset.account),
      })),
    ...(active.find((e) => e.source.id === disposalId)
      ? { disposal: active.find((e) => e.source.id === disposalId) }
      : {}),
  };
}

// ── creation and setup ──────────────────────────────────────────────────────────────────────────────────

/** SET-064: assets get an inventory number from the `asset` range (seeded on first use if setup skipped it). */
async function ensureAssetRange(ctx: ModelCtx): Promise<void> {
  if ((await listDefaultRanges(ctx)).some((r) => r.docTypes.includes("asset"))) return;
  const seed = seedRange("asset");
  if (!seed) return;
  const today = berlinCalendarDate(ctx.now());
  await saveRanges(
    ctx,
    {
      ranges: [
        { key: seed.key, name: seed.name, format: seed.format, resetPolicy: seed.resetPolicy, next: seed.startValue },
      ],
    },
    { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
  );
}

export interface AssetSetupInput {
  name: string;
  account: string;
  acquisitionDate: string;
  costCents: number;
  method: AssetMethod;
  usefulLifeMonths?: number;
  usefulLifeKey?: string;
  evQualified?: boolean;
  erinnerungswert?: boolean;
  inputVatDeducted: boolean;
  costCenterId?: Id<"costCenters">;
  notes?: string;
}

interface Checked {
  assetClass: Asset["assetClass"];
  ruleVersion: string;
  degressiveRateBp?: number;
  evScheduleBp?: number[];
  poolYear?: number;
  fiscalYear: number;
  yearChoice: YearChoice | null;
}

function checkSetup(profile: CompanyProfile, input: AssetSetupInput, setupRequired: boolean): Checked {
  if (!isCalendarDate(input.acquisitionDate)) throw appError("invalid_input", "Ungültiges Anschaffungsdatum.");
  const name = input.name.trim();
  if (name.length === 0 || name.length > 200) throw appError("invalid_input", "Bitte eine Bezeichnung angeben.");
  const date = calendarDate(input.acquisitionDate);
  const fyStart = fyStartOf(profile);
  const chart = chartAt(profile.chartOfAccounts, fyStart, date);
  const assetClass = assetClassOf(chart, input.account);
  if (!assetClass) throw appError("asset_rejected", ASSET_MESSAGES.notDepreciable, { reason: "asset_invalid" });
  const fiscalYear = fiscalYearOf(date, fyStart);
  if (setupRequired) return { assetClass, ruleVersion: "pending", fiscalYear, yearChoice: null };
  const policy = profile.assetPolicy.find((p) => p.fiscalYear === fiscalYear);
  const r = validateAssetSetup({
    acquisitionDate: date,
    costCents: input.costCents,
    method: input.method,
    assetClass,
    fiscalYear,
    ...(input.usefulLifeMonths !== undefined ? { usefulLifeMonths: input.usefulLifeMonths } : {}),
    ...(input.evQualified !== undefined ? { evQualified: input.evQualified } : {}),
    ...(policy ? { yearPolicy: policy.mode250to1000 } : {}),
  });
  if (!r.ok) throw appError("asset_rejected", r.error.message, { reason: r.error.code });
  return {
    assetClass,
    ruleVersion: r.value.ruleVersion,
    ...(r.value.degressiveRateBp !== undefined ? { degressiveRateBp: r.value.degressiveRateBp } : {}),
    ...(r.value.evScheduleBp ? { evScheduleBp: r.value.evScheduleBp } : {}),
    ...(input.method === "pool" ? { poolYear: fiscalYear } : {}),
    fiscalYear,
    yearChoice: r.value.yearChoice,
  };
}

/** AST-008: the first item of 250,01–1.000 € in a fiscal year fixes the uniform choice of that year. */
async function rememberYearChoice(ctx: ModelCtx, profile: CompanyProfile, c: Checked): Promise<void> {
  if (!c.yearChoice || profile.assetPolicy.some((p) => p.fiscalYear === c.fiscalYear)) return;
  const rows = [
    ...profile.assetPolicy,
    { fiscalYear: c.fiscalYear, mode250to1000: c.yearChoice, erinnerungswert: false },
  ];
  rows.sort((a, b) => a.fiscalYear - b.fiscalYear);
  await patchCompanyProfile(ctx, { assetPolicy: rows }, { action: "settings.asset_policy.update" });
}

export async function createAsset(
  ctx: ModelCtx,
  input: AssetSetupInput,
  link: { voucherId?: Id<"vouchers">; voucherLineId?: Id<"voucherLines">; setupRequired?: boolean } = {},
): Promise<Id<"assets">> {
  const profile = await profileOrThrow(ctx);
  const c = checkSetup(profile, input, link.setupRequired === true);
  await rememberYearChoice(ctx, profile, c);
  const policy = profile.assetPolicy.find((p) => p.fiscalYear === c.fiscalYear);
  await ensureAssetRange(ctx);
  const today = berlinCalendarDate(ctx.now());
  const { number } = await assignCounterNumber(ctx, {
    docType: "asset",
    date: { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) },
    action: "asset.create",
  });
  return auditedInsert(
    ctx,
    "assets",
    {
      inventoryNumber: number,
      name: input.name.trim(),
      account: input.account,
      assetClass: c.assetClass,
      acquisitionDate: input.acquisitionDate,
      costCents: input.costCents,
      inputVatDeducted: input.inputVatDeducted,
      ...(link.voucherId ? { voucherId: link.voucherId } : {}),
      ...(link.voucherLineId ? { voucherLineId: link.voucherLineId } : {}),
      method: input.method,
      ...(link.setupRequired ? { setupRequired: true } : {}),
      ...(input.usefulLifeMonths !== undefined ? { usefulLifeMonths: input.usefulLifeMonths } : {}),
      ...(input.usefulLifeKey ? { usefulLifeKey: input.usefulLifeKey } : {}),
      ...(c.degressiveRateBp !== undefined ? { degressiveRateBp: c.degressiveRateBp } : {}),
      ...(c.evScheduleBp ? { evScheduleBp: c.evScheduleBp } : {}),
      ...(input.evQualified !== undefined ? { evQualified: input.evQualified } : {}),
      ...(c.poolYear !== undefined ? { poolYear: c.poolYear } : {}),
      erinnerungswert: input.erinnerungswert ?? policy?.erinnerungswert ?? false,
      ...(input.costCenterId ? { costCenterId: input.costCenterId } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      ruleVersion: c.ruleVersion,
      recordedAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "asset.create", label: number },
  );
}

/**
 * AST-001: method, useful life, name … may change until the first AfA (E-AST-10). Voucher-linked assets keep the
 * account, cost and acquisition date of the voucher line (corrections go through „Beleg korrigieren“).
 */
export async function updateAsset(ctx: ModelCtx, id: Id<"assets">, input: AssetSetupInput): Promise<void> {
  const a = await requireAsset(ctx, id);
  if (a.voidedAt !== undefined) throw appError("invalid_input", "Die Anlage wurde storniert.");
  if (a.firstDepreciationAt !== undefined || a.disposal) {
    throw appError("immutable_record", ASSET_MESSAGES.costAfterAfa, { reason: "E-AST-10" });
  }
  if (a.voucherId) {
    if (input.costCents !== a.costCents || input.account !== a.account || input.acquisitionDate !== a.acquisitionDate) {
      throw appError(
        "invalid_input",
        "Konto, Anschaffungskosten und -datum kommen aus dem Beleg. Bitte den Beleg korrigieren.",
      );
    }
    const posted = a.method === "gwg" || a.method === "pool";
    if (posted !== (input.method === "gwg" || input.method === "pool") || (posted && input.method !== a.method)) {
      throw appError("invalid_input", "GWG und Sammelposten werden im Beleg festgelegt. Bitte den Beleg korrigieren.");
    }
  }
  const profile = await profileOrThrow(ctx);
  const c = checkSetup(profile, input, false);
  await rememberYearChoice(ctx, profile, c);
  await auditedPatch(
    ctx,
    "assets",
    id,
    {
      name: input.name.trim(),
      account: input.account,
      assetClass: c.assetClass,
      acquisitionDate: input.acquisitionDate,
      costCents: input.costCents,
      inputVatDeducted: input.inputVatDeducted,
      method: input.method,
      setupRequired: undefined,
      usefulLifeMonths: input.usefulLifeMonths,
      usefulLifeKey: input.usefulLifeKey,
      degressiveRateBp: c.degressiveRateBp,
      evScheduleBp: c.evScheduleBp,
      evQualified: input.evQualified,
      poolYear: c.poolYear,
      ...(input.erinnerungswert !== undefined ? { erinnerungswert: input.erinnerungswert } : {}),
      costCenterId: input.costCenterId,
      notes: input.notes?.trim() || undefined,
      ruleVersion: c.ruleVersion,
    },
    { action: "asset.update", label: a.inventoryNumber },
  );
}

/** AST-001: notes stay editable after the first AfA. */
export async function setAssetNotes(ctx: ModelCtx, id: Id<"assets">, notes: string): Promise<void> {
  const a = await requireAsset(ctx, id);
  await auditedPatch(
    ctx,
    "assets",
    id,
    { notes: notes.trim() || undefined },
    { action: "asset.note", label: a.inventoryNumber },
  );
}

// ── voucher integration (AST-002) ───────────────────────────────────────────────────────────────────────

export async function assetsOfVoucher(ctx: ReadCtx, voucherId: Id<"vouchers">): Promise<Asset[]> {
  return (
    await ctx.db
      .query("assets")
      .withIndex("by_voucher", (q) => q.eq("voucherId", voucherId))
      .collect()
  ).filter((a) => a.voidedAt === undefined);
}

/** A voucher whose assets already have AfA or a disposal cannot be cancelled or corrected (asset first). */
export async function assertVoucherAssetsReversible(ctx: ReadCtx, voucherId: Id<"vouchers">): Promise<void> {
  const blocked = (await assetsOfVoucher(ctx, voucherId)).filter(
    (a) => a.firstDepreciationAt !== undefined || a.disposal,
  );
  if (blocked.length > 0) {
    throw appError(
      "invalid_input",
      `Zu diesem Beleg gibt es Anlagen mit gebuchter AfA (${blocked.map((a) => a.inventoryNumber).join(", ")}). Bitte den Abgang der Anlage erfassen oder eine manuelle Korrekturbuchung vornehmen.`,
      { reason: "ASSET_DEPRECIATED" },
    );
  }
}

/** Cancel/correction of the voucher before any AfA: its assets are voided (the record stays, audited). */
export async function voidVoucherAssets(ctx: ModelCtx, voucherId: Id<"vouchers">, reason: string): Promise<void> {
  for (const a of await assetsOfVoucher(ctx, voucherId)) {
    await auditedPatch(
      ctx,
      "assets",
      a._id,
      { voidedAt: ctx.now(), voidReason: reason },
      { action: "asset.void", label: a.inventoryNumber, reason },
    );
  }
}

/**
 * AST-002: called by `finalizeVoucher`/`correctVoucher` after the booking entry, in the same transaction. Creates
 * one asset per item (cost = what the line debits to its account), enforces the yearly GWG/Sammelposten choice
 * (E-AST-04 aborts the booking) and links the first asset of each line (`voucherLines.assetId`).
 */
export async function createAssetsForVoucher(
  ctx: ModelCtx,
  args: {
    voucher: Doc<"vouchers">;
    number: string;
    eurLines: readonly ({ netEurCents: number; vatEurCents: number } | undefined)[];
    ku: boolean;
    accounts: { gwg: string | null; pool: string | null };
  },
): Promise<Id<"assets">[]> {
  const v = args.voucher;
  if (v.direction !== "expense") return [];
  const stored = await ctx.db
    .query("voucherLines")
    .withIndex("by_voucher", (q) => q.eq("voucherId", v._id))
    .collect();
  if (!stored.some((l) => l.assetDecision && l.assetDecision !== "none")) return [];
  const taxRule = v.taxRule;
  const drafts = assetDraftsFromVoucher(
    stored.map((l, index) => {
      const eur = args.eurLines[index];
      return {
        index,
        account: l.account,
        ...(l.description ? { description: l.description } : {}),
        ...(l.quantityMilli !== undefined ? { quantityMilli: l.quantityMilli } : {}),
        baseCents: voucherLineBaseCents(
          {
            netCents: eur?.netEurCents ?? l.netEurCents ?? l.netCents,
            vatCents: eur?.vatEurCents ?? l.vatEurCents ?? l.vatCents,
            ...(l.nonDeductibleShareBp !== undefined ? { nonDeductibleShareBp: l.nonDeductibleShareBp } : {}),
          },
          taxRule,
          args.ku,
        ),
        ...(l.assetDecision ? { assetDecision: l.assetDecision } : {}),
      };
    }),
    `Anlage aus Beleg ${args.number}`,
    { gwg: args.accounts.gwg ?? "", pool: args.accounts.pool ?? "" },
  );
  const date = supplyEnd(v.supplyDate ?? { kind: "date", date: v.documentDate ?? berlinCalendarDate(ctx.now()) });
  const deducted = voucherInputVatDeducted(taxRule, args.ku);
  const ids: Id<"assets">[] = [];
  for (const d of drafts) {
    const line = stored[d.index];
    if (!line) continue;
    const id = await createAsset(
      ctx,
      {
        name: d.name,
        account: d.account,
        acquisitionDate: date,
        costCents: d.costCents,
        method: d.method,
        inputVatDeducted: deducted,
      },
      { voucherId: v._id, voucherLineId: line._id, setupRequired: d.setupRequired },
    );
    ids.push(id);
    if (d.item === 1 && line.assetId === undefined) {
      await auditedPatch(
        ctx,
        "voucherLines",
        line._id,
        { assetId: id },
        { action: "asset.create", label: args.number },
      );
    }
  }
  return ids;
}

// ── depreciation run (AST-009) ──────────────────────────────────────────────────────────────────────────

export interface RunResult {
  posted: number;
  findings: { assetId?: Id<"assets">; code: string; message: string }[];
  runId?: Id<"depreciationRuns">;
}

type RunEntry = Doc<"depreciationRuns">["entries"][number];

async function postAfaRows(
  ctx: ModelCtx,
  asset: Asset,
  rows: readonly PlanRow[],
  chart: ReturnType<typeof chartAt>,
  out: { entries: RunEntry[]; findings: RunResult["findings"] },
): Promise<void> {
  if (rows.length === 0) return;
  let first = asset.firstDepreciationAt === undefined;
  for (const row of rows) {
    const event: AssetDepreciationEvent = {
      kind: "asset_depreciation",
      assetId: asset._id,
      inventoryNumber: asset.inventoryNumber,
      name: asset.name,
      period: row.period,
      date: endOfMonth(row.period),
      amountCents: row.amountCents,
      assetAccount: asset.account,
      afaRole: afaRoleFor(asset.method, chart, asset.account) as AssetDepreciationEvent["afaRole"],
    };
    const r = await postJournalEntry(ctx, event);
    if (r.status !== "posted") continue;
    const e = r.entries[0];
    if (!e) continue;
    out.entries.push({
      assetId: asset._id,
      period: row.period,
      amountCents: row.amountCents,
      journalEntryId: e.entryId,
      ...(e.latePosting ? { latePosting: e.latePosting } : {}),
    });
    if (e.period !== row.period) {
      out.findings.push({
        assetId: asset._id,
        code: "E-AST-14",
        message: `AfA ${mmYyyy(row.period)} konnte wegen Festschreibung nicht gebucht werden und wurde im ${mmYyyy(e.period)} nachgeholt.`,
      });
    }
    if (first) {
      await auditedPatch(
        ctx,
        "assets",
        asset._id,
        { firstDepreciationAt: ctx.now() },
        {
          action: "asset.depreciate",
          label: asset.inventoryNumber,
        },
      );
      first = false;
    }
  }
}

/** Unposted plan rows up to and including `through` (idempotent per (asset, period), E-AST-13). */
async function dueRows(ctx: ReadCtx, asset: Asset, fyStart: number, through: string): Promise<PlanRow[]> {
  const posted = new Set((await postedOf(ctx, asset)).afa.map((p) => p.period));
  return planOf(asset, fyStart).filter((r) => r.period <= through && !posted.has(r.period));
}

/**
 * AST-009 „AfA buchen“ through a month (cron: the previous month; manual „AfA jetzt buchen“). Entries for a locked
 * month move to the first open period with the late-posting flag (ACC-006, E-AST-14); plan months before the
 * Buchungsbeginn are skipped (ACC-014).
 */
export async function depreciateThrough(
  ctx: ModelCtx,
  through: string,
  trigger: "cron" | "manual",
): Promise<RunResult> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(through)) throw appError("invalid_input", "Ungültiger Monat.");
  const profile = await profileOrThrow(ctx);
  const fyStart = fyStartOf(profile);
  const out: { entries: RunEntry[]; findings: RunResult["findings"] } = { entries: [], findings: [] };
  for (const asset of await ctx.db.query("assets").collect()) {
    if (asset.voidedAt !== undefined) continue;
    if (asset.acquisitionDate.slice(0, 7) > through) continue;
    if (asset.setupRequired) {
      out.findings.push({
        assetId: asset._id,
        code: "E-AST-11",
        message: `${asset.inventoryNumber} ${asset.name}: ${ASSET_MESSAGES.usefulLife}`,
      });
      continue;
    }
    const chart = chartAt(profile.chartOfAccounts, fyStart, asset.acquisitionDate);
    await postAfaRows(ctx, asset, await dueRows(ctx, asset, fyStart, through), chart, out);
  }
  if (out.entries.length === 0 && out.findings.length === 0) return { posted: 0, findings: [] };
  const runId = await auditedInsert(
    ctx,
    "depreciationRuns",
    {
      year: Number(through.slice(0, 4)),
      month: Number(through.slice(5, 7)),
      trigger,
      entries: out.entries,
      findings: out.findings,
      at: ctx.now(),
      actor: ctx.actor,
    },
    { action: "asset.run", label: `AfA bis ${mmYyyy(through)}` },
  );
  return { posted: out.entries.length, findings: out.findings, runId };
}

// ── disposal (AST-010) ──────────────────────────────────────────────────────────────────────────────────

export interface DisposalArgs {
  date: string;
  kind: DisposalKind;
  /** Sale: the outgoing invoice with the proceeds (finalised). */
  documentId?: Id<"salesDocuments">;
  /** UI alternative to `documentId`: the invoice number. */
  documentNumber?: string;
  proceedsCents?: number;
  teilwertCents?: number;
}

export async function disposeAsset(
  ctx: ModelCtx,
  id: Id<"assets">,
  input: DisposalArgs,
): Promise<{ info?: string; journalEntryId?: Id<"journalEntries">; rbwCents: number; latePosting?: string }> {
  let args = input;
  const a = await requireAsset(ctx, id);
  if (a.voidedAt !== undefined) throw appError("invalid_input", "Die Anlage wurde storniert.");
  if (a.disposal) throw appError("invalid_input", "Für diese Anlage ist bereits ein Abgang erfasst.");
  if (a.setupRequired) throw appError("invalid_input", ASSET_MESSAGES.usefulLife, { reason: "E-AST-11" });
  if (!isCalendarDate(args.date)) throw appError("invalid_input", "Ungültiges Abgangsdatum.");
  if (args.date > berlinCalendarDate(ctx.now())) {
    throw appError("invalid_input", "Das Abgangsdatum darf nicht in der Zukunft liegen.");
  }
  if (args.kind === "sale" && !args.documentId && args.documentNumber?.trim()) {
    const number = args.documentNumber.trim();
    const found = await ctx.db
      .query("salesDocuments")
      .withIndex("by_number", (q) => q.eq("number", number))
      .first();
    if (!found)
      throw appError("invalid_input", `Die Rechnung ${number} wurde nicht gefunden.`, { reason: "SALE_INVOICE" });
    args = { ...args, documentId: found._id };
  }
  if (args.kind === "sale") {
    if (!args.documentId) {
      throw appError("invalid_input", "Ein Verkauf braucht die Ausgangsrechnung über den Erlös.", {
        reason: "SALE_INVOICE",
      });
    }
    const doc = await ctx.db.get(args.documentId);
    if (!doc || !["finalized", "sent"].includes(doc.status) || !["invoice", "final_invoice"].includes(doc.type)) {
      throw appError("invalid_input", "Bitte eine fertiggestellte Ausgangsrechnung verknüpfen.", {
        reason: "SALE_INVOICE",
      });
    }
  }
  const profile = await profileOrThrow(ctx);
  const fyStart = fyStartOf(profile);
  const chart = chartAt(profile.chartOfAccounts, fyStart, a.acquisitionDate);
  const posted = await postedOf(ctx, a);
  const plan = planOf(a, fyStart);
  const d = planDisposal({
    method: a.method,
    costCents: a.costCents,
    plan,
    postedPeriods: posted.afa.map((p) => p.period),
    disposal: {
      date: calendarDate(args.date),
      kind: args.kind,
      ...(args.proceedsCents !== undefined ? { proceedsNetCents: args.proceedsCents } : {}),
      ...(args.teilwertCents !== undefined ? { teilwertCents: args.teilwertCents } : {}),
    },
  });
  if (!d.ok) throw appError("asset_rejected", d.error.message, { reason: d.error.code });
  const base = {
    date: args.date,
    kind: args.kind,
    ...(args.proceedsCents !== undefined ? { proceedsCents: args.proceedsCents } : {}),
    ...(args.teilwertCents !== undefined ? { teilwertCents: args.teilwertCents } : {}),
    ...(args.documentId ? { documentId: args.documentId } : {}),
    recordedAt: ctx.now(),
  };
  if (d.value.kind === "pool_unchanged") {
    await auditedPatch(
      ctx,
      "assets",
      id,
      { disposal: { ...base, rbwCents: 0 } },
      {
        action: "asset.dispose",
        label: a.inventoryNumber,
      },
    );
    return { info: POOL_DISPOSAL_INFO, rbwCents: 0 };
  }
  const out: { entries: RunEntry[]; findings: RunResult["findings"] } = { entries: [], findings: [] };
  await postAfaRows(ctx, a, d.value.catchUp, chart, out);
  let vatCents = 0;
  if (args.kind === "withdrawal" && a.inputVatDeducted && !kuAt(profile, args.date)) {
    const rate = lookupVatRate("standard", calendarDate(args.date));
    if (!rate.ok || rate.value.value.rateBp !== 1900) {
      throw appError("posting_rejected", "Für den Steuersatz am Entnahmetag ist keine Buchungsregel hinterlegt.");
    }
    vatCents = Number(roundHalfAway(BigInt(args.teilwertCents ?? 0) * BigInt(rate.value.value.rateBp), 10_000n));
  }
  const r = await postJournalEntry(ctx, {
    kind: "asset_disposal",
    assetId: a._id,
    inventoryNumber: a.inventoryNumber,
    name: a.name,
    date: args.date,
    disposalKind: args.kind,
    assetAccount: a.account,
    rbwCents: d.value.rbwCents,
    ...(args.kind === "sale" ? { gain: d.value.result.kind === "gain" } : {}),
    ...(args.kind === "withdrawal" ? { withdrawal: { teilwertCents: args.teilwertCents ?? 0, vatCents } } : {}),
  });
  const entry = r.status === "posted" ? r.entries[0] : undefined;
  const fresh = await requireAsset(ctx, id);
  await auditedPatch(
    ctx,
    "assets",
    id,
    {
      disposal: {
        ...base,
        ...(vatCents ? { vatCents } : {}),
        rbwCents: d.value.rbwCents,
        ...(entry ? { journalEntryId: entry.entryId } : {}),
      },
    },
    { action: "asset.dispose", label: fresh.inventoryNumber },
  );
  if (out.entries.length > 0) {
    await auditedInsert(
      ctx,
      "depreciationRuns",
      {
        year: Number(args.date.slice(0, 4)),
        month: Number(args.date.slice(5, 7)),
        trigger: "disposal",
        entries: out.entries,
        findings: out.findings,
        at: ctx.now(),
        actor: ctx.actor,
      },
      { action: "asset.run", label: `Abgang ${a.inventoryNumber}` },
    );
  }
  return {
    rbwCents: d.value.rbwCents,
    ...(entry ? { journalEntryId: entry.entryId } : {}),
    ...(entry?.latePosting ? { latePosting: entry.latePosting } : {}),
  };
}

// ── reads ───────────────────────────────────────────────────────────────────────────────────────────────

function yearRange(profile: CompanyProfile, year: number) {
  const fyStart = fyStartOf(profile);
  return { from: fiscalYearStart(year, fyStart) as string, to: fiscalYearEnd(year, fyStart) as string };
}

export function assetStatus(a: Asset, bookValueCents: number): { key: string; label: string } {
  if (a.voidedAt !== undefined) return { key: "voided", label: "Storniert" };
  if (a.setupRequired) return { key: "setup", label: "Einrichtung offen" };
  if (a.disposal) return { key: "disposed", label: "Abgegangen" };
  if (bookValueCents <= (a.erinnerungswert ? 100 : 0)) return { key: "written_off", label: "Abgeschrieben" };
  return { key: "active", label: "Aktiv" };
}

/** Movements per asset from the journal; plan months before the Buchungsbeginn count as pre-book AfA. */
async function movementsOf(ctx: ReadCtx, profile: CompanyProfile, a: Asset): Promise<Movement[]> {
  const posted = await postedOf(ctx, a);
  const out: Movement[] = posted.afa.map((p) => ({ date: p.entry.date, kind: "afa", amountCents: p.amountCents }));
  if (posted.disposal) {
    out.push({ date: posted.disposal.date, kind: "rbw", amountCents: creditOn(posted.disposal, a.account) });
  }
  const start = profile.bookkeepingStartDate;
  if (start) {
    const postedPeriods = new Set(posted.afa.map((p) => p.period));
    for (const r of planOf(a, fyStartOf(profile))) {
      if (endOfMonth(r.period) < start && !postedPeriods.has(r.period)) {
        out.push({ date: endOfMonth(r.period), kind: "afa", amountCents: r.amountCents });
      }
    }
  }
  return out;
}

export async function assetList(ctx: ReadCtx, year: number) {
  const profile = await profileOrThrow(ctx);
  const range = yearRange(profile, year);
  const out = [];
  for (const a of await ctx.db.query("assets").withIndex("by_acquisitionDate").order("desc").collect()) {
    const m = await movementsOf(ctx, profile, a);
    const afaTotal = m.filter((x) => x.kind === "afa").reduce((s, x) => s + x.amountCents, 0);
    const rbw = m.filter((x) => x.kind === "rbw").reduce((s, x) => s + x.amountCents, 0);
    const bookValue = a.voidedAt !== undefined ? 0 : a.costCents - afaTotal - rbw;
    out.push({
      _id: a._id,
      inventoryNumber: a.inventoryNumber,
      name: a.name,
      account: a.account,
      acquisitionDate: a.acquisitionDate,
      costCents: a.costCents,
      method: a.method,
      bookValueCents: bookValue,
      afaYearCents: m
        .filter((x) => x.kind === "afa" && x.date >= range.from && x.date <= range.to)
        .reduce((s, x) => s + x.amountCents, 0),
      status: assetStatus(a, bookValue),
      voucherId: a.voucherId ?? null,
    });
  }
  return out;
}

export async function assetDetail(ctx: ReadCtx, id: Id<"assets">) {
  const a = await requireAsset(ctx, id);
  const profile = await profileOrThrow(ctx);
  const posted = await postedOf(ctx, a);
  const byPeriod = new Map(posted.afa.map((p) => [p.period, p.entry]));
  const plan = planOf(a, fyStartOf(profile)).map((r) => {
    const e = byPeriod.get(r.period);
    return {
      ...r,
      posted: e ? { seq: e.seq, entryId: e._id, period: e.period, latePosting: e.latePosting?.reason ?? null } : null,
      preBook: !e && !!profile.bookkeepingStartDate && endOfMonth(r.period) < profile.bookkeepingStartDate,
    };
  });
  const voucher = a.voucherId ? await ctx.db.get(a.voucherId) : null;
  const chart = chartAt(profile.chartOfAccounts, fyStartOf(profile), a.acquisitionDate);
  return {
    asset: a,
    plan,
    disposalEntry: posted.disposal ? { seq: posted.disposal.seq, entryId: posted.disposal._id } : null,
    voucher: voucher ? { _id: voucher._id, number: voucher.internalNumber ?? null } : null,
    methods: allowedMethods({
      acquisitionDate: calendarDate(a.acquisitionDate),
      costCents: a.costCents,
      assetClass: a.assetClass,
    }),
    afaRole: afaRoleFor(a.method, chart, a.account),
  };
}

/** AST-003 form helper: methods offered for an account/date/cost (with the reason when not). */
export async function methodOptionsFor(
  ctx: ReadCtx,
  args: { account: string; acquisitionDate: string; costCents: number },
): Promise<{
  assetClass: Asset["assetClass"] | null;
  methods: MethodOption[];
  yearPolicy: YearChoice | null;
  gwgLimitCents: number | null;
}> {
  const profile = await profileOrThrow(ctx);
  if (!isCalendarDate(args.acquisitionDate))
    return { assetClass: null, methods: [], yearPolicy: null, gwgLimitCents: null };
  const date = calendarDate(args.acquisitionDate);
  const fyStart = fyStartOf(profile);
  const assetClass = assetClassOf(chartAt(profile.chartOfAccounts, fyStart, date), args.account);
  const t = lookupAssetThresholds(date);
  const policy = profile.assetPolicy.find((p) => p.fiscalYear === fiscalYearOf(date, fyStart));
  return {
    assetClass,
    methods: assetClass ? allowedMethods({ acquisitionDate: date, costCents: args.costCents, assetClass }) : [],
    yearPolicy: policy?.mode250to1000 ?? null,
    gwgLimitCents: t.ok ? t.value.value.gwgLimitCents : null,
  };
}

const activeAssets = async (ctx: ReadCtx) =>
  (await ctx.db.query("assets").collect()).filter((a) => a.voidedAt === undefined && !a.setupRequired);

/** AST-012 Anlagenspiegel of a fiscal year with per-asset movements from the journal. */
export async function anlagenspiegelOf(ctx: ReadCtx, year: number) {
  const profile = await profileOrThrow(ctx);
  const range = yearRange(profile, year);
  const assets = await activeAssets(ctx);
  const movements: Record<string, Movement[]> = {};
  for (const a of assets) movements[a._id] = await movementsOf(ctx, profile, a);
  const report = anlagenspiegel(
    assets.map((a) => ({
      id: a._id,
      inventoryNumber: a.inventoryNumber,
      name: a.name,
      account: a.account,
      acquisitionDate: a.acquisitionDate,
      costCents: a.costCents,
      method: a.method,
      ...(a.poolYear !== undefined ? { poolYear: a.poolYear } : {}),
      ...(a.disposal ? { disposal: { date: a.disposal.date, kind: a.disposal.kind } } : {}),
    })),
    movements,
    range,
  );
  return { year, range, ...report };
}

/** AST-007 GWG-Verzeichnis of a fiscal year (GWG above the recording limit valid on the acquisition date). */
export async function gwgListOf(ctx: ReadCtx, year: number) {
  const profile = await profileOrThrow(ctx);
  const range = yearRange(profile, year);
  const rows = [];
  for (const a of (await activeAssets(ctx)).filter((x) => x.method === "gwg")) {
    const t = lookupAssetThresholds(calendarDate(a.acquisitionDate));
    if (t.ok && a.costCents <= t.value.value.recordingLimitCents) continue;
    const v = a.voucherId ? await ctx.db.get(a.voucherId) : null;
    rows.push({
      id: a._id as string,
      inventoryNumber: a.inventoryNumber,
      name: a.name,
      acquisitionDate: a.acquisitionDate,
      costCents: a.costCents,
      method: a.method,
      ...(v?.internalNumber ? { voucherNumber: v.internalNumber } : {}),
      ...(v ? { voucherId: v._id as string } : {}),
    });
  }
  return gwgList(rows, range, 0);
}

/** AST-008 Sammelposten per pool year with the items. */
export async function poolsOf(ctx: ReadCtx, year: number) {
  const pools = (await activeAssets(ctx)).filter((a) => a.method === "pool");
  const items = pools.map((a) => ({
    id: a._id as string,
    inventoryNumber: a.inventoryNumber,
    name: a.name,
    poolYear: a.poolYear ?? Number(a.acquisitionDate.slice(0, 4)),
    costCents: a.costCents,
    disposed: a.disposal !== undefined,
  }));
  return poolSummary(items, year).map((p) => ({ ...p, list: items.filter((i) => i.poolYear === p.poolYear) }));
}

/** AST-013: AfA forecast of a calendar year over all assets (planned vs posted), for the tax reserve (RPT-010). */
export async function afaForecastOf(ctx: ReadCtx, year: number) {
  const profile = await profileOrThrow(ctx);
  const fyStart = fyStartOf(profile);
  const assets = [];
  for (const a of await ctx.db.query("assets").collect()) {
    const posted = await postedOf(ctx, a);
    assets.push({ plan: planOf(a, fyStart), postedPeriods: new Set(posted.afa.map((p) => p.period)) });
  }
  return afaForecast(assets, year);
}
