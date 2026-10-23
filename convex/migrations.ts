import { v } from "convex/values";
import { internal } from "./_generated/api";
import { systemAction, systemMutation, systemQuery } from "./functions";
import { runInvariants } from "./invariants";
import {
  assertMigrationPrecondition,
  findMigration,
  type MigrationCounts,
  type MigrationStart,
  migrationStart,
  runMigration,
} from "./model/migrations";

/**
 * Entry point for data migrations (F12 AUD-028): `npx convex run migrations:run '{"name":"…"}'` after
 * `convex deploy` (08 §6). Internal only. The action notes the audit-chain head (`start`), checks RI-01/04/14 with the
 * paged `invariants.run` (a mutation could not read a production-sized database in one transaction), then `apply`
 * runs the migration in one transaction with the protected-content and after-checks from that start (E-AUD-17 rolls
 * it back). Neither check reads the whole database in one transaction (model/migrations.ts).
 */
export const run = systemAction({
  job: "migration",
  args: { name: v.string() },
  handler: async (ctx, { name }): Promise<MigrationCounts> => {
    findMigration(name); // unknown names fail before the (long) pre-check
    // the head before the pre-check: everything up to it is verified by the pre-check, the rest by `apply`
    const start: MigrationStart = await ctx.runQuery(internal.migrations.start, { since: Date.now() });
    assertMigrationPrecondition(name, await runInvariants(ctx));
    return ctx.runMutation(internal.migrations.apply, { name, start });
  },
});

const vStart = v.object({
  since: v.number(),
  head: v.union(v.null(), v.object({ seq: v.number(), hash: v.string() })),
});

/** The audit-chain head before the pre-check of `run`. */
export const start = systemQuery({
  job: "migration",
  args: { since: v.number() },
  handler: async (ctx, { since }): Promise<MigrationStart> => migrationStart(ctx, since),
});

/** Steps 2–4 of the runner after the paged pre-check of `run` from `start`; call `run`, not this. */
export const apply = systemMutation({
  job: "migration",
  args: { name: v.string(), start: vStart },
  handler: async (ctx, { name, start }) => runMigration(ctx, findMigration(name), { start }),
});
