/**
 * OCR post-validation (F06 INB-026, EC-INB-18, GOBD-03). Pure: the model output is **untrusted input** (INB-030) —
 * every value is re-parsed and checked here before it can prefill a voucher draft, and nothing is ever booked
 * without the owner's confirmation (T06-033).
 *
 *  - decimal strings → integer cents via `parseDecimal` (never floats); rates "19" / "19.00" / "7,0" → basis points;
 *  - Σ per-rate net + VAT = gross (a printed tip may come on top); VAT per rate = round(net × rate) ± 1 cent;
 *  - dates parse, invoice/supply dates are neither > 1 day in the future nor > 10 years old;
 *  - DE USt-IdNr check digit (ISO 7064 MOD 11,10), IBAN mod 97 (ibantools via src/domain/banking/iban.ts);
 *  - confidence = min(confidence of the required fields, arithmetic ok ? 1 : 0.5); < 0.9 → `needs_review` with the
 *    highlighted fields (the caller decides the status; ≥ 0.9 still needs confirmation).
 */
import { parseIban } from "../banking/iban";
import { parseDecimal } from "../money/parse";
import { vatCents as vatOf } from "../money/vat";
import type { ReceiptExtraction } from "../schemas/receipt-extraction";
import { validateVatId } from "../tax/vat-id";
import { addDays, type CalendarDate, isCalendarDate } from "../time/calendar-date";

/** Threshold below which an item is highlighted for review (INB-026). */
export const OCR_REVIEW_THRESHOLD = 0.9;
/** Required fields of the confidence formula (INB-026). */
export const OCR_REQUIRED_FIELDS = ["supplier.name", "invoiceDate", "totals.gross"] as const;

export const OCR_MESSAGES = {
  /** EC-INB-16 */
  disabled: "Automatische Belegerkennung ist deaktiviert.",
  /** EC-INB-17 */
  nonEu:
    "Der OCR-Dienst verarbeitet Daten außerhalb der EU. Auftragsverarbeitungsvertrag und § 146 Abs. 2b AO beachten.",
  /** EC-INB-18 */
  inconsistent: "Die erkannten Beträge sind nicht stimmig. Bitte prüfen.",
} as const;

export interface OcrIssue {
  code: string;
  field?: string;
  message: string;
}

export interface OcrPrefillLine {
  account: string;
  description?: string;
  amountCents: number;
  vatRateBp: number;
  vatCents?: number;
}

/** Assignable to the Convex `vVoucherDraftInput` (convex/voucherValidators.ts). */
export interface OcrPrefill {
  supplierName?: string;
  supplierVatId?: string;
  supplierTaxNumber?: string;
  supplierAddress?: string;
  supplierIban?: string;
  documentNumber?: string;
  documentDate?: string;
  supplyDate?: { kind: "date"; date: string } | { kind: "period"; from: string; to: string };
  dueDate?: string;
  currency?: string;
  priceMode?: "net" | "gross";
  lines?: OcrPrefillLine[];
  statedTotals?: { grossCents?: number; byRate?: { rateBp: number; netCents: number; vatCents: number }[] };
  skontoTerms?: { percentBp: number; days: number };
}

export interface OcrAssessment {
  confidence: number;
  arithmeticOk: boolean;
  issues: OcrIssue[];
  highlighted: string[];
  prefill: OcrPrefill;
  paymentHint: ReceiptExtraction["paymentHint"];
  isRestaurant: boolean;
  /** Searchable plain text of the extraction (INB-029; stored as `vouchers.ocr.text`, never in the file). */
  text: string;
}

// ── parsing ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Decimal string from the model → scaled bigint. The prompt asks for "1234.56"; German "1.234,56" and "1234,56"
 * are accepted too. With both separators the last one is the decimal separator; a lone "." is a decimal point.
 */
export function parseOcrDecimal(input: string | null | undefined, scale: number): bigint | null {
  if (input === null || input === undefined) return null;
  const s = input
    .replace(/\s+/g, "") // \s covers NBSP and narrow NBSP
    .replace(/(EUR|€|%)/gi, "")
    .trim();
  if (!s) return null;
  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSeparator: "," | "." = ".";
  let grouping = false;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSeparator = lastComma > lastDot ? "," : ".";
    grouping = true;
  } else if (lastComma >= 0) {
    decimalSeparator = ",";
  }
  const r = parseDecimal(s, { scale, decimalSeparator, grouping, currencySymbol: false });
  return r.ok ? r.value : null;
}

const toCents = (s: string | null | undefined): number | null => {
  const v = parseOcrDecimal(s, 2);
  return v === null || v > 9_999_999_999_999n || v < -9_999_999_999_999n ? null : Number(v);
};
const toBp = (s: string | null | undefined): number | null => {
  const v = parseOcrDecimal(s, 2);
  return v === null || v < 0n || v > 10_000n ? null : Number(v);
};

