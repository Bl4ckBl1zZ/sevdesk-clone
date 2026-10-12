/**
 * Product prices (F03 §3.2–3.6): input parsing with ≤ 4 decimals (PRD-010), net/gross derivation by the rate of a
 * reference date (PRD-011…013), extra units (PRD-035), price resolution for documents, API and MCP (`resolvePrice`,
 * PRD-032…034, PRD-015, PRD-022, PRD-031), the product key vs. the document tax case (PRD-023), margin (PRD-036/038),
 * the §35a labour/material split (PRD-041) and the line copy (PRD-070, PRD-051/053).
 */
import { type FieldIssue, fieldIssue } from "../contacts/core";
import { grossToNetMicros, netToGrossMicros, parseFxRate } from "../money/convert";
import { parseDecimal } from "../money/parse";
import { roundHalfAway } from "../money/rounding";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { RuleOverride, RuleRow } from "../rules/rule-table";
import { lookupVatRate, lookupVatRateForPeriod, type VatRateValue } from "../rules/vat-rates";
import type { TaxCase } from "../tax/tax-case";
import type { VatCategory } from "../tax/vat-category";
import type { CalendarDate } from "../time/calendar-date";
import { type ExtraUnit, MAX_PRICE_MICROS, type PriceMode } from "./product";

// ── input (PRD-010, T-PRD-031) ─────────────────────────────────────────────────────────────────────────
export type PriceIssueCode = "PRICE_INVALID" | "PRICE_PRECISION" | "PRICE_OUT_OF_RANGE";

/**
 * "1.234,5678" → 12345678 micros; "1234.5" → 12345000 (one dot and not exactly 3 decimals = decimal point, 04 §8);
 * "1.234" → 1234 € (German thousands); more than 4 decimals → PRICE_PRECISION (never rounded).
 */
export function parseUnitPrice(
  input: string,
  opts: { allowNegative?: boolean } = {},
): Result<number, Issue<PriceIssueCode>> {
  const t = input.trim().replace(/\s*€$/, "");
  const dots = (t.match(/\./g) ?? []).length;
  const fraction = t.split(".")[1] ?? "";
  const international = !t.includes(",") && dots === 1 && fraction.length !== 3;
  const r = parseDecimal(
    t,
    international ? { scale: 4, decimalSeparator: ".", grouping: false } : { scale: 4, decimalSeparator: "," },
  );
  if (!r.ok) {
    if (r.error.code === "amount_precision")
      return err(issue("PRICE_PRECISION", "Preise können höchstens 4 Nachkommastellen haben."));
    return err(issue("PRICE_INVALID", "Bitte einen gültigen Preis eingeben (z. B. 1.234,56)."));
  }
  const v = r.value;
  if (v > BigInt(MAX_PRICE_MICROS) || v < -BigInt(MAX_PRICE_MICROS) || (v < 0n && opts.allowNegative === false)) {
    return err(issue("PRICE_OUT_OF_RANGE", "Der Preis liegt außerhalb des zulässigen Bereichs."));
  }
  return ok(Number(v));
}

// ── net / gross (PRD-011…013) ──────────────────────────────────────────────────────────────────────────
/** Both views of a stored price at `rateBp`; the entered side is exact, the other derived (never stored). */
export function priceViews(priceMode: PriceMode, unitPriceMicros: number, rateBp: number) {
  return priceMode === "net"
    ? { netMicros: unitPriceMicros, grossMicros: netToGrossMicros(unitPriceMicros, rateBp) }
    : { netMicros: grossToNetMicros(unitPriceMicros, rateBp), grossMicros: unitPriceMicros };
}

export function convertPriceMode(micros: number, from: PriceMode, to: PriceMode, rateBp: number): number {
  if (from === to) return micros;
  return to === "gross" ? netToGrossMicros(micros, rateBp) : grossToNetMicros(micros, rateBp);
}

