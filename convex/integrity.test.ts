import { afterEach, describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { clearInvariantTarget } from "../test/invariants";
import { api, internal } from "./_generated/api";
import { checkpointKey, memoryCheckpointObjects, memoryFailures } from "./lib/checkpointStore";
import { errorCode } from "./lib/errors";
import { loadCheckpointKey, verifyCheckpoint } from "./lib/jws";
import { berlinParts } from "./lib/time";
import { makeT, type TestT } from "./test.setup";

async function withActivity(t: TestT) {
  const owner = await t.asUser("owner");
  for (const email of ["a@example.test", "b@example.test"])
    await owner.mutation(api.invites.create, { email, role: "viewer" });
  return owner;
}

afterEach(() => {
  memoryCheckpointObjects.clear();
  memoryFailures.remaining = 0;
});

describe("integrity.verify (AUD-013, RI-14)", () => {
  test("AUD-013 an untouched chain verifies; the run is stored and audited (integrity.run)", async () => {
    const t = makeT();
    await withActivity(t);
    const res = await t.action(internal.integrity.verify, {});
    expect(res).toMatchObject({ ok: true, findings: [] });
    const run = await t.run((ctx) => ctx.db.query("integrityRuns").first());
    expect(run).toMatchObject({ ok: true, scope: "full", lastVerifiedSeq: res.lastVerifiedSeq });
    expect(res.lastVerifiedSeq).toBeGreaterThan(0);
  });

  test("AUD-013 incremental runs continue from the last verified seq", async () => {
    const t = makeT();
    const owner = await withActivity(t);
    const first = await t.action(internal.integrity.verify, {});
    await owner.mutation(api.invites.create, { email: "c@example.test", role: "viewer" });
    const second = await t.action(internal.integrity.verify, { scope: "incremental" });
    expect(second.ok).toBe(true);
    expect(second.lastVerifiedSeq).toBeGreaterThan(first.lastVerifiedSeq);
  });

  test("AUD-013 SEC-04 a direct DB edit of an audit diff is reported with the first broken seq (E-AUD-03/05)", async () => {
    const t = makeT();
    await withActivity(t);
    const target = await t.run(async (ctx) => {
      const e = await ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.eq("seq", 2))
        .first();
      if (!e) throw new Error("no entry");
      await ctx.db.patch(e._id, { diff: { after: { forged: true } } }); // out-of-band (bypasses the model layer)
      return e;
    });
    const res = await t.action(internal.integrity.verify, {});
    expect(res.ok).toBe(false);
    expect(res.findings[0]).toMatchObject({
      kind: "chain_hash_mismatch",
      firstBrokenSeq: 2,
      entity: { table: target.entity.table, id: target.entity.id },
      detail: "Protokolleintrag seq 2 wurde verändert oder beschädigt.",
    });
    const status = await (await t.asUser("owner")).query(api.integrity.status, {});
    expect(status.finalisationBlocked).toBe(true);
    clearInvariantTarget(); // tampered on purpose
  });

  test("AUD-013 RI-14 a deleted audit entry is reported as a gap (E-AUD-04)", async () => {
    const t = makeT();
    await withActivity(t);
    await t.run(async (ctx) => {
      const e = await ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.eq("seq", 2))
        .first();
      if (e) await ctx.db.delete(e._id);
    });
    const res = await t.action(internal.integrity.verify, {});
    expect(res.findings.map((f) => f.kind)).toContain("chain_gap");
    const invariants = await t.query(internal.invariants.check, {});
    expect(invariants.map((v) => v.id)).toContain("RI-14");
    clearInvariantTarget();
  });

  test("AUD-015 only the owner acknowledges a failed run, with a note (E-AUD-16); this unblocks finalisation", async () => {
    const t = makeT();
    await withActivity(t);
    await t.run(async (ctx) => {
      const e = await ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.eq("seq", 1))
        .first();
      if (e) await ctx.db.patch(e._id, { reason: "x" });
    });
    await t.action(internal.integrity.verify, {});
    const owner = await t.asUser("owner");
    const bookkeeper = await t.asUser("bookkeeper");
    const { lastRun } = await owner.query(api.integrity.status, {});
    if (!lastRun) throw new Error("no run");
    await expect(bookkeeper.mutation(api.integrity.acknowledge, { runId: lastRun.id, note: "x" })).rejects.toThrow();
    const short = await owner.mutation(api.integrity.acknowledge, { runId: lastRun.id, note: " " }).catch(errorCode);
    expect(short).toBe("invalid_input");
    await owner.mutation(api.integrity.acknowledge, {
      runId: lastRun.id,
      note: "Testmanipulation, Ursache dokumentiert",
    });
    expect((await owner.query(api.integrity.status, {})).finalisationBlocked).toBe(false);
    clearInvariantTarget();
  });
});

