/**
 * Product schemas (F03 §5): the product form (price entered on one side, PRD-011/013), customer prices (PRD-030),
 * scheduled price changes (PRD-031) and categories (PRD-060). Shared by the product UI, the Convex mutations
 * (re-validated with context: active units, existing numbers, today) and later REST/MCP/CSV import.
 */
import { z } from "zod";
import type { FieldIssue } from "../contacts/core";
import { formatBasisPoints, formatMicros, formatMilli } from "../money/format";
import { parseMilli } from "../money/parse";
import { parseUnitPrice } from "../products/pricing";
import {
  PLACE_OF_SUPPLY_RULES,
  PRICE_MODES,
  PRODUCT_TYPES,
  type ProductFields,
  validateProductFields,
} from "../products/product";
import { isCalendarDate } from "../time/calendar-date";
import { percentToBp } from "./contacts";

const trimmed = () => z.string().trim();

function addIssues(ctx: z.RefinementCtx, issues: readonly FieldIssue[]) {
  for (const i of issues) {
    ctx.addIssue({
      code: "custom",
      path: i.field ? i.field.split(".") : [],
      message: i.message,
      params: { code: i.code },
    });
  }
}

const priceOrNaN = (v: string): number => {
  const r = parseUnitPrice(v);
  return r.ok ? r.value : Number.NaN;
};