function checkDate(
  value: string | null,
  field: string,
  today: CalendarDate,
  issues: OcrIssue[],
  opts: { bounded: boolean },
): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const v = value.trim();
  if (!isCalendarDate(v)) {
    issues.push({ code: "ocr_date_invalid", field, message: `Das erkannte Datum „${v}“ ist ungültig.` });
    return undefined;
  }
  if (opts.bounded) {
    if (v > addDays(today, 1)) {
      issues.push({ code: "ocr_date_future", field, message: "Das erkannte Datum liegt in der Zukunft." });
      return undefined;
    }
    const tenYearsAgo = `${Number(today.slice(0, 4)) - 10}${today.slice(4)}`;
    if (v < tenYearsAgo) {
      issues.push({ code: "ocr_date_too_old", field, message: "Das erkannte Datum liegt mehr als 10 Jahre zurück." });
      return undefined;
    }
  }
  return v;
}

const clean = (s: string | null | undefined): string | undefined => {
  if (s === null || s === undefined) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: untrusted model output (INB-030)
  const t = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return t || undefined;
};

// ── assessment ──────────────────────────────────────────────────────────────────────────────────────────

export function postValidateExtraction(x: ReceiptExtraction, ctx: { today: string }): OcrAssessment {
  const today = ctx.today as CalendarDate;
  const issues: OcrIssue[] = [];
  const bad = new Set<string>();
  const prefill: OcrPrefill = {};

  // Supplier
  const supplierName = clean(x.supplier.name);
  if (supplierName) prefill.supplierName = supplierName;
  const address = clean(x.supplier.address);
  if (address) prefill.supplierAddress = address;
  const taxNumber = clean(x.supplier.taxNumber);
  if (taxNumber) prefill.supplierTaxNumber = taxNumber;
  const rawVat = clean(x.supplier.vatId)
    ?.toUpperCase()
    .replace(/[\s.-]/g, "");
  if (rawVat) {
    const r = validateVatId(rawVat);
    if (r.ok) prefill.supplierVatId = r.value.vatId;
    else if (rawVat.startsWith("DE") || r.error.code === "vat_id_checksum") {
      issues.push({ code: "ocr_vat_id_invalid", field: "supplier.vatId", message: r.error.message });
      bad.add("supplier.vatId");
    } else prefill.supplierVatId = rawVat; // non-EU / unknown format: kept as printed, checked at booking
  }
  const rawIban = clean(x.supplier.iban);
  if (rawIban) {
    const r = parseIban(rawIban);
    if (r.ok) prefill.supplierIban = r.value.iban;
    else {
      issues.push({ code: "ocr_iban_invalid", field: "supplier.iban", message: r.error.message });
      bad.add("supplier.iban");
    }
  }

  // Header
  const number = clean(x.invoiceNumber);
  if (number) prefill.documentNumber = number;
  const invoiceDate = checkDate(x.invoiceDate, "invoiceDate", today, issues, { bounded: true });
  if (invoiceDate) prefill.documentDate = invoiceDate;
  else if (x.invoiceDate) bad.add("invoiceDate");
  const from = x.supplyPeriod
    ? checkDate(x.supplyPeriod.from, "supplyPeriod", today, issues, { bounded: true })
    : undefined;
  const to = x.supplyPeriod
    ? checkDate(x.supplyPeriod.to, "supplyPeriod", today, issues, { bounded: true })
    : undefined;
  const supplyDate = checkDate(x.supplyDate, "supplyDate", today, issues, { bounded: true });
  if (from && to && from <= to) prefill.supplyDate = { kind: "period", from, to };
  else if (supplyDate) prefill.supplyDate = { kind: "date", date: supplyDate };
  if (x.supplyPeriod && !(from && to && from <= to)) bad.add("supplyPeriod");
  if (x.supplyDate && !supplyDate) bad.add("supplyDate");
  const dueDate = checkDate(x.dueDate, "dueDate", today, issues, { bounded: false });
  if (dueDate) prefill.dueDate = dueDate;
  else if (x.dueDate) bad.add("dueDate");
  if (/^[A-Z]{3}$/.test(x.currency)) prefill.currency = x.currency;

  // Amounts (arithmetic self-check)
  let arithmeticOk = true;
  const inconsistent = (field: string) => {
    arithmeticOk = false;
    bad.add(field);
  };
  const gross = toCents(x.totals.gross);
  if (gross === null) {
    issues.push({
      code: "ocr_amount_invalid",
      field: "totals.gross",
      message: "Der erkannte Bruttobetrag ist ungültig.",
    });
    inconsistent("totals.gross");
  }
  const tip = toCents(x.hospitality.tip) ?? 0;
  const byRate: { rateBp: number; netCents: number; vatCents: number }[] = [];
  x.vatLines.forEach((l, i) => {
    const rateBp = toBp(l.ratePercent);
    const net = toCents(l.net);
    const vat = toCents(l.vat);
    if (rateBp === null || net === null || vat === null) {
      issues.push({
        code: "ocr_amount_invalid",
        field: `vatLines.${i}`,
        message: `Die erkannte Steuerzeile ${i + 1} ist ungültig.`,
      });
      inconsistent(`vatLines.${i}`);
      return;
    }
    if (Math.abs(vat - vatOf(net, rateBp)) > 1) {
      issues.push({
        code: "ocr_vat_mismatch",
        field: `vatLines.${i}`,
        message: `Die erkannte Umsatzsteuer der Zeile ${i + 1} passt nicht zum Steuersatz.`,
      });
      inconsistent(`vatLines.${i}`);
    }
    byRate.push({ rateBp, netCents: net, vatCents: vat });
  });
  const totalNet = toCents(x.totals.net);
  const totalVat = toCents(x.totals.vat);
  if (gross !== null) {
    if (byRate.length > 0) {
      const sum = byRate.reduce((s, r) => s + r.netCents + r.vatCents, 0);
      if (sum !== gross && sum + tip !== gross) inconsistent("totals.gross");
      if (totalNet !== null && totalNet !== byRate.reduce((s, r) => s + r.netCents, 0)) inconsistent("totals.net");
      if (totalVat !== null && totalVat !== byRate.reduce((s, r) => s + r.vatCents, 0)) inconsistent("totals.vat");
    } else if (
      totalNet !== null &&
      totalVat !== null &&
      totalNet + totalVat !== gross &&
      totalNet + totalVat + tip !== gross
    ) {
      inconsistent("totals.gross");
    }
  }
  if (!arithmeticOk && !issues.some((i) => i.code === "ocr_arithmetic")) {
    issues.push({ code: "ocr_arithmetic", field: "totals.gross", message: OCR_MESSAGES.inconsistent });
  }

  // Lines and totals for the draft
  if (gross !== null) prefill.statedTotals = { grossCents: gross, ...(byRate.length ? { byRate } : {}) };
  if (byRate.length > 0) {
    prefill.priceMode = "net";
    prefill.lines = byRate.map((r) => {
      const description = describe(x, r.rateBp);
      return {
        account: "",
        ...(description ? { description } : {}),
        amountCents: r.netCents,
        vatRateBp: r.rateBp,
        vatCents: r.vatCents,
      };
    });
  } else if (gross !== null) {
    prefill.priceMode = "gross";
    const rates = [...new Set(x.lineItems.map((l) => toBp(l.ratePercent)))];
    const rate = rates.length === 1 ? rates[0] : undefined;
    if (rate !== undefined && rate !== null) {
      const description = describe(x, rate);
      prefill.lines = [{ account: "", ...(description ? { description } : {}), amountCents: gross, vatRateBp: rate }];
    }
  }
  if (x.skonto) {
    const percentBp = toBp(x.skonto.percent);
    if (percentBp !== null && x.skonto.days >= 0) prefill.skontoTerms = { percentBp, days: x.skonto.days };
  }

  // Confidence
  const conf = x.fieldConfidence;
  const requiredValues: Record<(typeof OCR_REQUIRED_FIELDS)[number], boolean> = {
    "supplier.name": !!supplierName,
    invoiceDate: !!invoiceDate,
    "totals.gross": gross !== null,
  };
  let confidence = 1;
  for (const f of OCR_REQUIRED_FIELDS) {
    const c = requiredValues[f] ? (conf[f] ?? 0) : 0;
    confidence = Math.min(confidence, c);
    if (c < OCR_REVIEW_THRESHOLD) bad.add(f);
  }
  confidence = Math.min(confidence, arithmeticOk ? 1 : 0.5);
  for (const [f, c] of Object.entries(conf)) if (c < OCR_REVIEW_THRESHOLD) bad.add(f);

  return {
    confidence,
    arithmeticOk,
    issues,
    highlighted: [...bad].sort(),
    prefill,
    paymentHint: x.paymentHint,
    isRestaurant: x.hospitality.isRestaurant,
    text: searchableText(x),
  };
}

