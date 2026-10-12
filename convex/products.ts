import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { normalizeSearchQuery } from "../src/domain/contacts/core";
import { formatMicros } from "../src/domain/money/format";
import { render } from "../src/domain/numbering/format";
import { categoryPath } from "../src/domain/products/categories";
import { PRODUCT_EXPORT_HEADERS, productExportRow, productRow } from "../src/domain/products/csv-io";
import { computeMargin, priceViews, resolveRate } from "../src/domain/products/pricing";
import { rateChangeBanner, upcomingRateChanges } from "../src/domain/products/rate-change";
import {
  categorySchema,
  customerPriceSchema,
  productSchema,
  scheduledPriceSchema,
} from "../src/domain/schemas/products";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { berlinParts } from "./lib/time";
import { companyContext } from "./model/contacts";
import { listDefaultRanges, nextValue } from "./model/numberRanges";
import {
  applyScheduledPrices,
  createProduct,
  customerPricesOf,
  deleteCategory as deleteCategoryModel,
  deleteProduct,
  ensureCategoryPath,
  listCategories,
  productUsageCount,
  removeCustomerPrice as removeCustomerPriceModel,
  saveCategory as saveCategoryModel,
  saveCustomerPrice as saveCustomerPriceModel,
  setProductActive,
  setScheduledPrice as setScheduledPriceModel,
  updateProduct,
} from "./model/products";

/**
 * Produkte (F03). Public queries and mutations for the UI (and later REST/MCP). Writes go through
 * convex/model/products.ts; prices are shown with the rate of today (PRD-012), documents resolve by supply date.
 */

const listArgs = {
  q: v.optional(v.string()),
  status: v.optional(v.union(v.literal("active"), v.literal("archived"), v.literal("all"))),
  type: v.optional(v.union(v.literal("service"), v.literal("good"))),
  categoryId: v.optional(v.id("productCategories")),
  vatRateKey: v.optional(v.string()),
};

type ListFilter = {
  q?: string;
  status?: "active" | "archived" | "all";
  type?: "service" | "good";
  categoryId?: Id<"productCategories">;
  vatRateKey?: string;
};

function baseQuery(ctx: QueryCtx, f: ListFilter) {
  const status = f.status ?? "active";
  const q = f.q?.trim() ? normalizeSearchQuery(f.q) : "";
  if (q) {
    return ctx.db.query("products").withSearchIndex("search", (s) => {
      const base = s.search("searchText", q);
      const withStatus = status === "all" ? base : base.eq("active", status === "active");
      return f.type ? withStatus.eq("type", f.type) : withStatus;
    });
  }
  if (status === "all") return ctx.db.query("products").withIndex("by_active_name").order("asc");
  return ctx.db
    .query("products")
    .withIndex("by_active_name", (i) => i.eq("active", status === "active"))
    .order("asc");
}

function matches(p: Doc<"products">, f: ListFilter): boolean {
  const status = f.status ?? "active";
  if (status !== "all" && p.active !== (status === "active")) return false;
  if (f.type && p.type !== f.type) return false;
  if (f.categoryId && p.categoryId !== f.categoryId) return false;
  if (f.vatRateKey && p.vatRateKey !== f.vatRateKey) return false;
  return true;
}

async function priceInfo(ctx: QueryCtx, p: Doc<"products">, now: number) {
  const cc = await companyContext(ctx, now);
  const rate = resolveRate(p.vatRateKey, cc.today);
  const rateBp = rate.ok ? rate.value.value.rateBp : 0;
  const views = priceViews(p.priceMode, p.unitPriceMicros, rateBp);
  const standard = resolveRate("standard", cc.today);
  const margin =
    p.purchasePriceMicros !== undefined
      ? computeMargin(views.netMicros, p.purchasePriceMicros, {
          kleinunternehmer: cc.kleinunternehmer,
          standardRateBp: standard.ok ? standard.value.value.rateBp : 1900,
        })
      : null;
  return { rateBp, ...views, margin, today: cc.today };
}

