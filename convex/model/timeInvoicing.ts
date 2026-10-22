import { convertPriceMode } from "../../src/domain/products/pricing";
import {
  type BillableEntry,
  checkSelection,
  planTimeInvoice,
  type TimeInvoicePlan,
} from "../../src/domain/projects/invoicing";
import { NO_ROUNDING, type TimeRounding } from "../../src/domain/projects/rates";
import { lookupVatRate } from "../../src/domain/rules/vat-rates";
import type { DraftValues } from "../../src/domain/schemas/documents";
import type { InvoiceFromEntriesValues } from "../../src/domain/schemas/projects";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { loadRuleOverrides } from "./ruleOverrides";
import { createDraft, documentLines, draftFromDoc, getDocument, updateDraft } from "./salesDocuments";
import { getEntry } from "./timeEntries";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * „Zeiten abrechnen“ (F11 PRJ-010…013, §4.3): selected open entries → invoice lines (grouping, rounding, unit) →
 * a new invoice draft or appended to an existing draft of the same contact. One transaction: lines with
 * `timeEntryIds` are saved, the draft sync locks the entries (`in_draft`), `roundedMinutes` are stored (PRJ-009).
 * Finalising stays the F04 pipeline (preview, confirm token for MCP).
 */

/** Conservative VAT key for time without a product (services at the standard rate). */
const DEFAULT_TIME_VAT_KEY = "standard";

async function billable(
  ctx: ReadCtx,
  ids: readonly string[],
): Promise<{ entries: BillableEntry[]; docs: Doc<"timeEntries">[] }> {
  const entries: BillableEntry[] = [];
  const docs: Doc<"timeEntries">[] = [];
  const products = new Map<string, Doc<"products"> | null>();
  const product = async (id: Id<"products"> | undefined) => {
    if (!id) return null;
    if (!products.has(id)) products.set(id, await ctx.db.get(id));
    return products.get(id) ?? null;
  };
  for (const raw of new Set(ids)) {
    const id = ctx.db.normalizeId("timeEntries", raw);
    if (!id) throw appError("invalid_input", "Unbekannter Zeiteintrag.", { reason: "TIME_ENTRY_UNKNOWN" });
    const e = await getEntry(ctx, id);
    const project = e.projectId ? await ctx.db.get(e.projectId) : null;
    const p = (await product(e.productId)) ?? (await product(project?.defaultProductId));
    const lockDoc = e.draftDocumentId ?? e.invoicedDocumentId;
    const lockLabel = lockDoc ? ((await ctx.db.get(lockDoc))?.number ?? "Entwurf") : undefined;
    docs.push(e);
    entries.push({
      id: e._id,
      date: e.date as CalendarDate,
      durationMinutes: e.durationMinutes,
      description: e.description,
      ...(e.contactId ? { contactId: e.contactId } : {}),
      currency: e.currency,
      hourlyRateMicros: e.hourlyRateMicros,
      ...(p ? { productId: p._id, productName: p.name } : {}),
      vatRateKey: p?.vatRateKey ?? DEFAULT_TIME_VAT_KEY,
      billable: e.billable,
      status: e.status,
      ...(e.incomplete ? { incomplete: true } : {}),
      ...(lockLabel ? { documentLabel: lockLabel } : {}),
    });
  }
  return { entries, docs };
}

async function roundingFor(ctx: ReadCtx, docs: Doc<"timeEntries">[], explicit?: TimeRounding): Promise<TimeRounding> {
  if (explicit) return explicit;
  const projects = new Set(docs.map((d) => d.projectId).filter(Boolean));
  if (projects.size === 1) {
    const p = await ctx.db.get([...projects][0] as Id<"projects">);
    if (p?.rounding) return p.rounding;
  }
  const profile = await getCompanyProfile(ctx);
  return (profile?.defaults.time?.rounding as TimeRounding | undefined) ?? NO_ROUNDING;
}

/** Preview and plan (dialog „Zeiten abrechnen“: raw vs rounded, amounts, notices). */
export async function planFromEntries(ctx: ReadCtx, v: InvoiceFromEntriesValues) {
  const { entries, docs } = await billable(ctx, v.entryIds);
  const rounding = await roundingFor(ctx, docs, v.rounding as TimeRounding | undefined);
  const profile = await getCompanyProfile(ctx);
  const unit = v.unit ?? profile?.defaults.time?.unitCode ?? "HUR";
  const overrides = await loadRuleOverrides(ctx);
  // E-PRJ-16 / EC-025: the date-effective KU status rows of the company split the lines like a VAT rate change.
  const kuRows = [...(profile?.kleinunternehmer ?? [])].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  const kuRowOf = (date: CalendarDate) => {
    const row = kuRows.filter((r) => r.validFrom <= date).at(-1);
    return row ? { rowId: `ku:${row.isKU}`, validFrom: row.validFrom as CalendarDate } : null;
  };
  // E-PRJ-32: entries of a fixed-price project are invoiced only with the warning.
  let fixedPrice = false;
  for (const pid of new Set(docs.map((d) => d.projectId))) {
    if (pid && (await ctx.db.get(pid))?.billingMode === "fixed") fixedPrice = true;
  }
  const plan = planTimeInvoice(entries, {
    grouping: v.grouping,
    fixedPrice,
    kuRowOf,
    rounding,
    perGroup: v.perGroup === true,
    unit,
    vatRowOf: (key, date) => {
      const r = lookupVatRate(key, date, overrides.vatRateOverrides[key] ?? []);
      return r.ok ? { rowId: r.value.rowId, validFrom: r.value.validFrom } : null;
    },
  });
  const projectIds = new Set(docs.map((d) => d.projectId));
  return { plan, entries, docs, projectId: projectIds.size === 1 ? [...projectIds][0] : undefined };
}

