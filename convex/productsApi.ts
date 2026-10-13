import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { normalizeSearchQuery } from "../src/domain/contacts/core";
import { categoryPath } from "../src/domain/products/categories";
import { priceViews, resolvePrice as resolvePriceDomain, resolveRate } from "../src/domain/products/pricing";
import { productFormFromRecord, productSchema } from "../src/domain/schemas/products";
import { isCalendarDate } from "../src/domain/time/calendar-date";
import type { Doc } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { companyContext } from "./model/contacts";
import { customerPricesOf, listCategories, setProductActive, updateProduct } from "./model/products";
import type { ReadCtx } from "./model/types";

/**
 * Products for REST and MCP (05 §4.2, F03 §7). Same model functions and schemas as the UI (CLAUDE.md rule 5); the
 * wire mapping lives in src/domain/schemas/api/products.ts. Every row carries the price views of today (PRD-012).
 */

async function todayViews(ctx: ReadCtx, products: Doc<"products">[], now: number) {
  const cc = await companyContext(ctx, now);
  return products.map((p) => {
    const rate = resolveRate(p.vatRateKey, cc.today);
    const rateBp = rate.ok ? rate.value.value.rateBp : 0;
    const views = priceViews(p.priceMode, p.unitPriceMicros, rateBp);
    return { product: p, today: { netMicros: views.netMicros, grossMicros: views.grossMicros, rateBp } };
  });
}

function baseQuery(ctx: QueryCtx, a: { q?: string; active?: boolean; updatedSince?: number }) {
  if (a.updatedSince !== undefined) {
    const since = a.updatedSince;
    return ctx.db.query("products").withIndex("by_updatedAt", (i) => i.gt("updatedAt", since));
  }
  const q = a.q?.trim() ? normalizeSearchQuery(a.q) : "";
  if (q) {
    return ctx.db.query("products").withSearchIndex("search", (s) => {
      const base = s.search("searchText", q);
      return a.active === undefined ? base : base.eq("active", a.active);
    });
  }
  if (a.active === undefined) return ctx.db.query("products").withIndex("by_active_name");
  const active = a.active;
  return ctx.db.query("products").withIndex("by_active_name", (i) => i.eq("active", active));
}

/** GET /products and MCP `product_search` (`q`, `active`, `type`, `category_id`, `updated_since`). */
export const list = query({
  permission: "products.read",
  args: {
    paginationOpts: paginationOptsValidator,
    q: v.optional(v.string()),
    active: v.optional(v.boolean()),
    type: v.optional(v.union(v.literal("service"), v.literal("good"))),
    categoryId: v.optional(v.string()),
    updatedSince: v.optional(v.number()),
  },
  handler: async (ctx, { paginationOpts, ...a }) => {
    const categoryId = a.categoryId ? ctx.db.normalizeId("productCategories", a.categoryId) : null;
    if (a.categoryId && !categoryId) return { page: [], isDone: true, continueCursor: "" };
    const q = a.q?.trim() ? normalizeSearchQuery(a.q) : "";
    const keep = (p: Doc<"products">) => {
      if (a.active !== undefined && p.active !== a.active) return false;
      if (a.type && p.type !== a.type) return false;
      if (categoryId && p.categoryId !== categoryId) return false;
      if (a.updatedSince !== undefined && q && !q.split(/\s+/).every((t) => p.searchText.includes(t))) return false;
      return true;
    };
    const page = await filter(baseQuery(ctx, a), keep).paginate(paginationOpts);
    return { ...page, page: await todayViews(ctx, page.page, ctx.now()) };
  },
});

export const get = query({
  permission: "products.read",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const nid = ctx.db.normalizeId("products", id);
    const p = nid ? await ctx.db.get(nid) : null;
    if (!p) return null;
    const [row] = await todayViews(ctx, [p], ctx.now());
    return row ?? null;
  },
});