// ── extra units (PRD-035) ──────────────────────────────────────────────────────────────────────────────
/** round_half_up(base × factor / 1000) at 4 decimals (1.2345 × 100.000 → 123.4500; 0.3333 × 3.000 → 0.9999). */
export const extraUnitPriceMicros = (baseMicros: number, factorMilli: number): number =>
  Number(roundHalfAway(BigInt(baseMicros) * BigInt(factorMilli), 1000n));

// ── rate resolution (PRD-021/022) ──────────────────────────────────────────────────────────────────────
export type ReferenceDate = CalendarDate | { from: CalendarDate; to: CalendarDate };

export function resolveRate(
  key: string,
  ref: ReferenceDate,
  overrides: readonly RuleOverride<VatRateValue>[] = [],
): Result<RuleRow<VatRateValue>, Issue> {
  return typeof ref === "string"
    ? lookupVatRate(key, ref, overrides)
    : lookupVatRateForPeriod(key, ref.from, ref.to, overrides);
}

// ── price resolution (PRD-032) ─────────────────────────────────────────────────────────────────────────
export interface PricingProduct {
  readonly id: string;
  readonly active: boolean;
  readonly unitCode: string;
  readonly priceMode: PriceMode;
  readonly unitPriceMicros: number;
  readonly scheduledPrice?: { validFrom: string; priceMode: PriceMode; unitPriceMicros: number } | undefined;
  readonly purchasePriceMicros?: number | undefined;
  readonly vatRateKey: string;
  readonly extraUnits: readonly ExtraUnit[];
}

export interface CustomerPriceRow {
  readonly contactId: string;
  readonly unitPriceMicros: number;
  readonly priceMode: PriceMode;
  readonly validFrom?: string | undefined;
}

export interface ResolvePriceOptions {
  readonly contactId?: string | undefined;
  readonly parentContactId?: string | undefined;
  /** Customer prices of this product (restricted contacts already removed by the caller, PRD-E23). */
  readonly customerPrices: readonly CustomerPriceRow[];
  readonly referenceDate: ReferenceDate;
  readonly unitCode?: string | undefined;
  readonly documentPriceMode: PriceMode;
  readonly documentCurrency: string;
  /** "1 EUR = x FC" of the document (PRD-015). */
  readonly fxRate?: string | undefined;
  readonly contactDiscountBp?: number | undefined;
  /** Company setting „Kundenrabatt auch auf Kundenpreise“ (PRD-034, default off). */
  readonly discountOnCustomerPrices?: boolean;
  readonly rateOverrides?: readonly RuleOverride<VatRateValue>[];
}

export type PriceSource = "customer" | "parent_customer" | "base";

export interface ResolvedPrice {
  readonly unitPriceMicros: number;
  readonly priceMode: PriceMode;
  readonly source: PriceSource;
  readonly unitCode: string;
  readonly vatRateKey: string;
  readonly rateBp: number;
  readonly category: Extract<VatCategory, "S" | "Z" | "E">;
  readonly ruleRowId: string;
  readonly discountBp?: number;
  readonly warnings: FieldIssue[];
}

const refStart = (ref: ReferenceDate): string => (typeof ref === "string" ? ref : ref.from);

/** PRD-030: the row with the latest `validFrom` ≤ reference date; a row without `validFrom` applies from the start. */
export function applicableCustomerPrice(
  rows: readonly CustomerPriceRow[],
  contactId: string | undefined,
  refDate: string,
): CustomerPriceRow | undefined {
  if (!contactId) return undefined;
  return rows
    .filter((r) => r.contactId === contactId && (r.validFrom === undefined || r.validFrom <= refDate))
    .sort((a, b) => (a.validFrom ?? "").localeCompare(b.validFrom ?? ""))
    .at(-1);
}

