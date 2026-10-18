/**
 * Invoice list row → archived historic document (F09 IMP-003, IMP-007, IMP-010, IMP-020, §4.3.2, §4.3.3, EC-190).
 *
 * The export's amounts are authoritative and stored as-is (E-IMP-08); summary lines are one per VAT rate
 * (`fromSummary`); payment state is derived from amounts, not from the status text; our validators are not applied
 * retroactively — deviations from current rules are listed (EC-190). Pure; `today` is not needed.
 */
import { formatCents } from "../../money/format";
import { roundHalfAway } from "../../money/rounding";
import { largestNetThatFits, vatCents } from "../../money/vat";
import { SEVDESK_OSS_MARKERS, SEVDESK_TAX_LABELS } from "../../rules/import/sevdesk-tax-labels";
import { lookupVatRate } from "../../rules/vat-rates";
import type { TaxCase } from "../../tax/tax-case";
import type { VatCategory } from "../../tax/vat-category";
import type { CalendarDate } from "../../time/calendar-date";
import {
  type DateFormat,
  type NumberFormat,
  normalizeHeader,
  parseAmountCents,
  parseImportDate,
  parseRateBp,
} from "./formats";
import { type ColumnMapping, parsePerRate } from "./mapping";
import { type ImportedDocType, type ImportFinding, rowRefOf } from "./types";

export interface SummaryGroup {
  readonly category: VatCategory;
  readonly rateBp: number;
  readonly netCents: number;
  readonly vatCents: number;
  readonly grossCents: number;
}

export interface ImportedDocument {
  /** `importedRecords` key (`sevdesk.document` / `<type>:<number>`, IMP-006). */
  readonly key: string;
  readonly rowRef: string;
  readonly fileId: string;
  readonly line: number;
  readonly type: ImportedDocType;
  readonly number: string;
  readonly documentDate: CalendarDate;
  readonly supplyDate?: CalendarDate;
  readonly dueDate?: CalendarDate;
  /** §4.3.3: the export's sent date, else the document date (`sentOnAssumed`). */
  readonly sentOn: CalendarDate;
  readonly sentOnAssumed: boolean;
  readonly customerNumber?: string;
  readonly customerName: string;
  readonly currency: string;
  readonly taxCase: TaxCase;
  readonly groups: SummaryGroup[];
  readonly totals: { netCents: number; vatCents: number; grossCents: number };
  /** Status text „Storniert“ (the original of a Storno). */
  readonly cancelledByStatus: boolean;
  readonly statusText: string;
  /** Invoice types only: IMP-007 precedence result; `undefined` = not determinable (E-IMP-30). */
  readonly openAmountCents?: number;
  readonly openSource?: "open_column" | "paid_column" | "status_paid";
  readonly referenceNumber?: string;
  /** EC-190: deviations from current rules, listed in the preview and the import report. */
  readonly deviations: string[];
  /** Canonical row content for E-IMP-24 (identical duplicates are dropped silently). */
  readonly fingerprint: string;
}

export type InvoiceRowResult =
  | { readonly kind: "skipped"; readonly reason: "draft" | "reminder"; readonly findings: ImportFinding[] }
  | { readonly kind: "row"; readonly doc?: ImportedDocument; readonly findings: ImportFinding[] };

/** SEVDESK-LAYOUT-UNSURE: type texts incl. sevdesk's internal codes (RE, SR, TR, AR, ER, WKR, MA). */
const TYPE_TEXTS: Readonly<Record<string, ImportedDocType | "reminder">> = {
  "": "invoice",
  rechnung: "invoice",
  re: "invoice",
  wkr: "invoice",
  invoice: "invoice",
  "wiederkehrende rechnung": "invoice",
  abschlagsrechnung: "advance_invoice",
  anzahlungsrechnung: "advance_invoice",
  vorauszahlungsrechnung: "advance_invoice",
  ar: "advance_invoice",
  teilrechnung: "partial_invoice",
  tr: "partial_invoice",
  schlussrechnung: "final_invoice",
  endrechnung: "final_invoice",
  er: "final_invoice",
  gutschrift: "correction",
  rechnungskorrektur: "correction",
  korrektur: "correction",
  korrekturrechnung: "correction",
  "credit note": "correction",
  storno: "cancellation",
  stornorechnung: "cancellation",
  stornierung: "cancellation",
  sr: "cancellation",
  mahnung: "reminder",
  ma: "reminder",
};

