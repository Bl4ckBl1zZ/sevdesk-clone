import { encodeId } from "../../src/domain/api/ids";
import { foldSearch } from "../../src/domain/contacts/core";
import { INVOICE_FAMILY_TYPES } from "../../src/domain/documents/lifecycle";
import { formatCents } from "../../src/domain/money/format";
import { roundHalfAway } from "../../src/domain/money/rounding";
import { normalizeNumber, seedRange } from "../../src/domain/numbering/format";
import {
  armedAlerts,
  budgetAlertText,
  budgetConsumption,
  budgetStatus,
  evaluateBudgetAlerts,
} from "../../src/domain/projects/budget";
import { exactTimeNetCents } from "../../src/domain/projects/invoicing";
import { computeProfitability, type ProfitBasis, type RevenueRow } from "../../src/domain/projects/profitability";
import type { ProjectInput } from "../../src/domain/schemas/projects";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { notifyKind } from "./notifications";
import { assignCounterNumber, listDefaultRanges } from "./numberRanges";
import type { ModelCtx, ReadCtx } from "./types";
import { emitEvent } from "./webhooks";

/**
 * Projects (F11 PRJ-001…004, 03 §9). The only writer of `projects`. Numbers come from the project range at creation
 * (SET-064); projects with time entries, documents or vouchers can only be archived (E-PRJ-31). Budget alerts at
 * 80/100 % are sent once per threshold and re-armed when the budget is raised (PRJ-003).
 */

export type ProjectDoc = Doc<"projects">;

export const PROJECT_MESSAGES = {
  inUse: "Projekte mit Zeiten oder Belegen können nur archiviert werden.",
  notFound: "Projekt nicht gefunden.",
  archived: (name: string) => `Projekt ${name} ist archiviert.`,
} as const;

export async function getProject(ctx: ReadCtx, id: Id<"projects">): Promise<ProjectDoc> {
  const p = await ctx.db.get(id);
  if (!p) throw appError("not_found", PROJECT_MESSAGES.notFound);
  return p;
}

const searchText = (p: { name: string; number: string }) => foldSearch(`${p.number} ${p.name}`);

/**
 * The project range for instances seeded before F11 existed: created once from the seed (audited) so the first
 * project can be numbered (SET-064); the owner can change the format under Einstellungen › Nummernkreise.
 */
async function ensureProjectRange(ctx: ModelCtx): Promise<void> {
  if ((await listDefaultRanges(ctx)).some((r) => r.docTypes.includes("project"))) return;
  const seed = seedRange("project");
  if (!seed) return;
  await auditedInsert(
    ctx,
    "numberRanges",
    {
      docTypes: [...seed.docTypes],
      name: seed.name,
      format: seed.format,
      resetPolicy: seed.resetPolicy,
      startValue: seed.startValue,
      active: true,
      isDefault: true,
    },
    { action: "settings.number_range.create", label: seed.name, reason: "Nummernkreis für Projekte angelegt (F11)" },
  );
}

async function assignProjectNumber(ctx: ModelCtx): Promise<string> {
  await ensureProjectRange(ctx);
  const today = berlinCalendarDate(ctx.now());
  const date = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const { number } = await assignCounterNumber(ctx, { docType: "project", date, action: "project.create" });
  return number;
}

async function checkedRefs(ctx: ReadCtx, input: ProjectInput) {
  const contactId = input.contactId ? ctx.db.normalizeId("contacts", input.contactId) : null;
  const contact = contactId ? await ctx.db.get(contactId) : null;
  if (input.contactId && !contact) {
    throw appError("invalid_input", "Unbekannter Kontakt.", { reason: "CONTACT_UNKNOWN", field: "contactId" });
  }
  const productId = input.defaultProductId ? ctx.db.normalizeId("products", input.defaultProductId) : null;
  if (input.defaultProductId && !(productId && (await ctx.db.get(productId)))) {
    throw appError("invalid_input", "Unbekanntes Produkt.", { reason: "PRODUCT_UNKNOWN", field: "defaultProductId" });
  }
  return {
    ...(contact ? { contactId: contact._id } : {}),
    ...(productId ? { defaultProductId: productId } : {}),
    currency: contact?.currency ?? "EUR",
  };
}