/** PRD list with search, filters and both price views at today's rate. */
export const list = query({
  permission: "products.read",
  args: { paginationOpts: paginationOptsValidator, ...listArgs },
  handler: async (ctx, { paginationOpts, ...f }) => {
    const page = await filter(baseQuery(ctx, f), (p) => matches(p, f)).paginate(paginationOpts);
    const categories = (await listCategories(ctx)).map((c) => ({ id: c._id, name: c.name, parentId: c.parentId }));
    const rows = await Promise.all(
      page.page.map(async (p) => {
        const info = await priceInfo(ctx, p, ctx.now());
        return {
          _id: p._id,
          number: p.number,
          name: p.name,
          type: p.type,
          unitCode: p.unitCode,
          priceMode: p.priceMode,
          netMicros: info.netMicros,
          grossMicros: info.grossMicros,
          rateBp: info.rateBp,
          vatRateKey: p.vatRateKey,
          marginBp: info.margin?.marginBp ?? null,
          category: categoryPath(p.categoryId, categories),
          active: p.active,
          scheduledPrice: p.scheduledPrice ?? null,
        };
      }),
    );
    return { ...page, page: rows };
  },
});

/** Product picker (documents, F04): active products only (PRD-072). */
export const options = query({
  permission: "products.read",
  args: { q: v.optional(v.string()) },
  handler: async (ctx, { q }) => {
    const f: ListFilter = { status: "active", ...(q ? { q } : {}) };
    const rows = await filter(baseQuery(ctx, f), (p) => matches(p, f)).take(20);
    return rows.map((p) => ({ _id: p._id, number: p.number, name: p.name, unitCode: p.unitCode }));
  },
});

export const nextNumber = query({
  permission: "products.read",
  args: {},
  handler: async (ctx) => {
    const range = (await listDefaultRanges(ctx)).find((r) => r.docTypes.includes("product"));
    if (!range) return null;
    const today = berlinCalendarDate(ctx.now());
    const ym = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
    return render(range.format, ym, await nextValue(ctx, range, ym));
  },
});

export const get = query({
  permission: "products.read",
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => {
    const p = await ctx.db.get(id);
    if (!p) return null;
    const info = await priceInfo(ctx, p, ctx.now());
    const categories = (await listCategories(ctx)).map((c) => ({ id: c._id, name: c.name, parentId: c.parentId }));
    const prices = await customerPricesOf(ctx, id);
    const priceRows = [];
    for (const cp of prices) {
      const contact = await ctx.db.get(cp.contactId);
      // PRD-E23: prices of restricted contacts are hidden.
      if (!contact || contact.dsgvo?.restrictedAt !== undefined) continue;
      priceRows.push({
        ...cp,
        contact: { _id: contact._id, number: contact.number, displayName: contact.displayName, status: contact.status },
        views: priceViews(cp.priceMode, cp.unitPriceMicros, info.rateBp),
      });
    }
    priceRows.sort(
      (a, b) =>
        a.contact.displayName.localeCompare(b.contact.displayName, "de") ||
        (a.validFrom ?? "").localeCompare(b.validFrom ?? ""),
    );
    const tags = (await Promise.all(p.tags.map((t) => ctx.db.get(t)))).filter((t): t is Doc<"tags"> => t !== null);
    return {
      product: p,
      ...info,
      category: categoryPath(p.categoryId, categories),
      customerPrices: priceRows,
      tags: tags.map((t) => ({ _id: t._id, name: t.name, color: t.color ?? null })),
      usageCount: await productUsageCount(ctx, id),
    };
  },
});

/** PRD-027 banner: rate changes in the next 60 days with the affected products. */
export const rateChangeBanners = query({
  permission: "products.read",
  args: {},
  handler: async (ctx) => {
    const today = berlinCalendarDate(ctx.now());
    const changes = upcomingRateChanges(today);
    if (changes.length === 0) return [];
    const products = await ctx.db.query("products").collect();
    return changes.map((c) => rateChangeBanner(c, products)).filter((t): t is string => t !== null);
  },
});

// ── writes ────────────────────────────────────────────────────────────────────────────────────────────
export const create = mutation({
  permission: "products.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const r = await createProduct(ctx, parse(productSchema, values));
    return { id: r.id, number: r.number, warnings: r.warnings.map((w) => w.message) };
  },
});

export const update = mutation({
  permission: "products.write",
  args: { id: v.id("products"), version: v.number(), values: v.any(), confirmClearExtraUnits: v.optional(v.boolean()) },
  handler: async (ctx, { id, version, values, confirmClearExtraUnits }) => {
    const r = await updateProduct(ctx, id, version, parse(productSchema, values), {
      ...(confirmClearExtraUnits ? { confirmClearExtraUnits } : {}),
    });
    return { warnings: r.warnings.map((w) => w.message) };
  },
});

export const archive = mutation({
  permission: "products.write",
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => setProductActive(ctx, id, false),
});

export const unarchive = mutation({
  permission: "products.write",
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => setProductActive(ctx, id, true),
});

export const remove = mutation({
  permission: "products.write",
  args: { id: v.id("products") },
  handler: async (ctx, { id }) => deleteProduct(ctx, id),
});

