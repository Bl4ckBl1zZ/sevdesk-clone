import { exportPKCS8, generateKeyPair } from "jose";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { setupInvoicing } from "./invoices.fixtures";
import { memoryCheckpointObjects, memoryFailures } from "./lib/checkpointStore";
import { makeT, type TestT } from "./test.setup";

/**
 * Integrity jobs (02 §4.6/§7, F12 AUD-013…AUD-016, SET-133) — the cron gates, the checkpoint without signing key or
 * bucket, a checkpoint signed with a rotated key, the startup check after a plain verify run and the instance-wide
 * rate limit message of convex/integrity.ts.
 */

const MONDAY = new Date("2026-10-12T10:00:00Z"); // 12:00 Berlin
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(MONDAY);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  memoryCheckpointObjects.clear();
  memoryFailures.remaining = 0;
});

async function withActivity(t: TestT) {
  const owner = await t.asUser("owner");
  for (const email of ["a@example.test", "b@example.test"])
    await owner.mutation(api.invites.create, { email, role: "viewer" });
  return owner;
}

const latestRun = (t: TestT) => t.run((ctx) => ctx.db.query("integrityRuns").withIndex("by_at").order("desc").first());
const checkpoints = (t: TestT) => t.run((ctx) => ctx.db.query("integrityCheckpoints").collect());

describe("AUD-013 verify cron gate", () => {
  test("AUD-013 SEC-04 outside 02:xx Berlin the cron is a no-op; forced on Sunday it runs the full chain, on Monday incrementally", async () => {
    const t = makeT();
    await withActivity(t);
    vi.stubEnv("IS_TEST", "false");
    expect(await t.action(internal.integrity.verifyCron, {})).toBeNull();
    expect(await latestRun(t)).toBeNull();
    vi.stubEnv("IS_TEST", "true");
    vi.setSystemTime(new Date("2026-10-11T00:30:00Z")); // Sunday 02:30 Berlin
    await t.action(internal.integrity.verifyCron, { force: true });
    expect((await latestRun(t))?.scope).toBe("full");
    vi.setSystemTime(MONDAY);
    await t.action(internal.integrity.verifyCron, { force: true });
    expect((await latestRun(t))?.scope).toBe("incremental");
  });

  test("AUD-013 on the 1st of the month even an incremental run re-hashes every artifact; the test hook is off outside tests", async () => {
    vi.setSystemTime(new Date("2026-11-01T10:00:00Z"));
    const t = makeT();
    await withActivity(t);
    const res = await t.action(internal.integrity.verify, { scope: "incremental" });
    expect(res.ok).toBe(true);
    expect((await latestRun(t))?.scope).toBe("incremental");
    vi.stubEnv("IS_TEST", "false");
    expect(await t.action(internal.integrity.rehashArtifactsForTest, { since: "all", sample: true })).toEqual([]);
  });

  test("RI-14 only protected tables can be counted", async () => {
    const t = makeT();
    await expect(
      t.query(internal.integrity.countTable, { table: "contacts", paginationOpts: { numItems: 10, cursor: null } }),
    ).rejects.toThrow("not a counted table: contacts");
  });
});

