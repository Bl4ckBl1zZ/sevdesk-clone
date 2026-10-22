"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { localTimerFromQueue, type OfflineOp } from "@/domain/projects/offline";
import { deviceId, offlineTimeQueue } from "./offline-queue";

const EMPTY: readonly OfflineOp[] = [];

function subscribeOnline(fn: () => void) {
  window.addEventListener("online", fn);
  window.addEventListener("offline", fn);
  return () => {
    window.removeEventListener("online", fn);
    window.removeEventListener("offline", fn);
  };
}

/** `navigator.onLine` as React state (true during SSR). */
export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/** Convex application errors (ConvexError data with a message) are rejections; anything else is a network error. */
function rejection(e: unknown): string | null {
  const data = (e as { data?: { code?: unknown; message?: unknown } })?.data;
  return data && typeof data === "object" && "code" in data ? String(data.message ?? data.code) : null;
}

let handled: Promise<unknown> | null = null;

/**
 * PRJ-018: the offline queue as React state plus the automatic replay when the device is (back) online. Every timer
 * surface uses it; the replay runs once per flush even with several mounted surfaces.
 */
export function useOfflineTime() {
  const t = useTranslations("time.offline");
  const queue = offlineTimeQueue();
  const ops = useSyncExternalStore(queue.subscribe, queue.snapshot, () => EMPTY);
  const online = useOnline();
  const sync = useMutation(api.timeEntries.syncOffline);

  useEffect(() => {
    void queue.load();
  }, [queue]);

  useEffect(() => {
    if (!online || ops.length === 0) return;
    const p = queue.flush(deviceId(), (device, batch) => sync({ deviceId: device, ops: batch }), rejection);
    if (p === handled) return;
    handled = p;
    p.then((r) => {
      if (r.applied > 0) toast.success(t("synced", { count: r.applied }));
      for (const w of r.warnings) toast.warning(w);
      for (const m of r.rejected) toast.error(t("rejected", { message: m }));
    }).catch(() => {
      // still offline or the backend is unreachable: the queue stays and is retried on the next „online“ event
    });
  }, [online, ops.length, queue, sync, t]);

  return {
    online,
    ops,
    localTimer: localTimerFromQueue(ops),
    enqueue: (op: Parameters<typeof queue.enqueue>[0]) => queue.enqueue(op),
  };
}
