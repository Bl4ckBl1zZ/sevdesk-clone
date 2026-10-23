import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { MIGRATIONS, type Migration } from "./model/migrations";
import { makeT, type TestT } from "./test.setup";

/**
 * Migration runner at production volume (F12 AUD-028, EC-184, GOBD-23): `migrations:run` pre-checks RI-01/04/14 in
 * pages and `migrations:apply` must stay inside the Convex per-execution limits — its after-check verifies the audit
 * chain from the head the pre-check saw, compares only the protected rows the migration touched and re-checks RI-01
 * only for documents created or changed since the pre-check started.
 */

const addUnit: Migration = {
  name: "2026-11-scale-add-unit",
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

const registered = MIGRATIONS as Migration[];
const extra: Migration[] = [];
function register(m: Migration) {
  registered.push(m);
  extra.push(m);
}
beforeEach(() => register(addUnit));
afterEach(() => {
  for (const m of extra.splice(0)) registered.splice(registered.indexOf(m), 1);
});

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), data: e instanceof ConvexError ? (e.data as Record<string, unknown>) : {} };
  }
  throw new Error("expected the migration to fail");
}

/** `count` finalised documents with snapshot and artifacts — clones of a real one, written past the model layer. */
async function largeDataset(t: TestT, count: number) {
  const { id } = await finalizedInvoice(t);
  const perChunk = 300;
  for (let chunk = 0; chunk * perChunk < count; chunk++) {
    await t.run(async (ctx) => {
      const doc = await ctx.db.get(id);
      if (!doc?.snapshotId) throw new Error("no snapshot");
      const snap = await ctx.db.get(doc.snapshotId);
      if (!snap) throw new Error("no snapshot");
      const artifacts = await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect();
      const { _id, _creationTime, ...docFields } = doc;
      const { _id: _s, _creationTime: _sc, ...snapFields } = snap;
      for (let i = chunk * perChunk; i < Math.min(count, (chunk + 1) * perChunk); i++) {
        // same number as the snapshot (RI-01 holds; the duplicate number is RI-02, which does not block migrations)
        const copy: Id<"salesDocuments"> = await ctx.db.insert("salesDocuments", docFields);
        const snapshotId = await ctx.db.insert("documentSnapshots", { ...snapFields, documentId: copy });
        await ctx.db.patch(copy, { snapshotId });
        for (const a of artifacts) {
          const { _id: _a, _creationTime: _ac, ...artifactFields } = a;
          await ctx.db.insert("documentArtifacts", { ...artifactFields, documentId: copy });
        }
      }
    });
  }
  clearInvariantTarget(); // the clones have no audit entries (RI-15) and duplicate numbers (RI-02) on purpose
  return { id };
}

describe("migrations:apply at production volume (F12 AUD-028, EC-184)", () => {
  test("AUD-028 EC-184 GOBD-23 a migration applies on a database whose full check exceeds the Convex read limits", async () => {
    const t = makeT({ transactionLimits: true });
    await largeDataset(t, 1500);
    // a full single-transaction check (the former after-check) cannot run on this data
    await expect(t.query(internal.invariants.check, {})).rejects.toThrow(/too many|too much/i);

    expect(await t.action(internal.migrations.run, { name: addUnit.name })).toEqual({ scanned: 0, changed: 1 });
    const last = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(last).toMatchObject({ action: "system.migration", actor: `system:migration.${addUnit.name}` });
    expect((await t.run((ctx) => ctx.db.query("units").collect())).map((u) => u.code)).toContain("PF");
  }, 600_000);
});

