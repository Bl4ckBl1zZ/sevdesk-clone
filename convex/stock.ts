import { v } from "convex/values";
import { stockAdjustmentSchema, stockSettingsSchema } from "../src/domain/schemas/projects";
import { mutation, query } from "./functions";
import { parse } from "./lib/parse";
import { adjustStock, configureStock, stockHistory } from "./model/stock";

/** Bestand (F03 §3.10 PRD-090…097): stock settings, manual movements and the „Buchungsverlauf“ of a product. */

export const history = query({
  permission: "products.read",
  args: { productId: v.id("products") },
  handler: async (ctx, { productId }) => {
    const p = await ctx.db.get(productId);
    if (!p) return null;
    return {
      type: p.type,
      unitCode: p.unitCode,
      stock: p.stock ?? null,
      movements: await stockHistory(ctx, productId),
    };
  },
});

export const configure = mutation({
  permission: "products.write",
  args: { productId: v.id("products"), values: v.any() },
  handler: async (ctx, { productId, values }) => {
    await configureStock(ctx, productId, parse(stockSettingsSchema, values));
    return null;
  },
});

export const adjust = mutation({
  permission: "products.write",
  args: { productId: v.id("products"), values: v.any() },
  handler: async (ctx, { productId, values }) => adjustStock(ctx, productId, parse(stockAdjustmentSchema, values)),
});