export const INVOICE_TYPES_WITH_OPEN_ITEMS: readonly ImportedDocType[] = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
];

type StatusClass = "draft" | "open" | "partial" | "paid" | "cancelled" | "other";

/** SEVDESK-LAYOUT-UNSURE: status texts (§4.3.3). */
function statusClass(text: string): StatusClass {
  const s = normalizeHeader(text);
  if (s === "") return "other";
  if (/^(entwurf|draft)$/.test(s)) return "draft";
  if (/^(teilbezahlt|teilweise bezahlt|teilzahlung)$/.test(s)) return "partial";
  if (/^(bezahlt|beglichen|paid)$/.test(s)) return "paid";
  if (/^(storniert|cancelled|canceled)$/.test(s)) return "cancelled";
  if (/^(offen|faellig|ueberfaellig|versendet|gestellt|open)$/.test(s)) return "open";
  return "other";
}

const CATEGORY_LABELS = (label: string) => {
  const n = normalizeHeader(label);
  if (n === "") return null;
  if (SEVDESK_OSS_MARKERS.some((m) => ` ${n} `.includes(` ${m} `))) return "oss" as const;
  return SEVDESK_TAX_LABELS.find((row) => row.labels.some((l) => normalizeHeader(l) === n)) ?? ("unknown" as const);
};

export interface InvoiceRowContext {
  readonly fileId: string;
  readonly fileName: string;
  readonly numberFormat: NumberFormat;
  readonly dateFormat: DateFormat;
}

const euro = (cents: number) => `${formatCents(cents)} €`;

/** Effective rate of a group whose VAT matches no table rate (archived only, `unknown_imported`). */
const effectiveRateBp = (net: number, vat: number) =>
  net === 0 ? 0 : Number(roundHalfAway(BigInt(vat) * 10_000n, BigInt(net)));

/** German standard/reduced rates valid on the date (date-effective table, never hard-coded). */
function germanRatesOn(date: CalendarDate): number[] {
  const out: number[] = [];
  for (const key of ["standard", "reduced"] as const) {
    const r = lookupVatRate(key, date);
    if (r.ok) out.push(r.value.value.rateBp);
  }
  return out;
}

