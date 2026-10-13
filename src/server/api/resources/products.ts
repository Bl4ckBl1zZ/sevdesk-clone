import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId, encodeOptionalId } from "@/domain/api/ids";
import { scaledToDecimal } from "@/domain/schemas/api/common";
import {
  categoryOut,
  type ProductWireRecord,
  productCreateToForm,
  productCreateWire,
  productFieldMapper,
  productList,
  productListQuery,
  productOut,
  productPatchToForm,
  productPatchWire,
  resolvedPriceOut,
  resolvePriceQuery,
  serializeProduct,
} from "@/domain/schemas/api/products";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { idParams, nextCursor, paginationOpts, rawId, requireVersion, updatedSince, versionField } from "./shared";

export async function loadProduct(convex: ConvexCaller, id: string) {
  const row = await convex.query(api.productsApi.get, { id });
  if (!row) throw new ApiProblem("not_found", { detail: "Produkt nicht gefunden." });
  return serializeProduct(row.product as unknown as ProductWireRecord, row.today);
}

const warnings = z.array(z.object({ code: z.string(), message: z.string() }));
const productWithMeta = productOut.extend({ meta: z.object({ warnings }).optional() }).meta({ id: "ProductWithMeta" });
const patchBody = productPatchWire.extend({ version: versionField }).strict().meta({ id: "ProductPatchRequest" });
const categoryList = z
  .object({ data: z.array(categoryOut), next_cursor: z.null() })
  .meta({ id: "ProductCategoryList" });

/** 05 §4.2 / F03 §7.1 products (this slice: list, get, create, update, archive, price, categories). */
export const productsResource = defineResource("products", "Produkte und Leistungen", [
  defineEndpoint({
    method: "GET",
    path: "/products",
    operationId: "listProducts",
    summary: "Produkte auflisten",
    description: "Filter `q`, `active` (Standard: nur aktive), `type`, `category_id`, `updated_since`.",
    tag: "Produkte",
    scope: "products:read",
    query: productListQuery,
    response: { status: 200, schema: productList, description: "Eine Seite Produkte" },
    handler: async ({ convex, query }) => {
      const since = updatedSince(query);
      const page = await convex.query(api.productsApi.list, {
        paginationOpts: paginationOpts(query),
        ...(query.q ? { q: query.q } : {}),
        active: query.active === undefined ? (since === undefined ? true : undefined) : query.active === "true",
        ...(query.type ? { type: query.type } : {}),
        ...(query.category_id ? { categoryId: rawId("productCategories", query.category_id) } : {}),
        ...(since !== undefined ? { updatedSince: since } : {}),
      });
      return {
        body: {
          data: page.page.map((r) => serializeProduct(r.product as unknown as ProductWireRecord, r.today)),
          next_cursor: nextCursor(page),
        },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/products",
    operationId: "createProduct",
    summary: "Produkt anlegen",
    description: "`unit_price` als Dezimalstring mit Punkt (≤ 4 Nachkommastellen). `Idempotency-Key` wird unterstützt.",
    tag: "Produkte",
    scope: "products:write",
    body: productCreateWire,
    response: { status: 201, schema: productWithMeta, description: "Angelegt" },
    errors: ["validation_failed", "number_collision", "idempotency_key_reused"],
    fieldMapper: productFieldMapper,
    handler: async ({ convex, body }) => {
      const r = await convex.mutation(api.products.create, { values: productCreateToForm(body) });
      const product = await loadProduct(convex, r.id);
      return {
        status: 201,
        body: { ...product, meta: { warnings: r.warnings.map((message) => ({ code: "warning", message })) } },
        headers: { Location: `/api/v1/products/${product.id}` },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/products/{id}",
    operationId: "getProduct",
    summary: "Produkt abrufen",
    tag: "Produkte",
    scope: "products:read",
    params: idParams("products"),
    response: { status: 200, schema: productOut, description: "Das Produkt" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => ({ body: await loadProduct(convex, rawId("products", params.id)) }),
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/products/{id}",
    operationId: "updateProduct",
    summary: "Produkt ändern",
    description: "Nur die übergebenen Felder werden geändert; `version` (oder `If-Match`) ist Pflicht.",
    tag: "Produkte",
    scope: "products:write",
    params: idParams("products"),
    body: patchBody,
    response: { status: 200, schema: productWithMeta, description: "Das geänderte Produkt" },
    errors: ["not_found", "validation_failed", "version_conflict", "number_collision"],
    fieldMapper: productFieldMapper,
    handler: async ({ convex, params, body, ifMatch }) => {
      const { version: bodyVersion, ...fields } = body;
      const version = requireVersion(ifMatch, bodyVersion);
      const id = rawId("products", params.id);
      const r = await convex.mutation(api.productsApi.patch, { id, version, values: productPatchToForm(fields) });
      return { body: { ...(await loadProduct(convex, id)), meta: { warnings: r.warnings } } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/products/{id}/archive",
    operationId: "archiveProduct",
    summary: "Produkt archivieren",
    description: "Reversibel; archivierte Produkte sind in neuen Belegen nicht wählbar.",
    tag: "Produkte",
    scope: "products:write",
    params: idParams("products"),
    response: { status: 200, schema: productOut, description: "Das archivierte Produkt" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      const id = rawId("products", params.id);
      await convex.mutation(api.productsApi.archive, { id });
      return { body: await loadProduct(convex, id) };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/products/{id}/price",
    operationId: "resolveProductPrice",
    summary: "Preis ermitteln",
    description: "Kundenpreis → Preis der Organisation → Grundpreis, Einheit, Netto/Brutto am Stichtag (PRD-032).",
    tag: "Produkte",
    scope: "products:read",
    params: idParams("products"),
    query: resolvePriceQuery,
    response: { status: 200, schema: resolvedPriceOut, description: "Ermittelter Preis" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params, query }) => {
      const r = await convex.query(api.productsApi.resolvePrice, {
        id: rawId("products", params.id),
        ...(query.contact_id ? { contactId: rawId("contacts", query.contact_id) } : {}),
        ...(query.date ? { date: query.date } : {}),
        ...(query.unit_code ? { unitCode: query.unit_code } : {}),
        ...(query.price_mode ? { priceMode: query.price_mode } : {}),
      });
      return {
        body: {
          unit_price: scaledToDecimal(r.unitPriceMicros, 4),
          unit_price_micros: r.unitPriceMicros,
          price_mode: r.priceMode,
          source: r.source,
          unit_code: r.unitCode,
          vat_rate_key: r.vatRateKey,
          rate_bp: r.rateBp,
          category: r.category,
          warnings: r.warnings,
        },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/product-categories",
    operationId: "listProductCategories",
    summary: "Produktkategorien",
    tag: "Produkte",
    scope: "products:read",
    response: { status: 200, schema: categoryList, description: "Alle Kategorien mit Pfad" },
    handler: async ({ convex }) => ({
      body: {
        data: (await convex.query(api.productsApi.categories, {})).map((c) => ({
          id: encodeId("productCategories", c._id),
          name: c.name,
          parent_id: encodeOptionalId("productCategories", c.parentId),
          path: c.path,
        })),
        next_cursor: null,
      },
    }),
  }),
]);
