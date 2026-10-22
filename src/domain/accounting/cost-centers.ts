/**
 * ACC-019: cost centres (KST, DATEV KOST1) on sales postings. The journal posts one revenue line per VAT group
 * (S2), so a group carries a cost centre only when every item line of the group resolves to the same one (line
 * KST, else the document KST, frozen as its number in the snapshot). Mixed groups stay without cost centre rather
 * than splitting a revenue line by guesswork; vouchers carry the cost centre per line (`VoucherPostingLine`).
 */
import type { VatCategory } from "../tax/vat-category";

export interface CostCenterItem {
  vatCategory: VatCategory;
  vatRateBp: number;
  /** Cost centre number frozen in the snapshot (DOC-53). */
  costCenter?: string | undefined;
}

export function groupCostCenter(
  items: readonly CostCenterItem[],
  idByNumber: Readonly<Record<string, string>>,
  category: VatCategory,
  rateBp: number,
): string | undefined {
  const numbers = new Set(
    items.filter((i) => i.vatCategory === category && i.vatRateBp === rateBp).map((i) => i.costCenter ?? ""),
  );
  if (numbers.size !== 1) return undefined;
  const [number] = [...numbers];
  return number ? idByNumber[number] : undefined;
}