/** PRD-031: base price on the reference date (a pending scheduled price already applies from its date). */
export function basePriceOn(p: PricingProduct, refDate: string): { priceMode: PriceMode; unitPriceMicros: number } {
  if (p.scheduledPrice && p.scheduledPrice.validFrom <= refDate) {
    return { priceMode: p.scheduledPrice.priceMode, unitPriceMicros: p.scheduledPrice.unitPriceMicros };
  }
  return { priceMode: p.priceMode, unitPriceMicros: p.unitPriceMicros };
}

/**
 * PRD-032: customer price of the contact → of its parent organisation (PRD-033) → base price; then the extra-unit
 * factor; then net/gross conversion to the document mode at the rate of the reference date; then the currency.
 */
export function resolvePrice(p: PricingProduct, o: ResolvePriceOptions): Result<ResolvedPrice, Issue> {
  const refDate = refStart(o.referenceDate);
  const rate = resolveRate(p.vatRateKey, o.referenceDate, o.rateOverrides);
  if (!rate.ok) return rate;
  const { rateBp, category } = rate.value.value;
  const own = applicableCustomerPrice(o.customerPrices, o.contactId, refDate);
  const parent = own ? undefined : applicableCustomerPrice(o.customerPrices, o.parentContactId, refDate);
  const chosen = own ?? parent;
  const source: PriceSource = own ? "customer" : parent ? "parent_customer" : "base";
  const base = chosen
    ? { priceMode: chosen.priceMode, unitPriceMicros: chosen.unitPriceMicros }
    : basePriceOn(p, refDate);
  let micros = base.unitPriceMicros;
  const warnings: FieldIssue[] = [];
  let unitCode = p.unitCode;
  if (o.unitCode && o.unitCode !== p.unitCode) {
    const extra = p.extraUnits.find((u) => u.unitCode === o.unitCode);
    if (!extra) return err(issue("UNIT_INVALID", "Bitte eine gültige Einheit auswählen.", { unitCode: o.unitCode }));
    micros = extraUnitPriceMicros(micros, extra.factorMilli);
    unitCode = extra.unitCode;
  }
  micros = convertPriceMode(micros, base.priceMode, o.documentPriceMode, rateBp);
  if (o.documentCurrency !== "EUR") {
    const fx = o.fxRate ? parseFxRate(o.fxRate) : undefined;
    if (!fx?.ok)
      return err(issue("FX_RATE_REQUIRED", "Für Fremdwährungsdokumente ist ein Umrechnungskurs erforderlich."));
    micros = Number(roundHalfAway(BigInt(micros) * fx.value.scaled, 1_000_000n));
  }
  if (!p.active) warnings.push(fieldIssue("productId", "PRODUCT_ARCHIVED", "Das Produkt ist archiviert."));
  if (base.unitPriceMicros === 0) warnings.push(fieldIssue("price", "PRICE_ZERO", "Der Preis ist 0,00 €."));
  if (p.vatRateKey === "zero") {
    warnings.push(
      fieldIssue(
        "vatRateKey",
        "PV_CONFIRMATION_REQUIRED",
        "Nullsteuersatz nur für Photovoltaikanlagen (≤ 30 kWp, Betreiber, Wohngebäude/öffentliches Gebäude) — Bestätigung im Dokument erforderlich.",
      ),
    );
  }
  const below = belowPurchaseWarning(p, base, rateBp);
  if (below) warnings.push(below);
  const discount =
    o.contactDiscountBp && o.contactDiscountBp > 0 && (source === "base" || o.discountOnCustomerPrices)
      ? { discountBp: o.contactDiscountBp }
      : {};
  return ok({
    unitPriceMicros: micros,
    priceMode: o.documentPriceMode,
    source,
    unitCode,
    vatRateKey: p.vatRateKey,
    rateBp,
    category,
    ruleRowId: rate.value.rowId,
    ...discount,
    warnings,
  });
}

// ── tax case vs. product key (PRD-023, PRD-051) ───────────────────────────────────────────────────────
const KEY_CASES: ReadonlySet<TaxCase> = new Set(["domestic", "exempt_4"]);