describe("migrations:apply after-check guarantees (F12 AUD-028, E-AUD-17, EC-184)", () => {
  test("AUD-028 EC-184 E-AUD-17 RI-01 at production volume a new artifact that breaks an old document's RI-01 aborts the migration", async () => {
    const t = makeT({ transactionLimits: true });
    const { id } = await largeDataset(t, 1500);
    const breakArtifact: Migration = {
      name: "2026-11-scale-bad-artifact",
      description: "Artefakt ergänzen",
      run: async (ctx) => {
        const old = await ctx.db
          .query("documentArtifacts")
          .withIndex("by_document", (q) => q.eq("documentId", id))
          .first();
        if (!old) throw new Error("no artifact");
        const { _id, _creationTime, ...fields } = old;
        await auditedInsert(
          ctx,
          "documentArtifacts",
          { ...fields, sha256: "0".repeat(64), variant: "copy" },
          { action: "document.artifact_archived" },
        );
        return { scanned: 1, changed: 1 };
      },
    };
    register(breakArtifact);
    const f = await failure(t.action(internal.migrations.run, { name: breakArtifact.name }));
    expect(f.code).toBe("immutable_record");
    expect(f.data).toMatchObject({
      reason: "MIGRATION_PROTECTED_CONTENT",
      message: `Migration ${breakArtifact.name} abgebrochen: geschützte Inhalte würden verändert.`,
    });
    expect((f.data.violations as string[]).length).toBeGreaterThan(0);
    expect((f.data.violations as string[]).every((v) => v.startsWith("RI-01"))).toBe(true);
    const artifacts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    expect(artifacts.some((a) => a.sha256 === "0".repeat(64))).toBe(false); // rolled back
  }, 600_000);

  test("AUD-028 GOBD-23 E-AUD-17 a migration may not delete the file behind an archived artifact", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const dropFile: Migration = {
      name: "2026-11-drop-file",
      description: "Datei löschen",
      run: async (ctx) => {
        const a = await ctx.db
          .query("documentArtifacts")
          .withIndex("by_document", (q) => q.eq("documentId", id))
          .first();
        if (a) await ctx.storage.delete(a.storageId);
        return { scanned: 1, changed: 1 };
      },
    };
    register(dropFile);
    const f = await failure(t.action(internal.migrations.run, { name: dropFile.name }));
    expect(f.code).toBe("immutable_record");
    expect(f.data.reason).toBe("MIGRATION_PROTECTED_CONTENT");
    const file = await t.run(async (ctx) => {
      const a = await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .first();
      return a ? await ctx.db.system.get(a.storageId) : null;
    });
    expect(file).not.toBeNull();
  });

  test("AUD-028 TST-AUD-27 a guard-allowed change of a protected row through the legacy patch(id, …) form is caught", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    await t.action(internal.integrity.verify, {});
    const ack: Migration = {
      name: "2026-11-ack-legacy",
      description: "Prüfläufe quittieren",
      run: async (ctx) => {
        const runs = await ctx.db.query("integrityRuns").collect();
        for (const r of runs) await ctx.db.patch(r._id, { acknowledgedAt: ctx.now(), acknowledgedNote: "Migration" });
        return { scanned: runs.length, changed: runs.length };
      },
    };
    register(ack);
    const f = await failure(t.action(internal.migrations.run, { name: ack.name }));
    expect(f.code).toBe("immutable_record");
    expect(String((f.data.changes as string[])[0])).toMatch(/^integrityRuns:.+ changed$/);
    expect((await t.run((ctx) => ctx.db.query("integrityRuns").first()))?.acknowledgedAt).toBeUndefined();
  });

  test("AUD-028 RI-14 an audit entry written after the pre-check head and altered before apply aborts the migration", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    const start = await t.query(internal.migrations.start, { since: Date.now() });
    await owner.mutation(api.invites.create, { email: "late@example.test", role: "viewer" }); // after the head
    await t.run(async (ctx) => {
      const last = await ctx.db.query("auditLog").withIndex("by_seq").order("desc").first();
      if (last) await ctx.db.patch(last._id, { actorLabel: "manipuliert" }); // out-of-band
    });
    clearInvariantTarget(); // tampered on purpose
    const f = await failure(t.mutation(internal.migrations.apply, { name: addUnit.name, start }));
    expect(f.code).toBe("immutable_record");
    expect(f.data.reason).toBe("MIGRATION_PROTECTED_CONTENT");
    const violations = f.data.violations as string[];
    expect(violations.some((v) => /^RI-14: Protokolleintrag seq \d+ wurde verändert/.test(v))).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("units").collect())).map((u) => u.code)).not.toContain("PF");
  });

  test("AUD-028 RI-14 the head entry the pre-check saw must still carry its hash", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    const start = await t.query(internal.migrations.start, { since: Date.now() });
    const seq = start.head?.seq ?? 0;
    expect(seq).toBeGreaterThan(0);
    const f = await failure(
      t.mutation(internal.migrations.apply, {
        name: addUnit.name,
        start: { ...start, head: { seq, hash: "f".repeat(64) } },
      }),
    );
    expect(f.code).toBe("immutable_record");
    expect(f.data.violations).toEqual(
      expect.arrayContaining([`RI-14: Protokolleintrag seq ${seq} hat sich seit der Vorprüfung verändert.`]),
    );
  });

  test("AUD-028 RI-01 a finalised document created after the pre-check started is re-checked by apply", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    const start = await t.query(internal.migrations.start, { since: Date.now() });
    await new Promise((r) => setTimeout(r, 5));
    await t.run(async (ctx) => {
      const doc = await ctx.db.get(id);
      if (!doc) throw new Error("no document");
      const { _id, _creationTime, snapshotId, ...fields } = doc;
      await ctx.db.insert("salesDocuments", fields); // out-of-band, no snapshot
    });
    clearInvariantTarget(); // broken on purpose
    const f = await failure(t.mutation(internal.migrations.apply, { name: addUnit.name, start }));
    expect(f.code).toBe("immutable_record");
    expect((f.data.violations as string[]).some((v) => /^RI-01: .*kein Snapshot vorhanden\.$/.test(v))).toBe(true);
    expect((await t.run((ctx) => ctx.db.query("units").collect())).map((u) => u.code)).not.toContain("PF");
  });
});
