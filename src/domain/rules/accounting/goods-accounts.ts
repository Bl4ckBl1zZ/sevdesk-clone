/**
 * Expense accounts of a goods-type category (F06 VOU-065): a line on one of these accounts with a per-item cost
 * above the recording threshold triggers the „Anlagegut?“ question (AO-03). Fixed-asset accounts (class 0) always
 * trigger it. Chart data, versioned with the chart seed (LEGAL-OPEN: F08-Q1 — selection without Steuerberater check).
 */
import type { Chart } from "./types";

export const GOODS_EXPENSE_ACCOUNTS: Readonly<Record<Chart, readonly string[]>> = {
  // Wareneingang, innergemeinschaftlicher Erwerb, Bürobedarf, sonstige Aufwendungen, GWG-Sofortabschreibung
  SKR03: ["3300", "3400", "3420", "3425", "4930", "4900", "4855"],
  SKR04: ["5300", "5400", "5420", "5425", "6815", "6300", "6260"],
};
