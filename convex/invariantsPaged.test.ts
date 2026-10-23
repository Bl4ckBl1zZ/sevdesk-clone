import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { unacknowledgedFailure } from "./model/integrity";
import { DEFAULT_PAGE_BUDGET, type InvariantPage, type InvariantState } from "./model/invariants";
import { MIGRATIONS, type Migration } from "./model/migrations";
import { makeT, type TestT } from "./test.setup";

/**
 * Paged invariant check (10 §2, 02 §7 `invariants.check`, F12 AUD-013 (e)): `internal.invariants.run` drives
 * budget-sized pages (`internal.invariants.page`) so the check scales past the Convex per-execution limits; it must
 * report exactly what the single-transaction `internal.invariants.check` reports.
 */

/** Convex per-execution limits the pages must stay under (convex-test does not enforce them). */
const CONVEX_LIMITS = { calls: 4096, docs: 32_000, bytes: 16 * 1024 * 1024 };

async function pages(t: TestT, budget?: { calls?: number; docs?: number; bytes?: number }) {
  const out: InvariantPage[] = [];
  let state: InvariantState | null = null;
  for (;;) {
    const page: InvariantPage = await t.query(internal.invariants.page, {
      ...(state ? { state } : {}),
      budget: budget ?? DEFAULT_PAGE_BUDGET,
    });
    out.push(page);
    if (page.done) return out;
    state = page.state;
  }
}

/** Tampers past the model layer so several sections report: chain (RI-14), replay (RI-15), document (RI-01/RI-17). */
async function tamperedDataset() {
  const t = makeT();
  const { id, owner } = await finalizedInvoice(t);
  await owner.mutation(api.invites.create, { email: "b@example.test", role: "viewer" });
  await t.run(async (ctx) => {
    const entries = await ctx.db.query("auditLog").withIndex("by_seq").collect();
    const mid = entries[Math.floor(entries.length / 2)];
    if (mid) await ctx.db.patch(mid._id, { actorLabel: "manipuliert" });
    const d = await ctx.db.get(id);
    if (!d?.snapshotId) throw new Error("no snapshot");
    const snap = await ctx.db.get(d.snapshotId);
    if (!snap) throw new Error("no snapshot");
    const parsed = JSON.parse(snap.json) as { seller: Record<string, unknown> };
    await ctx.db.patch(d.snapshotId, {
      json: JSON.stringify({ ...parsed, seller: { ...parsed.seller, kleinunternehmer: true } }),
    });
    const invite = await ctx.db.query("invites").first();
    if (invite) await ctx.db.patch(invite._id, { email: "c@example.test" });
  });
  clearInvariantTarget(); // tampered on purpose; this file asserts the findings itself
  return { t, id };
}

describe("paged invariants.check (10 §2, AUD-013)", () => {
  test("AUD-013 RI-14 RI-15 RI-17 one-row pages report exactly what the single transaction reports", async () => {
    const { t } = await tamperedDataset();
    const single = await t.query(internal.invariants.check, {});
    for (const id of ["RI-14", "RI-15", "RI-01", "RI-17"]) expect(single.map((v) => v.id)).toContain(id);

    const tiny = await pages(t, { calls: 1, docs: 1, bytes: 1 });
    expect(tiny.length).toBeGreaterThan(20); // really paged, incl. the chain cursor across pages
    const paged = await t.action(internal.invariants.run, { budget: { calls: 1, docs: 1, bytes: 1 } });
    expect(paged).toEqual(single);
    expect(await t.action(internal.invariants.run, {})).toEqual(single);
  });

  test("AUD-013 a database whose single pass exceeds 4,096 reads is checked in pages within the Convex limits", async () => {
    const t = makeT();
    const { id } = await finalizedInvoice(t);
    // 1,500 finalised documents with snapshot and artifacts (clones of a real one, written past the model layer).
    await t.run(async (ctx) => {
      const doc = await ctx.db.get(id);
      if (!doc?.snapshotId) throw new Error("no snapshot");
      const snap = await ctx.db.get(doc.snapshotId);
      if (!snap) throw new Error("no snapshot");
      const artifacts = await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect();
      expect(artifacts.length).toBeGreaterThan(0);
      const { _id, _creationTime, ...docFields } = doc;
      const { _id: _s, _creationTime: _sc, ...snapFields } = snap;
      for (let i = 0; i < 1500; i++) {
        const number = `K-${String(i).padStart(5, "0")}`;
        const copy: Id<"salesDocuments"> = await ctx.db.insert("salesDocuments", { ...docFields, number });
        const snapshotId = await ctx.db.insert("documentSnapshots", { ...snapFields, documentId: copy });
        await ctx.db.patch(copy, { snapshotId });
        for (const a of artifacts) {
          const { _id: _a, _creationTime: _ac, ...artifactFields } = a;
          await ctx.db.insert("documentArtifacts", { ...artifactFields, documentId: copy });
        }
      }
    });
    clearInvariantTarget(); // the clones have no audit entries and no register rows — reported, asserted below

    const [single] = await pages(t, {});
    expect(single?.done).toBe(true);
    expect(single?.reads.calls).toBeGreaterThan(CONVEX_LIMITS.calls); // the former single query fails on the backend

    const paged = await pages(t);
    expect(paged.length).toBeGreaterThan(1);
    for (const p of paged) {
      expect(p.reads.calls).toBeLessThan(CONVEX_LIMITS.calls);
      expect(p.reads.docs).toBeLessThan(CONVEX_LIMITS.docs);
      expect(p.reads.bytes).toBeLessThan(CONVEX_LIMITS.bytes);
    }

    const violations = await t.action(internal.invariants.run, {});
    expect(violations).toEqual(await t.query(internal.invariants.check, {}));
    expect(violations.filter((v) => v.id === "RI-15").length).toBeGreaterThanOrEqual(1500);
  }, 300_000);
});

