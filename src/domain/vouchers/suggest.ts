/**
 * Account suggestions and supplier learning (F06 VOU-041, VOU-042; US-05).
 *
 * Cascade with confidence: (1) supplier profile — the same account on the last ≥ 3 uses → 0.95 „gelernt“, 1–2 uses
 * → 0.8; (2) the OCR model's category → model confidence × 0.9; (3) the built-in keyword table → 0.6; (4) none.
 * Every suggestion is restricted to the accounts allowed for the direction and tax rule; suggestions are never applied
 * without the owner's confirmation (the editor only preselects). Pure.
 */
import { keywordAccount } from "../accounting/keywords";
import type { Chart } from "../rules/accounting";

export interface SupplierProfileData {
  lastAccount?: string;
  lastTaxRule?: string;
  lastCostCenterId?: string;
  uses: number;
  /** Consecutive uses of `lastAccount` (the „last ≥ 3 uses“ condition of VOU-041). */
  accountStreak?: number;
}

export type SuggestionSource = "profile" | "ocr" | "keyword";

export interface AccountSuggestion {
  account: string;
  confidence: number;
  source: SuggestionSource;
  /** German reason chip, e.g. „gelernt (5×)“. */
  reason: string;
}

export function suggestAccount(input: {
  profile?: SupplierProfileData | null;
  ocr?: { account: string; confidence: number } | null;
  /** Supplier name and line descriptions (for the keyword table). */
  text: string;
  chart: Chart;
  allowed: ReadonlySet<string>;
}): AccountSuggestion | null {
  const p = input.profile;
  if (p?.lastAccount && input.allowed.has(p.lastAccount)) {
    const streak = p.accountStreak ?? Math.min(p.uses, 1);
    if (streak >= 3)
      return { account: p.lastAccount, confidence: 0.95, source: "profile", reason: `gelernt (${streak}×)` };
    if (streak >= 1)
      return { account: p.lastAccount, confidence: 0.8, source: "profile", reason: `zuletzt verwendet (${streak}×)` };
  }
  if (input.ocr && input.allowed.has(input.ocr.account)) {
    return {
      account: input.ocr.account,
      confidence: Math.round(input.ocr.confidence * 0.9 * 1000) / 1000,
      source: "ocr",
      reason: "Belegerkennung",
    };
  }
  const k = keywordAccount(input.text, input.chart);
  if (k && input.allowed.has(k.account)) {
    return { account: k.account, confidence: 0.6, source: "keyword", reason: `Stichwort (${k.label})` };
  }
  return null;
}

/** VOU-042: profile after a finalisation or a correction (VOU-008) with the booked values. */
export function learnProfile(
  before: SupplierProfileData | null,
  booked: { account?: string; taxRule: string; costCenterId?: string },
): SupplierProfileData {
  const sameAccount = before?.lastAccount !== undefined && before.lastAccount === booked.account;
  return {
    ...(booked.account ? { lastAccount: booked.account } : {}),
    lastTaxRule: booked.taxRule,
    ...(booked.costCenterId ? { lastCostCenterId: booked.costCenterId } : {}),
    uses: (before?.uses ?? 0) + 1,
    accountStreak: booked.account ? (sameAccount ? (before?.accountStreak ?? 1) + 1 : 1) : 0,
  };
}

/**
 * VOU-042 after a correction: the profile takes the corrected values but the correction does not count as another
 * use — the streak restarts if the account changed.
 */
export function correctProfile(
  before: SupplierProfileData | null,
  corrected: { account?: string; taxRule: string; costCenterId?: string },
): SupplierProfileData {
  const same = before?.lastAccount === corrected.account;
  return {
    ...(corrected.account ? { lastAccount: corrected.account } : {}),
    lastTaxRule: corrected.taxRule,
    ...(corrected.costCenterId ? { lastCostCenterId: corrected.costCenterId } : {}),
    uses: Math.max(before?.uses ?? 0, 1),
    accountStreak: same ? Math.max(before?.accountStreak ?? 1, 1) : 1,
  };
}