function fieldsOf(input: ProjectInput) {
  return {
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    status: input.status,
    billingMode: input.billingMode,
    ...(input.hourlyRateMicros !== undefined ? { hourlyRateMicros: input.hourlyRateMicros } : {}),
    ...(input.internalCostRateMicros !== undefined ? { internalCostRateMicros: input.internalCostRateMicros } : {}),
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.startDate ? { startDate: input.startDate } : {}),
    ...(input.endDate ? { endDate: input.endDate } : {}),
    ...(input.rounding ? { rounding: input.rounding } : {}),
    ...(input.attachTimesheetDefault ? { attachTimesheetDefault: true } : {}),
  };
}

const CLEARABLE = [
  "description",
  "contactId",
  "hourlyRateMicros",
  "internalCostRateMicros",
  "budget",
  "startDate",
  "endDate",
  "defaultProductId",
  "rounding",
  "attachTimesheetDefault",
] as const;

/** PRJ-001: creates a project with its own number. */
export async function createProject(
  ctx: ModelCtx,
  input: ProjectInput,
): Promise<{ id: Id<"projects">; number: string }> {
  const refs = await checkedRefs(ctx, input);
  const number = await assignProjectNumber(ctx);
  const fields = fieldsOf(input);
  const id = await auditedInsert(
    ctx,
    "projects",
    {
      number,
      numberNormalized: normalizeNumber(number),
      searchText: searchText({ name: fields.name, number }),
      ...fields,
      ...refs,
      budgetAlerts: armedAlerts(),
      createdAt: ctx.now(),
      actor: ctx.actor,
    },
    { action: "project.create", label: `${number} ${fields.name}` },
  );
  return { id, number };
}

/**
 * PRJ-001 edit. Returns the number of open entries whose stored rate differs from a changed project rate (E-PRJ-19:
 * the UI asks whether to update them; in_draft/invoiced entries are never touched).
 */
export async function updateProject(
  ctx: ModelCtx,
  id: Id<"projects">,
  input: ProjectInput,
): Promise<{ openEntriesWithOldRate: number }> {
  const p = await getProject(ctx, id);
  const refs = await checkedRefs(ctx, input);
  const fields = fieldsOf(input);
  const cleared = Object.fromEntries(
    CLEARABLE.filter((k) => !(k in fields) && !(k in refs)).map((k) => [k, undefined]),
  );
  await auditedPatch(
    ctx,
    "projects",
    id,
    {
      ...cleared,
      ...fields,
      ...refs,
      searchText: searchText({ name: fields.name, number: p.number }),
    } as Partial<ProjectDoc>,
    { action: "project.update", label: `${p.number} ${fields.name}` },
  );
  await checkBudget(ctx, id);
  let openEntriesWithOldRate = 0;
  if (input.hourlyRateMicros !== undefined && input.hourlyRateMicros !== p.hourlyRateMicros) {
    openEntriesWithOldRate = (await entriesOf(ctx, id)).filter(
      (e) => e.status === "open" && e.hourlyRateMicros !== input.hourlyRateMicros,
    ).length;
  }
  return { openEntriesWithOldRate };
}

export async function entriesOf(ctx: ReadCtx, projectId: Id<"projects">): Promise<Doc<"timeEntries">[]> {
  return ctx.db
    .query("timeEntries")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
}

/** E-PRJ-31 usage: entries, documents (header or line project) and vouchers (header or line project). */
export async function projectUsage(ctx: ReadCtx, id: Id<"projects">) {
  const entries = await entriesOf(ctx, id);
  const documents = await ctx.db
    .query("salesDocuments")
    .withIndex("by_project", (q) => q.eq("projectId", id))
    .collect();
  const lineDocs = new Set(
    (
      await ctx.db
        .query("documentLines")
        .withIndex("by_project", (q) => q.eq("projectId", id))
        .collect()
    ).map((l) => l.documentId),
  );
  for (const d of documents) lineDocs.delete(d._id);
  const vouchers = await ctx.db
    .query("vouchers")
    .withIndex("by_project", (q) => q.eq("projectId", id))
    .collect();
  return { entries, documents, lineDocumentIds: [...lineDocs], vouchers };
}

