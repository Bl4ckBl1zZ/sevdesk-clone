import { DOC_TYPE_LABEL_DE, documentPath } from "../../src/domain/documents/doc-types";
import { formatMilli } from "../../src/domain/money/format";
import {
  checkStockAllowed,
  deliveryNoteMovements,
  type ManualMovementInput,
  manualMovement,
  negativeStockCheck,
  reorderTransition,
  reversingMovements,
  STOCK_MESSAGES,
  type StockMovementDraft,
  type StockProduct,
  stockSum,
  withRunningBalance,
} from "../../src/domain/products/stock";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import { notify } from "./notifications";
import type { ModelCtx, ReadCtx } from "./types";
import { emitProductEvent } from "./webhooks";

/**
 * Stock (F03 §3.10 PRD-090…097, §4.4). The only writer of `stockMovements` (append-only, GOBD-06) and of
 * `products.stock`. The cached `stock.quantityMilli` is recomputed as Σ movements in the same transaction as every
 * movement (PRD-090; RI-30 checks it). Delivery notes move stock at finalisation and reverse it when withdrawn;
 * invoices and their Stornos never move stock (PRD-093, sevdesk parity — the company option is not offered).
 */

type ProductDoc = Doc<"products">;

const STOCK_LOW_KIND = "stock.low";

async function product(ctx: ReadCtx, id: Id<"products">): Promise<ProductDoc> {
  const p = await ctx.db.get(id);
  if (!p) throw appError("not_found", "Produkt nicht gefunden.");
  return p;
}

export async function movementsOf(ctx: ReadCtx, productId: Id<"products">): Promise<Doc<"stockMovements">[]> {
  return ctx.db
    .query("stockMovements")
    .withIndex("by_product", (q) => q.eq("productId", productId))
    .collect();
}

/** PRD-090: enable/disable stock keeping (goods only) and set the reorder level (PRD-096). */
export async function configureStock(
  ctx: ModelCtx,
  id: Id<"products">,
  input: { enabled: boolean; reorderLevelMilli?: number },
): Promise<void> {
  const p = await product(ctx, id);
  const blocked = checkStockAllowed(p.type, input.enabled);
  if (blocked) throw appError("invalid_input", blocked.message, { reason: blocked.code, field: "enabled" });
  const quantityMilli = stockSum(await movementsOf(ctx, id));
  const stock: NonNullable<ProductDoc["stock"]> = {
    enabled: input.enabled,
    quantityMilli,
    ...(input.reorderLevelMilli !== undefined ? { reorderLevelMilli: input.reorderLevelMilli } : {}),
    ...(p.stock?.belowReorderSince !== undefined && input.reorderLevelMilli !== undefined
      ? { belowReorderSince: p.stock.belowReorderSince }
      : {}),
  };
  await auditedPatch(ctx, "products", id, { stock }, { action: "product.stock.configure", label: p.number });
  await syncReorderState(ctx, id, { notify: false }); // a level set below the current stock is no crossing
}

/** Inserts one movement and recomputes the cache (PRD-090) and the reorder state (PRD-096). */
async function book(
  ctx: ModelCtx,
  m: StockMovementDraft & { text?: string; documentId?: Id<"salesDocuments">; reversesId?: Id<"stockMovements"> },
  action: string,
): Promise<Id<"stockMovements">> {
  const productId = m.productId as Id<"products">;
  const p = await product(ctx, productId);
  const before = stockSum(await movementsOf(ctx, productId));
  const id = await auditedInsert(
    ctx,
    "stockMovements",
    {
      productId,
      quantityMilli: m.quantityMilli,
      reason: m.reason,
      ...(m.text ? { text: m.text } : {}),
      ...(m.documentId ? { documentId: m.documentId } : {}),
      ...(m.reversesId ? { reversesId: m.reversesId } : {}),
      at: ctx.now(),
      actor: ctx.actor,
    },
    { action, label: p.number, ...(m.text ? { reason: m.text } : {}) },
  );
  const after = before + m.quantityMilli;
  const stock = p.stock ?? { enabled: false, quantityMilli: 0 };
  await auditedPatch(
    ctx,
    "products",
    productId,
    { stock: { ...stock, quantityMilli: after } },
    { action, label: p.number },
  );
  await syncReorderState(ctx, productId);
  return id;
}

