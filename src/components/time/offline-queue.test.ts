import { describe, expect, test } from "vitest";
import type { OfflineOp } from "@/domain/projects/offline";
import { memoryStore, OfflineTimeQueue, type SyncSender } from "./offline-queue";

const rejection = (e: unknown) => {
  const data = (e as { data?: { message?: string } }).data;
  return data ? (data.message ?? "abgelehnt") : null;
};

describe("PRJ-018 offline queue (IndexedDB store abstraction)", () => {
  test("PRJ-018 queued ops get client IDs, persist in the store and leave it only once the server confirmed them", async () => {
    const store = memoryStore();
    const q = new OfflineTimeQueue(store);
    await q.enqueue({ kind: "timer_start", at: 1000, fields: { description: "Workshop" } });
    await q.enqueue({ kind: "timer_stop", at: 2000 });
    expect(q.snapshot().map((o) => o.kind)).toEqual(["timer_start", "timer_stop"]);
    expect(new Set(q.snapshot().map((o) => o.id)).size).toBe(2);
    // a reload reads the persisted queue
    const reloaded = new OfflineTimeQueue(store);
    await reloaded.load();
    expect(reloaded.snapshot()).toHaveLength(2);

    const sent: OfflineOp[][] = [];
    const send: SyncSender = async (_device, ops) => {
      sent.push(ops);
      return { applied: ops.map((o) => o.id), skipped: [], warnings: ["Hinweis"] };
    };
    const r = await reloaded.flush("phone", send, rejection);
    expect(r).toEqual({ warnings: ["Hinweis"], rejected: [], applied: 2 });
    expect(sent).toHaveLength(1);
    expect(reloaded.snapshot()).toEqual([]);
    expect(await store.all()).toEqual([]);
  });

  test("PRJ-018 a network error keeps everything queued; concurrent flushes share one request", async () => {
    const q = new OfflineTimeQueue(memoryStore());
    await q.enqueue({ kind: "manual", at: 1, values: { duration: "1h" } });
    let calls = 0;
    const offline: SyncSender = async () => {
      calls++;
      throw new TypeError("Failed to fetch");
    };
    const [a, b] = [q.flush("phone", offline, rejection), q.flush("phone", offline, rejection)];
    expect(a).toBe(b);
    await expect(a).rejects.toThrow("Failed to fetch");
    expect(calls).toBe(1);
    expect(q.snapshot()).toHaveLength(1);
  });

  test("PRJ-018 a rejected batch is retried op by op: the bad op is dropped with its message, the rest is applied", async () => {
    const q = new OfflineTimeQueue(memoryStore());
    await q.enqueue({ kind: "manual", at: 1, values: { description: "ok" } });
    const bad = await q.enqueue({ kind: "manual", at: 2, values: { description: "archiviert" } });
    await q.enqueue({ kind: "manual", at: 3, values: { description: "auch ok" } });
    const send: SyncSender = async (_d, ops) => {
      if (ops.some((o) => o.id === bad.id)) {
        throw { data: { code: "conflict", message: "Projekt Alt ist archiviert." } };
      }
      return { applied: ops.map((o) => o.id), skipped: [], warnings: [] };
    };
    const r = await q.flush("phone", send, rejection);
    expect(r).toEqual({ warnings: [], rejected: ["Projekt Alt ist archiviert."], applied: 2 });
    expect(q.snapshot()).toEqual([]);
  });

  test("PRJ-018 ops the server reports as already applied (replay) leave the queue too", async () => {
    const q = new OfflineTimeQueue(memoryStore());
    const op = await q.enqueue({ kind: "timer_stop", at: 5 });
    const r = await q.flush("phone", async () => ({ applied: [], skipped: [op.id], warnings: [] }), rejection);
    expect(r.applied).toBe(0);
    expect(q.snapshot()).toEqual([]);
  });
});
