/**
 * Product CSV import mapping and export (F03 PRD-080…085, §5.5): header aliases (incl. sevdesk article export headers,
 * UNSURE until owner samples exist), unit aliases (PRD-081), VAT key or percentage (PRD-082), one price column per row
 * in German or international notation (PRD-083), category paths (PRD-084). Match key: `number` (PRD-080).
 */
import { type FieldIssue, fieldIssue, foldSearch } from "../contacts/core";
import { netToGrossMicros } from "../money/convert";
import { UNIT_CODES } from "../rules/unit-codes";
import { isVatRateKey } from "../rules/vat-rates";
import { parseUnitPrice } from "./pricing";

export const PRODUCT_IMPORT_FIELDS = [
  "number",
  "name",
  "description",
  "type",
  "unit",
  "netPrice",
  "grossPrice",
  "purchasePrice",
  "vat",
  "exemptionReasonCode",
  "category",
  "gtin",
  "laborCostShare",
  "tags",
  "internalNote",
] as const;
export type ProductImportField = (typeof PRODUCT_IMPORT_FIELDS)[number];

export const PRODUCT_IMPORT_FIELD_LABELS: Readonly<Record<ProductImportField, string>> = {
  number: "Artikelnummer",
  name: "Name",
  description: "Beschreibung",
  type: "Typ (Ware/Dienstleistung)",
  unit: "Einheit",
  netPrice: "VK netto",
  grossPrice: "VK brutto",
  purchasePrice: "EK netto",
  vat: "Steuersatz",
  exemptionReasonCode: "Befreiungsgrund (VATEX)",
  category: "Kategorie",
  gtin: "GTIN",
  laborCostShare: "Arbeitskostenanteil (%)",
  tags: "Tags",
  internalNote: "Interne Notiz",
};

const ALIASES: Readonly<Record<string, ProductImportField>> = Object.fromEntries(
  (
    [
      ["number", ["artikelnummer", "artikel-nr", "artikel-nr.", "art.-nr.", "art-nr", "nummer", "nr", "sku", "number"]],
      ["name", ["name", "bezeichnung", "artikel", "artikelname", "produkt", "titel"]],
      ["description", ["beschreibung", "text", "langtext", "description"]],
      ["type", ["typ", "art", "artikeltyp", "type"]],
      ["unit", ["einheit", "mengeneinheit", "unit"]],
      ["netPrice", ["vk netto", "verkaufspreis netto", "preis netto", "nettopreis", "preis", "net price"]],
      ["grossPrice", ["vk brutto", "verkaufspreis brutto", "preis brutto", "bruttopreis", "gross price"]],
      ["purchasePrice", ["ek netto", "einkaufspreis", "einkaufspreis netto", "ek", "purchase price"]],
      ["vat", ["steuersatz", "ust", "ust.", "mwst", "mwst.", "umsatzsteuer", "steuer", "vat", "vat rate"]],
      ["exemptionReasonCode", ["befreiungsgrund", "vatex", "steuerbefreiung"]],
      ["category", ["kategorie", "warengruppe", "category"]],
      ["gtin", ["gtin", "ean", "barcode"]],
      ["laborCostShare", ["arbeitskostenanteil", "lohnanteil", "35a"]],
      ["tags", ["tags", "schlagworte"]],
      ["internalNote", ["interne notiz", "interne bemerkung", "notiz", "bemerkung"]],
    ] as const
  ).flatMap(([field, names]) => names.map((n) => [foldSearch(n), field as ProductImportField])),
);

export function autoMapProductHeaders(headers: readonly string[]): (ProductImportField | null)[] {
  const used = new Set<ProductImportField>();
  return headers.map((h) => {
    const f = ALIASES[foldSearch(h)];
    if (!f || used.has(f)) return null;
    used.add(f);
    return f;
  });
}

/** PRD-081: unit labels → Rec 20 code (aliases win: "Stk" is also a Rec 20 code but means "Stück" here); Rec 20 codes pass through. */
const UNIT_ALIASES: Readonly<Record<string, string>> = {
  stk: "C62",
  "stk.": "C62",
  stuck: "C62",
  stueck: "C62",
  st: "C62",
  pc: "C62",
  pcs: "C62",
  std: "HUR",
  "std.": "HUR",
  stunde: "HUR",
  stunden: "HUR",
  h: "HUR",
  tag: "DAY",
  tage: "DAY",
  pauschal: "LS",
  pauschale: "LS",
  km: "KMT",
  m: "MTR",
  "m²": "MTK",
  m2: "MTK",
  qm: "MTK",
  "m³": "MTQ",
  m3: "MTQ",
  kg: "KGM",
  g: "GRM",
  l: "LTR",
  monat: "MON",
  monate: "MON",
  min: "MIN",
  minute: "MIN",
  minuten: "MIN",
  woche: "WEE",
  jahr: "ANN",
};

export function mapUnit(value: string): string | null {
  const v = value.trim();
  const alias = UNIT_ALIASES[v.toLowerCase()] ?? UNIT_ALIASES[foldSearch(v)];
  if (alias) return alias;
  return UNIT_CODES.has(v.toUpperCase()) ? v.toUpperCase() : null;
}

/**
 * PRD-082: key (`standard`, `reduced`, …) or a percentage: 19 → standard, 7 → reduced; 0 is ambiguous (PV or exempt)
 * and must be given as key; restaurant food only as key.
 */
