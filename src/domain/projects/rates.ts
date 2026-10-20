/**
 * Hourly rate resolution and rounding rules for time entries (F11 PRJ-008, PRJ-009). Pure.
 *
 * Rate chain at entry creation (stored on the entry as `hourlyRateMicros`, editable while open):
 *   entry override → project rate → customer price of the product → product price → default hourly rate (settings).
 * Prices are net micros per hour (1/10,000 €); the caller converts a gross product price or a per-minute unit.
 */
import { roundHalfAway } from "../money";

export type RateSource = "override" | "project" | "customer_price" | "product" | "default";

export const RATE_SOURCE_LABELS: Readonly<Record<RateSource, string>> = {
  override: "Eigener Satz",
  project: "Projektsatz",
  customer_price: "Kundenpreis",
  product: "Produktpreis",
  default: "Standardsatz",
};

export interface RateCandidates {
  readonly overrideMicros?: number | undefined;
  readonly projectMicros?: number | undefined;
  readonly customerPriceMicros?: number | undefined;
  readonly productMicros?: number | undefined;
  readonly defaultMicros?: number | undefined;
}

export interface ResolvedRate {
  readonly hourlyRateMicros: number;
  readonly source: RateSource;
}

const ORDER: readonly [keyof RateCandidates, RateSource][] = [
  ["overrideMicros", "override"],
  ["projectMicros", "project"],
  ["customerPriceMicros", "customer_price"],
  ["productMicros", "product"],
  ["defaultMicros", "default"],
];

/** First defined candidate of the chain; null when none is set (E-PRJ-23 blocks invoicing then). */
export function resolveHourlyRate(c: RateCandidates): ResolvedRate | null {
  for (const [key, source] of ORDER) {
    const v = c[key];
    if (v !== undefined && Number.isSafeInteger(v) && v >= 0) return { hourlyRateMicros: v, source };
  }
  return null;
}

/** A product price per unit converted to an hourly rate: `HUR` as is, `MIN` × 60; other units do not apply. */
export function hourlyFromUnitPrice(unitCode: string, unitPriceMicros: number): number | undefined {
  if (unitCode === "HUR") return unitPriceMicros;
  if (unitCode === "MIN") return unitPriceMicros * 60;
  return undefined;
}

// ── rounding (PRJ-009) ──────────────────────────────────────────────────────────────────────────────────────

export const ROUNDING_INCREMENTS = [0, 1, 5, 6, 10, 15, 30, 60] as const;
export type RoundingIncrement = (typeof ROUNDING_INCREMENTS)[number];

export interface TimeRounding {
  /** 0 = keine Rundung. */
  readonly incrementMinutes: RoundingIncrement;
  readonly mode: "up" | "nearest";
  /** Optional minimum per entry (or per group), e.g. 15 min. */
  readonly minimumMinutes?: number | undefined;
}

export const NO_ROUNDING: TimeRounding = { incrementMinutes: 0, mode: "up" };

/**
 * Rounded minutes for one entry (or one group with „pro Gruppe runden“). Raw durations are never altered — the
 * result is stored as `roundedMinutes` at invoicing. `nearest` rounds half up (7.5 → 15 for a 15-minute step).
 */
export function roundMinutes(raw: number, rule: TimeRounding = NO_ROUNDING): number {
  let m = Math.max(0, Math.trunc(raw));
  const step = rule.incrementMinutes;
  if (step > 1) {
    m = rule.mode === "up" ? Math.ceil(m / step) * step : Number(roundHalfAway(BigInt(m), BigInt(step))) * step;
  }
  if (rule.minimumMinutes !== undefined && m < rule.minimumMinutes && raw > 0) m = rule.minimumMinutes;
  return m;
}

export function roundingLabel(rule: TimeRounding): string {
  if (rule.incrementMinutes <= 1 && rule.minimumMinutes === undefined) return "keine Rundung";
  const step =
    rule.incrementMinutes > 1
      ? `${rule.incrementMinutes}-Minuten-Takt (${rule.mode === "up" ? "aufrunden" : "kaufmännisch"})`
      : "keine Taktung";
  return rule.minimumMinutes ? `${step}, mindestens ${rule.minimumMinutes} min` : step;
}
