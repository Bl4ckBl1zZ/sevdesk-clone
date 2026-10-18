import { query } from "./functions";
import { dashboardOverview } from "./model/dashboard";

/**
 * Übersicht (04 §4.7, DASH-011): one read for the start page. Every member role may read it; widgets whose data
 * the role may not read come back as `null` (model/dashboard.ts).
 */
export const overview = query({
  permission: "dashboard.read",
  args: {},
  handler: async (ctx) => dashboardOverview(ctx, { now: ctx.now(), actor: ctx.actor, role: ctx.role }),
});
