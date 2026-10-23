/**
 * Stock (F03 §3.10 PRD-090…097, §4.4; PRD-E29/E30). Pure.
 *
 * - Only goods carry stock (`STOCK_SERVICE`).
 * - `stock.quantityMilli` is a cache of Σ `stockMovements` (append-only; corrections are new movements, GOBD-06).
 * - A finalised delivery note moves stock out per stock-enabled line, converted from extra units to base units;
 *   cancelling it books the reversing `correction` movements.
 * - Crossing below the reorder level opens one notification until the stock is back at or above the level.
 */
import { roundHalfAway } from "../money";
import { formatMilli } from "../money/format";
import { type Issue, issue } from "../result";

export const STOCK_REASONS = ["delivery_note", "manual_in", "manual_out", "correction"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const STOCK_REASON_LABELS: Readonly<Record<StockReason, string>> = {
  delivery_note: "Lieferschein",
  manual_in: "Zugang",
  manual_out: "Abgang",
  correction: "Korrektur",
};

export const MANUAL_STOCK_KINDS = ["manual_in", "manual_out", "correction"] as const;
export type ManualStockKind = (typeof MANUAL_STOCK_KINDS)[number];

export const STOCK_MESSAGES = {
  service: "Bestandsführung ist nur für Waren möglich.",
  text: "Bitte einen Text zur Bestandsbuchung angeben.",
  quantity: "Bitte eine Menge größer als 0 angeben.",
  correction: "Eine Korrektur braucht eine Menge ungleich 0 (positiv = Zugang, negativ = Abgang).",
  disabled: "Für dieses Produkt ist keine Bestandsführung aktiviert.",
  negative: "Der Bestand wird negativ.",
} as const;

/** PRD-090: stock only for goods. */
export function checkStockAllowed(type: "good" | "service", enabled: boolean): Issue<"STOCK_SERVICE"> | null {
  return enabled && type !== "good" ? issue("STOCK_SERVICE", STOCK_MESSAGES.service) : null;
}

export interface StockProduct {
  readonly unitCode: string;
  readonly extraUnits: readonly { readonly unitCode: string; readonly factorMilli: number }[];
}

/**
 * Base-unit quantity of a document line (§4.4): `quantityMilli × factor / 1000` for an extra unit (half away from
 * zero), the quantity itself for the base unit or an unknown unit.
 */
export function baseQuantityMilli(quantityMilli: number, unitCode: string | undefined, p: StockProduct): number {
  if (!unitCode || unitCode === p.unitCode) return quantityMilli;
  const extra = p.extraUnits.find((u) => u.unitCode === unitCode);
  if (!extra) return quantityMilli;
  return Number(roundHalfAway(BigInt(quantityMilli) * BigInt(extra.factorMilli), 1000n));
}

export interface DeliveryLine {
  readonly id: string;
  readonly kind: string;
  readonly productId?: string | undefined;
  readonly quantityMilli?: number | undefined;
  readonly unitCode?: string | undefined;
}

export interface StockMovementDraft {
  readonly productId: string;
  readonly quantityMilli: number;
  readonly reason: StockReason;
}

/** PRD-091: one negative movement per stock-enabled item line of a finalised delivery note. */
export function deliveryNoteMovements(
  lines: readonly DeliveryLine[],
  products: ReadonlyMap<string, StockProduct & { readonly stockEnabled: boolean }>,
): StockMovementDraft[] {
  const out: StockMovementDraft[] = [];
  for (const l of lines) {
    if (l.kind !== "item" || !l.productId || !l.quantityMilli) continue;
    const p = products.get(l.productId);
    if (!p?.stockEnabled) continue;
    const q = baseQuantityMilli(l.quantityMilli, l.unitCode, p);
    if (q !== 0) out.push({ productId: l.productId, quantityMilli: -q, reason: "delivery_note" });
  }
  return out;
}

/** PRD-092: the reversing movements of a cancelled delivery note (`correction`, opposite sign). */
export function reversingMovements(
  original: readonly { readonly productId: string; readonly quantityMilli: number }[],
): StockMovementDraft[] {
  return original.map((m) => ({ productId: m.productId, quantityMilli: -m.quantityMilli, reason: "correction" }));
}

export interface ManualMovementInput {
  readonly kind: ManualStockKind;
  /** Zugang/Abgang: positive amount; Korrektur: signed (+ adds, − removes). */
  readonly quantityMilli: number;
  readonly text: string;
}

/** PRD-094: manual Zugang/Abgang/Korrektur with a mandatory text; returns the signed movement quantity. */
export function manualMovement(
  input: ManualMovementInput,
):
  | { ok: true; quantityMilli: number; text: string }
  | { ok: false; issue: Issue<"STOCK_TEXT" | "STOCK_QUANTITY">; field: "text" | "quantity" } {
  const text = input.text.trim();
  if (!Number.isSafeInteger(input.quantityMilli)) {
    return { ok: false, issue: issue("STOCK_QUANTITY", STOCK_MESSAGES.quantity), field: "quantity" };
  }
  if (input.kind === "correction") {
    if (input.quantityMilli === 0) {
      return { ok: false, issue: issue("STOCK_QUANTITY", STOCK_MESSAGES.correction), field: "quantity" };
    }
  } else if (input.quantityMilli <= 0) {
    return { ok: false, issue: issue("STOCK_QUANTITY", STOCK_MESSAGES.quantity), field: "quantity" };
  }
  if (!text) return { ok: false, issue: issue("STOCK_TEXT", STOCK_MESSAGES.text), field: "text" };
  const q = input.kind === "manual_out" ? -input.quantityMilli : input.quantityMilli;
  return { ok: true, quantityMilli: q, text };
}

/** PRD-096: below = strictly less than the reorder level. */
export function reorderTransition(
  beforeMilli: number,
  afterMilli: number,
  reorderLevelMilli: number | undefined,
): "crossed_below" | "recovered" | null {
  if (reorderLevelMilli === undefined) return null;
  const wasBelow = beforeMilli < reorderLevelMilli;
  const isBelow = afterMilli < reorderLevelMilli;
  if (!wasBelow && isBelow) return "crossed_below";
  if (wasBelow && !isBelow) return "recovered";
  return null;
}

export interface MovementRow {
  readonly id: string;
  readonly at: number;
  readonly quantityMilli: number;
}

/** PRD-097: running balance in booking order (oldest first). */
export function withRunningBalance<M extends MovementRow>(movements: readonly M[]): (M & { balanceMilli: number })[] {
  let balance = 0;
  return [...movements]
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
    .map((m) => {
      balance += m.quantityMilli;
      return { ...m, balanceMilli: balance };
    });
}

/** PRD-090 cache: Σ of all movements. */
export const stockSum = (movements: readonly { readonly quantityMilli: number }[]): number =>
  movements.reduce((s, m) => s + m.quantityMilli, 0);

/**
 * PRD-095: negative stock is allowed with a warning by default; with the company option „Negativen Bestand
 * verhindern“ a delivery note that would take any product below zero is blocked (`STOCK_NEGATIVE`).
 */
export function negativeStockCheck(
  moves: readonly { readonly productId: string; readonly quantityMilli: number }[],
  current: ReadonlyMap<string, { readonly name: string; readonly quantityMilli: number; readonly unitCode: string }>,
  prevent: boolean,
): { readonly block: Issue<"STOCK_NEGATIVE"> | null; readonly warning: string | null } {
  const after = new Map<string, number>();
  for (const m of moves)
    after.set(m.productId, (after.get(m.productId) ?? current.get(m.productId)?.quantityMilli ?? 0) + m.quantityMilli);
  const below = [...after].filter(([, q]) => q < 0);
  if (below.length === 0) return { block: null, warning: null };
  const list = below
    .map(([id, q]) => {
      const c = current.get(id);
      return `${c?.name ?? id} (${formatMilli(q)} ${c?.unitCode ?? ""})`.replace(" )", ")");
    })
    .join(", ");
  return prevent
    ? {
        block: issue(
          "STOCK_NEGATIVE",
          `Der Lieferschein würde den Bestand ins Minus bringen: ${list}. „Negativen Bestand verhindern“ ist aktiviert.`,
        ),
        warning: null,
      }
    : { block: null, warning: `${STOCK_MESSAGES.negative} ${list}` };
}
