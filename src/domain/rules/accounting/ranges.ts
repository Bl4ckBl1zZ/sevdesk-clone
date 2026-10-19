/**
 * Number ranges of the Sachkonten per account type (F08 ACC-009, E-ACC-07). Four-digit general-ledger accounts only
 * (Debitoren/Kreditoren are five digits and not created here). Ranges follow the DATEV Kontenklassen; where a class
 * mixes types (SKR03 class 0/1, SKR04 class 7) the class is allowed for each of them (conservative: the chart's own
 * class structure, never a number DATEV reserves for another class).
 *
 * Source: DATEV Standardkontenrahmen SKR03 / SKR04 (Kontenklassen 0–9), Stand 2025.
 */
import type { AccountType, Chart } from "./types";

type Range = readonly [from: number, to: number];

export const ACCOUNT_RANGES: Readonly<Record<Chart, Readonly<Record<AccountType, readonly Range[]>>>> = {
  SKR03: {
    // 0 Anlage- und Kapitalkonten, 1 Finanz- und Privatkonten
    asset: [
      [1, 799],
      [1000, 1599],
    ],
    liability: [
      [600, 999],
      [1600, 1799],
    ],
    equity: [
      [800, 999],
      [1800, 1999],
    ],
    // 3 Wareneingang, 4 betriebliche Aufwendungen, 2 Abgrenzungskonten (neutrale Aufwendungen)
    expense: [
      [2000, 2499],
      [3000, 4999],
    ],
    // 8 Erlöse, 2 Abgrenzungskonten (neutrale Erträge)
    revenue: [
      [2500, 2999],
      [8000, 8999],
    ],
    neutral: [
      [2000, 2999],
      [9000, 9999],
    ],
  },
  SKR04: {
    // 0 Anlagevermögen, 1 Umlaufvermögen
    asset: [[1, 1999]],
    equity: [[2000, 2999]],
    liability: [[3000, 3999]],
    // 4 Erlöse, 7 weitere Erträge
    revenue: [
      [4000, 4999],
      [7000, 7999],
    ],
    // 5 Material/Waren, 6 betriebliche Aufwendungen, 7 weitere Aufwendungen
    expense: [
      [5000, 6999],
      [7000, 7999],
    ],
    neutral: [
      [7000, 7999],
      [9000, 9999],
    ],
  },
};

export const ACCOUNT_TYPE_LABEL: Readonly<Record<AccountType, string>> = {
  asset: "Aktivkonto",
  liability: "Verbindlichkeit",
  equity: "Eigenkapital",
  revenue: "Erlöskonto",
  expense: "Aufwandskonto",
  neutral: "neutrales Konto",
};

export function inAccountRange(chart: Chart, type: AccountType, number: string): boolean {
  if (!/^\d{4}$/.test(number)) return false;
  const n = Number(number);
  return ACCOUNT_RANGES[chart][type].some(([from, to]) => n >= from && n <= to);
}