describe("AUD-016 checkpoint without key or bucket", () => {
  test("AUD-016 without CHECKPOINT_SIGNING_KEY_PEM no checkpoint is created and the verify run skips the signature check", async () => {
    const t = makeT();
    await withActivity(t);
    await t.action(internal.integrity.checkpoint, {});
    vi.stubEnv("CHECKPOINT_SIGNING_KEY_PEM", "");
    vi.setSystemTime(new Date("2026-10-13T10:00:00Z"));
    expect(await t.action(internal.integrity.checkpoint, {})).toEqual({ skipped: "CHECKPOINT_SIGNING_KEY_PEM fehlt" });
    expect(await checkpoints(t)).toHaveLength(1);
    const res = await t.action(internal.integrity.verify, {});
    expect(res.ok).toBe(true);
  });

  test("AUD-017 a checkpoint signed with a key that is no longer configured is a warning, not an error", async () => {
    const t = makeT();
    await withActivity(t);
    await t.action(internal.integrity.checkpoint, {});
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    vi.stubEnv("CHECKPOINT_SIGNING_KEY_PEM", await exportPKCS8(privateKey));
    const res = await t.action(internal.integrity.verify, {});
    expect(res.ok).toBe(true);
    const cp = (await checkpoints(t))[0];
    expect(res.findings).toEqual([
      expect.objectContaining({
        kind: "checkpoint_signature",
        severity: "warning",
        detail: `Prüfpunkt vom 12.10.2026 wurde mit einem anderen Schlüssel (${cp?.kid}) signiert.`,
      }),
    ]);
  });

  test("E-AUD-10 AUD-016 without a bucket the upload is recorded as failed; the hourly cron retries outside 02:xx and succeeds once the bucket exists", async () => {
    const t = makeT();
    const owner = await withActivity(t);
    vi.stubEnv("IS_TEST", "false"); // no R2 env and no test fake → no store
    const r = await t.action(internal.integrity.checkpoint, {});
    expect(r).toMatchObject({ uploaded: false });
    expect((await checkpoints(t))[0]).toMatchObject({
      uploadStatus: "failed",
    });
    // 12:00 Berlin: the cron only retries the upload (still no bucket) and creates no new checkpoint
    expect(await t.action(internal.integrity.checkpointCron, {})).toBeNull();
    expect(await checkpoints(t)).toHaveLength(1);
    vi.stubEnv("IS_TEST", "true");
    const forced = await t.action(internal.integrity.checkpointCron, { force: true });
    expect(forced).toEqual({ skipped: "Prüfpunkt für 2026-10-12 existiert bereits" });
    const status = await owner.query(api.integrity.status, {});
    expect(status.latestCheckpoint).toMatchObject({
      uploadStatus: "uploaded",
      exportedTo: expect.stringContaining("checkpoints/2026/10/12.jws"),
    });
  });
});

describe("AUD-014 startup check", () => {
  test("AUD-014 without a checkpoint the startup check continues from the last successful verify run", async () => {
    const t = makeT();
    const owner = await withActivity(t);
    const first = await t.action(internal.integrity.verify, {});
    await owner.mutation(api.invites.create, { email: "c@example.test", role: "viewer" });
    const res = await t.action(internal.integrity.startupCron, { force: true });
    expect(res?.ok).toBe(true);
    expect(res?.lastVerifiedSeq).toBeGreaterThan(first.lastVerifiedSeq);
    expect((await latestRun(t))?.scope).toBe("startup");
  });

  test("AUD-014 a checkpoint whose entry was edited fails the startup check with lastVerifiedSeq 0", async () => {
    const t = makeT();
    await withActivity(t);
    await t.action(internal.integrity.checkpoint, {});
    const cp = (await checkpoints(t))[0];
    await t.run(async (ctx) => {
      const entry = await ctx.db
        .query("auditLog")
        .withIndex("by_seq", (q) => q.eq("seq", cp?.lastSeq ?? 0))
        .first();
      if (entry) await ctx.db.patch(entry._id, { hash: "0".repeat(64) });
    });
    const res = await t.action(internal.integrity.startupCron, { force: true });
    expect(res?.ok).toBe(false);
    expect(res?.lastVerifiedSeq).toBe(0);
    expect(res?.findings.map((f) => f.kind)).toContain("checkpoint_mismatch");
    const { clearInvariantTarget } = await import("../test/invariants");
    clearInvariantTarget(); // tampered on purpose
  });
});

describe("SET-133 run now", () => {
  test("SET-133 a second run within the last minute of the window names one minute", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.action(api.integrity.runNow, {});
    // the fixed window starts at an offset: step minute by minute until the run is allowed again
    const messages: string[] = [];
    for (let i = 0; i <= 11; i++) {
      vi.setSystemTime(new Date(MONDAY.getTime() + i * 60_000));
      const r = await owner.action(api.integrity.runNow, {}).then(
        () => null,
        (err: { data?: Record<string, unknown> }) => String(err.data?.message),
      );
      if (r === null) break;
      messages.push(r);
    }
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.at(-1)).toBe(
      "Die Integritätsprüfung wurde gerade erst ausgeführt. Bitte in 1 Minute erneut versuchen.",
    );
    for (const m of messages.slice(0, -1)) expect(m).toMatch(/Bitte in \d+ Minuten erneut versuchen\.$/);
  });
});