/** E-PRJ-30/31: archive (with a warning about open billable entries) or delete an unused project. */
export async function setProjectStatus(
  ctx: ModelCtx,
  id: Id<"projects">,
  status: ProjectDoc["status"],
): Promise<{ warning?: string }> {
  const p = await getProject(ctx, id);
  if (p.status === status) return {};
  await auditedPatch(
    ctx,
    "projects",
    id,
    { status },
    {
      action: status === "archived" ? "project.archive" : "project.status",
      label: `${p.number} ${p.name}`,
    },
  );
  if (status !== "archived") return {};
  const open = (await entriesOf(ctx, id)).filter((e) => e.status === "open" && e.billable);
  if (open.length === 0) return {};
  const value = open.reduce((s, e) => s + exactTimeNetCents(e.durationMinutes, e.hourlyRateMicros), 0);
  return { warning: `Es gibt noch ${open.length} nicht abgerechnete Einträge (${formatCents(value)} €).` };
}

export async function deleteProject(ctx: ModelCtx, id: Id<"projects">): Promise<void> {
  const p = await getProject(ctx, id);
  const u = await projectUsage(ctx, id);
  if (u.entries.length + u.documents.length + u.lineDocumentIds.length + u.vouchers.length > 0) {
    throw appError("conflict", PROJECT_MESSAGES.inUse, { reason: "PROJECT_IN_USE" });
  }
  await auditedDelete(ctx, "projects", id, { action: "project.delete", label: `${p.number} ${p.name}` });
}

// ── budget (PRJ-003) ────────────────────────────────────────────────────────────────────────────────────────

const FINAL = (d: Doc<"salesDocuments">) => d.status !== "draft";

/** Invoiced fixed amounts of a fixed-price project count against an amount budget (PRJ-003). */
async function invoicedNetCents(ctx: ReadCtx, id: Id<"projects">): Promise<number> {
  const docs = await ctx.db
    .query("salesDocuments")
    .withIndex("by_project", (q) => q.eq("projectId", id))
    .collect();
  return docs
    .filter((d) => FINAL(d) && INVOICE_FAMILY_TYPES.includes(d.type) && d.status !== "cancelled")
    .reduce((s, d) => s + d.totals.netCents, 0);
}

export async function projectBudget(ctx: ReadCtx, p: ProjectDoc) {
  if (!p.budget) return null;
  const entries = await entriesOf(ctx, p._id);
  const fixed = p.budget.kind === "amount" && p.billingMode === "fixed" ? await invoicedNetCents(ctx, p._id) : 0;
  return budgetStatus(p.budget, budgetConsumption(p.budget, entries, fixed));
}

/** PRJ-003 / E-PRJ-20: notify reached thresholds once; re-arm thresholds no longer reached. */
export async function checkBudget(ctx: ModelCtx, id: Id<"projects">): Promise<number[]> {
  const p = await getProject(ctx, id);
  const status = await projectBudget(ctx, p);
  if (!status) return [];
  const r = evaluateBudgetAlerts(p.budgetAlerts, status.ratioBp, ctx.now());
  const changed = JSON.stringify(r.alerts) !== JSON.stringify(p.budgetAlerts);
  if (changed) {
    await auditedPatch(
      ctx,
      "projects",
      id,
      { budgetAlerts: r.alerts },
      { action: "project.budget_alert", label: p.number },
    );
  }
  for (const t of r.notify) {
    await notifyKind(ctx, "project.budget", {
      title: budgetAlertText(p.name, t, status),
      link: `/projekte/${id}`,
      entity: { table: "projects", id },
      dedupeKey: `project.budget|${id}|${t}|${r.alerts.find((a) => a.thresholdBp === t)?.notifiedAt ?? 0}`,
    });
    // F11 project.budget_threshold: once per reached threshold (re-armed per PRJ-003)
    await emitEvent(ctx, "project.budget_threshold", {
      id: encodeId("projects", id),
      object: "project",
      threshold_bp: t,
      ratio_bp: status.ratioBp,
      updated_at: new Date(ctx.now()).toISOString(),
    });
  }
  return r.notify;
}

// ── documents, vouchers, profitability (PRJ-002, PRJ-004) ──────────────────────────────────────────────────

/** a × b / c, half away from zero, integer arithmetic only (money never touches floats). */
const mulDiv = (a: number, b: number, c: number): number =>
  c === 0 ? 0 : Number(roundHalfAway(BigInt(a) * BigInt(b), BigInt(c)));

/** Signed net of a finalised document (Storno nets are stored negative; defensive for older rows). */
const signedNet = (d: Doc<"salesDocuments">) =>
  d.type === "cancellation" ? -Math.abs(d.totals.netCents) : d.totals.netCents;