async function loadProduct(ctx: ReadCtx, id: string) {
  const nid = ctx.db.normalizeId("products", id);
  const p = nid ? await ctx.db.get(nid) : null;
  if (!p) throw appError("not_found", "Produkt nicht gefunden.");
  return p;
}

/** PATCH /products/{id}: the given form fields overlay the stored record; validated with the UI schema. */
export const patch = mutation({
  permission: "products.write",
  args: { id: v.string(), version: v.number(), values: v.any() },
  handler: async (ctx, { id, version, values }) => {
    const p = await loadProduct(ctx, id);
    const form = { ...productFormFromRecord(p), ...(values as Record<string, unknown>) };
    const r = await updateProduct(ctx, p._id, version, parse(productSchema, form));
    return { id: p._id, warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })) };
  },
});

/** POST /products/{id}/archive and MCP `product_archive` (reversible). */
export const archive = mutation({
  permission: "products.write",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const p = await loadProduct(ctx, id);
    await setProductActive(ctx, p._id, false);
    return { id: p._id };
  },
});

/** GET /products/{id}/price and MCP `product_resolve_price` (PRD-032 via the domain `resolvePrice`). */
export const resolvePrice = query({
  permission: "products.read",
  args: {
    id: v.string(),
    contactId: v.optional(v.string()),
    date: v.optional(v.string()),
    unitCode: v.optional(v.string()),
    priceMode: v.optional(v.union(v.literal("net"), v.literal("gross"))),
  },
  handler: async (ctx, a) => {
    const p = await loadProduct(ctx, a.id);
    const cc = await companyContext(ctx, ctx.now());
    if (a.date !== undefined && !isCalendarDate(a.date)) {
      throw appError("invalid_input", "Datum im Format JJJJ-MM-TT.", { field: "date" });
    }
    const contactNid = a.contactId ? ctx.db.normalizeId("contacts", a.contactId) : null;
    const contact = contactNid ? await ctx.db.get(contactNid) : null;
    if (a.contactId && (!contact || contact.dsgvo?.restrictedAt !== undefined)) {
      throw appError("not_found", "Kontakt nicht gefunden.");
    }
    const rows = [];
    for (const cp of await customerPricesOf(ctx, p._id)) {
      const c = await ctx.db.get(cp.contactId);
      if (c && c.dsgvo?.restrictedAt === undefined) rows.push(cp); // PRD-E23
    }
    const r = resolvePriceDomain(
      { ...p, id: p._id },
      {
        contactId: contact?._id,
        parentContactId: contact?.parentId,
        customerPrices: rows,
        referenceDate: (a.date ?? cc.today) as never,
        unitCode: a.unitCode,
        documentPriceMode: a.priceMode ?? p.priceMode,
        documentCurrency: "EUR",
      },
    );
    if (!r.ok) {
      throw appError("invalid_input", r.error.message, {
        reason: r.error.code,
        ...(r.error.code === "UNIT_INVALID" ? { field: "unitCode" } : {}),
      });
    }
    const x = r.value;
    return {
      unitPriceMicros: x.unitPriceMicros,
      priceMode: x.priceMode,
      source: x.source,
      unitCode: x.unitCode,
      vatRateKey: x.vatRateKey,
      rateBp: x.rateBp,
      category: x.category,
      warnings: x.warnings.map((w) => ({ code: w.code, message: w.message })),
    };
  },
});

/** GET /product-categories and MCP `product_list_categories`. */
export const categories = query({
  permission: "products.read",
  args: {},
  handler: async (ctx) => {
    const rows = await listCategories(ctx);
    const nodes = rows.map((c) => ({ id: c._id, name: c.name, parentId: c.parentId }));
    return rows
      .map((c) => ({ _id: c._id, name: c.name, parentId: c.parentId ?? null, path: categoryPath(c._id, nodes) }))
      .sort((a, b) => a.path.localeCompare(b.path, "de"));
  },
});
