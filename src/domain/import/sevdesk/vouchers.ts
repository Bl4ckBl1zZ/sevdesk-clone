/**
 * Historical vouchers from sevdesk's voucher list CSV + voucher files (F09 IMP-025, §4.3.1 row "Voucher list CSV").
 *
 * The list has a header row per voucher followed by its position rows (same „Belegnummer“, „Position“ 1…n, category
 * and rate per position; verified layout 2026-10-18). Each voucher becomes an archived `vouchers` record with
 * `imported: true` and its original file byte-identical — never a journal posting: only vouchers dated before the
 * Buchungsbeginn are imported, open ones are blocked (there are no opening payables, E-IMP-43), and the tax and
 * account information is kept for the archive only (unknown category → no account, E-IMP-46).
 *
 * Pure: strings in, integer cents out (VAT from gross half-away via src/domain/money, never floats).
 */
import { foldSearch } from "../../contacts/core";
import { historyAt } from "../../documents/draft";
import { formatCents } from "../../money/format";
import { roundHalfAway } from "../../money/rounding";
import { normalizeNumber } from "../../numbering/format";
import { type CalendarDate, formatGermanDate } from "../../time/calendar-date";
import {
  type DateFormat,
  type NumberFormat,
  normalizeHeader,
  parseAmountCents,
  parseImportDate,
  parseRateBp,
} from "./formats";
import type { ColumnMapping } from "./mapping";
import { type MatchFile, matchFiles, type PdfMatchResult } from "./pdf-match";
import { type ImportFinding, type KuHistory, rowRefOf } from "./types";

export interface ImportedVoucherLine {
  readonly position: number;
  readonly description: string;
  readonly category: string;
  /** Chart account from a mapped „Buchungskonto“ column; empty = category not mapped (archive only, E-IMP-46). */
  readonly account: string;
  readonly rateBp: number;
  readonly netCents: number;
  readonly vatCents: number;
  readonly grossCents: number;
}

export interface ImportedVoucher {
  /** `importedRecords` key (`sevdesk.voucher`): `voucher:<supplier>|<number>` (IMP-006). */
  readonly key: string;
  /** Row reference of the voucher's header row (exclusions and findings use it). */
  readonly rowRef: string;
  readonly fileId: string;
  readonly line: number;
  readonly number: string;
  readonly supplierName: string;
  readonly documentDate: CalendarDate;
  readonly dueDate?: CalendarDate;
  /** „Bezahlt am“ as exported — a hint kept in the note. */
  readonly paidOn?: CalendarDate;
  readonly statusText: string;
  readonly cancelled: boolean;
  /** Open amount from the export (`undefined` = not determinable). */
  readonly openAmountCents?: number;
  readonly costCenter?: string;
  /**
   * Archival tax rule (no journal impact): input VAT is not deductible for a Kleinunternehmer on the voucher date or a
   * voucher without VAT; otherwise the supplier's VAT is recorded as deductible input VAT as printed.
   */
  readonly taxRule: "no_input_vat" | "input_vat_deductible";
  readonly lines: ImportedVoucherLine[];
  readonly totals: {
    netCents: number;
    vatCents: number;
    grossCents: number;
    byRate: { rateBp: number; netCents: number; vatCents: number }[];
  };
  /** The header row's „Betrag“ (the Belegsumme as exported). */
  readonly statedGrossCents: number;
  readonly deviations: string[];
  readonly fingerprint: string;
}

export interface VoucherParseContext {
  readonly fileId: string;
  readonly fileName: string;
  readonly numberFormat: NumberFormat;
  readonly dateFormat: DateFormat;
  readonly kleinunternehmer?: KuHistory;
}

export interface VoucherParseResult {
  readonly vouchers: ImportedVoucher[];
  readonly findings: ImportFinding[];
  readonly skippedDrafts: number;
  /** Rows whose category could not be mapped to an account (E-IMP-46, one info per file). */
  readonly unmappedCategories: number;
}

const euro = (cents: number) => `${formatCents(cents)} €`;

/** VAT contained in a gross amount: round_half_away(G × r / (10⁴ + r)) — integer arithmetic only. */
export function vatOfGross(grossCents: number, rateBp: number): number {
  if (rateBp === 0) return 0;
  return Number(roundHalfAway(BigInt(grossCents) * BigInt(rateBp), BigInt(10_000 + rateBp)));
}

type StatusKind = "draft" | "cancelled" | "paid" | "open" | "unknown";