/** Paid share of a document's net for the cash basis (payments allocated / payable). */
function paidNet(d: Doc<"salesDocuments">): number {
  const payable = d.totals.payableCents;
  if (payable === 0) return 0;
  const paid = payable - (d.openAmountCents ?? payable);
  return mulDiv(signedNet(d), paid, payable);
}

/**
 * PRJ-002: everything that belongs to the project — documents with the project (header or line), the Stornos and
 * corrections of its invoices, vouchers with the project (header or line).
 */
export async function projectDocuments(ctx: ReadCtx, id: Id<"projects">) {
  const u = await projectUsage(ctx, id);
  const docs = new Map(u.documents.map((d) => [d._id, d]));
  for (const did of u.lineDocumentIds) {
    const d = await ctx.db.get(did);
    if (d) docs.set(d._id, d);
  }
  for (const d of [...docs.values()]) {
    if (!INVOICE_FAMILY_TYPES.includes(d.type)) continue;
    for (const c of await ctx.db
      .query("salesDocuments")
      .withIndex("by_correctsId", (q) => q.eq("correctsId", d._id))
      .collect()) {
      docs.set(c._id, c);
    }
  }
  const vouchers = new Map(u.vouchers.map((v) => [v._id, v]));
  for (const l of await ctx.db.query("voucherLines").collect()) {
    if (l.projectId !== id || vouchers.has(l.voucherId)) continue;
    const v = await ctx.db.get(l.voucherId);
    if (v) vouchers.set(v._id, v);
  }
  return { documents: [...docs.values()], vouchers: [...vouchers.values()], entries: u.entries };
}

const REVENUE_TYPES = new Set<string>([...INVOICE_FAMILY_TYPES, "cancellation", "correction"]);

/**
 * PRJ-004: revenue = Σ net of finalised invoices/corrections/Stornos of the project; costs = Σ voucher net with the
 * project (+ non-deductible VAT) + minutes × internal cost rate. Line-level projects count only their lines.
 * Basis `cash` weights each document/voucher by its paid share (payment allocations, F08 §4.4).
 */
export async function projectProfitability(ctx: ReadCtx, id: Id<"projects">, basis: ProfitBasis = "accrual") {
  const p = await getProject(ctx, id);
  const { documents, vouchers, entries } = await projectDocuments(ctx, id);
  const revenue: RevenueRow[] = [];
  for (const d of documents) {
    if (!FINAL(d) || !REVENUE_TYPES.has(d.type)) continue;
    let net = basis === "cash" ? paidNet(d) : signedNet(d);
    if (d.projectId !== id && d.type !== "cancellation" && d.type !== "correction") {
      // only the lines of this project (line-level assignment)
      const lines = await ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", d._id))
        .collect();
      const own = lines.filter((l) => l.projectId === id).reduce((s, l) => s + (l.lineNetCents ?? 0), 0);
      net = mulDiv(net, own, d.totals.netCents);
    }
    revenue.push({
      id: d._id,
      kind: d.type === "cancellation" ? "cancellation" : d.type === "correction" ? "correction" : "invoice",
      netCents: net,
    });
  }
  const costs = [];
  for (const v of vouchers) {
    if (v.status === "draft" || v.status === "cancelled" || v.direction !== "expense") continue;
    const lines = await ctx.db
      .query("voucherLines")
      .withIndex("by_voucher", (q) => q.eq("voucherId", v._id))
      .collect();
    const own = v.projectId === id ? lines : lines.filter((l) => l.projectId === id);
    const net = own.reduce((s, l) => s + (l.netEurCents ?? l.netCents), 0);
    const nonDeductible = own.reduce(
      (s, l) => s + mulDiv(l.vatEurCents ?? l.vatCents, l.nonDeductibleShareBp ?? 0, 10_000),
      0,
    );
    const paid = basis === "cash" ? v.totals.grossCents - v.openAmountCents : v.totals.grossCents;
    const gross = v.totals.grossCents;
    costs.push({
      id: v._id,
      netCents: gross === 0 ? net : mulDiv(net, paid, gross),
      nonDeductibleVatCents: gross === 0 ? nonDeductible : mulDiv(nonDeductible, paid, gross),
    });
  }
  const result = computeProfitability({
    revenue,
    costs,
    time: entries.map((e) => ({ durationMinutes: e.durationMinutes })),
    internalCostRateMicros: p.internalCostRateMicros,
  });
  return { ...result, basis, revenueRows: revenue, costRows: costs };
}