const productObject = z.object({
  /** Empty = assign from the `product` number range (PRD-002). */
  number: trimmed(),
  name: trimmed(),
  description: z.string(),
  internalNote: z.string(),
  type: z.enum(PRODUCT_TYPES),
  unitCode: trimmed(),
  gtin: trimmed(),
  /** The side the price was entered on (PRD-011/013). */
  priceMode: z.enum(PRICE_MODES),
  price: trimmed(),
  purchasePrice: trimmed(),
  vatRateKey: trimmed(),
  exemptionReasonCode: trimmed(),
  placeOfSupplyRule: z.enum(["", ...PLACE_OF_SUPPLY_RULES]),
  reverseCharge13b: trimmed(),
  /** PRD-050: revenue account of the company chart (checked against the chart in the mutation); empty = default. */
  revenueAccountOverride: trimmed()
    .regex(/^(\d{4,8})?$/, "Bitte eine Kontonummer mit 4 bis 8 Ziffern angeben.")
    .optional(),
  /** Percent "60" or "62,5" (PRD-040). */
  laborCostShare: trimmed(),
  categoryId: trimmed(),
  extraUnits: z.array(z.object({ unitCode: trimmed(), factor: trimmed() })),
  tags: z.array(z.string()),
  customFields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
type ProductObject = z.output<typeof productObject>;

export interface ProductInput extends ProductFields {
  readonly number?: string;
  readonly description: string;
  readonly internalNote: string;
  readonly gtin?: string;
  readonly categoryId?: string;
  readonly tags: string[];
  readonly customFields: Record<string, string | number | boolean>;
}

export function toProductInput(v: ProductObject): ProductInput {
  const purchase = v.purchasePrice === "" ? undefined : priceOrNaN(v.purchasePrice);
  const labor = percentToBp(v.laborCostShare);
  return {
    ...(v.number ? { number: v.number } : {}),
    name: v.name,
    description: v.description,
    internalNote: v.internalNote,
    type: v.type,
    unitCode: v.unitCode,
    ...(v.gtin ? { gtin: v.gtin } : {}),
    priceMode: v.priceMode,
    unitPriceMicros: v.price === "" ? 0 : priceOrNaN(v.price),
    ...(purchase !== undefined ? { purchasePriceMicros: purchase } : {}),
    vatRateKey: v.vatRateKey,
    ...(v.exemptionReasonCode ? { exemptionReasonCode: v.exemptionReasonCode } : {}),
    ...(v.placeOfSupplyRule && v.type === "service" ? { placeOfSupplyRule: v.placeOfSupplyRule } : {}),
    ...(v.reverseCharge13b ? { reverseCharge13b: v.reverseCharge13b } : {}),
    ...(v.revenueAccountOverride ? { revenueAccountOverride: v.revenueAccountOverride } : {}),
    ...(labor !== undefined ? { laborCostShareBp: labor } : {}),
    ...(v.categoryId ? { categoryId: v.categoryId } : {}),
    extraUnits: v.extraUnits.map((u) => {
      const f = parseMilli(u.factor);
      return { unitCode: u.unitCode, factorMilli: f.ok ? f.value : Number.NaN };
    }),
    tags: v.tags,
    customFields: v.customFields,
  };
}

function refineProduct(v: ProductObject, ctx: z.RefinementCtx) {
  for (const field of ["price", "purchasePrice"] as const) {
    if (v[field] === "") continue;
    const r = parseUnitPrice(v[field]);
    if (!r.ok) ctx.addIssue({ code: "custom", path: [field], message: r.error.message });
    else if (field === "purchasePrice" && r.value < 0) {
      ctx.addIssue({ code: "custom", path: [field], message: "Der Einkaufspreis darf nicht negativ sein." });
    }
  }
  const input = toProductInput(v);
  if (Number.isNaN(input.laborCostShareBp)) {
    ctx.addIssue({
      code: "custom",
      path: ["laborCostShare"],
      message: "Der Arbeitskostenanteil muss zwischen 0 und 100 % liegen.",
    });
  }
  const checked: ProductFields = {
    ...input,
    unitPriceMicros: Number.isNaN(input.unitPriceMicros) ? 0 : input.unitPriceMicros,
    ...(Number.isNaN(input.purchasePriceMicros) || (input.purchasePriceMicros ?? 0) < 0
      ? { purchasePriceMicros: undefined }
      : {}),
    ...(Number.isNaN(input.laborCostShareBp) ? { laborCostShareBp: undefined } : {}),
    extraUnits: input.extraUnits.map((u) => ({ ...u, factorMilli: Number.isNaN(u.factorMilli) ? 0 : u.factorMilli })),
  };
  addIssues(ctx, validateProductFields(checked).errors);
}

export const productSchema = productObject.superRefine(refineProduct).transform(toProductInput);
export type ProductFormValues = z.input<typeof productSchema>;
export type ProductValues = z.output<typeof productSchema>;

export const emptyProductForm = (
  defaults: { type?: "service" | "good"; vatRateKey?: string } = {},
): ProductFormValues => {
  const type = defaults.type ?? "service";
  return {
    number: "",
    name: "",
    description: "",
    internalNote: "",
    type,
    unitCode: type === "good" ? "C62" : "HUR",
    gtin: "",
    priceMode: "net",
    price: "",
    purchasePrice: "",
    vatRateKey: defaults.vatRateKey ?? "standard",
    exemptionReasonCode: "",
    placeOfSupplyRule: "",
    reverseCharge13b: "",
    laborCostShare: "",
    categoryId: "",
    extraUnits: [],
    tags: [],
    customFields: {},
  };
};

/** The stored fields of a product the form edits (structural subset of `Doc<"products">`). */
export interface ProductRecord {
  number: string;
  name: string;
  description?: string | undefined;
  internalNote?: string | undefined;
  type: ProductFormValues["type"];
  unitCode: string;
  gtin?: string | undefined;
  priceMode: ProductFormValues["priceMode"];
  unitPriceMicros: number;
  purchasePriceMicros?: number | undefined;
  vatRateKey: string;
  exemptionReasonCode?: string | undefined;
  placeOfSupplyRule?: string | undefined;
  reverseCharge13b?: string | undefined;
  revenueAccountOverride?: string | undefined;
  laborCostShareBp?: number | undefined;
  categoryId?: string | undefined;
  extraUnits: readonly { unitCode: string; factorMilli: number }[];
  tags: readonly string[];
  customFields: Record<string, unknown>;
}

/** Form values of a stored product (prices back to German input strings); shared by the UI and REST/MCP PATCH. */
export function productFormFromRecord(p: ProductRecord): ProductFormValues {
  return {
    ...emptyProductForm(),
    number: p.number,
    name: p.name,
    description: p.description ?? "",
    internalNote: p.internalNote ?? "",
    type: p.type,
    unitCode: p.unitCode,
    gtin: p.gtin ?? "",
    priceMode: p.priceMode,
    price: formatMicros(p.unitPriceMicros),
    purchasePrice: p.purchasePriceMicros !== undefined ? formatMicros(p.purchasePriceMicros) : "",
    vatRateKey: p.vatRateKey,
    exemptionReasonCode: p.exemptionReasonCode ?? "",
    placeOfSupplyRule: (p.placeOfSupplyRule ?? "") as ProductFormValues["placeOfSupplyRule"],
    reverseCharge13b: p.reverseCharge13b ?? "",
    revenueAccountOverride: p.revenueAccountOverride ?? "",
    laborCostShare: p.laborCostShareBp !== undefined ? formatBasisPoints(p.laborCostShareBp) : "",
    categoryId: p.categoryId ?? "",
    extraUnits: p.extraUnits.map((u) => ({ unitCode: u.unitCode, factor: formatMilli(u.factorMilli) })),
    tags: [...p.tags],
    customFields: p.customFields as ProductFormValues["customFields"],
  };
}

/** PRD-030: one customer price row; `validFrom` empty = from the start. */
export const customerPriceSchema = z
  .object({
    contactId: trimmed().min(1, "Bitte einen Kontakt wählen."),
    priceMode: z.enum(PRICE_MODES),
    price: trimmed(),
    validFrom: trimmed().refine((v) => v === "" || isCalendarDate(v), "Ungültiges Datum."),
  })
  .superRefine((v, ctx) => {
    const r = parseUnitPrice(v.price);
    if (!r.ok) ctx.addIssue({ code: "custom", path: ["price"], message: r.error.message });
  })
  .transform((v) => ({
    contactId: v.contactId,
    priceMode: v.priceMode,
    unitPriceMicros: priceOrNaN(v.price),
    ...(v.validFrom ? { validFrom: v.validFrom } : {}),
  }));
export type CustomerPriceFormValues = z.input<typeof customerPriceSchema>;

/** PRD-031: "Neuer Preis ab {date}" — the date must be in the future (checked with `today` on the server). */
export const scheduledPriceSchema = z
  .object({
    validFrom: trimmed().refine(isCalendarDate, "Ungültiges Datum."),
    priceMode: z.enum(PRICE_MODES),
    price: trimmed(),
  })
  .superRefine((v, ctx) => {
    const r = parseUnitPrice(v.price);
    if (!r.ok) ctx.addIssue({ code: "custom", path: ["price"], message: r.error.message });
  })
  .transform((v) => ({ validFrom: v.validFrom, priceMode: v.priceMode, unitPriceMicros: priceOrNaN(v.price) }));
export type ScheduledPriceFormValues = z.input<typeof scheduledPriceSchema>;

/** PRD-060: name 1–60, optional parent (depth and sibling uniqueness need the tree: model). */
export const categorySchema = z.object({
  name: trimmed()
    .min(1, "Der Kategoriename muss 1 bis 60 Zeichen lang sein.")
    .max(60, "Der Kategoriename muss 1 bis 60 Zeichen lang sein."),
  parentId: trimmed(),
});
export type CategoryFormValues = z.input<typeof categorySchema>;