/** PRD-023: the product key applies only for domestic (and §4) tax cases; otherwise the document category wins. */
export function productKeyApplies(taxCase: TaxCase): { applies: true } | { applies: false; notice: string } {
  if (KEY_CASES.has(taxCase)) return { applies: true };
  return { applies: false, notice: `Produktsteuersatz wird wegen Steuerfall ${taxCase} nicht angewendet.` };
}

/** PRD-051: the revenue override applies to domestic lines (S, Z, E) only. */
export function revenueAccountForLine(category: VatCategory, override: string | undefined): string | undefined {
  return category === "S" || category === "Z" || category === "E" ? override : undefined;
}

// ── margin (PRD-036…038) ───────────────────────────────────────────────────────────────────────────────
export interface Margin {
  /** Effective cost: net purchase price, or gross for a Kleinunternehmer (no input-tax deduction). */
  readonly costMicros: number;
  readonly costLabel?: string;
  readonly marginMicros: number;
  /** (net sales − cost) / net sales; null when net sales are 0. */
  readonly marginBp: number | null;
  /** (net sales − cost) / cost; null when cost is 0. */
  readonly markupBp: number | null;
}

export function computeMargin(
  netSalesMicros: number,
  purchaseNetMicros: number,
  opts: { kleinunternehmer: boolean; standardRateBp: number },
): Margin {
  const cost = opts.kleinunternehmer ? netToGrossMicros(purchaseNetMicros, opts.standardRateBp) : purchaseNetMicros;
  const marginMicros = netSalesMicros - cost;
  const bp = (num: number, den: number) =>
    den === 0 ? null : Number(roundHalfAway(BigInt(num) * 10_000n, BigInt(den)));
  return {
    costMicros: cost,
    ...(opts.kleinunternehmer ? { costLabel: "inkl. nicht abziehbarer Vorsteuer" } : {}),
    marginMicros,
    marginBp: bp(marginMicros, netSalesMicros),
    markupBp: bp(marginMicros, cost),
  };
}

/** PRD-038: the sales price is below the purchase price (compared net). */
export function belowPurchaseWarning(
  p: Pick<PricingProduct, "purchasePriceMicros" | "vatRateKey">,
  price: { priceMode: PriceMode; unitPriceMicros: number },
  rateBp?: number,
): FieldIssue | null {
  if (p.purchasePriceMicros === undefined) return null;
  const net =
    price.priceMode === "net" || rateBp === undefined
      ? price.unitPriceMicros
      : grossToNetMicros(price.unitPriceMicros, rateBp);
  return net < p.purchasePriceMicros
    ? fieldIssue("price", "PRICE_BELOW_PURCHASE", "Verkaufspreis liegt unter dem Einkaufspreis.")
    : null;
}

// ── §35a labour share (PRD-040/041) ────────────────────────────────────────────────────────────────────
export interface SplitLine {
  readonly name: string;
  readonly unitPriceMicros: number;
  readonly isLaborCost: boolean;
}

/**
 * PRD-041: on B2C documents a product with 0 < share < 10000 becomes "{name} – Arbeitskosten" (price × share, half-up)
 * and "{name} – Material" (rest), so the sum is exact. B2B, 0 % and 100 % stay one line (100 % = labour).
 */
export function splitLaborMaterial(
  name: string,
  unitPriceMicros: number,
  laborCostShareBp: number | undefined,
  isConsumer: boolean,
): SplitLine[] {
  const share = laborCostShareBp ?? 0;
  if (!isConsumer || share <= 0 || share >= 10000) {
    return [{ name, unitPriceMicros, isLaborCost: share >= 10000 }];
  }
  const labour = Number(roundHalfAway(BigInt(unitPriceMicros) * BigInt(share), 10_000n));
  return [
    { name: `${name} – Arbeitskosten`, unitPriceMicros: labour, isLaborCost: true },
    { name: `${name} – Material`, unitPriceMicros: unitPriceMicros - labour, isLaborCost: false },
  ];
}