export const saveCustomerPrice = mutation({
  permission: "products.write",
  args: { productId: v.id("products"), priceId: v.optional(v.id("customerPrices")), values: v.any() },
  handler: async (ctx, { productId, priceId, values }) =>
    saveCustomerPriceModel(ctx, productId, parse(customerPriceSchema, values), priceId),
});

export const removeCustomerPrice = mutation({
  permission: "products.write",
  args: { priceId: v.id("customerPrices") },
  handler: async (ctx, { priceId }) => removeCustomerPriceModel(ctx, priceId),
});

export const setScheduledPrice = mutation({
  permission: "products.write",
  args: { id: v.id("products"), values: v.union(v.null(), v.any()) },
  handler: async (ctx, { id, values }) =>
    setScheduledPriceModel(ctx, id, values === null ? null : parse(scheduledPriceSchema, values)),
});

/** `products.applyScheduledPrices` (02 §7, daily 00:05 Europe/Berlin; PRD-031). */
export const applyScheduledPricesCron = systemMutation({
  job: "cron.products.applyScheduledPrices",
  args: { force: v.optional(v.boolean()), today: v.optional(v.string()) },
  handler: async (ctx, { force, today }) => {
    if (isTest() && !force) return 0;
    const p = berlinParts(ctx.now());
    if (p.hour !== 0 && !force) return 0;
    return applyScheduledPrices(ctx, (today ?? p.date) as ReturnType<typeof berlinCalendarDate>);
  },
});

// ── categories (PRD-060/061) ─────────────────────────────────────────────────────────────────────────────
export const categories = query({
  permission: "products.read",
  args: {},
  handler: async (ctx) => {
    const rows = await listCategories(ctx);
    const nodes = rows.map((c) => ({ id: c._id, name: c.name, parentId: c.parentId }));
    const counts = new Map<string, number>();
    for (const p of await ctx.db.query("products").collect()) {
      if (p.categoryId) counts.set(p.categoryId, (counts.get(p.categoryId) ?? 0) + 1);
    }
    return rows
      .map((c) => ({
        _id: c._id,
        name: c.name,
        parentId: c.parentId ?? null,
        path: categoryPath(c._id, nodes),
        productCount: counts.get(c._id) ?? 0,
        childCount: rows.filter((x) => x.parentId === c._id).length,
      }))
      .sort((a, b) => a.path.localeCompare(b.path, "de"));
  },
});

export const saveCategory = mutation({
  permission: "products.write",
  args: { categoryId: v.optional(v.id("productCategories")), values: v.any() },
  handler: async (ctx, { categoryId, values }) => saveCategoryModel(ctx, parse(categorySchema, values), categoryId),
});

export const deleteCategory = mutation({
  permission: "products.write",
  args: { categoryId: v.id("productCategories"), target: v.optional(v.union(v.literal("parent"), v.literal("none"))) },
  handler: async (ctx, { categoryId, target }) => deleteCategoryModel(ctx, categoryId, target),
});

// ── import / export (PRD-080…085) ───────────────────────────────────────────────────────────────────────
const vImportRow = v.object({ rowNumber: v.number(), cells: v.array(v.string()) });
const vMapping = v.array(v.union(v.string(), v.null()));

function rateBpToday(today: ReturnType<typeof berlinCalendarDate>) {
  return (key: string) => {
    const r = resolveRate(key, today);
    return r.ok ? r.value.value.rateBp : undefined;
  };
}

async function importMatch(ctx: QueryCtx, number: string) {
  if (!number) return null;
  return ctx.db
    .query("products")
    .withIndex("by_number", (q) => q.eq("numberNormalized", number.trim().toUpperCase()))
    .first();
}

function toForm(values: NonNullable<ReturnType<typeof productRow>["values"]>, categoryId: string) {
  return {
    number: values.number,
    name: values.name,
    description: values.description,
    internalNote: values.internalNote,
    type: values.type,
    unitCode: values.unitCode,
    gtin: values.gtin,
    priceMode: values.priceMode,
    price: formatMicros(values.unitPriceMicros),
    purchasePrice: values.purchasePriceMicros !== undefined ? formatMicros(values.purchasePriceMicros) : "",
    vatRateKey: values.vatRateKey,
    exemptionReasonCode: values.exemptionReasonCode ?? "",
    placeOfSupplyRule: "" as const,
    reverseCharge13b: "",
    laborCostShare:
      values.laborCostShareBp !== undefined ? String(values.laborCostShareBp / 100).replace(".", ",") : "",
    categoryId,
    extraUnits: [],
    tags: [],
    customFields: {},
  };
}

