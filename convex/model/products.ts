import { chartAt } from "../../src/domain/accounting/period";
import { type FieldIssue, foldSearch } from "../../src/domain/contacts/core";
import {
  type CategoryNode,
  categoryPath,
  planCategoryDelete,
  resolveCategoryPath,
  SEED_CATEGORIES,
  validateCategory,
} from "../../src/domain/products/categories";
import {
  baseUnitChangeClearsExtraUnits,
  normalizeProductNumber,
  productNumberTaken,
  sanitizeDescription,
  validateProductFields,
} from "../../src/domain/products/product";
import { keyRatesFromToday, revenueAccountIssue } from "../../src/domain/products/revenue-account";
import type { ProductInput } from "../../src/domain/schemas/products";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedDelete, auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { assertCustomFields, assertTags, fail } from "./contacts";
import { assignCounterNumber } from "./numberRanges";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * Products (F03, 03 §3). The only writer of `products`, `productCategories` and `customerPrices`. Prices are stored
 * in the mode they were entered (PRD-011); rates are resolved by date in the documents (PRD-021). Every write is
 * audited; finalised documents copy the product data, so no product change reaches them (PRD-070).
 */
export type ProductDoc = Doc<"products">;

function versionConflict(): never {
  throw appError("version_conflict", "Das Produkt wurde zwischenzeitlich geändert. Bitte neu laden.", {
    reason: "VERSION_CONFLICT",
  });
}

export async function getProduct(ctx: ReadCtx, id: Id<"products">): Promise<ProductDoc> {
  const p = await ctx.db.get(id);
  if (!p) throw appError("not_found", "Produkt nicht gefunden.");
  return p;
}

export const productSearchText = (p: { name: string; number: string }) =>
  [...new Set([foldSearch(p.name), p.name.toLowerCase(), p.number.toLowerCase()].join(" ").split(/\s+/))]
    .filter(Boolean)
    .join(" ");

async function numberTaken(ctx: ReadCtx, number: string, self?: Id<"products">): Promise<boolean> {
  const hit = await ctx.db
    .query("products")
    .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeProductNumber(number)))
    .first();
  return hit !== null && hit._id !== self;
}

async function activeUnitCodes(ctx: ReadCtx): Promise<Set<string>> {
  return new Set((await ctx.db.query("units").collect()).filter((u) => u.archivedAt === undefined).map((u) => u.code));
}

async function assignProductNumber(ctx: ModelCtx, today: CalendarDate): Promise<string> {
  const date = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  for (let attempt = 0; attempt < 100; attempt++) {
    const { number } = await assignCounterNumber(ctx, { docType: "product", date, action: "product.create" });
    if (!(await numberTaken(ctx, number))) return number;
  }
  throw appError("conflict", "Es konnte keine freie Artikelnummer vergeben werden. Bitte den Nummernkreis prüfen.", {
    reason: "NUMBER_COLLISION",
  });
}

const REMOVABLE: readonly (keyof ProductDoc)[] = [
  "description",
  "internalNote",
  "gtin",
  "purchasePriceMicros",
  "exemptionReasonCode",
  "placeOfSupplyRule",
  "reverseCharge13b",
  "revenueAccountOverride",
  "laborCostShareBp",
  "categoryId",
];

