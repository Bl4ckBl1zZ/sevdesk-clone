import { v } from "convex/values";
import { systemMutation } from "./functions";
import { findMigration, runMigration } from "./model/migrations";

/**
 * Entry point for data migrations (F12 AUD-028): `npx convex run migrations:run '{"name":"…"}'` after
 * `convex deploy` (08 §6). Internal only; the runner checks RI-01/04/14 and protected content before and after.
 */
export const run = systemMutation({
  job: "migration",
  args: { name: v.string() },
  handler: async (ctx, { name }) => runMigration(ctx, findMigration(name)),
});