/**
 * PRD-096: a movement crossing below the reorder level opens one notification
 * (`stock.low`, e-mail per the owner's channel matrix); it stays the only one until the stock is back at or above the
 * level, which resolves it. `belowReorderSince` remembers the state (set silently when a level is configured above
 * the current stock — that is no crossing).
 */
async function syncReorderState(
  ctx: ModelCtx,
  productId: Id<"products">,
  opts: { notify?: boolean } = {},
): Promise<void> {
  const p = await product(ctx, productId);
  const s = p.stock;
  if (!s) return;
  const level = s.enabled ? s.reorderLevelMilli : undefined;
  const below = reorderTransition(level ?? 0, s.quantityMilli, level) === "crossed_below";
  const dedupeKey = `${STOCK_LOW_KIND}:${productId}`;
  const audit = { action: "product.stock.reorder_level", label: p.number };
  if (below && s.belowReorderSince === undefined) {
    await auditedPatch(ctx, "products", productId, { stock: { ...s, belowReorderSince: ctx.now() } }, audit);
    if (opts.notify === false) return;
    await emitProductEvent(ctx, "product.stock_low", productId, {
      number: p.number,
      stock_quantity_milli: s.quantityMilli,
      reorder_level_milli: level ?? 0,
    });
    await notify(ctx, {
      kind: STOCK_LOW_KIND,
      severity: "warning",
      title: `Mindestbestand unterschritten: ${p.name} (${formatMilli(s.quantityMilli)} ${p.unitCode}, Mindestbestand ${formatMilli(level ?? 0)})`,
      link: `/produkte/${productId}`,
      entity: { table: "products", id: productId },
      dedupeKey,
    });
    return;
  }
  if (below) return;
  if (s.belowReorderSince !== undefined) {
    const { belowReorderSince: _b, ...rest } = s;
    await auditedPatch(ctx, "products", productId, { stock: rest }, audit);
  }
  const open = await ctx.db
    .query("notifications")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
    .first();
  if (open && open.resolvedAt === undefined) {
    await auditedPatch(ctx, "notifications", open._id, { resolvedAt: ctx.now() }, { action: "notification.resolve" });
  }
}

/** PRD-094: manual Zugang / Abgang / Korrektur with a mandatory text. */
export async function adjustStock(
  ctx: ModelCtx,
  productId: Id<"products">,
  input: ManualMovementInput,
): Promise<{ id: Id<"stockMovements">; quantityMilli: number; warning?: string }> {
  const p = await product(ctx, productId);
  if (!p.stock?.enabled) throw appError("invalid_input", STOCK_MESSAGES.disabled, { reason: "STOCK_DISABLED" });
  const m = manualMovement(input);
  if (!m.ok) throw appError("invalid_input", m.issue.message, { reason: m.issue.code, field: m.field });
  const id = await book(
    ctx,
    { productId, quantityMilli: m.quantityMilli, reason: input.kind, text: m.text },
    "product.stock.adjust",
  );
  const after = (await product(ctx, productId)).stock?.quantityMilli ?? 0;
  return { id, quantityMilli: after, ...(after < 0 ? { warning: STOCK_MESSAGES.negative } : {}) };
}