async function fieldsFrom(ctx: ModelCtx, input: ProductInput) {
  // The unit check needs the active units (PRD-006); a seeded-units-less test database accepts any Rec 20 code.
  const units = await activeUnitCodes(ctx);
  const v = validateProductFields(input, units.size > 0 ? units : undefined);
  if (v.errors[0]) fail(v.errors[0]);
  let categoryId: Id<"productCategories"> | undefined;
  if (input.categoryId) {
    categoryId = ctx.db.normalizeId("productCategories", input.categoryId) ?? undefined;
    if (!categoryId || !(await ctx.db.get(categoryId))) {
      fail({ code: "CATEGORY_UNKNOWN", message: "Unbekannte Kategorie.", field: "categoryId" });
    }
  }
  if (input.revenueAccountOverride) {
    // PRD-050 / PRD-052: a revenue account of the company chart whose automatic VAT fits the key from today on.
    const today = berlinCalendarDate(ctx.now());
    const profile = await getCompanyProfile(ctx);
    const chart = chartAt(profile?.chartOfAccounts ?? [], profile?.fiscalYearStartMonth ?? 1, today);
    const issue = revenueAccountIssue({
      chart,
      account: input.revenueAccountOverride,
      date: today,
      rates: keyRatesFromToday(input.vatRateKey, today),
    });
    if (issue) fail({ code: issue.code, message: issue.message, field: "revenueAccountOverride" });
  }
  const tags = await assertTags(ctx, input.tags);
  await assertCustomFields(ctx, "product", input.customFields);
  const description = input.description ? sanitizeDescription(input.description) : "";
  return {
    warnings: v.warnings,
    fields: {
      name: input.name.trim(),
      ...(description ? { description } : {}),
      ...(input.internalNote ? { internalNote: input.internalNote } : {}),
      type: input.type,
      unitCode: input.unitCode,
      ...(input.gtin ? { gtin: input.gtin } : {}),
      priceMode: input.priceMode,
      unitPriceMicros: input.unitPriceMicros,
      ...(input.purchasePriceMicros !== undefined ? { purchasePriceMicros: input.purchasePriceMicros } : {}),
      vatRateKey: input.vatRateKey,
      ...(input.exemptionReasonCode ? { exemptionReasonCode: input.exemptionReasonCode } : {}),
      ...(input.placeOfSupplyRule ? { placeOfSupplyRule: input.placeOfSupplyRule } : {}),
      ...(input.reverseCharge13b ? { reverseCharge13b: input.reverseCharge13b } : {}),
      ...(input.revenueAccountOverride ? { revenueAccountOverride: input.revenueAccountOverride } : {}),
      ...(input.laborCostShareBp !== undefined ? { laborCostShareBp: input.laborCostShareBp } : {}),
      ...(categoryId ? { categoryId } : {}),
      extraUnits: [...input.extraUnits],
      tags,
      customFields: input.customFields,
    },
  };
}

export async function createProduct(
  ctx: ModelCtx,
  input: ProductInput,
): Promise<{ id: Id<"products">; number: string; warnings: FieldIssue[] }> {
  const { fields, warnings } = await fieldsFrom(ctx, input);
  let number: string;
  if (input.number) {
    if (await numberTaken(ctx, input.number)) fail(productNumberTaken(input.number));
    number = input.number.trim();
  } else {
    number = await assignProductNumber(ctx, berlinCalendarDate(ctx.now()));
  }
  const id = await auditedInsert(
    ctx,
    "products",
    {
      ...fields,
      number,
      numberNormalized: normalizeProductNumber(number),
      searchText: productSearchText({ name: fields.name, number }),
      active: true,
      version: 1,
    },
    { action: "product.create", label: number },
  );
  return { id, number, warnings };
}

/** PRD-007 optimistic concurrency; PRD-E13 a base-unit change clears the extra units only when confirmed. */
export async function updateProduct(
  ctx: ModelCtx,
  id: Id<"products">,
  expectedVersion: number,
  input: ProductInput,
  opts: { confirmClearExtraUnits?: boolean } = {},
): Promise<{ warnings: FieldIssue[] }> {
  const p = await getProduct(ctx, id);
  if (p.version !== expectedVersion) versionConflict();
  let extraUnits = input.extraUnits;
  if (baseUnitChangeClearsExtraUnits(p.unitCode, input.unitCode, p.extraUnits) && sameUnits(extraUnits, p.extraUnits)) {
    if (!opts.confirmClearExtraUnits) {
      throw appError(
        "invalid_input",
        "Die Basiseinheit wurde geändert. Die Zusatzeinheiten beziehen sich auf die alte Einheit und werden entfernt.",
        { reason: "EXTRA_UNITS_CLEAR_CONFIRM", field: "unitCode" },
      );
    }
    extraUnits = [];
  }
  const { fields, warnings } = await fieldsFrom(ctx, { ...input, extraUnits });
  let number = p.number;
  if (input.number && normalizeProductNumber(input.number) !== p.numberNormalized) {
    if (await numberTaken(ctx, input.number, id)) fail(productNumberTaken(input.number));
    number = input.number.trim();
  }
  const cleared = Object.fromEntries(REMOVABLE.filter((k) => !(k in fields)).map((k) => [k, undefined]));
  await auditedPatch(
    ctx,
    "products",
    id,
    {
      ...cleared,
      ...fields,
      number,
      numberNormalized: normalizeProductNumber(number),
      searchText: productSearchText({ name: fields.name, number }),
      version: p.version + 1,
    } as Partial<ProductDoc>,
    { action: "product.update", label: number },
  );
  return { warnings };
}

