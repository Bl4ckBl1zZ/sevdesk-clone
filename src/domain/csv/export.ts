/**
 * List CSV export (F09 EXP-021/022). Pure.
 *
 * Two variants of the same typed rows:
 * - „CSV (Excel)": UTF-8 with BOM, `;`, decimal comma, `DD.MM.YYYY`, amounts in euros, German headers, no technical
 *   IDs; text cells starting with `=`, `+`, `-`, `@`, tab or CR are prefixed with `'` (EXP-022, SEC-06).
 * - „CSV (technisch)": UTF-8 without BOM, `,`, ISO dates, `*_cents` integers, snake_case headers, IDs included.
 */

export type CsvVariant = "excel" | "technical";

export type CsvKind = "text" | "cents" | "date" | "int" | "id" | "bool";

export interface CsvColumn<T> {
  /** German header (Excel variant). */
  readonly label: string;
  /** snake_case header (technical variant); `cents` columns should end in `_cents`. */
  readonly key: string;
  readonly kind: CsvKind;
  readonly value: (row: T) => string | number | boolean | null | undefined;
}

/** EXP-022: a text cell that a spreadsheet would read as a formula gets a leading apostrophe. */
export function neutraliseFormula(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const centsDe = (c: number): string => {
  const neg = c < 0;
  const s = Math.abs(Math.trunc(c)).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)},${s.slice(-2)}`;
};

const dateDe = (iso: string): string =>
  /^\d{4}-\d{2}-\d{2}/.test(iso) ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : iso;

function cell(kind: CsvKind, raw: string | number | boolean | null | undefined, variant: CsvVariant): string {
  if (raw === null || raw === undefined || raw === "") return "";
  if (variant === "technical") {
    if (kind === "bool") return raw ? "true" : "false";
    if (kind === "cents" || kind === "int") return String(Math.trunc(Number(raw)));
    return String(raw);
  }
  if (kind === "cents") return centsDe(Number(raw));
  if (kind === "int") return String(Math.trunc(Number(raw)));
  if (kind === "date") return dateDe(String(raw));
  if (kind === "bool") return raw ? "ja" : "nein";
  return neutraliseFormula(String(raw));
}

function quote(v: string, sep: string): string {
  return v.includes(sep) || /["\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function formatCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[], variant: CsvVariant): string {
  const cols = variant === "excel" ? columns.filter((c) => c.kind !== "id") : columns;
  const sep = variant === "excel" ? ";" : ",";
  const head = cols.map((c) => quote(variant === "excel" ? c.label : c.key, sep)).join(sep);
  const body = rows.map((r) => cols.map((c) => quote(cell(c.kind, c.value(r), variant), sep)).join(sep));
  const text = `${[head, ...body].join("\r\n")}\r\n`;
  return variant === "excel" ? `﻿${text}` : text;
}

/** Plain text rows (lists that already build German display rows, e.g. contacts CON-143). */
export function formatTextCsv(rows: readonly (readonly string[])[], variant: CsvVariant): string {
  const [header = [], ...body] = rows;
  const columns: CsvColumn<readonly string[]>[] = header.map((label, i) => ({
    label,
    key: label
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/ß/g, "ss")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, ""),
    kind: "text",
    value: (r) => r[i],
  }));
  return formatCsv(columns, body, variant);
}

/** EXP-021: more rows than this run as a background job (EXP-026). */
export const CSV_DIRECT_MAX_ROWS = 5000;

export const csvFileName = (list: string, variant: CsvVariant, today: string): string =>
  `${list}-${today}${variant === "technical" ? "-technisch" : ""}.csv`;
