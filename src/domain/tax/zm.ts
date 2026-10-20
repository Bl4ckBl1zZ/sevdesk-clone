/**
 * Zusammenfassende Meldung (F08 TAX-009/TAX-010, UVA-05; §18a UStG). Pure.
 *
 * Rows per (customer USt-IdNr, type): L = innergemeinschaftliche Lieferung (tax key `igL`), S = sonstige Leistung
 * nach § 3a Abs. 2 UStG (`EU-RC`); D (Dreiecksgeschäft) has no posting tax key and is not offered (F08 §4.5: only the
 * ZM „D“ entry would be supported — LEGAL-OPEN F08 §4.5 not-supported list). Amounts by tax point in whole euros
 * (decided default: truncated toward zero ⚠), negative values allowed for corrections. The 50,000 € quarterly goods
 * threshold (§18a Abs. 1 S. 2 UStG) is date-effective rule data.
 */
import type { RuleOverride } from "../rules/rule-table";
import { lookupZmGoodsThreshold, type ZmGoodsThreshold } from "../rules/zm";
import { calendarDate } from "../time/calendar-date";
import type { TaxJournalEntry } from "./ustva";

export type ZmType = "L" | "S" | "D";

export interface ZmContribution {
  vatId: string;
  name: string;
  type: ZmType;
  cents: number;
  taxPointDate: string;
  entryId: string;
  seq: number;
  source: { kind: string; id: string };
}

const TYPE_BY_TAX_KEY: Readonly<Record<string, ZmType>> = { igL: "L", "EU-RC": "S" };

export const normalizeVatId = (id: string) => id.replace(/[\s.-]/g, "").toUpperCase();

export function zmContributions(entry: TaxJournalEntry): ZmContribution[] {
  const out: ZmContribution[] = [];
  for (const l of entry.lines) {
    const type = l.taxKey ? TYPE_BY_TAX_KEY[l.taxKey] : undefined;
    if (!type || !l.taxPointDate) continue;
    const cents = l.creditCents - l.debitCents;
    if (cents === 0) continue;
    out.push({
      vatId: normalizeVatId(entry.counterparty?.vatId ?? ""),
      name: entry.counterparty?.name ?? "",
      type,
      cents,
      taxPointDate: l.taxPointDate,
      entryId: entry.id,
      seq: entry.seq,
      source: entry.source,
    });
  }
  return out;
}

export interface ZmRow {
  countryCode: string;
  /** Number without the country prefix (as entered in ELSTER). */
  vatNumber: string;
  vatId: string;
  name: string;
  type: ZmType;
  exactCents: number;
  /** Whole euros (form value). */
  euros: number;
  contributors: { entryId: string; seq: number; source: { kind: string; id: string }; cents: number }[];
}

export interface ZmSheet {
  period: string;
  rows: ZmRow[];
  totalEuros: number;
  totalsByType: Record<ZmType, number>;
  warnings: string[];
  /** §18a Abs. 1 S. 2: goods (L) above the quarterly threshold → monthly ZM required. */
  monthlyRequired: boolean;
}

export function computeZm(
  period: string,
  contributions: readonly ZmContribution[],
  opts: { quarterGoodsCents?: number; date?: string; overrides?: readonly RuleOverride<ZmGoodsThreshold>[] } = {},
): ZmSheet {
  const byKey = new Map<string, ZmRow>();
  const warnings: string[] = [];
  for (const c of contributions) {
    const key = `${c.vatId}|${c.type}`;
    const row = byKey.get(key) ?? {
      countryCode: c.vatId.slice(0, 2),
      vatNumber: c.vatId.slice(2),
      vatId: c.vatId,
      name: c.name,
      type: c.type,
      exactCents: 0,
      euros: 0,
      contributors: [],
    };
    row.exactCents += c.cents;
    row.contributors.push({ entryId: c.entryId, seq: c.seq, source: c.source, cents: c.cents });
    byKey.set(key, row);
  }
  const rows = [...byKey.values()]
    .map((r) => ({ ...r, euros: Math.trunc(r.exactCents / 100) }))
    .sort((a, b) => a.vatId.localeCompare(b.vatId) || a.type.localeCompare(b.type));
  for (const r of rows) {
    if (!/^[A-Z]{2}[0-9A-Z+*]{2,12}$/.test(r.vatId)) {
      warnings.push(
        `Für ${r.name || "einen Kunden"} fehlt eine gültige USt-IdNr. – ohne USt-IdNr. ist keine Zusammenfassende Meldung möglich.`,
      );
    }
  }
  const totalsByType: Record<ZmType, number> = { L: 0, S: 0, D: 0 };
  for (const r of rows) totalsByType[r.type] += r.euros;
  const threshold = lookupZmGoodsThreshold(calendarDate(opts.date ?? `${period.slice(0, 4)}-01-01`), opts.overrides);
  const limit = threshold.ok ? threshold.value.value.quarterlyGoodsLimitCents : 5_000_000;
  const goods = opts.quarterGoodsCents ?? rows.filter((r) => r.type === "L").reduce((s, r) => s + r.exactCents, 0);
  const monthlyRequired = goods > limit;
  if (monthlyRequired && period.includes("-Q")) {
    warnings.push(
      `Die innergemeinschaftlichen Lieferungen im Quartal übersteigen ${limit / 100} € – die Zusammenfassende Meldung ist monatlich abzugeben (§ 18a Abs. 1 UStG).`,
    );
  }
  return {
    period,
    rows,
    totalEuros: rows.reduce((s, r) => s + r.euros, 0),
    totalsByType,
    warnings,
    monthlyRequired,
  };
}

/** TAX-010 / E-UVA-13: Σ ZM L = Kz 41, Σ ZM S = Kz 21 (whole euros) for the same months. */
export function reconcileZmWithUstva(zm: ZmSheet, kz41Euros: number, kz21Euros: number): string[] {
  const out: string[] = [];
  if (zm.totalsByType.L !== kz41Euros) {
    out.push(`ZM-Summe (${zm.totalsByType.L} €) weicht von UStVA Kz 41 (${kz41Euros} €) ab.`);
  }
  if (zm.totalsByType.S !== kz21Euros) {
    out.push(`ZM-Summe (${zm.totalsByType.S} €) weicht von UStVA Kz 21 (${kz21Euros} €) ab.`);
  }
  return out;
}

/**
 * CSV for the BZSt-Online-Portal (alternative channel, F08 open question 13). LEGAL-OPEN: F08-Q13 — CSV layout ⚠
 * (header and column order as published by the BZSt; one-off check before the first upload recommended).
 */
export function zmCsv(zm: ZmSheet): string {
  const lines = ["Laenderkennzeichen,USt-IdNr.,Betrag(EUR),Art der Leistung"];
  for (const r of zm.rows) lines.push([r.countryCode, r.vatNumber, String(r.euros), r.type].join(","));
  return `${lines.join("\r\n")}\r\n`;
}
