import { z } from "zod";
// Type-only: the `.meta({ example, … })` typings of zod-openapi (no runtime import in the domain layer).
import type {} from "zod-openapi";
import { ID_PREFIXES, type IdTable } from "../../api/ids";

/**
 * Wire conventions of the REST API (05 §3), shared by the REST handlers, the OpenAPI document and the MCP tools:
 * snake_case, prefixed IDs, ISO dates, RFC 3339 instants, unit prices/quantities as decimal strings with a dot
 * (`"12.3450"`, never floats), cursor pagination, whitelisted `expand`.
 */

// ── decimal strings ──────────────────────────────────────────────────────────────────────────────────
/** `"12.3450"` (scale 4) → 123450; null when malformed or more decimals than `scale` (never rounded). */
export function decimalToScaled(value: string, scale: number): number | null {
  const m = /^(-)?(\d{1,13})(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return null;
  const fraction = m[3] ?? "";
  if (fraction.length > scale) return null;
  const n = Number(`${m[2]}${fraction.padEnd(scale, "0")}`);
  if (!Number.isSafeInteger(n)) return null;
  return m[1] ? -n : n;
}

/** 950000 (scale 4) → `"95.0000"`. */
export function scaledToDecimal(value: number, scale: number): string {
  const negative = value < 0;
  const digits = String(Math.abs(value)).padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale);
  return `${negative ? "-" : ""}${int}${scale > 0 ? `.${fraction}` : ""}`;
}

export const decimalString = (scale: number, description: string, example: string) =>
  z
    .string()
    .regex(
      new RegExp(`^-?\\d{1,13}(\\.\\d{1,${scale}})?$`),
      `Dezimalzahl mit Punkt und höchstens ${scale} Nachkommastellen.`,
    )
    .meta({ description, example });

// ── IDs, dates, instants ─────────────────────────────────────────────────────────────────────────────
export const prefixedId = (table: IdTable, description?: string) =>
  z
    .string()
    .regex(new RegExp(`^${ID_PREFIXES[table]}[0-9a-z]{16,64}$`), `Erwartet eine ID mit Präfix ${ID_PREFIXES[table]}.`)
    .meta({
      description: description ?? `ID (${ID_PREFIXES[table]}…)`,
      example: `${ID_PREFIXES[table]}k57f3x2m9q8w1e4r6t`,
    });

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Datum im Format JJJJ-MM-TT.")
  .meta({ description: "Datum (YYYY-MM-DD)", example: "2026-10-12" });

export const instant = z
  .string()
  .meta({ description: "Zeitpunkt (RFC 3339, UTC)", example: "2026-10-12T08:30:00.000Z" });

export function toInstant(ms: number): string {
  return new Date(ms).toISOString();
}

export function toOptionalInstant(ms: number | undefined | null): string | null {
  return ms === undefined || ms === null ? null : toInstant(ms);
}

/** RFC 3339 → epoch ms; null when not a valid instant. */
export function parseInstant(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

// ── list conventions ─────────────────────────────────────────────────────────────────────────────────
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

export const listQuery = z.object({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .meta({ description: `Anzahl je Seite (1–${MAX_LIMIT}, Standard ${DEFAULT_LIMIT})`, example: 25 }),
  cursor: z.string().max(2000).optional().meta({ description: "Cursor aus `next_cursor` der vorherigen Seite" }),
  updated_since: z
    .string()
    .refine((v) => parseInstant(v) !== null, "Zeitpunkt im Format RFC 3339 (z. B. 2026-10-12T08:30:00Z).")
    .optional()
    .meta({ description: "Nur Datensätze, die seit diesem Zeitpunkt geändert wurden (Synchronisation)" }),
});

export function listEnvelope<T extends z.ZodType>(item: T, id: string) {
  return z
    .object({
      data: z.array(item),
      next_cursor: z.string().nullable().meta({ description: "Cursor der nächsten Seite oder null" }),
    })
    .meta({ id });
}

/** `?expand=a,b` → the whitelisted names, or the first unknown name. */
export function parseExpand(
  value: string | undefined,
  allowed: readonly string[],
): { ok: true; expand: Set<string> } | { ok: false; unknown: string } {
  const names = (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) if (!allowed.includes(n)) return { ok: false, unknown: n };
  return { ok: true, expand: new Set(names) };
}

export const expandQuery = (allowed: readonly string[]) =>
  z
    .string()
    .optional()
    .meta({ description: `Kommagetrennt: ${allowed.join(", ")}`, example: allowed.slice(0, 2).join(",") });

/** `"true"`/`"false"` query flags. */
export const booleanQuery = z
  .enum(["true", "false"])
  .transform((v) => v === "true")
  .optional();

// ── problem details (RFC 9457) for OpenAPI ───────────────────────────────────────────────────────────
const fieldError = z.object({
  code: z.string(),
  field: z.string().optional(),
  rule: z.string().optional(),
  message: z.string(),
});

export const problemSchema = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.string(),
    request_id: z.string(),
    detail: z.string().optional(),
    errors: z.array(fieldError).optional(),
    warnings: z.array(fieldError).optional(),
    required_scope: z.string().optional(),
  })
  .meta({
    id: "Problem",
    description: "RFC 9457 problem details (05 §3.1)",
    example: {
      type: "https://api.example.de/problems/validation_failed",
      title: "Die Eingaben sind nicht gültig.",
      status: 422,
      code: "validation_failed",
      request_id: "req_01J9Z6",
      errors: [{ code: "vat_id_format", field: "vat_id", message: "Die USt-IdNr hat ein ungültiges Format." }],
    },
  });

/** Deep camelCase → snake_case for plain data objects (settings views); arrays and nested objects included. */
export function snakeKeys(value: unknown, keep: ReadonlySet<string> = new Set()): unknown {
  if (Array.isArray(value)) return value.map((v) => snakeKeys(v, keep));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    const key = k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
    out[key] = keep.has(k) ? v : snakeKeys(v, keep);
  }
  return out;
}
