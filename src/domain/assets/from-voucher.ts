/**
 * F08 AST-002: asset records from the booked voucher lines with an „Anlagegut?“ decision (F06 VOU-065). Pure.
 *
 * One record per item: a line with an integer quantity of n ≤ 100 items gives n assets with the line cost split
 * evenly (largest remainder on the first items, Σ = line cost). GWG → `gwg`, Sammelposten → `pool`, Anlage →
 * `linear` with `setupRequired` (useful life and method are chosen on /buchhaltung/anlagen, E-AST-11).
 */
import type { AssetMethod } from "./methods";

export interface VoucherAssetLine {
  /** 0-based line index of the voucher. */
  index: number;
  account: string;
  description?: string;
  quantityMilli?: number;
  /** What the line debits to its base account (`voucherLineBaseCents`). */
  baseCents: number;
  assetDecision?: "gwg" | "pool" | "asset" | "none";
}

export interface AssetDraft {
  index: number;
  item: number;
  name: string;
  account: string;
  costCents: number;
  method: AssetMethod;
  setupRequired: boolean;
}

const MAX_ITEMS = 100;

function itemCount(quantityMilli: number | undefined): number {
  if (!quantityMilli || quantityMilli <= 0 || quantityMilli % 1000 !== 0) return 1;
  const n = quantityMilli / 1000;
  return n > MAX_ITEMS ? 1 : n;
}

export function assetDraftsFromVoucher(
  lines: readonly VoucherAssetLine[],
  fallbackName: string,
  /** GWG/pool items in the asset accounts (asset.gwg / asset.pool) — the voucher posts them there. */
  accounts: { gwg: string; pool: string },
): AssetDraft[] {
  const out: AssetDraft[] = [];
  for (const l of lines) {
    if (l.assetDecision !== "gwg" && l.assetDecision !== "pool" && l.assetDecision !== "asset") continue;
    if (l.baseCents <= 0) continue;
    const n = itemCount(l.quantityMilli);
    const per = Math.floor(l.baseCents / n);
    const rest = l.baseCents - per * n;
    const name = l.description?.trim() || fallbackName;
    const account = l.assetDecision === "gwg" ? accounts.gwg : l.assetDecision === "pool" ? accounts.pool : l.account;
    for (let i = 0; i < n; i++) {
      out.push({
        index: l.index,
        item: i + 1,
        name: n > 1 ? `${name} (${i + 1}/${n})` : name,
        account,
        costCents: per + (i < rest ? 1 : 0),
        method: l.assetDecision === "gwg" ? "gwg" : l.assetDecision === "pool" ? "pool" : "linear",
        setupRequired: l.assetDecision === "asset",
      });
    }
  }
  return out;
}
