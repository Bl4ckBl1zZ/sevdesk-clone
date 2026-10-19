/**
 * Revenue account override (F03 PRD-050..PRD-053, DATEV-02).
 *  - PRD-050: the override must be a revenue account of the company chart (`REVENUE_ACCOUNT_INVALID`);
 *  - PRD-052: a DATEV automatic account carries its own VAT (category, rate); it must match every rate the
 *    product's key resolves to today or at any known future validity (`REVENUE_ACCOUNT_RATE_MISMATCH`). At
 *    finalisation the same check runs per line against the line's actual category and rate.
 * The account's VAT is read from the role mapping valid on the date (e.g. `revenue.domestic.19` → S 19 %); an
 * automatic account without a domestic revenue role (IG-Lieferung, Ausfuhr, § 13b …) never fits a domestic line.
 */
import { type Issue, issue } from "../result";
import { type Chart, type ChartAccount, chartAccounts, lookupRoleMapping } from "../rules/accounting";
import { isVatRateKey, VAT_RATE_KEYS, type VatRateValue } from "../rules/vat-rates";
import type { CalendarDate } from "../time/calendar-date";

export type RevenueAccountIssue = Issue<"REVENUE_ACCOUNT_INVALID" | "REVENUE_ACCOUNT_RATE_MISMATCH">;

type Vat = Pick<VatRateValue, "rateBp"> & { readonly category: string };

const CHART_LABEL: Readonly<Record<Chart, string>> = { SKR03: "SKR 03", SKR04: "SKR 04" };

/** VAT of a role: `….19` / `….7` → S, `revenue.exempt_4` → E 0, `revenue.zero_pv` → Z 0; anything else → null. */
function roleVat(role: string): Vat | null {
  if (role.endsWith(".19")) return { category: "S", rateBp: 1900 };
  if (role.endsWith(".7")) return { category: "S", rateBp: 700 };
  if (role === "revenue.exempt_4") return { category: "E", rateBp: 0 };
  if (role === "revenue.zero_pv") return { category: "Z", rateBp: 0 };
  return null;
}

/** The (category, rate) an automatic account implies on `date`, or null if it has no domestic VAT role. */
export function automaticAccountVat(chart: Chart, account: string, date: CalendarDate): Vat | null {
  const mapping = lookupRoleMapping(date);
  if (!mapping.ok) return null;
  for (const row of mapping.value.value.rows) {
    if (row[chart] !== account) continue;
    const vat = roleVat(row.role);
    if (vat) return vat;
  }
  return null;
}

/** Rates of a VAT key valid today or later (PRD-052 "today or at any known future validity"). */
export function keyRatesFromToday(key: string, today: CalendarDate): Vat[] {
  if (!isVatRateKey(key)) return [];
  return VAT_RATE_KEYS[key].entries
    .filter((e) => e.validTo === undefined || e.validTo >= today)
    .map((e) => ({ category: e.value.category, rateBp: e.value.rateBp }));
}

const pct = (bp: number) => `${(bp / 100).toLocaleString("de-DE")} %`;

/**
 * PRD-050 + PRD-052. `rates` are the (category, rate) pairs the account must carry: the key's rates from today on
 * (product save) or the line's actual rate (finalisation).
 */
export function revenueAccountIssue(input: {
  readonly chart: Chart;
  readonly account: string;
  readonly date: CalendarDate;
  readonly rates: readonly Vat[];
  /** The company chart on `date`; default = the shipped seed. */
  readonly accounts?: readonly ChartAccount[];
}): RevenueAccountIssue | null {
  const accounts = input.accounts ?? chartOf(input.chart, input.date);
  const a = accounts.find((x) => x.number === input.account);
  if (a?.type !== "revenue") {
    return issue(
      "REVENUE_ACCOUNT_INVALID",
      `Das Konto ${input.account} ist kein Erlöskonto im ${CHART_LABEL[input.chart]}.`,
      { account: input.account },
    );
  }
  if (!a.automaticVatAccount) return null;
  const vat = automaticAccountVat(input.chart, input.account, input.date);
  const bad = input.rates.find((r) => !vat || r.category !== vat.category || r.rateBp !== vat.rateBp);
  if (!bad) return null;
  return issue(
    "REVENUE_ACCOUNT_RATE_MISMATCH",
    vat
      ? `Das Erlöskonto ${input.account} ist ein Automatikkonto für ${pct(vat.rateBp)}, das Produkt hat ${pct(bad.rateBp)}.`
      : `Das Erlöskonto ${input.account} ist ein Automatikkonto ohne Inlands-Steuersatz, das Produkt hat ${pct(bad.rateBp)}.`,
    { account: input.account, rateBp: bad.rateBp },
  );
}

function chartOf(chart: Chart, date: CalendarDate): readonly ChartAccount[] {
  const r = chartAccounts(chart, date);
  return r.ok ? r.value : [];
}

/** Revenue accounts for the product/line select (number and name). */
export function revenueAccountOptions(chart: Chart, date: CalendarDate): { number: string; name: string }[] {
  return chartOf(chart, date)
    .filter((a) => a.type === "revenue")
    .map((a) => ({ number: a.number, name: a.name }));
}