function describe(x: ReceiptExtraction, rateBp: number): string | undefined {
  const items = x.lineItems
    .filter((l) => {
      const r = toBp(l.ratePercent);
      return r === null || r === rateBp;
    })
    .map((l) => clean(l.description))
    .filter((d): d is string => !!d);
  const text = items.join(", ");
  if (!text) return undefined;
  return text.length > 200 ? `${text.slice(0, 199)}…` : text;
}

/** INB-029: the searchable text of an extraction (stored separately from the original file). */
export function searchableText(x: ReceiptExtraction): string {
  const parts: string[] = [];
  const add = (label: string, v: string | null | undefined) => {
    const c = clean(v);
    if (c) parts.push(`${label}: ${c}`);
  };
  add("Lieferant", x.supplier.name);
  add("Anschrift", x.supplier.address);
  add("USt-IdNr", x.supplier.vatId);
  add("Steuernummer", x.supplier.taxNumber);
  add("IBAN", x.supplier.iban);
  add("E-Mail", x.supplier.email);
  add("Empfänger", x.buyerName);
  add("Rechnungsnummer", x.invoiceNumber);
  add("Rechnungsdatum", x.invoiceDate);
  add("Leistungsdatum", x.supplyDate);
  add("Fällig", x.dueDate);
  add("Brutto", x.totals.gross ? `${x.totals.gross} ${x.currency}` : null);
  add("Kategorie", x.categoryHint);
  for (const l of x.lineItems) add("Position", l.description);
  return parts.join("\n");
}
