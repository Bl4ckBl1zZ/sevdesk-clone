/**
 * Rate-change banner for the product list (F03 PRD-027, PRD-E05, MISC-09): when the rule tables (shipped rows or F01
 * overrides) change the rate of a key within the next 60 days, list how many products keep their gross price (net
 * changes) and how many keep their net price (gross changes).
 */
import type { RuleOverride } from "../rules/rule-table";
import { lookupVatRate, VAT_RATE_KEYS, type VatRateValue } from "../rules/vat-rates";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import type { PriceMode } from "./product";

export interface RateChange {
  readonly key: string;
  readonly date: CalendarDate;
  readonly fromBp: number;
  readonly toBp: number;
}

/** Rate changes of every key in (today, today + days]. */
export function upcomingRateChanges(
  today: CalendarDate,
  days = 60,
  overridesByKey: Readonly<Record<string, readonly RuleOverride<VatRateValue>[]>> = {},
): RateChange[] {
  const until = addDays(today, days);
  const out: RateChange[] = [];
  for (const key of Object.keys(VAT_RATE_KEYS)) {
    const table = VAT_RATE_KEYS[key as keyof typeof VAT_RATE_KEYS];
    const overrides = overridesByKey[key] ?? [];
    const boundaries = new Set<string>();
    for (const e of [...table.entries, ...overrides]) {
      boundaries.add(e.validFrom);
      if (e.validTo) boundaries.add(addDays(e.validTo, 1));
    }
    for (const b of [...boundaries].sort()) {
      if (b <= today || b > until) continue;
      const before = lookupVatRate(key, addDays(b as CalendarDate, -1), overrides);
      const after = lookupVatRate(key, b as CalendarDate, overrides);
      if (before.ok && after.ok && before.value.value.rateBp !== after.value.value.rateBp) {
        out.push({ key, date: b as CalendarDate, fromBp: before.value.value.rateBp, toBp: after.value.value.rateBp });
      }
    }
  }
  return out;
}

/** PRD-027 banner text for one change and the affected products. */
export function rateChangeBanner(
  change: RateChange,
  products: readonly { vatRateKey: string; priceMode: PriceMode; active: boolean }[],
): string | null {
  const affected = products.filter((p) => p.active && p.vatRateKey === change.key);
  if (affected.length === 0) return null;
  const gross = affected.filter((p) => p.priceMode === "gross").length;
  const net = affected.length - gross;
  const direction = change.toBp < change.fromBp ? "steigt" : "sinkt";
  return `Ab ${formatGermanDate(change.date)} ändert sich der Steuersatz für ${change.key}. ${gross} Produkte mit Bruttopreis behalten den Bruttopreis (Nettopreis ${direction}); ${net} Produkte mit Nettopreis behalten den Nettopreis.`;
}
