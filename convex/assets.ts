import { v } from "convex/values";
import { USEFUL_LIFE_TABLE } from "../src/domain/rules/afa";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { appError } from "./lib/errors";
import {
  anlagenspiegelOf,
  assetDetail,
  assetList,
  createAsset,
  depreciateThrough,
  disposeAsset,
  gwgListOf,
  methodOptionsFor,
  poolsOf,
  setAssetNotes,
  updateAsset,
} from "./model/assets";

/**
 * Anlagen (F08 §6 /buchhaltung/anlagen; AST-001…AST-012): register, depreciation plan, „AfA jetzt buchen“,
 * disposal, Anlagenspiegel, GWG-Verzeichnis and Sammelposten. Reads `accounting:read`; writes owner/bookkeeper.
 */

const vMethod = v.union(
  v.literal("linear"),
  v.literal("degressive"),
  v.literal("gwg"),
  v.literal("pool"),
  v.literal("ev_special"),
);

const vSetup = {
  name: v.string(),
  account: v.string(),
  acquisitionDate: v.string(),
  costCents: v.number(),
  method: vMethod,
  usefulLifeMonths: v.optional(v.number()),
  usefulLifeKey: v.optional(v.string()),
  evQualified: v.optional(v.boolean()),
  erinnerungswert: v.optional(v.boolean()),
  inputVatDeducted: v.boolean(),
  costCenterId: v.optional(v.id("costCenters")),
  notes: v.optional(v.string()),
};

export const list = query({
  permission: "accounting.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => assetList(ctx, year),
});

export const detail = query({
  permission: "accounting.read",
  args: { id: v.id("assets") },
  handler: async (ctx, { id }) => assetDetail(ctx, id),
});

/** AST-012 Anlagenspiegel of a fiscal year. */
export const anlagenspiegel = query({
  permission: "accounting.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => anlagenspiegelOf(ctx, year),
});

/** AST-007 GWG-Verzeichnis. */
export const gwgList = query({
  permission: "accounting.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => gwgListOf(ctx, year),
});

/** AST-008 Sammelposten. */
export const pools = query({
  permission: "accounting.read",
  args: { year: v.number() },
  handler: async (ctx, { year }) => poolsOf(ctx, year),
});

/** AST-003 methods offered for an account, acquisition date and cost (form helper) and the AfA-Tabelle excerpt. */
export const methodOptions = query({
  permission: "accounting.read",
  args: { account: v.string(), acquisitionDate: v.string(), costCents: v.number() },
  handler: async (ctx, args) => ({ ...(await methodOptionsFor(ctx, args)), usefulLives: USEFUL_LIFE_TABLE }),
});

export const create = mutation({
  permission: "assets.write",
  args: vSetup,
  handler: async (ctx, args) => createAsset(ctx, args),
});

export const update = mutation({
  permission: "assets.write",
  args: { id: v.id("assets"), ...vSetup },
  handler: async (ctx, { id, ...input }) => updateAsset(ctx, id, input),
});

export const setNotes = mutation({
  permission: "assets.write",
  args: { id: v.id("assets"), notes: v.string() },
  handler: async (ctx, { id, notes }) => setAssetNotes(ctx, id, notes),
});

/** AST-010 „Abgang erfassen“. */
export const dispose = mutation({
  permission: "assets.write",
  args: {
    id: v.id("assets"),
    date: v.string(),
    kind: v.union(v.literal("sale"), v.literal("scrap"), v.literal("withdrawal")),
    documentId: v.optional(v.id("salesDocuments")),
    documentNumber: v.optional(v.string()),
    proceedsCents: v.optional(v.number()),
    teilwertCents: v.optional(v.number()),
  },
  handler: async (ctx, { id, ...args }) => disposeAsset(ctx, id, args),
});

/** AST-009 „AfA jetzt buchen“ through a month (default: the current month). */
export const depreciateNow = mutation({
  permission: "assets.write",
  args: { through: v.optional(v.string()) },
  handler: async (ctx, { through }) => {
    const today = berlinCalendarDate(ctx.now()).slice(0, 7);
    const target = through ?? today;
    if (target > today) {
      throw appError("invalid_input", "AfA kann nicht für künftige Monate gebucht werden.");
    }
    return depreciateThrough(ctx, target, "manual");
  },
});

const previousMonth = (month: string) => {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};

/** AST-009 cron: 1st of the month 05:00 Europe/Berlin for the previous month (idempotent per asset and month). */
export const depreciateCron = systemMutation({
  job: "cron.assets.depreciate",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return { posted: 0, findings: [] };
    return depreciateThrough(ctx, previousMonth(berlinCalendarDate(ctx.now()).slice(0, 7)), "cron");
  },
});
