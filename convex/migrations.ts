import { v } from "convex/values";
import { internal } from "./_generated/api";
import { systemAction, systemMutation } from "./functions";
import { runInvariants } from "./invariants";
import { assertMigrationPrecondition, findMigration, type MigrationCounts, runMigration } from "./model/migrations";

/**
 * Entry point for data migrations (F12 AUD-028): `npx convex run migrations:run '{"name":"…"}'` after
 * `convex deploy` (08 §6). Internal only. The action first checks RI-01/04/14 with the paged `invariants.run` (a
 * mutation could not read a production-sized database in one transaction), then `apply` runs the migration in one
 * transaction with the protected-content and after-checks (E-AUD-17 rolls it back).
 */
export const run = systemAction({
  job: "migration",
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<MigrationCounts> => {
    findMigration(name); // unknown names fail before the (long) pre-check
    assertMigrationPrecondition(name, await runInvariants(ctx));
    return ctx.runMutation(internal.migrations.apply, { name });
  },
});

/** Step 2–5 of the runner after the paged pre-check of `run`; call `run`, not this. */
export const apply = systemMutation({
  job: "migration",
  args: { name: v.string() },
  handler: async (ctx, { name }) => runMigration(ctx, findMigration(name), { prechecked: true }),
});
