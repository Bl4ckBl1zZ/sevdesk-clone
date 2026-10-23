import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import { memoryBuckets } from "./lib/backupStore";
import { memoryBucketLock } from "./lib/checkpointStore";
import { makeT } from "./test.setup";

/** F12 AUD-026: backup status page data and the daily `backups.verify` notification (fake R2 lister). */

const NOW = new Date("2026-10-19T03:40:00Z"); // 05:40 Europe/Berlin
const H = 3_600_000;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  memoryBuckets.clear();
});

const obj = (key: string, hoursAgo: number, bytes = 1_000) => ({ key, at: NOW.getTime() - hoursAgo * H, bytes });

describe("backup status (AUD-026)", () => {
  test("AUD-026 lists the latest object per prefix and the checkpoint bucket; stale sources notify, fresh ones resolve", async () => {
    const t = makeT();
    memoryBuckets.set("backups", [
      obj("postgres/2026-10-18.sql.gz", 30),
      obj("postgres/2026-10-19.sql.gz", 4, 2_048),
      obj("convex-export/2026-10-17.zip", 60),
      obj("convex-volume/2026-10-12.tar", 7 * 24),
    ]);
    memoryBuckets.set("checkpoints", [obj("checkpoints/2026/10/19.jws", 1, 900)]);
    const owner = await t.asUser("owner");
    const o = await owner.action(api.backups.status, {});
    expect(o.configured).toBe(true);
    expect(o.sources.map((s) => [s.prefix, s.status])).toEqual([
      ["postgres/", "ok"],
      ["convex-export/", "error"],
      ["convex-volume/", "ok"],
    ]);
    expect(o.sources[0]?.latest).toMatchObject({ key: "postgres/2026-10-19.sql.gz", bytes: 2_048 });
    expect(o.checkpoint?.latest?.key).toBe("checkpoints/2026/10/19.jws");
    expect(o.status).toBe("error");

    expect(await t.action(internal.backups.verifyCron, {})).toBeNull(); // IS_TEST skip
    expect(await t.action(internal.backups.verifyCron, { force: true })).toBe("notified");
    const open = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(open.find((n) => n.kind === "backup.stale")?.title).toContain("Convex-Export");

    memoryBuckets.set("backups", [obj("postgres/x", 1), obj("convex-export/x", 1), obj("convex-volume/x", 1)]);
    expect(await t.action(internal.backups.verifyCron, { force: true })).toBe("ok");
    const after = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(after.find((n) => n.kind === "backup.stale")?.resolvedAt).toBeDefined();
  });

  test("E-AUD-44 without the read-only R2 credentials the status is unknown with the F12 warning", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    process.env.IS_TEST = ""; // no fake lister: the real one needs R2_BACKUP_READONLY_* (absent here)
    try {
      expect(await owner.action(api.backups.status, {})).toMatchObject({
        configured: false,
        status: "unknown",
        notices: ["Sicherungsstatus kann nicht geprüft werden (R2-Lesezugang fehlt)."],
      });
      expect(await t.action(internal.backups.verifyCron, { force: true })).toBeNull(); // nothing notified
    } finally {
      process.env.IS_TEST = "true";
    }
  });

  test("E-AUD-45 a checkpoint bucket without a bucket-lock rule adds the recommendation warning", async () => {
    const t = makeT();
    memoryBuckets.set("backups", [obj("postgres/x", 1), obj("convex-export/x", 1), obj("convex-volume/x", 1)]);
    memoryBuckets.set("checkpoints", [obj("checkpoints/2026/10/19.jws", 1)]);
    memoryBucketLock.value = "absent";
    const o = await (await t.asUser("owner")).action(api.backups.status, {});
    memoryBucketLock.value = "unknown";
    expect(o.status).toBe("ok");
    expect(o.checkpoint?.bucketLock).toBe("absent");
    expect(o.notices).toEqual(["Für den Prüfpunkt-Bucket ist keine Aufbewahrungssperre eingerichtet (empfohlen)."]);
  });

  test("E-AUD-43 a stale database backup is notified with its age in hours", async () => {
    const t = makeT();
    memoryBuckets.set("backups", [obj("postgres/x", 30), obj("convex-export/x", 1), obj("convex-volume/x", 1)]);
    expect(await t.action(internal.backups.verifyCron, { force: true })).toBe("notified");
    const n = (await t.run((ctx) => ctx.db.query("notifications").collect())).find((x) => x.kind === "backup.stale");
    expect(n).toMatchObject({
      severity: "error",
      title: "Dokploy-Datenbank (Postgres): Letzte Datenbanksicherung vor 30 Stunden.",
    });
  });

  test("AUD-026 viewers may read the status; the page needs settings.read", async () => {
    const t = makeT();
    const viewer = await t.asUser("viewer");
    const o = await viewer.action(api.backups.status, {});
    expect(o.sources.every((s) => s.status === "error")).toBe(true); // empty fake bucket
  });
});