/** SEVDESK-LAYOUT-UNSURE: status texts of the voucher list (verified: lower case, e.g. „bezahlt“). */
function statusKind(raw: string): StatusKind {
  const s = normalizeHeader(raw);
  if (s === "") return "unknown";
  if (s.includes("entwurf") || s === "draft") return "draft";
  if (s.includes("storn") || s === "cancelled") return "cancelled";
  if (s === "bezahlt" || s === "paid" || s === "beglichen") return "paid";
  if (/(offen|unbezahlt|faellig|ueberfaellig|teil|open|due)/.test(s)) return "open";
  return "unknown";
}

interface RawRow {
  readonly line: number;
  readonly cells: string[];
}

/**
 * IMP-025: voucher list → archived vouchers. Rows are grouped: a row with an empty „Position“ starts a voucher, the
 * following rows with the same „Belegnummer“ are its positions; without a position column every row is a voucher of
 * one line.
 */
export function parseVoucherList(
  headers: readonly string[],
  records: readonly RawRow[],
  mapping: ColumnMapping,
  ctx: VoucherParseContext,
): VoucherParseResult {
  const index = (target: string) => {
    const h = mapping[target];
    return h === undefined ? -1 : headers.indexOf(h);
  };
  const cell = (r: RawRow, target: string) => {
    const i = index(target);
    return i < 0 ? "" : (r.cells[i] ?? "").trim();
  };
  const findings: ImportFinding[] = [];
  const vouchers: ImportedVoucher[] = [];
  let skippedDrafts = 0;
  let unmappedCategories = 0;

  // ── grouping ──
  const groups: { header: RawRow; positions: RawRow[] }[] = [];
  const hasPosition = index("position") >= 0;
  for (const r of records) {
    const number = cell(r, "number");
    const position = hasPosition ? cell(r, "position") : "";
    const current = groups.at(-1);
    const continues =
      position !== "" &&
      current !== undefined &&
      (number === "" || normalizeNumber(number) === normalizeNumber(cell(current.header, "number")));
    if (continues) current.positions.push(r);
    else groups.push({ header: r, positions: [] });
  }

  for (const g of groups) {
    const h = g.header;
    const rowRef = rowRefOf(ctx.fileId, h.line);
    const at = { fileId: ctx.fileId, fileName: ctx.fileName, line: h.line, rowRef };
    const number = cell(h, "number");
    const supplierName = cell(h, "supplierName");
    const errors: ImportFinding[] = [];
    const fail = (code: string, message: string) => errors.push({ code, severity: "error", message, ...at });
    const status = statusKind(cell(h, "status"));
    if (status === "draft") {
      skippedDrafts++;
      continue;
    }
    const label = number || `Zeile ${h.line}`;
    const date = (raw: string, what: string): CalendarDate | undefined => {
      const r = parseImportDate(raw, ctx.dateFormat);
      if (r.ok) return r.value;
      fail("E-IMP-16", `Zeile ${h.line}: ${what} „${raw}“ ist ungültig.`);
      return undefined;
    };
    const amount = (r: RawRow, target: string): number | undefined => {
      const raw = cell(r, target);
      const v = parseAmountCents(raw, ctx.numberFormat);
      if (v.ok) return v.value;
      fail("E-IMP-16", `Zeile ${r.line}: Betrag „${raw}“ ist ungültig.`);
      return undefined;
    };
    if (!number) fail("E-IMP-16", `Zeile ${h.line}: Belegnummer fehlt.`);
    const documentDate = date(cell(h, "documentDate"), "Datum");
    if (cell(h, "documentDate") === "") fail("E-IMP-16", `Zeile ${h.line}: Belegdatum fehlt.`);
    const dueRaw = cell(h, "dueDate");
    const dueDate = dueRaw ? date(dueRaw, "Fälligkeitsdatum") : undefined;
    // „Bezahlt am“ is a hint only — an unreadable value never blocks.
    const paidRaw = cell(h, "paidOn");
    const paidParsed = paidRaw ? parseImportDate(paidRaw, ctx.dateFormat) : undefined;
    const paidOn = paidParsed?.ok ? paidParsed.value : undefined;
    const stated = amount(h, "amount");
    if (cell(h, "amount") === "") fail("E-IMP-16", `Zeile ${h.line}: Betrag fehlt.`);

    const ku = documentDate ? (historyAt(ctx.kleinunternehmer ?? [], documentDate)?.isKU ?? false) : false;
    const lineRows = g.positions.length > 0 ? g.positions : [h];
    const lines: ImportedVoucherLine[] = [];
    for (const [i, r] of lineRows.entries()) {
      const gross = amount(r, "amount");
      const rateRaw = cell(r, "rate") || cell(h, "rate");
      const rate = parseRateBp(rateRaw);
      if (!rate.ok) {
        fail("E-IMP-16", `Zeile ${r.line}: ${rate.error.message}`);
        continue;
      }
      if (gross === undefined) continue;
      const rateBp = rate.value ?? 0;
      const netCol = index("net") >= 0 ? amount(r, "net") : undefined;
      const vatCol = index("vat") >= 0 ? amount(r, "vat") : undefined;
      const vatCents = vatCol ?? (netCol !== undefined ? gross - netCol : vatOfGross(gross, rateBp));
      const category = cell(r, "category") || cell(h, "category");
      const account = /^\d{4,8}$/.test(cell(r, "account")) ? cell(r, "account") : "";
      if (!account) unmappedCategories++;
      const description = cell(r, "description") || (r === h ? "" : cell(h, "description"));
      lines.push({
        position: Number(cell(r, "position")) || i + 1,
        description: [category, description].filter(Boolean).join(" – ") || "Position laut sevdesk-Export",
        category,
        account,
        rateBp,
        netCents: netCol ?? gross - vatCents,
        vatCents,
        grossCents: gross,
      });
    }
    const grossCents = lines.reduce((s, l) => s + l.grossCents, 0);
    // SEVDESK-LAYOUT-UNSURE: whether income vouchers or supplier credit notes appear with a negative „Betrag“ is not
    // verified — never flip a sign silently (E-IMP-45).
    if ((stated ?? 0) < 0 || lines.some((l) => l.grossCents < 0)) {
      fail(
        "E-IMP-45",
        `${label}: negativer Betrag (Gutschrift oder Einnahme) – solche Belege werden nicht übernommen. Bitte in der App erfassen oder Zeile ausschließen.`,
      );
    }
    const key = `voucher:${foldSearch(supplierName)}|${normalizeNumber(number)}`;
    // An empty date or amount always produced an error above.
    if (errors.length > 0 || !documentDate || stated === undefined) {
      findings.push(...errors.map((e) => ({ ...e, key })));
      continue;
    }
    const deviations: string[] = [];
    if (g.positions.length > 0 && grossCents !== stated) {
      findings.push({
        code: "E-IMP-08",
        severity: "warning",
        message: `Summen von ${label} weichen um ${euro(Math.abs(grossCents - stated))} ab (übernommen wie im sevdesk-Export).`,
        ...at,
      });
      deviations.push(`Positionssumme ${euro(grossCents)} ≠ Belegsumme ${euro(stated)} (wie im sevdesk-Export).`);
    }
    // Open amount: the column wins, then the status text; a cancelled voucher has nothing open.
    let openAmountCents: number | undefined;
    if (status === "cancelled") openAmountCents = 0;
    else if (index("open") >= 0 && cell(h, "open") !== "") openAmountCents = amount(h, "open");
    else if (status === "paid") openAmountCents = 0;
    else if (status === "open") openAmountCents = stated;

    const byRateMap = new Map<number, { rateBp: number; netCents: number; vatCents: number }>();
    for (const l of lines) {
      const e = byRateMap.get(l.rateBp) ?? { rateBp: l.rateBp, netCents: 0, vatCents: 0 };
      e.netCents += l.netCents;
      e.vatCents += l.vatCents;
      byRateMap.set(l.rateBp, e);
    }
    const vatCents = lines.reduce((s, l) => s + l.vatCents, 0);
    const costCenter = cell(h, "costCenter");
    vouchers.push({
      key,
      rowRef,
      fileId: ctx.fileId,
      line: h.line,
      number,
      supplierName,
      documentDate,
      ...(dueDate ? { dueDate } : {}),
      ...(paidOn ? { paidOn } : {}),
      statusText: cell(h, "status"),
      cancelled: status === "cancelled",
      ...(openAmountCents !== undefined ? { openAmountCents } : {}),
      ...(costCenter ? { costCenter } : {}),
      taxRule: ku || vatCents === 0 ? "no_input_vat" : "input_vat_deductible",
      lines,
      totals: {
        netCents: lines.reduce((s, l) => s + l.netCents, 0),
        vatCents,
        grossCents,
        byRate: [...byRateMap.values()].sort((a, b) => b.rateBp - a.rateBp),
      },
      statedGrossCents: stated,
      deviations,
      fingerprint: JSON.stringify(
        [h, ...g.positions].map((r) => headers.map((x, i) => `${normalizeHeader(x)}=${(r.cells[i] ?? "").trim()}`)),
      ),
    });
  }
  if (unmappedCategories > 0) {
    findings.push({
      code: "E-IMP-46",
      severity: "info",
      message: `${ctx.fileName}: ${unmappedCategories} Belegpositionen ohne Buchungskonto – die Kategorie wird nur archiviert (keine Buchung, keine Auswertung).`,
      fileId: ctx.fileId,
      fileName: ctx.fileName,
    });
  }
  return { vouchers, findings, skippedDrafts, unmappedCategories };
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────────────────

export interface PlannedVoucher {
  readonly voucher: ImportedVoucher;
  readonly status: "new" | "skip" | "excluded" | "error";
  readonly localId?: string;
  /** Import file id of the matched original (PDF or image). */
  readonly fileId?: string;
}

export interface VoucherPlanInput {
  readonly vouchers: readonly ImportedVoucher[];
  /** Rows marked error by parsing or deduplication. */
  readonly errorRows: ReadonlySet<string>;
  readonly excluded: ReadonlySet<string>;
  /** Local id of a voucher imported earlier (IMP-006). */
  readonly imported: (key: string) => string | undefined;
  /** The Buchungsbeginn (`null` = not set). */
  readonly bookkeepingStart: CalendarDate | null;
  /** Files no sales document claimed (PDFs) plus images. */
  readonly files: readonly MatchFile[];
  readonly assignments: Readonly<Record<string, string>>;
  readonly fileName: (id: string) => string;
}

/**
 * IMP-025 plan: what is committed. A voucher is archived without any journal entry, so it must lie before the
 * Buchungsbeginn (E-IMP-44), be settled (E-IMP-43: there are no opening payables to carry an open voucher) and carry
 * its original file (E-IMP-42; RI-21: a booked voucher always has a Beleg). Files are matched by voucher number like
 * IMP-019; manual assignments (`pdfAssignments`) win.
 */
export function planVouchers(
  input: VoucherPlanInput,
  findings: ImportFinding[],
): { planned: PlannedVoucher[]; match: PdfMatchResult } {
  const at = (v: ImportedVoucher) => ({
    fileId: v.fileId,
    fileName: input.fileName(v.fileId),
    line: v.line,
    rowRef: v.rowRef,
    key: v.key,
  });
  const fail = (v: ImportedVoucher, code: string, message: string): PlannedVoucher => {
    findings.push({ code, severity: "error", message, ...at(v) });
    return { voucher: v, status: "error" };
  };
  const start = input.bookkeepingStart;
  const first = input.vouchers.map((v): PlannedVoucher => {
    if (input.excluded.has(v.rowRef)) return { voucher: v, status: "excluded" };
    if (input.errorRows.has(v.rowRef)) return { voucher: v, status: "error" };
    const prior = input.imported(v.key);
    if (prior) return { voucher: v, status: "skip", localId: prior };
    if (!start) {
      return fail(
        v,
        "E-IMP-44",
        `${v.number}: Belege werden nur vor dem Buchungsbeginn archiviert – bitte zuerst den Buchungsbeginn festlegen.`,
      );
    }
    if (v.documentDate >= start) {
      return fail(
        v,
        "E-IMP-44",
        `${v.number} liegt am oder nach dem Buchungsbeginn (${formatGermanDate(start)}) und wird nicht archiviert. Bitte den Beleg in der App erfassen und buchen oder die Zeile ausschließen.`,
      );
    }
    if (v.openAmountCents === undefined) {
      return fail(
        v,
        "E-IMP-43",
        `${v.number}: Zahlungsstatus nicht ermittelbar (weder „offener Betrag“ noch Status „bezahlt“). Bitte die Spalte zuordnen oder die Zeile ausschließen.`,
      );
    }
    if (v.openAmountCents !== 0) {
      return fail(
        v,
        "E-IMP-43",
        `${v.number} ist noch offen (${euro(v.openAmountCents)}). Offene Eingangsbelege werden nicht übernommen – bitte die Verbindlichkeit in der Eröffnungsbilanz erfassen oder den Beleg in der App buchen und die Zeile ausschließen.`,
      );
    }
    return { voucher: v, status: "new" };
  });
  const match = matchFiles(
    first.filter((p) => p.status === "new").map((p) => ({ key: p.voucher.key, number: p.voucher.number })),
    input.files,
    input.assignments,
  );
  const planned = first.map((p): PlannedVoucher => {
    if (p.status !== "new") return p;
    const candidates = match.ambiguous[p.voucher.key];
    if (candidates) {
      return fail(
        p.voucher,
        "E-IMP-22",
        `Für ${p.voucher.number} passen mehrere Dateien (${candidates.map(input.fileName).join(", ")}). Bitte die richtige Datei wählen.`,
      );
    }
    const fileId = match.matched[p.voucher.key];
    if (!fileId) {
      return fail(
        p.voucher,
        "E-IMP-42",
        `Für Beleg ${p.voucher.number} wurde keine Belegdatei gefunden. Bitte die Datei hochladen und zuordnen oder die Zeile ausschließen.`,
      );
    }
    return { ...p, fileId };
  });
  return { planned, match };
}