const sameUnits = (
  a: readonly { unitCode: string; factorMilli: number }[],
  b: readonly { unitCode: string; factorMilli: number }[],
) => a.length === b.length && a.every((u, i) => u.unitCode === b[i]?.unitCode && u.factorMilli === b[i]?.factorMilli);

/** PRD-072 archive / restore. */
export async function setProductActive(ctx: ModelCtx, id: Id<"products">, active: boolean): Promise<void> {
  const p = await getProduct(ctx, id);
  if (p.active === active) return;
  await auditedPatch(
    ctx,
    "products",
    id,
    { active, version: p.version + 1 },
    {
      action: active ? "product.unarchive" : "product.archive",
      label: p.number,
    },
  );
}

/**
 * PRD-073 references that block a delete: document lines (F04, drafts included). Recurring templates, time entries
 * and stock movements arrive with F11/P4 (each extends this count).
 */
export async function productUsageCount(ctx: ReadCtx, id: Id<"products">): Promise<number> {
  const lines = await ctx.db
    .query("documentLines")
    .withIndex("by_product", (q) => q.eq("productId", id))
    .collect();
  return new Set(lines.map((l) => l.documentId)).size;
}

export async function customerPricesOf(ctx: ReadCtx, productId: Id<"products">) {
  return ctx.db
    .query("customerPrices")
    .withIndex("by_product_contact_validFrom", (q) => q.eq("productId", productId))
    .collect();
}

export async function deleteProduct(ctx: ModelCtx, id: Id<"products">): Promise<void> {
  const p = await getProduct(ctx, id);
  const n = await productUsageCount(ctx, id);
  if (n > 0) {
    throw appError("invalid_input", `Das Produkt wird in ${n} Dokumenten verwendet und kann nur archiviert werden.`, {
      reason: "PRODUCT_IN_USE",
    });
  }
  for (const cp of await customerPricesOf(ctx, id)) {
    await auditedDelete(ctx, "customerPrices", cp._id, { action: "product.customer_price.delete", label: p.number });
  }
  await auditedDelete(ctx, "products", id, { action: "product.delete", label: p.number });
}

// ── customer prices (PRD-030) ───────────────────────────────────────────────────────────────────────────
export async function saveCustomerPrice(
  ctx: ModelCtx,
  productId: Id<"products">,
  values: { contactId: string; priceMode: "net" | "gross"; unitPriceMicros: number; validFrom?: string },
  priceId?: Id<"customerPrices">,
): Promise<Id<"customerPrices">> {
  const p = await getProduct(ctx, productId);
  const contactId = ctx.db.normalizeId("contacts", values.contactId);
  const contact = contactId ? await ctx.db.get(contactId) : null;
  if (!contactId || !contact || contact.mergedIntoId) {
    fail({ code: "CONTACT_UNKNOWN", message: "Bitte einen gültigen Kontakt wählen.", field: "contactId" });
  }
  if (contact.dsgvo?.restrictedAt !== undefined) {
    fail({ code: "CONTACT_RESTRICTED", message: "Der Kontakt ist nach DSGVO eingeschränkt.", field: "contactId" });
  }
  // One row per (product, contact, validFrom): the history is several rows with different dates.
  const dup = await ctx.db
    .query("customerPrices")
    .withIndex("by_product_contact_validFrom", (q) =>
      q.eq("productId", productId).eq("contactId", contactId).eq("validFrom", values.validFrom),
    )
    .first();
  if (dup && dup._id !== priceId) {
    fail({
      code: "CUSTOMER_PRICE_DUPLICATE",
      message: "Für diesen Kontakt gibt es bereits einen Preis mit diesem Gültigkeitsdatum.",
      field: "validFrom",
    });
  }
  const row = {
    productId,
    contactId,
    unitPriceMicros: values.unitPriceMicros,
    priceMode: values.priceMode,
    ...(values.validFrom ? { validFrom: values.validFrom } : {}),
  };
  if (priceId) {
    const existing = await ctx.db.get(priceId);
    if (!existing || existing.productId !== productId) throw appError("not_found", "Kundenpreis nicht gefunden.");
    await auditedPatch(
      ctx,
      "customerPrices",
      priceId,
      { ...row, validFrom: values.validFrom },
      {
        action: "product.customer_price.update",
        label: p.number,
      },
    );
    return priceId;
  }
  return auditedInsert(ctx, "customerPrices", row, { action: "product.customer_price.create", label: p.number });
}

