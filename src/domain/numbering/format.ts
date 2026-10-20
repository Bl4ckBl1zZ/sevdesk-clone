/**
 * Number-range formats (F01 SET-056…058, §5.5; UST-06, DATEV-04). Pure: renders, validates and previews numbers.
 * Numbers are assigned only in the finalisation transaction (SET-061, P1); this module never reserves anything.
 */
import { err, type Issue, issue, ok, type Result } from "../result";

export type ResetPolicy = "never" | "yearly" | "monthly";
export const RESET_POLICIES = ["never", "yearly", "monthly"] as const satisfies readonly ResetPolicy[];

export type FormatIssueCode =
  | "format_counter_token"
  | "format_unknown_token"
  | "format_illegal_char"
  | "format_too_long"
  | "reset_requires_year"
  | "reset_requires_month";

const TOKEN = /\{([^}]*)\}/g;
const LITERAL_OK = /^[A-Za-z0-9$%&*+\-/]*$/;
/** UST-06 / DATEV Belegfeld 1. */
export const MAX_NUMBER_LENGTH = 36;
export const MIN_START_VALUE = 1;
export const MAX_START_VALUE = 10_000_000_000;

export interface YearMonth {
  year: number;
  month: number;
}

export interface FormatCheck {
  ok: boolean;
  code?: FormatIssueCode;
  message?: string;
}

