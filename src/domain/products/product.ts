/**
 * Product master data (F03 §3.1, §5.1; 03 §3 `products`): enums, number normalisation, the generic-name warning
 * (PRD-004, UST-07), default units by type (PRD-005), GTIN check digit (PRD-008) and the field validation shared by
 * the zod schema and the Convex model (which adds context: active units, existing numbers, categories).
 */
import { type FieldIssue, fieldIssue, type Validation } from "../contacts/core";
import { isExemptionReasonCode } from "../rules/exemption-reasons";
import { isRc13bType } from "../rules/rc13b-types";
import { isVatRateKey } from "../rules/vat-rates";
import { sanitizeTemplateHtml } from "../templates/sanitize";

export const PRODUCT_TYPES = ["service", "good"] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

export const PRODUCT_TYPE_LABELS: Readonly<Record<ProductType, string>> = { service: "Dienstleistung", good: "Ware" };

export const PRICE_MODES = ["net", "gross"] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

/** 03 §0.2 `PlaceOfSupplyRule` (services only; absent = general). */
export const PLACE_OF_SUPPLY_RULES = [
  "general",
  "property",
  "event_admission",
  "restaurant",
  "short_term_vehicle_rental",
  "passenger_transport",
  "catalogue_3a4",
  "electronic",
] as const;
export type PlaceOfSupplyRule = (typeof PLACE_OF_SUPPLY_RULES)[number];

export const PLACE_OF_SUPPLY_LABELS: Readonly<Record<PlaceOfSupplyRule, string>> = {
  general: "Allgemein (§ 3a Abs. 1/2 UStG)",
  property: "Grundstücksleistung (§ 3a Abs. 3 Nr. 1 UStG)",
  event_admission: "Eintrittsberechtigung zu Veranstaltungen (§ 3a Abs. 3 Nr. 5 UStG)",
  restaurant: "Restaurant- und Verpflegungsleistung (§ 3a Abs. 3 Nr. 3 Buchst. b UStG)",
  short_term_vehicle_rental: "Kurzfristige Vermietung von Beförderungsmitteln (§ 3a Abs. 3 Nr. 2 UStG)",
  passenger_transport: "Personenbeförderung (§ 3b Abs. 1 UStG)",
  catalogue_3a4: "Katalogleistung an Nicht-EU-Privatkunden (§ 3a Abs. 4 UStG)",
  electronic: "Elektronische Dienstleistung (§ 3a Abs. 5 UStG)",
};

/** PRD-005: default unit by type. */
export const defaultUnitFor = (type: ProductType): string => (type === "good" ? "C62" : "HUR");

/** PRD-002: 1–50 printable characters; compared case-insensitively. */
export const PRODUCT_NUMBER_RE = /^[\x21-\x7E -￿](?:[\x20-\x7E -￿]{0,48}[\x21-\x7E -￿])?$/;
export const normalizeProductNumber = (n: string): string => n.trim().toUpperCase();

export const productNumberTaken = (number: string): FieldIssue =>
  fieldIssue("number", "PRODUCT_NUMBER_TAKEN", `Die Artikelnummer ${number} ist bereits vergeben.`, { number });

const GENERIC = new Set(["diverses", "leistung", "pauschale", "sonstiges", "artikel", "ware", "dienstleistung"]);

/** PRD-004 / T-PRD-026: a generic-only name (also with trailing punctuation) is too vague for § 14 Abs. 4 Nr. 5 UStG. */
export function genericNameWarning(name: string): FieldIssue | null {
  const core = name
    .trim()
    .replace(/[.,;:!?…\-–\s]+$/u, "")
    .toLowerCase();
  if (!GENERIC.has(core)) return null;
  return fieldIssue(
    "name",
    "GENERIC_NAME",
    `„${name.trim()}“ ist zu allgemein. Rechnungen brauchen eine handelsübliche Bezeichnung (§ 14 Abs. 4 Nr. 5 UStG).`,
  );
}

