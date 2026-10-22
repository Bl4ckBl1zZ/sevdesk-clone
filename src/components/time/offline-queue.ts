"use client";

import type { OfflineOp } from "@/domain/projects/offline";

/**
 * Offline queue for time capture (F11 PRJ-018, 04-ui-ux §10): manual entries and timer start/stop are stored in
 * IndexedDB while the device is offline and replayed with `timeEntries.syncOffline` when it is back online (the
 * server assigns the IDs and applies the E-PRJ-29 conflict rule). Operations leave the queue only after the server
 * confirmed them (applied or already applied), so a failed sync loses nothing.
 */

export type NewOfflineOp =
  | Omit<Extract<OfflineOp, { kind: "manual" }>, "id">
  | Omit<Extract<OfflineOp, { kind: "timer_start" }>, "id">
  | Omit<Extract<OfflineOp, { kind: "timer_stop" }>, "id">;

export interface TimeOpStore {
  all(): Promise<OfflineOp[]>;
  put(op: OfflineOp): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
}

const DB_NAME = "rechnung-offline";
const STORE = "timeOps";

function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB store (one object store keyed by the op id). */
export function indexedDbStore(): TimeOpStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = () => {
    db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: "id" });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    all: async () => request((await tx("readonly")).getAll() as IDBRequest<OfflineOp[]>),
    put: async (op) => {
      await request((await tx("readwrite")).put(op));
    },
    remove: async (ids) => {
      const store = await tx("readwrite");
      await Promise.all(ids.map((id) => request(store.delete(id))));
    },
  };
}

/** In-memory store (tests, browsers without IndexedDB). */
export function memoryStore(initial: OfflineOp[] = []): TimeOpStore {
  const map = new Map(initial.map((o) => [o.id, o]));
  return {
    all: async () => [...map.values()],
    put: async (op) => {
      map.set(op.id, op);
    },
    remove: async (ids) => {
      for (const id of ids) map.delete(id);
    },
  };
}

export type SyncSender = (
  deviceId: string,
  ops: OfflineOp[],
) => Promise<{ applied: string[]; skipped: string[]; warnings: string[] }>;

const newId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Queue state shared by every timer surface (header pill, /zeiten, project page) via `subscribe`. */
export class OfflineTimeQueue {
  private ops: OfflineOp[] = [];
  private listeners = new Set<() => void>();
  private flushing: Promise<{ warnings: string[]; rejected: string[]; applied: number }> | null = null;
  private loaded: Promise<void> | null = null;

  constructor(private readonly store: TimeOpStore) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  snapshot = (): readonly OfflineOp[] => this.ops;

  private emit() {
    for (const fn of this.listeners) fn();
  }

  load(): Promise<void> {
    this.loaded ??= this.store.all().then((ops) => {
      this.ops = ops.sort((a, b) => a.at - b.at);
      this.emit();
    });
    return this.loaded;
  }

  async enqueue(op: NewOfflineOp): Promise<OfflineOp> {
    await this.load();
    const full = { ...op, id: newId() } as OfflineOp;
    await this.store.put(full);
    this.ops = [...this.ops, full];
    this.emit();
    return full;
  }

  private async drop(ids: Iterable<string>) {
    const done = new Set(ids);
    if (done.size === 0) return;
    await this.store.remove([...done]);
    this.ops = this.ops.filter((o) => !done.has(o.id));
    this.emit();
  }

  /**
   * Sends the queue; confirmed ops leave it. Concurrent calls share one request. A rejected batch (an application
   * error such as an archived project) is retried op by op so one bad entry cannot block the rest: the rejected op
   * is dropped and its message returned. Network errors keep everything queued for the next attempt.
   */
  flush(
    deviceId: string,
    send: SyncSender,
    isRejection: (e: unknown) => string | null = () => null,
  ): Promise<{ warnings: string[]; rejected: string[]; applied: number }> {
    this.flushing ??= (async () => {
      try {
        await this.load();
        if (this.ops.length === 0) return { warnings: [], rejected: [], applied: 0 };
        const batch = [...this.ops];
        try {
          const r = await send(deviceId, batch);
          await this.drop([...r.applied, ...r.skipped]);
          return { warnings: r.warnings, rejected: [], applied: r.applied.length };
        } catch (e) {
          if (isRejection(e) === null) throw e;
        }
        const warnings: string[] = [];
        const rejected: string[] = [];
        let applied = 0;
        for (const op of batch) {
          try {
            const r = await send(deviceId, [op]);
            await this.drop([...r.applied, ...r.skipped]);
            applied += r.applied.length;
            warnings.push(...r.warnings);
          } catch (e) {
            const message = isRejection(e);
            if (message === null) throw e;
            rejected.push(message);
            await this.drop([op.id]);
          }
        }
        return { warnings, rejected, applied };
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}

const DEVICE_KEY = "rechnung-device-id";

/** A stable random ID of this browser (the E-PRJ-29 rule compares devices). */
export function deviceId(): string {
  if (typeof localStorage === "undefined") return "server";
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = newId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

let shared: OfflineTimeQueue | null = null;

/** Replaces the browser-wide queue (tests). */
export function setOfflineTimeQueue(q: OfflineTimeQueue | null): void {
  shared = q;
}

/** The browser-wide queue (IndexedDB when available). */
export function offlineTimeQueue(): OfflineTimeQueue {
  shared ??= new OfflineTimeQueue(typeof indexedDB === "undefined" ? memoryStore() : indexedDbStore());
  return shared;
}
