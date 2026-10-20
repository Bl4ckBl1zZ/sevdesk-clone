import { v } from "convex/values";
import { normalizeSearchQuery } from "../src/domain/contacts/core";
import { DOC_TYPE_LABEL_DE, documentPath } from "../src/domain/documents/doc-types";
import { exactTimeNetCents } from "../src/domain/projects/invoicing";
import { projectFormSchema } from "../src/domain/schemas/projects";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { parse } from "./lib/parse";
import {
  createProject,
  deleteProject,
  getProject,
  projectBudget,
  projectDocuments,
  projectProfitability,
  setProjectStatus,
  updateProject,
} from "./model/projects";
import { updateOpenEntryRates } from "./model/timeEntries";
import type { ReadCtx } from "./model/types";

/**
 * Projekte (F11 PRJ-001…004). Public queries and mutations for the UI (REST/MCP follow the same model functions).
 * Writes go through convex/model/projects.ts.
 */

const vStatusFilter = v.optional(
  v.union(v.literal("active"), v.literal("done"), v.literal("archived"), v.literal("all")),
);

async function contactName(ctx: ReadCtx, id: Id<"contacts"> | undefined) {
  return id ? ((await ctx.db.get(id))?.displayName ?? null) : null;
}

async function summary(ctx: ReadCtx, p: Doc<"projects">) {
  const entries = await ctx.db
    .query("timeEntries")
    .withIndex("by_project", (q) => q.eq("projectId", p._id))
    .collect();
  const unbilled = entries.filter((e) => e.status === "open" && e.billable);
  return {
    _id: p._id,
    number: p.number,
    name: p.name,
    status: p.status,
    billingMode: p.billingMode,
    contactId: p.contactId ?? null,
    contactName: await contactName(ctx, p.contactId),
    budget: await projectBudget(ctx, p),
    trackedMinutes: entries.reduce((s, e) => s + e.durationMinutes, 0),
    unbilledMinutes: unbilled.reduce((s, e) => s + e.durationMinutes, 0),
    unbilledValueCents: unbilled.reduce((s, e) => s + exactTimeNetCents(e.durationMinutes, e.hourlyRateMicros), 0),
    currency: p.currency,
  };
}

export const list = query({
  permission: "projects.read",
  args: { status: vStatusFilter, q: v.optional(v.string()) },
  handler: async (ctx, { status, q }) => {
    const s = status ?? "active";
    const text = q?.trim() ? normalizeSearchQuery(q) : "";
    const rows = text
      ? await ctx.db
          .query("projects")
          .withSearchIndex("search", (x) =>
            s === "all" ? x.search("searchText", text) : x.search("searchText", text).eq("status", s),
          )
          .take(200)
      : s === "all"
        ? await ctx.db.query("projects").collect()
        : await ctx.db
            .query("projects")
            .withIndex("by_status", (x) => x.eq("status", s))
            .collect();
    const out = [];
    for (const p of rows) out.push(await summary(ctx, p));
    return out.sort((a, b) => a.name.localeCompare(b.name, "de"));
  },
});

/** Project picker (timer, entries, document editor): active projects. */
export const options = query({
  permission: "projects.read",
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("projects")
      .withIndex("by_status", (x) => x.eq("status", "active"))
      .collect();
    return rows.map((p) => ({ _id: p._id, number: p.number, name: p.name, contactId: p.contactId ?? null }));
  },
});

/** PRJ-002 project page: master data, budget, documents, vouchers, entries and profitability (accrual). */
export const get = query({
  permission: "projects.read",
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    const p = await ctx.db.get(id);
    if (!p) return null;
    const { documents, vouchers, entries } = await projectDocuments(ctx, id);
    const product = p.defaultProductId ? await ctx.db.get(p.defaultProductId) : null;
    return {
      project: p,
      summary: await summary(ctx, p),
      defaultProduct: product ? { _id: product._id, name: product.name } : null,
      documents: documents
        .map((d) => ({
          _id: d._id,
          type: d.type,
          typeLabel: DOC_TYPE_LABEL_DE[d.type],
          number: d.number ?? null,
          status: d.status,
          documentDate: d.documentDate ?? null,
          netCents: d.totals.netCents,
          currency: d.currency,
          href: documentPath(d.type, d._id),
        }))
        .sort((a, b) => (b.documentDate ?? "9999").localeCompare(a.documentDate ?? "9999")),
      vouchers: vouchers.map((x) => ({
        _id: x._id,
        number: x.internalNumber ?? null,
        supplierName: x.supplierName ?? null,
        documentDate: x.documentDate ?? null,
        status: x.status,
        netCents: x.totals.netCents,
        href: `/belege/${x._id}`,
      })),
      entryCount: entries.length,
      profitability: await projectProfitability(ctx, id, "accrual"),
    };
  },
});

export const profitability = query({
  permission: "projects.read",
  args: { id: v.id("projects"), basis: v.union(v.literal("accrual"), v.literal("cash")) },
  handler: async (ctx, { id, basis }) => {
    await getProject(ctx, id);
    return projectProfitability(ctx, id, basis);
  },
});

export const create = mutation({
  permission: "projects.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => createProject(ctx, parse(projectFormSchema, values)),
});

export const update = mutation({
  permission: "projects.write",
  args: { id: v.id("projects"), values: v.any() },
  handler: async (ctx, { id, values }) => updateProject(ctx, id, parse(projectFormSchema, values)),
});

export const setStatus = mutation({
  permission: "projects.write",
  args: { id: v.id("projects"), status: v.union(v.literal("active"), v.literal("done"), v.literal("archived")) },
  handler: async (ctx, { id, status }) => setProjectStatus(ctx, id, status),
});

export const remove = mutation({
  permission: "projects.write",
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => {
    await deleteProject(ctx, id);
    return null;
  },
});

/** E-PRJ-19: apply a changed project rate to the open entries. */
export const applyRateToOpenEntries = mutation({
  permission: "time.write",
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => ({ updated: await updateOpenEntryRates(ctx, id) }),
});