/** Validates a format against the token grammar and the reset policy (messages: F01 §5.5). */
export function validateFormat(format: string, reset: ResetPolicy): Result<{ digits: number }, Issue<FormatIssueCode>> {
  const tokens = [...format.matchAll(TOKEN)].map((m) => m[1] ?? "");
  const counters = tokens.filter((t) => /^#{1,10}$/.test(t));
  const unknown = tokens.find((t) => !/^#{1,10}$/.test(t) && !["YYYY", "YY", "MM"].includes(t));
  if (unknown !== undefined) {
    return err(
      issue(
        "format_unknown_token",
        `Unbekannter Platzhalter {${unknown}}. Erlaubt sind {YYYY}, {YY}, {MM} und {#…#}.`,
        { token: unknown },
      ),
    );
  }
  if (counters.length !== 1) {
    return err(issue("format_counter_token", "Das Format muss genau einen Zähler wie {####} enthalten."));
  }
  const literal = format.replace(TOKEN, "");
  if (!LITERAL_OK.test(literal)) {
    const bad = [...literal].find((c) => !LITERAL_OK.test(c)) ?? "";
    return err(
      issue(
        "format_illegal_char",
        `Das Zeichen „${bad}“ ist nicht erlaubt (DATEV Belegfeld 1). Erlaubt: A–Z, a–z, 0–9 und $ % & * + - /.`,
        { char: bad },
      ),
    );
  }
  const hasYear = tokens.includes("YYYY") || tokens.includes("YY");
  if (reset === "yearly" && !hasYear) {
    return err(
      issue(
        "reset_requires_year",
        "Ein jährlicher Neustart ist nur möglich, wenn das Format {YYYY} oder {YY} enthält.",
      ),
    );
  }
  if (reset === "monthly" && !(hasYear && tokens.includes("MM"))) {
    return err(
      issue(
        "reset_requires_month",
        "Ein monatlicher Neustart ist nur möglich, wenn das Format ein Jahr und {MM} enthält.",
      ),
    );
  }
  const digits = counters[0]?.length ?? 1;
  // Longest possible number: 4-digit year, counter at 10^digits (one digit more than the padding).
  const longest = render(format, { year: 2000, month: 12 }, 10 ** digits);
  if (longest.length > MAX_NUMBER_LENGTH) {
    return err(
      issue(
        "format_too_long",
        `Die Nummer kann bis zu ${longest.length} Zeichen lang werden; erlaubt sind höchstens ${MAX_NUMBER_LENGTH}.`,
        { length: longest.length },
      ),
    );
  }
  return ok({ digits });
}

/** Boolean form for live UI checks. */
export function checkFormat(format: string, reset: ResetPolicy): FormatCheck {
  const r = validateFormat(format, reset);
  return r.ok ? { ok: true } : { ok: false, code: r.error.code, message: r.error.message };
}

export function render(format: string, date: YearMonth, counter: number): string {
  return format.replace(TOKEN, (_, token: string) => {
    if (token === "YYYY") return String(date.year);
    if (token === "YY") return String(date.year % 100).padStart(2, "0");
    if (token === "MM") return String(date.month).padStart(2, "0");
    if (/^#{1,10}$/.test(token)) return String(counter).padStart(token.length, "0");
    return `{${token}}`;
  });
}

/** Next three numbers for a business date (Europe/Berlin year/month, passed in). */
export function previewNumbers(format: string, date: YearMonth, next: number): string[] {
  return [next, next + 1, next + 2].map((n) => render(format, date, n));
}

/** Counter period of a business date (F01 §4.3 step 2): "" | "YYYY" | "YYYY-MM". */
export function periodKey(reset: ResetPolicy, date: YearMonth): string {
  if (reset === "never") return "";
  const y = String(date.year).padStart(4, "0");
  return reset === "yearly" ? y : `${y}-${String(date.month).padStart(2, "0")}`;
}

/** Uppercase, trimmed (F01 §5.5 "Normalisation"; numberRegister.normalized). */
export function normalizeNumber(number: string): string {
  return number.trim().toUpperCase();
}

// ── seeded ranges (F01 §5.5 table, SET-006/SET-053) ───────────────────────────────────────────────────
export type NumberedDocType =
  | "invoice"
  | "advance_invoice"
  | "partial_invoice"
  | "final_invoice"
  | "cancellation"
  | "correction"
  | "quote"
  | "order_confirmation"
  | "delivery_note"
  | "proforma"
  | "reminder"
  | "self_billing"
  | "contact"
  | "product"
  | "asset"
  | "voucherInternal";

export interface SeedRange {
  /** Stable key = the first document type (UI field key). */
  key: NumberedDocType;
  name: string;
  docTypes: readonly NumberedDocType[];
  format: string;
  resetPolicy: ResetPolicy;
  startValue: number;
}

export const SEEDED_RANGES: readonly SeedRange[] = [
  {
    key: "invoice",
    name: "Rechnungen",
    docTypes: ["invoice", "advance_invoice", "partial_invoice", "final_invoice", "cancellation"],
    format: "RE-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "correction",
    name: "Rechnungskorrekturen",
    docTypes: ["correction"],
    format: "RK-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "quote",
    name: "Angebote",
    docTypes: ["quote"],
    format: "AN-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "order_confirmation",
    name: "Auftragsbestätigungen",
    docTypes: ["order_confirmation"],
    format: "AB-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "delivery_note",
    name: "Lieferscheine",
    docTypes: ["delivery_note"],
    format: "LS-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "proforma",
    name: "Proforma",
    docTypes: ["proforma"],
    format: "PF-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "reminder",
    name: "Mahnungen",
    docTypes: ["reminder"],
    format: "MA-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  // F04 §4.9 INV-16: Gutschriften (self-billing) have their own gapless range
  {
    key: "self_billing",
    name: "Gutschriften",
    docTypes: ["self_billing"],
    format: "GS-{YYYY}-{####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
  {
    key: "contact",
    name: "Kontakte",
    docTypes: ["contact"],
    format: "{#####}",
    resetPolicy: "never",
    startValue: 10000,
  },
  {
    key: "product",
    name: "Produkte",
    docTypes: ["product"],
    format: "ART-{#####}",
    resetPolicy: "never",
    startValue: 1,
  },
  { key: "asset", name: "Anlagen", docTypes: ["asset"], format: "AV-{#####}", resetPolicy: "never", startValue: 1 },
  {
    key: "voucherInternal",
    name: "Belege (intern)",
    docTypes: ["voucherInternal"],
    format: "BE-{YYYY}-{#####}",
    resetPolicy: "yearly",
    startValue: 1,
  },
];

export function seedRange(key: string): SeedRange | undefined {
  return SEEDED_RANGES.find((r) => r.key === key);
}