/** PRD-008: GTIN-8/12/13/14 with the GS1 mod-10 check digit. */
export function isValidGtin(value: string): boolean {
  const v = value.trim();
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(v)) return false;
  const digits = [...v].map(Number);
  const check = digits.pop() as number;
  const sum = digits.reverse().reduce((acc, d, i) => acc + d * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

/** PRD-003: sanitised rich text (bold, italic, lists) — the template sanitiser of F01 SET-081 (one implementation). */
export const sanitizeDescription = (html: string): string => sanitizeTemplateHtml(html);

export const MAX_EXTRA_UNITS = 10;

export interface ExtraUnit {
  readonly unitCode: string;
  readonly factorMilli: number;
}

export interface ProductFields {
  readonly name: string;
  readonly number?: string | undefined;
  readonly description?: string | undefined;
  readonly internalNote?: string | undefined;
  readonly type: ProductType;
  readonly unitCode: string;
  readonly gtin?: string | undefined;
  readonly priceMode: PriceMode;
  readonly unitPriceMicros: number;
  readonly purchasePriceMicros?: number | undefined;
  readonly vatRateKey: string;
  readonly exemptionReasonCode?: string | undefined;
  readonly placeOfSupplyRule?: PlaceOfSupplyRule | undefined;
  readonly reverseCharge13b?: string | undefined;
  /** PRD-050..053: revenue account override (domestic lines only, PRD-051). */
  readonly revenueAccountOverride?: string | undefined;
  readonly laborCostShareBp?: number | undefined;
  readonly extraUnits: readonly ExtraUnit[];
}

export const MAX_PRICE_MICROS = 999_999_999_999;

/** §5.1 rules without context; `activeUnits` adds the unit check (PRD-006). */
export function validateProductFields(p: ProductFields, activeUnits?: ReadonlySet<string>): Validation {
  const errors: FieldIssue[] = [];
  const warnings: FieldIssue[] = [];
  const name = p.name.trim();
  if (name.length === 0 || name.length > 200) {
    errors.push(
      fieldIssue(
        "name",
        name.length === 0 ? "REQUIRED" : "TOO_LONG",
        name.length === 0 ? "Bitte einen Produktnamen angeben." : "Der Text ist zu lang (max. 200 Zeichen).",
      ),
    );
  } else {
    const g = genericNameWarning(name);
    if (g) warnings.push(g);
  }
  const number = (p.number ?? "").trim();
  if (number && !PRODUCT_NUMBER_RE.test(number)) {
    errors.push(
      fieldIssue("number", "PRODUCT_NUMBER_INVALID", "Die Artikelnummer darf 1–50 druckbare Zeichen enthalten."),
    );
  }
  if ((p.description ?? "").length > 5000) {
    errors.push(fieldIssue("description", "TOO_LONG", "Die Beschreibung ist zu lang (max. 5.000 Zeichen)."));
  }
  if ((p.internalNote ?? "").length > 5000) {
    errors.push(fieldIssue("internalNote", "TOO_LONG", "Der Text ist zu lang (max. 5.000 Zeichen)."));
  }
  if (!p.unitCode || (activeUnits && !activeUnits.has(p.unitCode))) {
    errors.push(fieldIssue("unitCode", "UNIT_INVALID", "Bitte eine gültige Einheit auswählen."));
  }
  if (p.gtin && !isValidGtin(p.gtin)) {
    errors.push(fieldIssue("gtin", "GTIN_INVALID", "Die GTIN ist ungültig (Prüfziffer stimmt nicht)."));
  }
  if (Math.abs(p.unitPriceMicros) > MAX_PRICE_MICROS) {
    errors.push(fieldIssue("price", "PRICE_OUT_OF_RANGE", "Der Preis liegt außerhalb des zulässigen Bereichs."));
  } else if (p.unitPriceMicros === 0) {
    warnings.push(fieldIssue("price", "PRICE_ZERO", "Der Preis ist 0,00 €."));
  } else if (p.unitPriceMicros < 0) {
    warnings.push(
      fieldIssue(
        "price",
        "PRICE_NEGATIVE",
        "Negativer Preis: Bitte die steuerliche Behandlung prüfen (z. B. Gutscheine, Pfand).",
      ),
    );
  }
  if (p.purchasePriceMicros !== undefined && (p.purchasePriceMicros < 0 || p.purchasePriceMicros > MAX_PRICE_MICROS)) {
    errors.push(
      fieldIssue("purchasePrice", "PRICE_OUT_OF_RANGE", "Der Preis liegt außerhalb des zulässigen Bereichs."),
    );
  }
  if (!isVatRateKey(p.vatRateKey)) {
    errors.push(fieldIssue("vatRateKey", "VAT_KEY_INVALID", "Unbekannter Steuersatz-Schlüssel."));
  } else if (p.vatRateKey === "exempt" && !p.exemptionReasonCode) {
    errors.push(
      fieldIssue(
        "exemptionReasonCode",
        "EXEMPTION_REASON_REQUIRED",
        "Für steuerfreie Produkte ist ein Befreiungsgrund (§ 4 UStG) erforderlich.",
      ),
    );
  } else if (p.vatRateKey !== "exempt" && p.exemptionReasonCode) {
    errors.push(
      fieldIssue(
        "exemptionReasonCode",
        "EXEMPTION_REASON_NOT_ALLOWED",
        "Ein Befreiungsgrund ist nur bei steuerfreien Produkten möglich.",
      ),
    );
  } else if (p.exemptionReasonCode && !isExemptionReasonCode(p.exemptionReasonCode)) {
    errors.push(
      fieldIssue(
        "exemptionReasonCode",
        "EXEMPTION_REASON_INVALID",
        "Unbekannter Befreiungsgrund. Bitte einen Befreiungsgrund aus der Liste wählen.",
      ),
    );
  }
  if (p.placeOfSupplyRule && p.placeOfSupplyRule !== "general" && p.type === "good") {
    errors.push(
      fieldIssue(
        "placeOfSupplyRule",
        "PLACE_OF_SUPPLY_SERVICES_ONLY",
        "Die Leistungsort-Regel gilt nur für Dienstleistungen.",
      ),
    );
  }
  if (p.reverseCharge13b && !isRc13bType(p.reverseCharge13b)) {
    errors.push(
      fieldIssue("reverseCharge13b", "RC13B_TYPE_UNKNOWN", "Unbekannte Art der Steuerschuldnerschaft nach § 13b UStG."),
    );
  }
  if (p.laborCostShareBp !== undefined) {
    if (!Number.isInteger(p.laborCostShareBp) || p.laborCostShareBp < 0 || p.laborCostShareBp > 10000) {
      errors.push(
        fieldIssue("laborCostShare", "OUT_OF_RANGE", "Der Arbeitskostenanteil muss zwischen 0 und 100 % liegen."),
      );
    } else if (p.laborCostShareBp > 0 && p.type === "good") {
      warnings.push(
        fieldIssue(
          "laborCostShare",
          "LABOR_ON_GOOD",
          "Arbeitskosten bei Waren: Ist das Produkt eine Handwerkerleistung?",
        ),
      );
    }
  }
  if (p.extraUnits.length > MAX_EXTRA_UNITS) {
    errors.push(fieldIssue("extraUnits", "EXTRA_UNIT_LIMIT", "Höchstens 10 Zusatzeinheiten."));
  }
  const seen = new Set<string>();
  p.extraUnits.forEach((u, i) => {
    if (u.unitCode === p.unitCode || seen.has(u.unitCode)) {
      errors.push(
        fieldIssue(
          `extraUnits.${i}.unitCode`,
          "EXTRA_UNIT_DUPLICATE",
          "Jede Zusatzeinheit darf nur einmal vorkommen und nicht der Basiseinheit entsprechen.",
        ),
      );
    }
    seen.add(u.unitCode);
    if (!Number.isInteger(u.factorMilli) || u.factorMilli <= 0) {
      errors.push(
        fieldIssue(`extraUnits.${i}.factor`, "EXTRA_UNIT_FACTOR", "Der Umrechnungsfaktor muss größer als 0 sein."),
      );
    }
    if (activeUnits && !activeUnits.has(u.unitCode)) {
      errors.push(fieldIssue(`extraUnits.${i}.unitCode`, "UNIT_INVALID", "Bitte eine gültige Einheit auswählen."));
    }
  });
  if (p.vatRateKey === "restaurant_food") {
    warnings.push(
      fieldIssue(
        "vatRateKey",
        "RESTAURANT_DRINKS_HINT",
        "Getränke bitte als eigenes Produkt mit dem Standardsatz anlegen.",
      ),
    );
  }
  return { errors, warnings };
}

/**
 * PRD-E13: changing the base unit clears the extra units (their factors refer to the old base) — the caller asks
 * for confirmation first.
 */
export function baseUnitChangeClearsExtraUnits(
  beforeUnit: string,
  afterUnit: string,
  extraUnits: readonly ExtraUnit[],
) {
  return beforeUnit !== afterUnit && extraUnits.length > 0;
}

export const productInUse = (n: number): FieldIssue =>
  fieldIssue(
    undefined,
    "PRODUCT_IN_USE",
    `Das Produkt wird in ${n} Dokumenten verwendet und kann nur archiviert werden.`,
    { n },
  );
