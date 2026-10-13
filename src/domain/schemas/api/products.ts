import { z } from "zod";
import type {} from "zod-openapi";
import { decodeId, encodeId, encodeOptionalId } from "../../api/ids";
import { snakeCase } from "../../api/problems";
import { formatBasisPoints, formatMicros, formatMilli } from "../../money/format";
import { PLACE_OF_SUPPLY_RULES, PRICE_MODES, PRODUCT_TYPES } from "../../products/product";
import { emptyProductForm, type ProductFormValues } from "../products";
import {
  decimalString,
  decimalToScaled,
  instant,
  isoDate,
  listEnvelope,
  listQuery,
  prefixedId,
  scaledToDecimal,
  toInstant,
} from "./common";

/**
 * Products on the wire (05 §4.2, F03 §7.1): snake_case; unit prices as decimal strings with a dot and ≤ 4 decimals
 * (`"95.0000"`) plus the integer `*_micros` next to them; factors with ≤ 3 decimals; rates in basis points. The
 * wire maps onto the product form (src/domain/schemas/products.ts), so REST, MCP and the UI share one validation.
 */

const str = (max: number) => z.string().max(max);

const productFieldsWire = {
  number: str(40).optional().meta({ description: "Leer = aus dem Nummernkreis vergeben" }),
  name: str(200).optional(),
  description: str(5000).optional(),
  internal_note: str(5000).optional(),
  type: z.enum(PRODUCT_TYPES).optional(),
  unit_code: str(3).optional().meta({ description: "UN/ECE Rec. 20 (z. B. HUR, C62, DAY)", example: "HUR" }),
  gtin: str(14).optional(),
  price_mode: z.enum(PRICE_MODES).optional().meta({ description: "Seite, auf der der Preis eingegeben wurde" }),
  unit_price: decimalString(4, "Einzelpreis (Dezimalstring, ≤ 4 Nachkommastellen)", "95.0000").optional(),
  purchase_price: decimalString(4, "Einkaufspreis netto", "40.0000").nullable().optional(),
  vat_rate_key: str(40).optional().meta({ example: "standard" }),
  exemption_reason_code: str(40).optional(),
  place_of_supply_rule: z.enum(["", ...PLACE_OF_SUPPLY_RULES]).optional(),
  reverse_charge_13b: str(40).optional(),
  labor_cost_share_bp: z.number().int().min(0).max(10_000).nullable().optional(),
  category_id: prefixedId("productCategories").nullable().optional(),
  extra_units: z
    .array(z.object({ unit_code: str(3), factor: decimalString(3, "Faktor zur Basiseinheit", "8") }))
    .max(10)
    .optional(),
  tags: z.array(prefixedId("tags")).optional(),
  custom_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
};

export const productPatchWire = z.object(productFieldsWire).strict().meta({ id: "ProductPatch" });
export type ProductPatchWire = z.infer<typeof productPatchWire>;

export const productCreateWire = z
  .object({ ...productFieldsWire, name: str(200), unit_price: productFieldsWire.unit_price.unwrap() })
  .strict()
  .meta({ id: "ProductCreate" });
export type ProductCreateWire = z.infer<typeof productCreateWire>;

const micros = (v: string) => {
  const m = decimalToScaled(v, 4);
  return m === null ? v : formatMicros(m);
};
const milli = (v: string) => {
  const m = decimalToScaled(v, 3);
  return m === null ? v : formatMilli(m);
};

