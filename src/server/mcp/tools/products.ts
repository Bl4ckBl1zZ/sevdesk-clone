import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId, encodeOptionalId } from "@/domain/api/ids";
import { formatMicros } from "@/domain/money/format";
import { PRICE_MODES, PRODUCT_TYPES } from "@/domain/products/product";
import { decimalString, decimalToScaled, scaledToDecimal } from "@/domain/schemas/api/common";
import {
  type ProductWireRecord,
  productCreateToForm,
  productCreateWire,
  productFieldMapper,
  productPatchToForm,
  productPatchWire,
  productSearchRow,
} from "@/domain/schemas/api/products";
import { ApiProblem } from "../../api/http";
import { loadProduct } from "../../api/resources/products";
import { rawId } from "../../api/resources/shared";
import { defineTool } from "../tool";

const productId = z.string().meta({ description: "Produkt-ID (prd_…)" });

/** F03 §7.2 / 06 §3.3 product tools (stock P4 excluded). */
export const productTools = [
  defineTool({
    name: "product_search",
    title: "Produkte suchen",
    description:
      "Sucht Produkte/Leistungen (Name, Nummer). Liefert ID, Nummer, Name, Einheit, Netto/Brutto heute, Steuerschlüssel.",
    kind: "read",
    scopes: ["products:read"],
    input: z.object({
      query: z.string().max(200).optional(),
      type: z.enum(PRODUCT_TYPES).optional(),
      include_archived: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(2000).optional(),
    }),
    handler: async (a, { convex }) => {
      const page = await convex.query(api.productsApi.list, {
        paginationOpts: { numItems: a.limit ?? 20, cursor: a.cursor ?? null },
        ...(a.query ? { q: a.query } : {}),
        ...(a.include_archived ? {} : { active: true }),
        ...(a.type ? { type: a.type } : {}),
      });
      return {
        data: page.page.map((r) => productSearchRow(r.product as unknown as ProductWireRecord, r.today)),
        next_cursor: page.isDone ? null : page.continueCursor,
      };
    },
  }),
  defineTool({
    name: "product_get",
    title: "Produkt abrufen",
    description: "Vollständiges Produkt inkl. Preis heute, Zusatzeinheiten und geplanter Preisänderung.",
    kind: "read",
    scopes: ["products:read"],
    input: z.object({ id: productId }),
    handler: async ({ id }, { convex }) => loadProduct(convex, rawId("products", id)),
  }),
  defineTool({
    name: "product_upsert",
    title: "Produkt anlegen oder ändern",
    description:
      'Mit `id` (oder vorhandener `number`): ändert die übergebenen Felder (version Pflicht bei id). Sonst neu anlegen. Preise als Dezimalstring mit Punkt ("95.00"). Gibt Warnungen zurück (z. B. Preis 0).',
    kind: "write",
    scopes: ["products:write"],
    fieldMapper: productFieldMapper,
    input: z.object({
      id: productId.optional(),
      version: z.number().int().min(1).optional(),
      product: z.record(z.string(), z.unknown()).meta({
        description: "Felder wie bei POST/PATCH /products: name, unit_price, unit_code, vat_rate_key, type, …",
      }),
    }),
    handler: async ({ id, version, product }, { convex }) => {
      if (id) {
        const fields = productPatchWire.safeParse(product);
        if (!fields.success) throw new ApiProblem("validation_failed", { detail: fields.error.issues[0]?.message });
        if (version === undefined) {
          throw new ApiProblem("validation_failed", {
            errors: [{ code: "version_required", field: "version", message: "Bitte version aus product_get angeben." }],
          });
        }
        const raw = rawId("products", id);
        const r = await convex.mutation(api.productsApi.patch, {
          id: raw,
          version,
          values: productPatchToForm(fields.data),
        });
        return { product: await loadProduct(convex, raw), created: false, warnings: r.warnings };
      }
      const body = productCreateWire.safeParse(product);
      if (!body.success) throw new ApiProblem("validation_failed", { detail: body.error.issues[0]?.message });
      const r = await convex.mutation(api.products.create, { values: productCreateToForm(body.data) });
      return {
        product: await loadProduct(convex, r.id),
        created: true,
        warnings: r.warnings.map((message) => ({ code: "warning", message })),
      };
    },
  }),
  defineTool({
    name: "product_set_customer_price",
    title: "Kundenpreis setzen",
    description: "Sonderpreis eines Kunden für ein Produkt (optional ab Datum).",
    kind: "write",
    scopes: ["products:write"],
    input: z.object({
      id: productId,
      contact_id: z.string().meta({ description: "con_…" }),
      unit_price: decimalString(4, "Preis", "80.00"),
      price_mode: z.enum(PRICE_MODES).optional(),
      valid_from: z.string().optional().meta({ description: "YYYY-MM-DD" }),
    }),
    handler: async (a, { convex }) => {
      const productRaw = rawId("products", a.id);
      const contactRaw = rawId("contacts", a.contact_id);
      if (!(await convex.query(api.contactsApi.get, { id: contactRaw }))) throw new ApiProblem("not_found");
      const micros = decimalToScaled(a.unit_price, 4);
      const priceId = await convex.mutation(api.products.saveCustomerPrice, {
        productId: productRaw as never,
        values: {
          contactId: contactRaw,
          priceMode: a.price_mode ?? "net",
          price: micros === null ? a.unit_price : formatMicros(micros),
          validFrom: a.valid_from ?? "",
        },
      });
      return {
        customer_price_id: encodeId("customerPrices", String(priceId)),
        product: await loadProduct(convex, productRaw),
      };
    },
  }),
  defineTool({
    name: "product_resolve_price",
    title: "Preis ermitteln",
    description: "Preis für Kunde, Datum, Einheit und Preismodus (Kundenpreis → Organisation → Grundpreis, PRD-032).",
    kind: "read",
    scopes: ["products:read"],
    input: z.object({
      id: productId,
      contact_id: z.string().optional(),
      date: z.string().optional(),
      unit_code: z.string().optional(),
      price_mode: z.enum(PRICE_MODES).optional(),
    }),
    handler: async (a, { convex }) => {
      const r = await convex.query(api.productsApi.resolvePrice, {
        id: rawId("products", a.id),
        ...(a.contact_id ? { contactId: rawId("contacts", a.contact_id) } : {}),
        ...(a.date ? { date: a.date } : {}),
        ...(a.unit_code ? { unitCode: a.unit_code } : {}),
        ...(a.price_mode ? { priceMode: a.price_mode } : {}),
      });
      return {
        unit_price: scaledToDecimal(r.unitPriceMicros, 4),
        unit_price_micros: r.unitPriceMicros,
        price_mode: r.priceMode,
        source: r.source,
        unit_code: r.unitCode,
        vat_rate_key: r.vatRateKey,
        rate_bp: r.rateBp,
        warnings: r.warnings,
      };
    },
  }),
  defineTool({
    name: "product_list_categories",
    title: "Produktkategorien",
    description: "Alle Kategorien mit Pfad.",
    kind: "read",
    scopes: ["products:read"],
    input: z.object({}),
    handler: async (_a, { convex }) => ({
      data: (await convex.query(api.productsApi.categories, {})).map((c) => ({
        id: encodeId("productCategories", c._id),
        name: c.name,
        parent_id: encodeOptionalId("productCategories", c.parentId),
        path: c.path,
      })),
    }),
  }),
  defineTool({
    name: "product_archive",
    title: "Produkt archivieren",
    description: "Archiviert ein Produkt (reversibel; in neuen Belegen nicht mehr wählbar). Kein Löschen über MCP.",
    kind: "write",
    scopes: ["products:write"],
    idempotent: true,
    input: z.object({ id: productId }),
    handler: async ({ id }, { convex }) => {
      const raw = rawId("products", id);
      await convex.mutation(api.productsApi.archive, { id: raw });
      return loadProduct(convex, raw);
    },
  }),
];
