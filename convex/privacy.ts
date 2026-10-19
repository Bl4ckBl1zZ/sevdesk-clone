import { v } from "convex/values";
import { art30Markdown } from "../src/domain/privacy/art30";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { mutation, query } from "./functions";
import {
  art30 as art30Model,
  externalServices as externalServicesModel,
  retentionOverview,
  setAvvConfirmation,
} from "./model/privacy";

/** `/einstellungen/datenschutz` (F12 §6): Externe Dienste (AVV), Aufbewahrung, Verzeichnis (Art. 30). */

export const externalServices = query({
  permission: "settings.read",
  args: { publicEdge: v.optional(v.boolean()) },
  handler: async (ctx, args) => externalServicesModel(ctx, args),
});

export const confirmAvv = mutation({
  permission: "settings.ownerOnly",
  args: { serviceId: v.string(), confirmed: v.boolean(), note: v.optional(v.string()) },
  handler: async (ctx, { serviceId, confirmed, note }) => setAvvConfirmation(ctx, serviceId, confirmed, note),
});

export const art30 = query({
  permission: "settings.read",
  args: { publicEdge: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const record = await art30Model(ctx, args);
    return { record, markdown: art30Markdown(record) };
  },
});

export const retention = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => retentionOverview(berlinCalendarDate(ctx.now())),
});