/** The form fields a (partial) wire product sets; prices become German input strings for the shared parser. */
export function productPatchToForm(w: ProductPatchWire): Partial<ProductFormValues> {
  const out: Partial<ProductFormValues> = {};
  if (w.number !== undefined) out.number = w.number;
  if (w.name !== undefined) out.name = w.name;
  if (w.description !== undefined) out.description = w.description;
  if (w.internal_note !== undefined) out.internalNote = w.internal_note;
  if (w.type !== undefined) out.type = w.type;
  if (w.unit_code !== undefined) out.unitCode = w.unit_code;
  if (w.gtin !== undefined) out.gtin = w.gtin;
  if (w.price_mode !== undefined) out.priceMode = w.price_mode;
  if (w.unit_price !== undefined) out.price = micros(w.unit_price);
  if (w.purchase_price !== undefined) out.purchasePrice = w.purchase_price === null ? "" : micros(w.purchase_price);
  if (w.vat_rate_key !== undefined) out.vatRateKey = w.vat_rate_key;
  if (w.exemption_reason_code !== undefined) out.exemptionReasonCode = w.exemption_reason_code;
  if (w.place_of_supply_rule !== undefined) out.placeOfSupplyRule = w.place_of_supply_rule;
  if (w.reverse_charge_13b !== undefined) out.reverseCharge13b = w.reverse_charge_13b;
  if (w.labor_cost_share_bp !== undefined) {
    out.laborCostShare = w.labor_cost_share_bp === null ? "" : formatBasisPoints(w.labor_cost_share_bp);
  }
  if (w.category_id !== undefined) {
    out.categoryId = w.category_id === null ? "" : (decodeId("productCategories", w.category_id) ?? "");
  }
  if (w.extra_units !== undefined) {
    out.extraUnits = w.extra_units.map((u) => ({ unitCode: u.unit_code, factor: milli(u.factor) }));
  }
  if (w.tags !== undefined) out.tags = w.tags.map((t) => decodeId("tags", t) ?? "");
  if (w.custom_fields !== undefined) out.customFields = w.custom_fields;
  return out;
}

export function productCreateToForm(w: ProductCreateWire, defaults: { vatRateKey?: string } = {}): ProductFormValues {
  const type = w.type ?? "service";
  return { ...emptyProductForm({ type, ...defaults }), ...productPatchToForm(w) };
}

const FORM_TO_WIRE: Readonly<Record<string, string>> = {
  price: "unit_price",
  purchasePrice: "purchase_price",
  laborCostShare: "labor_cost_share_bp",
  reverseCharge13b: "reverse_charge_13b",
};