export async function removeCustomerPrice(ctx: ModelCtx, priceId: Id<"customerPrices">): Promise<void> {
  const row = await ctx.db.get(priceId);
  if (!row) throw appError("not_found", "Kundenpreis nicht gefunden.");
  const p = await getProduct(ctx, row.productId);
  await auditedDelete(ctx, "customerPrices", priceId, { action: "product.customer_price.delete", label: p.number });
}

// ── scheduled price change (PRD-031) ─────────────────────────────────────────────────────────────────────
export async function setScheduledPrice(
  ctx: ModelCtx,
  id: Id<"products">,
  values: { validFrom: string; priceMode: "net" | "gross"; unitPriceMicros: number } | null,
): Promise<void> {
  const p = await getProduct(ctx, id);
  if (values) {
    const today = berlinCalendarDate(ctx.now());
    if (values.validFrom <= today) {
      fail({
        code: "DATE_NOT_IN_FUTURE",
        message: "Der neue Preis muss ab einem künftigen Datum gelten.",
        field: "validFrom",
      });
    }
  }
  await auditedPatch(
    ctx,
    "products",
    id,
    { scheduledPrice: values ?? undefined, version: p.version + 1 },
    { action: values ? "product.price_schedule" : "product.price_schedule_cancel", label: p.number },
  );
}

/** Cron `products.applyScheduledPrices` (daily 00:05 Europe/Berlin): due scheduled prices become the price. */
export async function applyScheduledPrices(ctx: ModelCtx, today: CalendarDate): Promise<number> {
  let n = 0;
  for (const p of await ctx.db.query("products").collect()) {
    if (!p.scheduledPrice || p.scheduledPrice.validFrom > today) continue;
    await auditedPatch(
      ctx,
      "products",
      p._id,
      {
        priceMode: p.scheduledPrice.priceMode,
        unitPriceMicros: p.scheduledPrice.unitPriceMicros,
        scheduledPrice: undefined,
        version: p.version + 1,
      },
      { action: "product.price_apply", label: p.number, reason: `Neuer Preis ab ${p.scheduledPrice.validFrom}` },
    );
    n++;
  }
  return n;
}

// ── categories (PRD-060/061) ─────────────────────────────────────────────────────────────────────────────
export async function listCategories(ctx: ReadCtx): Promise<Doc<"productCategories">[]> {
  return ctx.db.query("productCategories").collect();
}

const nodes = (rows: readonly Doc<"productCategories">[]): CategoryNode[] =>
  rows.map((c) => ({ id: c._id, name: c.name, ...(c.parentId ? { parentId: c.parentId } : {}) }));

export async function categoryPathOf(ctx: ReadCtx, id: Id<"productCategories"> | undefined): Promise<string> {
  return id ? categoryPath(id, nodes(await listCategories(ctx))) : "";
}

export async function seedCategories(ctx: ModelCtx): Promise<number> {
  const rows = await listCategories(ctx);
  let n = 0;
  for (const name of SEED_CATEGORIES) {
    if (rows.some((r) => r.parentId === undefined && r.name === name)) continue;
    await auditedInsert(ctx, "productCategories", { name }, { action: "product.category.create", label: name });
    n++;
  }
  return n;
}