/** PRD-080 preview: neu / Aktualisierung / Fehler per row (dry run, writes nothing). */
export const importPreview = query({
  permission: "products.write",
  args: { rows: v.array(vImportRow), mapping: vMapping },
  handler: async (ctx, { rows, mapping }) => {
    const today = berlinCalendarDate(ctx.now());
    return Promise.all(
      rows.map(async (r) => {
        const parsed = productRow(r.cells, mapping as never, r.rowNumber, rateBpToday(today));
        if (!parsed.values) {
          return {
            rowNumber: r.rowNumber,
            status: "error" as const,
            message: parsed.errors.map((e) => e.message).join(" "),
          };
        }
        const form = productSchema.safeParse(toForm(parsed.values, ""));
        if (!form.success) {
          return {
            rowNumber: r.rowNumber,
            status: "error" as const,
            message: `Zeile ${r.rowNumber}: ${form.error.issues[0]?.message ?? ""}`,
          };
        }
        const match = await importMatch(ctx, parsed.values.number);
        return {
          rowNumber: r.rowNumber,
          status: match ? ("update" as const) : ("new" as const),
          message: null,
          name: parsed.values.name,
        };
      }),
    );
  },
});

/** PRD-080 commit (≤ 100 rows per call): idempotent by `number` (a re-run updates instead of duplicating). */
export const importCommit = mutation({
  permission: "products.write",
  args: {
    rows: v.array(vImportRow),
    mapping: vMapping,
    mode: v.union(v.literal("create_only"), v.literal("create_and_update")),
  },
  handler: async (ctx, { rows, mapping, mode }) => {
    if (rows.length > 100)
      throw appError("invalid_input", "Höchstens 100 Zeilen pro Aufruf.", { reason: "IMPORT_BATCH_TOO_LARGE" });
    const today = berlinCalendarDate(ctx.now());
    const out: { rowNumber: number; status: "created" | "updated" | "skipped" | "error"; message?: string }[] = [];
    for (const r of rows) {
      const parsed = productRow(r.cells, mapping as never, r.rowNumber, rateBpToday(today));
      if (!parsed.values) {
        out.push({ rowNumber: r.rowNumber, status: "error", message: parsed.errors.map((e) => e.message).join(" ") });
        continue;
      }
      try {
        const categoryId = await ensureCategoryPath(ctx, parsed.values.categoryPath);
        const input = parse(productSchema, toForm(parsed.values, categoryId ?? ""));
        const match = await importMatch(ctx, parsed.values.number);
        if (!match) {
          await createProduct(ctx, input);
          out.push({ rowNumber: r.rowNumber, status: "created" });
        } else if (mode === "create_and_update") {
          await updateProduct(
            ctx,
            match._id,
            match.version,
            { ...input, extraUnits: match.extraUnits },
            { confirmClearExtraUnits: true },
          );
          out.push({ rowNumber: r.rowNumber, status: "updated" });
        } else {
          out.push({
            rowNumber: r.rowNumber,
            status: "skipped",
            message: `Artikelnummer ${match.number} existiert bereits.`,
          });
        }
      } catch (e) {
        const data = (e as { data?: { message?: string } }).data;
        out.push({
          rowNumber: r.rowNumber,
          status: "error",
          message: `Zeile ${r.rowNumber}: ${data?.message ?? String(e)}`,
        });
      }
    }
    return out;
  },
});

/** PRD-085 export rows of the current filter: net and gross at today's rate, key and rate, margin. */
export const exportRows = query({
  permission: "products.read",
  args: listArgs,
  handler: async (ctx, f) => {
    const rows: string[][] = [[...PRODUCT_EXPORT_HEADERS]];
    const categories = (await listCategories(ctx)).map((c) => ({ id: c._id, name: c.name, parentId: c.parentId }));
    const products = await filter(baseQuery(ctx, f), (p) => matches(p, f)).take(20_000);
    for (const p of products) {
      const info = await priceInfo(ctx, p, ctx.now());
      const tags = (await Promise.all(p.tags.map((t) => ctx.db.get(t)))).filter((t): t is Doc<"tags"> => t !== null);
      rows.push(
        productExportRow({
          ...p,
          netMicros: info.netMicros,
          grossMicros: info.grossMicros,
          rateBp: info.rateBp,
          marginBp: info.margin?.marginBp ?? null,
          categoryPath: categoryPath(p.categoryId, categories),
          tagNames: tags.map((t) => t.name),
        }),
      );
    }
    return rows;
  },
});