export function productFieldMapper(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split(".").filter((p) => p !== "values");
  if (parts.length === 0) return undefined;
  return parts
    .map((p) => FORM_TO_WIRE[p] ?? (/^\d+$/.test(p) ? `[${p}]` : snakeCase(p)))
    .join(".")
    .replace(/\.\[/g, "[");
}

// ── record → wire ────────────────────────────────────────────────────────────────────────────────────
const priceOut = z
  .object({
    mode: z.enum(PRICE_MODES),
    unit_price: z.string().meta({ example: "95.0000" }),
    unit_price_micros: z.number().int(),
    net_micros_today: z.number().int(),
    gross_micros_today: z.number().int(),
    rate_bp_today: z.number().int(),
  })
  .meta({ id: "ProductPrice", description: "Preis heute (Steuersatz des heutigen Tages, PRD-012)" });

export const productOut = z
  .object({
    id: prefixedId("products"),
    object: z.literal("product"),
    number: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    internal_note: z.string().nullable(),
    type: z.enum(PRODUCT_TYPES),
    unit_code: z.string(),
    gtin: z.string().nullable(),
    price: priceOut,
    purchase_price: z.string().nullable(),
    vat_rate_key: z.string(),
    exemption_reason_code: z.string().nullable(),
    place_of_supply_rule: z.string().nullable(),
    reverse_charge_13b: z.string().nullable(),
    labor_cost_share_bp: z.number().int().nullable(),
    category_id: prefixedId("productCategories").nullable(),
    extra_units: z.array(z.object({ unit_code: z.string(), factor: z.string(), factor_milli: z.number().int() })),
    scheduled_price: z
      .object({ valid_from: isoDate, mode: z.enum(PRICE_MODES), unit_price: z.string(), unit_price_micros: z.number() })
      .nullable(),
    tags: z.array(prefixedId("tags")),
    custom_fields: z.record(z.string(), z.unknown()),
    active: z.boolean(),
    version: z.number().int(),
    created_at: instant,
    updated_at: instant,
  })
  .meta({ id: "Product" });
export type ProductOut = z.infer<typeof productOut>;
export const productList = listEnvelope(productOut, "ProductList");

export const productListQuery = listQuery.extend({
  q: z.string().max(200).optional(),
  active: z.enum(["true", "false"]).optional().meta({ description: "Standard: nur aktive" }),
  type: z.enum(PRODUCT_TYPES).optional(),
  category_id: prefixedId("productCategories").optional(),
});

export interface ProductWireRecord {
  _id: string;
  _creationTime: number;
  number: string;
  name: string;
  description?: string | undefined;
  internalNote?: string | undefined;
  type: (typeof PRODUCT_TYPES)[number];
  unitCode: string;
  gtin?: string | undefined;
  priceMode: (typeof PRICE_MODES)[number];
  unitPriceMicros: number;
  scheduledPrice?: { validFrom: string; priceMode: (typeof PRICE_MODES)[number]; unitPriceMicros: number } | undefined;
  purchasePriceMicros?: number | undefined;
  vatRateKey: string;
  exemptionReasonCode?: string | undefined;
  placeOfSupplyRule?: string | undefined;
  reverseCharge13b?: string | undefined;
  laborCostShareBp?: number | undefined;
  categoryId?: string | undefined;
  extraUnits: { unitCode: string; factorMilli: number }[];
  tags: string[];
  customFields: Record<string, unknown>;
  active: boolean;
  version: number;
  updatedAt?: number | undefined;
}

export interface PriceToday {
  netMicros: number;
  grossMicros: number;
  rateBp: number;
}

const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export function serializeProduct(p: ProductWireRecord, today: PriceToday): ProductOut {
  return {
    id: encodeId("products", p._id),
    object: "product",
    number: p.number,
    name: p.name,
    description: n(p.description),
    internal_note: n(p.internalNote),
    type: p.type,
    unit_code: p.unitCode,
    gtin: n(p.gtin),
    price: {
      mode: p.priceMode,
      unit_price: scaledToDecimal(p.unitPriceMicros, 4),
      unit_price_micros: p.unitPriceMicros,
      net_micros_today: today.netMicros,
      gross_micros_today: today.grossMicros,
      rate_bp_today: today.rateBp,
    },
    purchase_price: p.purchasePriceMicros === undefined ? null : scaledToDecimal(p.purchasePriceMicros, 4),
    vat_rate_key: p.vatRateKey,
    exemption_reason_code: n(p.exemptionReasonCode),
    place_of_supply_rule: n(p.placeOfSupplyRule),
    reverse_charge_13b: n(p.reverseCharge13b),
    labor_cost_share_bp: n(p.laborCostShareBp),
    category_id: encodeOptionalId("productCategories", p.categoryId),
    extra_units: p.extraUnits.map((u) => ({
      unit_code: u.unitCode,
      factor: scaledToDecimal(u.factorMilli, 3),
      factor_milli: u.factorMilli,
    })),
    scheduled_price: p.scheduledPrice
      ? {
          valid_from: p.scheduledPrice.validFrom,
          mode: p.scheduledPrice.priceMode,
          unit_price: scaledToDecimal(p.scheduledPrice.unitPriceMicros, 4),
          unit_price_micros: p.scheduledPrice.unitPriceMicros,
        }
      : null,
    tags: p.tags.map((t) => encodeId("tags", t)),
    custom_fields: p.customFields,
    active: p.active,
    version: p.version,
    created_at: toInstant(p._creationTime),
    updated_at: toInstant(p.updatedAt ?? p._creationTime),
  };
}

export const categoryOut = z
  .object({
    id: prefixedId("productCategories"),
    name: z.string(),
    parent_id: prefixedId("productCategories").nullable(),
    path: z.string(),
  })
  .meta({ id: "ProductCategory" });

export const resolvePriceQuery = z.object({
  contact_id: prefixedId("contacts").optional(),
  date: isoDate.optional().meta({ description: "Stichtag (Standard: heute)" }),
  unit_code: z.string().max(3).optional(),
  price_mode: z.enum(PRICE_MODES).optional(),
});

export const resolvedPriceOut = z
  .object({
    unit_price: z.string(),
    unit_price_micros: z.number().int(),
    price_mode: z.enum(PRICE_MODES),
    source: z.string().meta({ description: "customer | parent_customer | base" }),
    unit_code: z.string(),
    vat_rate_key: z.string(),
    rate_bp: z.number().int(),
    category: z.string(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .meta({ id: "ResolvedPrice" });

/** Compact row for MCP `product_search` (F03 §7.2). */
export function productSearchRow(p: ProductWireRecord, today: PriceToday) {
  return {
    id: encodeId("products", p._id),
    number: p.number,
    name: p.name,
    unit_code: p.unitCode,
    price_mode: p.priceMode,
    net_today: scaledToDecimal(today.netMicros, 4),
    gross_today: scaledToDecimal(today.grossMicros, 4),
    vat_rate_key: p.vatRateKey,
    active: p.active,
  };
}