/** PRD-091: a finalised delivery note books one negative movement per stock-enabled line (base units). */
export async function applyDeliveryNote(ctx: ModelCtx, doc: Doc<"salesDocuments">): Promise<number> {
  if (doc.type !== "delivery_note") return 0;
  const existing = await ctx.db
    .query("stockMovements")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id))
    .first();
  if (existing) return 0; // idempotent (finalisation replay)
  const lines = await ctx.db
    .query("documentLines")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id))
    .collect();
  const products = new Map<string, StockProduct & { stockEnabled: boolean }>();
  for (const l of lines) {
    if (!l.productId || products.has(l.productId)) continue;
    const p = await ctx.db.get(l.productId);
    if (p)
      products.set(l.productId, {
        unitCode: p.unitCode,
        extraUnits: p.extraUnits,
        stockEnabled: p.stock?.enabled === true,
      });
  }
  const moves = deliveryNoteMovements(
    lines.map((l) => ({
      id: l._id,
      kind: l.kind,
      ...(l.productId ? { productId: l.productId } : {}),
      ...(l.quantityMilli !== undefined ? { quantityMilli: l.quantityMilli } : {}),
      ...(l.unitCode ? { unitCode: l.unitCode } : {}),
    })),
    products,
  );
  // PRD-095: below zero is allowed (warning) unless „Negativen Bestand verhindern“ is set — then the finalisation
  // transaction is rolled back (no number is consumed).
  const current = new Map<string, { name: string; quantityMilli: number; unitCode: string }>();
  for (const m of moves) {
    const p = await ctx.db.get(m.productId as Id<"products">);
    if (p) current.set(m.productId, { name: p.name, quantityMilli: p.stock?.quantityMilli ?? 0, unitCode: p.unitCode });
  }
  const prevent = (await getCompanyProfile(ctx))?.defaults.preventNegativeStock === true;
  const check = negativeStockCheck(moves, current, prevent);
  if (check.block) throw appError("conflict", check.block.message, { reason: check.block.code });
  const text = `${DOC_TYPE_LABEL_DE.delivery_note} ${doc.number ?? ""}`.trim();
  for (const m of moves) await book(ctx, { ...m, documentId: doc._id, text }, "product.stock.delivery_note");
  return moves.length;
}

/** PRD-095: company option „Negativen Bestand verhindern“ (`defaults.preventNegativeStock`). */
export async function setPreventNegativeStock(ctx: ModelCtx, enabled: boolean): Promise<void> {
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  await patchCompanyProfile(
    ctx,
    { defaults: { ...profile.defaults, preventNegativeStock: enabled } },
    { action: "settings.company.update" },
  );
}

/** PRD-092: withdrawing a finalised delivery note books the reversing `correction` movements. */
export async function reverseDeliveryNote(ctx: ModelCtx, doc: Doc<"salesDocuments">): Promise<number> {
  if (doc.type !== "delivery_note") return 0;
  const all = await ctx.db
    .query("stockMovements")
    .withIndex("by_document", (q) => q.eq("documentId", doc._id))
    .collect();
  const reversed = new Set(all.map((m) => m.reversesId).filter(Boolean));
  const open = all.filter((m) => m.reason === "delivery_note" && !reversed.has(m._id));
  const text = `Storno ${DOC_TYPE_LABEL_DE.delivery_note} ${doc.number ?? ""}`.trim();
  for (const [i, m] of reversingMovements(open).entries()) {
    const original = open[i] as Doc<"stockMovements">;
    await book(ctx, { ...m, documentId: doc._id, reversesId: original._id, text }, "product.stock.correction");
  }
  return open.length;
}

/** PRD-097: „Buchungsverlauf“ with running balance and document links (newest first for the UI). */
export async function stockHistory(ctx: ReadCtx, productId: Id<"products">) {
  const rows = withRunningBalance((await movementsOf(ctx, productId)).map((m) => ({ ...m, id: m._id, at: m.at })));
  const out = [];
  for (const r of rows) {
    const d = r.documentId ? await ctx.db.get(r.documentId) : null;
    out.push({
      id: r._id,
      at: r.at,
      quantityMilli: r.quantityMilli,
      balanceMilli: r.balanceMilli,
      reason: r.reason,
      ...(r.text ? { text: r.text } : {}),
      actor: r.actor,
      ...(d
        ? { document: { id: d._id, label: d.number ?? DOC_TYPE_LABEL_DE[d.type], href: documentPath(d.type, d._id) } }
        : {}),
    });
  }
  return out.reverse();
}

/** PRD-073: stock movements block deleting a product. */
export async function stockMovementCount(ctx: ReadCtx, productId: Id<"products">): Promise<number> {
  return (await movementsOf(ctx, productId)).length;
}