export async function saveCategory(
  ctx: ModelCtx,
  values: { name: string; parentId: string },
  categoryId?: Id<"productCategories">,
): Promise<Id<"productCategories">> {
  const all = await listCategories(ctx);
  const parentId = values.parentId
    ? (ctx.db.normalizeId("productCategories", values.parentId) ?? undefined)
    : undefined;
  if (values.parentId && (!parentId || !all.some((c) => c._id === parentId))) {
    fail({ code: "CATEGORY_UNKNOWN", message: "Unbekannte Kategorie.", field: "parentId" });
  }
  const issue = validateCategory(
    { ...(categoryId ? { id: categoryId } : {}), name: values.name, parentId },
    nodes(all),
  );
  if (issue) fail(issue);
  const name = values.name.trim();
  if (categoryId) {
    if (!all.some((c) => c._id === categoryId)) throw appError("not_found", "Kategorie nicht gefunden.");
    await auditedPatch(
      ctx,
      "productCategories",
      categoryId,
      { name, parentId },
      {
        action: "product.category.update",
        label: name,
      },
    );
    return categoryId;
  }
  return auditedInsert(
    ctx,
    "productCategories",
    { name, ...(parentId ? { parentId } : {}) },
    {
      action: "product.category.create",
      label: name,
    },
  );
}

/** PRD-061 / T-PRD-043: products and children move to the parent (or none) — never orphans. */
export async function deleteCategory(
  ctx: ModelCtx,
  categoryId: Id<"productCategories">,
  target: "parent" | "none" | undefined,
): Promise<void> {
  const all = await listCategories(ctx);
  const cat = all.find((c) => c._id === categoryId);
  if (!cat) throw appError("not_found", "Kategorie nicht gefunden.");
  const products = await ctx.db
    .query("products")
    .withIndex("by_category", (q) => q.eq("categoryId", categoryId))
    .collect();
  const plan = planCategoryDelete(categoryId, nodes(all), products.length, target);
  if ("error" in plan) fail(plan.error);
  const moveTo = plan.moveTo as Id<"productCategories"> | undefined;
  for (const childId of plan.children) {
    await auditedPatch(
      ctx,
      "productCategories",
      childId as Id<"productCategories">,
      { parentId: moveTo },
      {
        action: "product.category.update",
        label: cat.name,
      },
    );
  }
  for (const p of products) {
    await auditedPatch(
      ctx,
      "products",
      p._id,
      { categoryId: moveTo, version: p.version + 1 },
      {
        action: "product.update",
        label: p.number,
      },
    );
  }
  await auditedDelete(ctx, "productCategories", categoryId, { action: "product.category.delete", label: cat.name });
}

/** PRD-084 / T-PRD-041: resolves "Waren > Kabel", creating missing levels (max depth 3). */
export async function ensureCategoryPath(ctx: ModelCtx, path: string): Promise<Id<"productCategories"> | undefined> {
  if (!path.trim()) return undefined;
  const r = resolveCategoryPath(path, nodes(await listCategories(ctx)));
  if ("error" in r) fail(r.error);
  let parent = r.existingId as Id<"productCategories"> | undefined;
  for (const name of r.toCreate) {
    parent = await saveCategory(ctx, { name, parentId: parent ?? "" });
  }
  return parent;
}

// ── shared lookups ──────────────────────────────────────────────────────────────────────────────────────
/** SET-090 delete guard: products using the unit as base or extra unit. */
export async function productsUsingUnit(ctx: ReadCtx, code: string): Promise<number> {
  return (await ctx.db.query("products").collect()).filter(
    (p) => p.unitCode === code || p.extraUnits.some((u) => u.unitCode === code),
  ).length;
}

/** SET-094: deleting a tag removes it from every product. */
export async function removeTagFromProducts(ctx: ModelCtx, tagId: Id<"tags">) {
  for (const p of await ctx.db.query("products").collect()) {
    if (!p.tags.includes(tagId)) continue;
    await auditedPatch(
      ctx,
      "products",
      p._id,
      { tags: p.tags.filter((t) => t !== tagId), version: p.version + 1 },
      {
        action: "product.tag.remove",
        label: p.number,
      },
    );
  }
}