export function mapVat(
  value: string,
  exemptionReasonCode: string,
  rowNumber: number,
): { key: string } | { error: string } {
  const v = value.trim().toLowerCase().replace(/\s*%$/, "").replace(",", ".");
  if (isVatRateKey(v)) return { key: v };
  if (v === "19" || v === "19.0" || v === "19.00") return { key: "standard" };
  if (v === "7" || v === "7.0" || v === "7.00") return { key: "reduced" };
  if (v === "0" || v === "0.0" || v === "0.00") {
    return exemptionReasonCode
      ? { key: "exempt" }
      : {
          error: `Zeile ${rowNumber}: 0 % ist mehrdeutig — bitte „zero“ (PV-Nullsatz) oder „exempt“ mit Befreiungsgrund angeben.`,
        };
  }
  return { error: `Zeile ${rowNumber}: Steuersatz „${value.trim()}“ unbekannt.` };
}

export interface ProductRowResult {
  readonly values?: {
    number: string;
    name: string;
    description: string;
    type: "service" | "good";
    unitCode: string;
    priceMode: "net" | "gross";
    unitPriceMicros: number;
    purchasePriceMicros?: number;
    vatRateKey: string;
    exemptionReasonCode?: string;
    categoryPath: string;
    gtin: string;
    laborCostShareBp?: number;
    tags: string[];
    internalNote: string;
  };
  readonly errors: FieldIssue[];
}

/** One CSV row → product values or row errors ("Zeile {n}: …", §5.5). `rateBpToday` checks net/gross consistency. */
export function productRow(
  row: readonly string[],
  mapping: readonly (ProductImportField | null)[],
  rowNumber: number,
  rateBpToday: (key: string) => number | undefined,
): ProductRowResult {
  const get = (f: ProductImportField) => {
    const i = mapping.indexOf(f);
    return i < 0 ? "" : (row[i] ?? "").trim();
  };
  const errors: FieldIssue[] = [];
  const fail = (field: string, code: string, message: string) =>
    errors.push(fieldIssue(field, code, `Zeile ${rowNumber}: ${message}`));
  const typeText = foldSearch(get("type"));
  const type: "service" | "good" = /^(ware|waren|good|goods|artikel|produkt)$/.test(typeText) ? "good" : "service";
  const unitRaw = get("unit");
  const unitCode = unitRaw ? mapUnit(unitRaw) : type === "good" ? "C62" : "HUR";
  if (!unitCode) fail("unit", "UNIT_INVALID", `Einheit „${unitRaw}“ unbekannt.`);
  const exemption = get("exemptionReasonCode");
  const vat = mapVat(get("vat") || "19", exemption, rowNumber);
  if ("error" in vat) errors.push(fieldIssue("vat", "VAT_KEY_INVALID", vat.error));
  const price = (field: "netPrice" | "grossPrice" | "purchasePrice") => {
    const raw = get(field);
    if (!raw) return undefined;
    const r = parseUnitPrice(raw);
    if (!r.ok) {
      fail(
        field,
        r.error.code,
        r.error.code === "PRICE_PRECISION" ? "Preise können höchstens 4 Nachkommastellen haben." : r.error.message,
      );
      return undefined;
    }
    return r.value;
  };
  const net = price("netPrice");
  const gross = price("grossPrice");
  const purchase = price("purchasePrice");
  const key = "key" in vat ? vat.key : undefined;
  if (net !== undefined && gross !== undefined && key) {
    const rate = rateBpToday(key);
    if (rate !== undefined && Math.abs(netToGrossMicros(net, rate) - gross) > 1) {
      fail(
        "grossPrice",
        "PRICE_INCONSISTENT",
        `Netto- und Bruttopreis passen nicht zusammen (${rate / 100} %). Bitte nur eine Spalte angeben.`,
      );
    }
  }
  const name = get("name");
  if (!name) fail("name", "REQUIRED", "Bitte einen Produktnamen angeben.");
  const laborRaw = get("laborCostShare").replace(/\s*%$/, "").replace(",", ".");
  let laborCostShareBp: number | undefined;
  if (laborRaw) {
    const n = Number(laborRaw);
    if (!Number.isFinite(n) || n < 0 || n > 100)
      fail("laborCostShare", "OUT_OF_RANGE", "Der Arbeitskostenanteil muss zwischen 0 und 100 % liegen.");
    else laborCostShareBp = Math.round(n * 100);
  }
  if (errors.length > 0 || !unitCode || !key) return { errors };
  return {
    errors,
    values: {
      number: get("number"),
      name,
      description: get("description"),
      type,
      unitCode,
      priceMode: net === undefined && gross !== undefined ? "gross" : "net",
      unitPriceMicros: net ?? gross ?? 0,
      ...(purchase !== undefined ? { purchasePriceMicros: purchase } : {}),
      vatRateKey: key,
      ...(exemption ? { exemptionReasonCode: exemption } : {}),
      categoryPath: get("category"),
      gtin: get("gtin"),
      ...(laborCostShareBp !== undefined ? { laborCostShareBp } : {}),
      tags: get("tags")
        .split(/[,;|]/)
        .map((t) => t.trim())
        .filter(Boolean),
      internalNote: get("internalNote"),
    },
  };
}

/** PRD-085 export columns. */
export const PRODUCT_EXPORT_HEADERS = [
  "Artikelnummer",
  "Name",
  "Typ",
  "Einheit",
  "Preismodus",
  "VK netto",
  "VK brutto",
  "Steuersatz-Schlüssel",
  "Steuersatz heute (%)",
  "Befreiungsgrund",
  "EK netto",
  "Marge (%)",
  "Kategorie",
  "Arbeitskostenanteil (%)",
  "GTIN",
  "Aktiv",
  "Tags",
  "Eigene Felder",
  "Zusatzeinheiten",
  "Beschreibung",
] as const;