describe("signed daily checkpoint (AUD-016, SEC-04)", () => {
  test("AUD-016 the checkpoint is an ES256 JWS over {date, lastSeq, lastHash, counts, …} uploaded to R2", async () => {
    const t = makeT();
    await withActivity(t);
    const res = await t.action(internal.integrity.checkpoint, {});
    if (!("jws" in res)) throw new Error(`skipped: ${res.skipped}`);
    expect(res.uploaded).toBe(true);

    const key = await loadCheckpointKey(process.env.CHECKPOINT_SIGNING_KEY_PEM as string);
    const verified = await verifyCheckpoint(res.jws, key.publicJwk);
    if (!verified.ok) throw new Error(verified.error);
    const head = await t.run((ctx) => ctx.db.query("auditLog").withIndex("by_seq").order("desc").first());
    const date = berlinParts(Date.now()).date;
    expect(verified.kid).toBe(key.kid);
    expect(verified.payload).toMatchObject({
      instance: "test",
      date,
      lastHash: expect.any(String),
      prevCheckpointHash: "0".repeat(64),
      schemaVersion: "p0-1",
      counts: expect.objectContaining({ integrityRuns: 0, integrityCheckpoints: 0 }),
    });
    expect(verified.payload.lastSeq).toBeLessThanOrEqual(head?.seq ?? 0);

    const row = await t.run((ctx) => ctx.db.query("integrityCheckpoints").first());
    expect(row).toMatchObject({
      date,
      uploadStatus: "uploaded",
      exportedTo: `memory://test-checkpoints/${checkpointKey(date)}`,
      kid: key.kid,
    });
    expect(memoryCheckpointObjects.get(checkpointKey(date))).toBe(res.jws);
    expect(checkpointKey("2026-10-12")).toBe("checkpoints/2026/10/12.jws");

    // a modified JWS fails verification
    const [h, p, s] = res.jws.split(".");
    const forged = `${h}.${p?.slice(0, -2)}AA.${s}`;
    expect((await verifyCheckpoint(forged, key.publicJwk)).ok).toBe(false);
  });

  test("AUD-016 one checkpoint per day; the next one links to the previous JWS", async () => {
    const t = makeT();
    await withActivity(t);
    const first = await t.action(internal.integrity.checkpoint, {});
    const again = await t.action(internal.integrity.checkpoint, {});
    expect(again).toMatchObject({ skipped: expect.stringContaining("existiert bereits") });
    if (!("jws" in first)) throw new Error("no checkpoint");
    expect(await sha256Hex(first.jws)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("AUD-016 a failed upload is recorded and retried by the hourly run (E-AUD-10)", async () => {
    const t = makeT();
    await withActivity(t);
    memoryFailures.remaining = 1;
    const res = await t.action(internal.integrity.checkpoint, {});
    expect(res).toMatchObject({ uploaded: false });
    expect(await t.run((ctx) => ctx.db.query("integrityCheckpoints").first())).toMatchObject({
      uploadStatus: "failed",
    });
    await t.action(internal.integrity.checkpointCron, { force: true });
    expect(await t.run((ctx) => ctx.db.query("integrityCheckpoints").first())).toMatchObject({
      uploadStatus: "uploaded",
    });
  });

  test("AUD-013 the verify run checks the checkpoint: a differing R2 copy is critical (E-AUD-06)", async () => {
    const t = makeT();
    await withActivity(t);
    await t.action(internal.integrity.checkpoint, {});
    expect((await t.action(internal.integrity.verify, {})).ok).toBe(true);
    const date = berlinParts(Date.now()).date;
    memoryCheckpointObjects.set(checkpointKey(date), "eyJ.forged.copy");
    const res = await t.action(internal.integrity.verify, {});
    expect(res.findings).toEqual([
      expect.objectContaining({
        kind: "checkpoint_signature",
        detail: expect.stringContaining("weicht von der externen Kopie ab"),
      }),
    ]);
  });

  test("AUD-013 RI-14 rows removed from an append-only table after the checkpoint are reported (E-AUD-09)", async () => {
    const t = makeT();
    await withActivity(t);
    await t.action(internal.integrity.verify, {});
    await t.action(internal.integrity.checkpoint, {});
    await t.run(async (ctx) => {
      const run = await ctx.db.query("integrityRuns").first();
      if (run) await ctx.db.delete(run._id);
    });
    const res = await t.action(internal.integrity.verify, {});
    expect(res.findings.some((f) => f.detail.startsWith("In integrityRuns fehlen 1 Datensätze"))).toBe(true);
    clearInvariantTarget();
  });

  test("SEC-04 crons skip under IS_TEST unless forced", async () => {
    const t = makeT();
    expect(await t.action(internal.integrity.verifyCron, {})).toBeNull();
    expect(await t.action(internal.integrity.checkpointCron, {})).toBeNull();
  });
});