describe("invariants.check cron (02 §7 daily 02:15, AUD-013, AUD-015, SET-134)", () => {
  test("AUD-013 AUD-015 ERROR findings are stored in integrityRuns (finalisation blocked) and raise integrity.failed", async () => {
    const { t } = await tamperedDataset();
    const res = await t.action(internal.invariants.checkCron, { force: true });
    expect(res?.errors).toBeGreaterThan(0);
    const run = await t.run((ctx) => ctx.db.query("integrityRuns").withIndex("by_at").order("desc").first());
    expect(run).toMatchObject({ ok: false, scope: "full", lastVerifiedSeq: 0 });
    expect(run?.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["RI-14", "RI-15", "RI-17"]));
    expect(run?.findings.every((f) => f.severity === "error" || f.severity === "warning")).toBe(true);
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.map((n) => n.kind)).toContain("integrity.failed");
    const blocked = await t.run((ctx) => unacknowledgedFailure(ctx));
    expect(blocked?._id).toBe(run?._id);
  });

  test("AUD-015 SET-134 a clean run stores no integrityRuns row (cannot lift a verify failure) but records the cron run", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    expect(await t.action(internal.invariants.checkCron, { force: true })).toMatchObject({ errors: 0 });
    expect(await t.run((ctx) => ctx.db.query("integrityRuns").collect())).toEqual([]);
    const runs = await t.run((ctx) => ctx.db.query("cronRuns").collect());
    expect(runs.find((r) => r.job === "cron.invariants.check")).toMatchObject({ result: "ok" });
  });

  test("AUD-013 the cron skips under IS_TEST unless forced", async () => {
    const t = makeT();
    expect(await t.action(internal.invariants.checkCron, {})).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("integrityRuns").collect())).toEqual([]);
  });
});

describe("migrations:run pre-check through the paged check (F12 AUD-028, EC-184)", () => {
  const addUnit: Migration = {
    name: "2026-11-paged-precheck",
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
  beforeEach(() => {
    registered.push(addUnit);
  });
  afterEach(() => {
    registered.splice(registered.indexOf(addUnit), 1);
  });

  test("AUD-028 GOBD-23 a clean database: the action checks in pages, then applies the migration in one transaction", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    expect(await t.action(internal.migrations.run, { name: addUnit.name })).toEqual({ scanned: 0, changed: 1 });
    const last = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    expect(last).toMatchObject({ action: "system.migration", actor: `system:migration.${addUnit.name}` });
  });

  test("AUD-028 EC-184 RI-14 a broken chain stops the migration before it starts (MIGRATION_PRECONDITION)", async () => {
    const t = makeT();
    await finalizedInvoice(t);
    await t.run(async (ctx) => {
      const e = await ctx.db.query("auditLog").first();
      if (e) await ctx.db.patch(e._id, { actorLabel: "manipuliert" }); // out-of-band
    });
    clearInvariantTarget(); // tampered on purpose
    const err = await t.action(internal.migrations.run, { name: addUnit.name }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(errorCode(err)).toBe("conflict");
    const data = (err as { data: Record<string, unknown> }).data;
    expect(data.reason).toBe("MIGRATION_PRECONDITION");
    expect(String((data.violations as string[])[0])).toMatch(/^RI-14/);
    expect((await t.run((ctx) => ctx.db.query("units").collect())).map((u) => u.code)).not.toContain("PF");
  });
});