/** One mapped invoice list row → document candidate with its findings. */
export function parseInvoiceRow(
  line: number,
  cells: readonly string[],
  headers: readonly string[],
  mapping: ColumnMapping,
  ctx: InvoiceRowContext,
): InvoiceRowResult {
  const rowRef = rowRefOf(ctx.fileId, line);
  const findings: ImportFinding[] = [];
  const col = new Map(headers.map((h, i) => [h, i]));
  const get = (target: string): string => {
    const header = mapping[target];
    const i = header === undefined ? undefined : col.get(header);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };
  const at = { fileId: ctx.fileId, fileName: ctx.fileName, line, rowRef };
  const error = (code: string, message: string) =>
    findings.push({ code, severity: "error", message: `Zeile ${line}: ${message}`, ...at });
  const warn = (code: string, message: string, severity: "warning" | "info" = "warning") =>
    findings.push({ code, severity, message, ...at });

  const status = statusClass(get("status"));
  const typeText = normalizeHeader(get("type"));
  const mapped = TYPE_TEXTS[typeText];
  if (status === "draft") return { kind: "skipped", reason: "draft", findings };
  if (mapped === "reminder") return { kind: "skipped", reason: "reminder", findings };
  if (mapped === undefined) {
    error("E-IMP-16", `Belegart „${get("type")}“ ist unbekannt.`);
    return { kind: "row", findings };
  }
  const type = mapped;
  const number = get("number");
  if (number === "") {
    error("E-IMP-16", "Rechnungsnummer fehlt.");
    return { kind: "row", findings };
  }
  const key = `${type}:${number}`;
  const withKey = (f: ImportFinding): ImportFinding => ({ ...f, key });

  const date = (target: string, label: string): CalendarDate | undefined => {
    const r = parseImportDate(get(target), ctx.dateFormat);
    if (!r.ok) {
      error("E-IMP-16", `${label}: ${r.error.message}`);
      return undefined;
    }
    return r.value;
  };
  const amount = (target: string, label: string): number | undefined => {
    const r = parseAmountCents(get(target), ctx.numberFormat);
    if (!r.ok) {
      error("E-IMP-16", `${label}: ${r.error.message}`);
      return undefined;
    }
    return r.value;
  };

  const documentDate = date("documentDate", "Rechnungsdatum");
  const supplyDate = date("supplyDate", "Leistungsdatum");
  const dueDate = date("dueDate", "Fälligkeit");
  const sentOnRaw = date("sentOn", "Versanddatum");
  if (findings.length === 0 && !documentDate) error("E-IMP-16", "Rechnungsdatum fehlt.");

  // ── amounts (IMP-020: per rate if the export splits them) ──
  const perRate = new Map<number, { net?: number; vat?: number; gross?: number }>();
  for (const target of Object.keys(mapping)) {
    const pr = parsePerRate(target);
    if (!pr) continue;
    const v = amount(target, target);
    if (v === undefined) continue;
    const slot = perRate.get(pr.rateBp) ?? {};
    slot[pr.kind] = v;
    perRate.set(pr.rateBp, slot);
  }
  const net = amount("net", "Netto");
  const vat = amount("vat", "Umsatzsteuer");
  const gross = amount("gross", "Brutto");
  const rateRaw = parseRateBp(get("rate"));
  if (!rateRaw.ok) error("E-IMP-16", rateRaw.error.message);
  const rate = rateRaw.ok ? rateRaw.value : undefined;

  type RawGroup = { rateBp?: number; net: number; vat: number; gross: number };
  const raw: RawGroup[] = [];
  /** Only a gross amount without rate or VAT: the split is unknown (archived as `unknown_imported`, E-IMP-34). */
  let splitUnknown = false;
  const complete = (n?: number, v?: number, g?: number) => {
    const nn = n ?? (g !== undefined && v !== undefined ? g - v : undefined);
    const vv = v ?? (g !== undefined && nn !== undefined ? g - nn : undefined);
    const gg = g ?? (nn !== undefined && vv !== undefined ? nn + vv : undefined);
    return nn !== undefined && vv !== undefined && gg !== undefined ? { net: nn, vat: vv, gross: gg } : null;
  };
  if (perRate.size > 0) {
    for (const [rateBp, a] of [...perRate].sort((x, y) => y[0] - x[0])) {
      const vv = a.vat ?? (a.net !== undefined && a.gross === undefined ? vatCents(a.net, rateBp) : undefined);
      const g = complete(a.net, vv, a.gross);
      if (g && (g.net !== 0 || g.vat !== 0 || g.gross !== 0)) raw.push({ rateBp, ...g });
    }
  } else {
    let g = complete(net, vat, gross);
    if (!g && gross !== undefined && rate !== undefined) {
      // Only gross and the rate: the largest net that fits (App. E.3), VAT = gross − net.
      const n = Number(largestNetThatFits(BigInt(gross), rate).net);
      g = { net: n, vat: gross - n, gross };
    }
    if (g) raw.push({ ...(rate !== undefined ? { rateBp: rate } : {}), ...g });
    else if (gross !== undefined) {
      splitUnknown = true;
      raw.push({ net: gross, vat: 0, gross });
    }
  }
  if (raw.length === 0 && findings.every((f) => f.severity !== "error")) {
    error("E-IMP-16", "Kein Betrag (Brutto oder Netto + USt) vorhanden.");
  }
  if (findings.some((f) => f.severity === "error") || !documentDate) {
    return { kind: "row", findings: findings.map(withKey) };
  }

  const sumNet = raw.reduce((s, g) => s + g.net, 0);
  const sumVat = raw.reduce((s, g) => s + g.vat, 0);
  const sumGross = raw.reduce((s, g) => s + g.gross, 0);
  const totals = {
    netCents: perRate.size > 0 ? (net ?? sumNet) : sumNet,
    vatCents: perRate.size > 0 ? (vat ?? sumVat) : sumVat,
    grossCents: gross ?? sumGross,
  };
  // E-IMP-08: archived values are authoritative — imported as-is, listed.
  const diffs = [
    ...raw.map((g) => g.gross - g.net - g.vat),
    totals.grossCents - totals.netCents - totals.vatCents,
    perRate.size > 0 ? totals.grossCents - sumGross : 0,
  ];
  const diff = diffs.find((d) => d !== 0);
  if (diff !== undefined) {
    warn("E-IMP-08", `Summen von ${number} weichen um ${euro(Math.abs(diff))} ab (übernommen wie im sevdesk-Export).`);
  }

  // ── tax case (IMP-010, §4.3.2; conservative: unknown_imported unless unambiguous) ──
  const deviations: string[] = [];
  const label = CATEGORY_LABELS(get("taxRule"));
  let taxCase: TaxCase;
  let groups: SummaryGroup[];
  const unknown = (): SummaryGroup[] =>
    raw.map((g) => ({
      // Archive-only representation; `unknown_imported` keeps it out of every tax evaluation (F08 refuses to post it).
      category: g.vat !== 0 ? "S" : "O",
      rateBp: g.rateBp ?? effectiveRateBp(g.net, g.vat),
      netCents: g.net,
      vatCents: g.vat,
      grossCents: g.gross,
    }));
  const rates = germanRatesOn(documentDate);
  const domesticGroup = (g: RawGroup): SummaryGroup | null => {
    if (g.vat === 0) return null;
    const candidates = g.rateBp !== undefined ? [g.rateBp] : rates;
    const hit = candidates.find((r) => rates.includes(r) && Math.abs(vatCents(g.net, r) - g.vat) <= 1);
    return hit === undefined
      ? null
      : { category: "S", rateBp: hit, netCents: g.net, vatCents: g.vat, grossCents: g.gross };
  };
  if (splitUnknown || label === "oss" || label === "unknown") {
    taxCase = "unknown_imported";
    groups = unknown();
  } else if (label && label.taxCase !== "domestic") {
    if (raw.some((g) => g.vat !== 0)) {
      taxCase = "unknown_imported";
      groups = unknown();
    } else {
      taxCase = label.taxCase;
      groups = raw.map((g) => ({
        category: label.category,
        rateBp: 0,
        netCents: g.net,
        vatCents: 0,
        grossCents: g.gross,
      }));
    }
  } else {
    const mapped = raw.map(domesticGroup);
    if (mapped.every((g): g is SummaryGroup => g !== null)) {
      taxCase = "domestic";
      groups = mapped;
    } else {
      taxCase = "unknown_imported";
      groups = unknown();
    }
  }
  if (taxCase === "unknown_imported") {
    warn(
      "E-IMP-09",
      `${number}: Steuerangabe nicht eindeutig zuordenbar – nur archiviert, nicht steuerlich ausgewertet.`,
    );
  }

  // ── payment state (IMP-007 precedence; §4.3.3: amounts beat the status text) ──
  const currency = (get("currency") || "EUR").toUpperCase();
  const openCol = amount("open", "Offener Betrag");
  const paidCol = amount("paid", "Bezahlter Betrag");
  let openAmountCents: number | undefined;
  let openSource: ImportedDocument["openSource"];
  const cancelledByStatus = status === "cancelled";
  const isInvoiceType = INVOICE_TYPES_WITH_OPEN_ITEMS.includes(type);
  if (isInvoiceType && !cancelledByStatus) {
    if (openCol !== undefined) {
      openAmountCents = openCol;
      openSource = "open_column";
    } else if (paidCol !== undefined) {
      openAmountCents = totals.grossCents - paidCol;
      openSource = "paid_column";
    } else if (status === "paid") {
      openAmountCents = 0;
      openSource = "status_paid";
    }
    if (openAmountCents !== undefined && (openAmountCents < 0 || openAmountCents > totals.grossCents)) {
      error(
        "E-IMP-16",
        `Offener Betrag ${euro(openAmountCents)} passt nicht zum Bruttobetrag ${euro(totals.grossCents)}.`,
      );
      return { kind: "row", findings: findings.map(withKey) };
    }
    if (openAmountCents !== undefined) {
      const contradicts =
        (status === "paid" && openAmountCents !== 0) ||
        (status === "open" && openAmountCents === 0) ||
        (status === "partial" && (openAmountCents === 0 || openAmountCents === totals.grossCents));
      if (contradicts) {
        warn(
          "E-IMP-08",
          `${number}: Status „${get("status")}“ passt nicht zum offenen Betrag ${euro(openAmountCents)}; der Betrag gilt.`,
        );
      }
    }
  }
  if (currency !== "EUR") {
    warn("E-IMP-33", `${number} ist in ${currency} – bitte EUR-Betrag des offenen Postens prüfen.`);
  }

  // ── EC-190: deviations from current rules (not enforced retroactively) ──
  if (!supplyDate) deviations.push("Kein Leistungsdatum angegeben (§ 14 Abs. 4 Nr. 6 UStG).");
  if (dueDate === undefined && isInvoiceType) deviations.push("Kein Fälligkeitsdatum angegeben.");
  if (diff !== undefined) deviations.push("Summen nicht konsistent (wie im sevdesk-Export übernommen).");
  if (taxCase === "unknown_imported") deviations.push("Steuerfall nicht eindeutig (unknown_imported).");

  const customerName = get("customerName");
  const customerNumber = get("customerNumber");
  const reference = get("reference");
  const fingerprint = JSON.stringify(headers.map((h, i) => `${normalizeHeader(h)}=${(cells[i] ?? "").trim()}`).sort());
  return {
    kind: "row",
    findings: findings.map(withKey),
    doc: {
      key,
      rowRef,
      fileId: ctx.fileId,
      line,
      type,
      number,
      documentDate,
      ...(supplyDate ? { supplyDate } : {}),
      ...(dueDate ? { dueDate } : {}),
      sentOn: sentOnRaw ?? documentDate,
      sentOnAssumed: sentOnRaw === undefined,
      ...(customerNumber ? { customerNumber } : {}),
      customerName,
      currency,
      taxCase,
      groups,
      totals,
      cancelledByStatus,
      statusText: get("status"),
      ...(openAmountCents !== undefined ? { openAmountCents } : {}),
      ...(openSource ? { openSource } : {}),
      ...(reference ? { referenceNumber: reference } : {}),
      deviations,
      fingerprint,
    },
  };
}

/** IMP-007: VAT of an open amount split per rate pro rata by gross (largest groups first, rounded half away). */
export function openVatSplit(
  doc: { groups: readonly { rateBp: number; vatCents: number }[]; totals: { grossCents: number } },
  openCents: number,
) {
  if (doc.totals.grossCents === 0) return [];
  return doc.groups
    .filter((g) => g.vatCents !== 0)
    .map((g) => ({
      rateBp: g.rateBp,
      vatCents: Number(roundHalfAway(BigInt(openCents) * BigInt(g.vatCents), BigInt(doc.totals.grossCents))),
    }));
}