async function linesFor(
  plan: TimeInvoicePlan,
  priceMode: "net" | "gross",
  projectId: Id<"projects"> | undefined,
  overrides: Awaited<ReturnType<typeof loadRuleOverrides>>,
): Promise<DraftValues["lines"]> {
  return plan.lines.map((l) => {
    let unitPriceMicros = l.unitPriceMicros;
    if (priceMode === "gross") {
      // E-PRJ-24 / MISC-03: consumers see gross unit prices; the net rate converts at the rate of the period start.
      const r = lookupVatRate(l.vatRateKey, l.linePeriod.from, overrides.vatRateOverrides[l.vatRateKey] ?? []);
      unitPriceMicros = convertPriceMode(l.unitPriceMicros, "net", "gross", r.ok ? r.value.value.rateBp : 0);
    }
    return {
      kind: "item" as const,
      productType: "service" as const,
      ...(l.productId ? { productId: l.productId } : {}),
      name: l.name,
      ...(l.description ? { description: l.description } : {}),
      quantityMilli: l.quantityMilli,
      unitCode: l.unitCode,
      unitPriceMicros,
      vatRateKey: l.vatRateKey,
      ...(l.linePeriod.from !== l.linePeriod.to ? { linePeriod: { ...l.linePeriod } } : {}),
      ...(projectId ? { projectId } : {}),
      timeEntryIds: [...l.timeEntryIds],
      timeRounding: { ...plan.rounding },
    };
  });
}

const supplyBounds = (s: DraftValues["supplyDate"] | TimeInvoicePlan["supplyDate"]) =>
  !s
    ? null
    : s.kind === "date"
      ? { from: s.date, to: s.date }
      : s.kind === "period"
        ? { from: s.from, to: s.to }
        : null;

/** PRJ-010: creates a new invoice draft or appends to an existing draft of the same contact. */
export async function invoiceFromEntries(
  ctx: ModelCtx,
  v: InvoiceFromEntriesValues,
): Promise<{ id: Id<"salesDocuments">; notices: string[]; lines: number }> {
  const { plan, docs, projectId } = await planFromEntries(ctx, v);
  if (!plan.ok) throw appError("invalid_input", plan.error.message, { reason: plan.error.code });
  const overrides = await loadRuleOverrides(ctx);
  const p = plan.value;
  let id: Id<"salesDocuments">;
  if (v.draftId) {
    const draftId = ctx.db.normalizeId("salesDocuments", v.draftId);
    const draft = draftId ? await getDocument(ctx, draftId) : null;
    if (draft?.status !== "draft" || draft.type !== "invoice") {
      throw appError("invalid_input", "Bitte einen Rechnungsentwurf wählen.", { reason: "DRAFT_REQUIRED" });
    }
    const { entries } = await billable(ctx, v.entryIds);
    const problem = checkSelection(entries, { contactId: draft.contactId, currency: draft.currency });
    if (problem) throw appError("invalid_input", problem.message, { reason: problem.code });
    const values = draftFromDoc(draft, await documentLines(ctx, draft._id)) as unknown as DraftValues;
    // PRJ-013: the draft's supply period grows to cover the appended entries (never shrinks).
    const add = supplyBounds(p.supplyDate) as { from: string; to: string };
    const old = values.supplyDateMode === "explicit" ? supplyBounds(values.supplyDate) : null;
    const from = old && old.from < add.from ? old.from : add.from;
    const to = old && old.to > add.to ? old.to : add.to;
    const next: DraftValues = {
      ...values,
      supplyDateMode: "explicit",
      supplyDate:
        from === to
          ? { kind: "date", date: from as CalendarDate }
          : { kind: "period", from: from as CalendarDate, to: to as CalendarDate },
      lines: [...values.lines, ...(await linesFor(p, values.priceMode, projectId, overrides))],
    };
    await updateDraft(ctx, draft._id, draft.version, next);
    id = draft._id;
  } else {
    const contact = p.contactId ? await ctx.db.get(p.contactId as Id<"contacts">) : null;
    const profile = await getCompanyProfile(ctx);
    const priceMode = contact?.isConsumer ? "gross" : "net";
    const values: DraftValues = {
      type: "invoice",
      ...(contact ? { contactId: contact._id } : {}),
      supplyDateMode: "explicit",
      supplyDate: p.supplyDate,
      currency: p.currency,
      priceMode,
      paymentTerms: contact?.paymentTerms ?? profile?.defaults.paymentTerms ?? { dueDays: 14 },
      showEpcQr: true,
      language: contact?.language ?? profile?.defaults.language ?? "de",
      ...(projectId ? { projectId } : {}),
      lines: await linesFor(p, priceMode, undefined, overrides),
    };
    id = await createDraft(ctx, values, {}, { reason: "Aus Zeiteinträgen erstellt" });
  }
  // PRJ-009: rounded minutes per entry are stored at invoicing (raw durations never change).
  for (const e of docs) {
    const rounded = p.roundedByEntry[e._id];
    if (rounded === undefined) continue;
    await auditedPatch(
      ctx,
      "timeEntries",
      e._id,
      { roundedMinutes: rounded },
      { action: "time_entry.round", label: e.description },
    );
  }
  return { id, notices: [...p.notices], lines: p.lines.length };
}
