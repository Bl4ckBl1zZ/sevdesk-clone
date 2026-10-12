/**
 * Number-range preview for the wizard (F01 SET-056…058, §5.5).
 *
 * TODO(domain): replace with `src/domain/numbering/format.ts` (render, validate, collision simulation) as soon as
 * it exists — this is a display-only stand-in so the wizard can show a preview. It never assigns numbers;
 * numbers are assigned only in the finalisation transaction (SET-061).
 */
export type ResetPolicy = "never" | "yearly" | "monthly";

const TOKEN = /\{([^}]*)\}/g;
const LITERAL_OK = /^[A-Za-z0-9$%&*+\-/]*$/;
const MAX_LENGTH = 36;

export interface FormatCheck {
  ok: boolean;
  message?: string;
}

/** Mirrors the error texts of F01 §5.5. */
export function checkFormat(format: string, reset: ResetPolicy): FormatCheck {
  const tokens = [...format.matchAll(TOKEN)].map((m) => m[1] ?? "");
  const counters = tokens.filter((t) => /^#{1,10}$/.test(t));
  const unknown = tokens.find((t) => !/^#{1,10}$/.test(t) && !["YYYY", "YY", "MM"].includes(t));
  if (unknown !== undefined) {
    return { ok: false, message: `Unbekannter Platzhalter {${unknown}}. Erlaubt sind {YYYY}, {YY}, {MM} und {#…#}.` };
  }
  if (counters.length !== 1) return { ok: false, message: "Das Format muss genau einen Zähler wie {####} enthalten." };
  const literal = format.replace(TOKEN, "");
  if (!LITERAL_OK.test(literal)) {
    const bad = [...literal].find((c) => !LITERAL_OK.test(c));
    return {
      ok: false,
      message: `Das Zeichen „${bad}“ ist nicht erlaubt (DATEV Belegfeld 1). Erlaubt: A–Z, a–z, 0–9 und $ % & * + - /.`,
    };
  }
  const hasYear = tokens.includes("YYYY") || tokens.includes("YY");
  if (reset === "yearly" && !hasYear) {
    return { ok: false, message: "Ein jährlicher Neustart ist nur möglich, wenn das Format {YYYY} oder {YY} enthält." };
  }
  if (reset === "monthly" && !(hasYear && tokens.includes("MM"))) {
    return {
      ok: false,
      message: "Ein monatlicher Neustart ist nur möglich, wenn das Format ein Jahr und {MM} enthält.",
    };
  }
  const digits = counters[0]?.length ?? 1;
  const longest = render(format, { year: 2026, month: 10 }, 10 ** digits);
  if (longest.length > MAX_LENGTH) {
    return {
      ok: false,
      message: `Die Nummer kann bis zu ${longest.length} Zeichen lang werden; erlaubt sind höchstens 36.`,
    };
  }
  return { ok: true };
}

export function render(format: string, date: { year: number; month: number }, counter: number): string {
  return format.replace(TOKEN, (_, token: string) => {
    if (token === "YYYY") return String(date.year);
    if (token === "YY") return String(date.year % 100).padStart(2, "0");
    if (token === "MM") return String(date.month).padStart(2, "0");
    if (/^#{1,10}$/.test(token)) return String(counter).padStart(token.length, "0");
    return `{${token}}`;
  });
}

/** Next three numbers for the given date (business date in Europe/Berlin). */
export function previewNumbers(format: string, date: { year: number; month: number }, next: number): string[] {
  return [next, next + 1, next + 2].map((n) => render(format, date, n));
}
