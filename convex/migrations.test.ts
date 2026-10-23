import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { MIGRATIONS, type Migration, runMigration } from "./model/migrations";
import { makeT, type TestT } from "./test.setup";

const addUnit: Migration = {
  name: "2026-11-add-unit",
  description: "Einheit „Palette“ ergänzen",
  run: async (ctx) => {
    await auditedInsert(
      ctx,
      "units",
      { code: "PF", label: { de: "Palette", en: "Pallet" }, isSystem: false },
      { action: "settings.unit.create", label: "PF" },
    );
    return { scanned: 0, changed: 1 };
  },
};

async function seeded() {
  const t = makeT();
  const owner = await t.asUser("owner");
  await owner.mutation(api.invites.create, { email: "a@example.test", role: "viewer" });
  return t;
}

const migrate = (t: TestT, m: Migration) => t.asSystem("migration").model((ctx) => runMigration(ctx, m));

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), data: e instanceof ConvexError ? (e.data as Record<string, unknown>) : {} };
  }
  throw new Error("expected the migration to fail");
}

describe("migration runner (F12 AUD-028, GOBD-23, EC-184)", () => {
  test("AUD-028 GOBD-23 an additive migration runs as system:migration.<name> and is audited with its counts", async () => {
    const t = await seeded();
    expect(await migrate(t, addUnit)).toEqual({ scanned: 0, changed: 1 });
    const log = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").collect());
    const last = log.at(-1);
    expect(last).toMatchObject({
      action: "system.migration",
      actor: "system:migration.2026-11-add-unit",
      entity: { table: "migrations", id: "2026-11-add-unit" },
      diff: { after: { name: "2026-11-add-unit", scanned: 0, changed: 1 } },
    });
    expect(log.at(-2)).toMatchObject({ action: "settings.unit.create", actor: "system:migration.2026-11-add-unit" });
  });

  test("AUD-028 TST-AUD-27 EC-184 a migration that rewrites audit content is aborted (E-AUD-17) and rolled back", async () => {
    const t = await seeded();
    const before = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const rewrite: Migration = {
      name: "rewrite-audit",
      description: "verboten",
      run: async (ctx) => {
        await auditedInsert(
          ctx,
          "units",
          { code: "PF", label: { de: "Palette", en: "Pallet" }, isSystem: false },
          { action: "settings.unit.create" },
        );
        const first = await ctx.db.query("auditLog").first();
        if (first) await ctx.db.patch(first._id, { actorLabel: "umgeschrieben" });
        return { scanned: 1, changed: 1 };
      },
    };
    const f = await failure(migrate(t, rewrite));
    expect(f.code).toBe("immutable_record");
    expect(f.data).toMatchObject({
      reason: "MIGRATION_PROTECTED_CONTENT",
      message: "Migration rewrite-audit abgebrochen: geschützte Inhalte würden verändert.",
    });
    const after = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(after).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query("units").collect())).toEqual([]);
  });

  test("AUD-028 GOBD-23 changes the write guard would allow (set-once fields) are caught by the before/after comparison", async () => {
    const t = await seeded();
    await t.action(internal.integrity.verify, {});
    const ack: Migration = {
      name: "ack-runs",
      description: "Prüfläufe quittieren",
      run: async (ctx) => {
        const runs = await ctx.db.query("integrityRuns").collect();
        for (const r of runs) {
          await auditedPatch(
            ctx,
            "integrityRuns",
            r._id,
            { acknowledgedAt: ctx.now(), acknowledgedNote: "Migration", acknowledgedBy: ctx.actor },
            { action: "integrity.acknowledge", reason: "Migration" },
          );
        }
        return { scanned: runs.length, changed: runs.length };
      },
    };
    const f = await failure(migrate(t, ack));
    expect(f.code).toBe("immutable_record");
    expect(f.data.reason).toBe("MIGRATION_PROTECTED_CONTENT");
    expect(String((f.data.changes as string[])[0])).toMatch(/^integrityRuns:.+ changed$/);
    const run = await t.run((ctx) => ctx.db.query("integrityRuns").first());
    expect(run?.acknowledgedAt).toBeUndefined();
  });

  test("AUD-028 RI-14 a broken audit chain stops the migration before it starts", async () => {
    const t = await seeded();
    await t.run(async (ctx) => {
      const e = await ctx.db.query("auditLog").first();
      if (e) await ctx.db.patch(e._id, { actorLabel: "manipuliert" }); // out-of-band
    });
    clearInvariantTarget(); // tampered on purpose
    const f = await failure(migrate(t, addUnit));
    expect(f.code).toBe("conflict");
    expect(f.data.reason).toBe("MIGRATION_PRECONDITION");
    expect(String((f.data.violations as string[])[0])).toMatch(/^RI-14/);
  });

  test("AUD-028 migrations run only through the registered entry point; unknown names are rejected", async () => {
    const t = await seeded();
    expect(MIGRATIONS.every((m) => /^[a-z0-9][a-z0-9-]{2,63}$/.test(m.name))).toBe(true);
    const f = await failure(t.action(internal.migrations.run, { name: "does-not-exist" }));
    expect(f.code).toBe("not_found");
    const bad = await failure(migrate(t, { ...addUnit, name: "Drop Table" }));
    expect(bad.data.reason).toBe("MIGRATION_NAME");
  });
});
