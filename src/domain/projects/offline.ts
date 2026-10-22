/**
 * Offline time capture (F11 PRJ-018, E-PRJ-29; 04-ui-ux §10). Pure.
 *
 * The PWA queues manual entries and timer start/stop in IndexedDB while offline and replays them in one call when
 * the connection is back; the server assigns the IDs. `planOfflineSync` turns the queued operations of one device
 * plus the server's running timer into the actions the server executes:
 *
 * - no running timer → the offline start becomes the running timer (with its offline start instant);
 * - a timer of the same device runs → it is stopped at the new start (like starting a new timer online);
 * - a timer of another device runs (E-PRJ-29) → **the later start wins**, the earlier run becomes an entry flagged
 *   „Konflikt“: if the offline start is later, the other device's timer is stopped at that instant (conflict) and the
 *   offline timer runs; if it is earlier, the offline run becomes the conflict entry ending where the other timer
 *   started (or at its own stop when that came first — then the runs do not overlap and there is no conflict).
 *
 * Instants come from the device clock and are capped at the server's `now`.
 */

export const OFFLINE_CONFLICT_MESSAGE = "Zeitkonflikt: Ein Timer wurde auf zwei Geräten gestartet.";

export interface OfflineTimerFields {
  readonly projectId?: string | undefined;
  readonly contactId?: string | undefined;
  readonly description?: string | undefined;
  readonly productId?: string | undefined;
  readonly billable?: boolean | undefined;
}

export type OfflineOp =
  | { readonly id: string; readonly kind: "manual"; readonly at: number; readonly values: Record<string, unknown> }
  | { readonly id: string; readonly kind: "timer_start"; readonly at: number; readonly fields: OfflineTimerFields }
  | { readonly id: string; readonly kind: "timer_stop"; readonly at: number; readonly fields?: OfflineTimerFields };

export interface ServerTimerState {
  readonly startedAt: number;
  readonly deviceId?: string | undefined;
}

export type OfflineAction =
  | { readonly type: "manual"; readonly opId: string; readonly values: Record<string, unknown> }
  | {
      readonly type: "start_timer";
      readonly opId: string;
      readonly startedAt: number;
      readonly fields: OfflineTimerFields;
    }
  | {
      /** Stops the timer currently running on the server at `endedAt`. */
      readonly type: "stop_timer";
      readonly opId: string;
      readonly endedAt: number;
      readonly fields?: OfflineTimerFields | undefined;
      readonly conflict: boolean;
    }
  | {
      /** An offline run that never became the running timer, saved as an entry. */
      readonly type: "entry";
      readonly opId: string;
      readonly startedAt: number;
      readonly endedAt: number;
      readonly fields: OfflineTimerFields;
      readonly conflict: boolean;
    }
  | { readonly type: "skip"; readonly opId: string; readonly reason: "no_timer" };

export interface OfflinePlan {
  readonly actions: readonly OfflineAction[];
  readonly conflict: boolean;
}

export function planOfflineSync(
  server: ServerTimerState | null,
  deviceId: string,
  ops: readonly OfflineOp[],
  now: number,
): OfflinePlan {
  const actions: OfflineAction[] = [];
  let conflict = false;
  let running: { startedAt: number; deviceId?: string | undefined } | null = server ? { ...server } : null;
  /** An offline start earlier than another device's running timer: decided at its stop (or at the end). */
  let deferred: { opId: string; at: number; fields: OfflineTimerFields } | null = null;
  const sorted = [...ops]
    .map((o) => ({ ...o, at: Math.min(o.at, now) }))
    // stable: equal instants (e.g. both capped at now) keep the queue order
    .sort((a, b) => a.at - b.at);
  const settleDeferred = (stopAt: number | null, fields?: OfflineTimerFields) => {
    if (!deferred) return;
    const otherStart = running?.startedAt ?? now;
    const overlaps = stopAt === null || stopAt > otherStart;
    if (overlaps) conflict = true;
    actions.push({
      type: "entry",
      opId: deferred.opId,
      startedAt: deferred.at,
      endedAt: overlaps ? otherStart : stopAt,
      fields: { ...deferred.fields, ...(fields ?? {}) },
      conflict: overlaps,
    });
    deferred = null;
  };
  for (const op of sorted) {
    if (op.kind === "manual") {
      actions.push({ type: "manual", opId: op.id, values: op.values });
      continue;
    }
    if (op.kind === "timer_start") {
      if (deferred) settleDeferred(op.at);
      if (!running) {
        actions.push({ type: "start_timer", opId: op.id, startedAt: op.at, fields: op.fields });
      } else if (running.deviceId === deviceId) {
        actions.push({ type: "stop_timer", opId: op.id, endedAt: op.at, conflict: false });
        actions.push({ type: "start_timer", opId: op.id, startedAt: op.at, fields: op.fields });
      } else if (op.at >= running.startedAt) {
        conflict = true;
        actions.push({ type: "stop_timer", opId: op.id, endedAt: op.at, conflict: true });
        actions.push({ type: "start_timer", opId: op.id, startedAt: op.at, fields: op.fields });
      } else {
        deferred = { opId: op.id, at: op.at, fields: op.fields };
        continue;
      }
      running = { startedAt: op.at, deviceId };
      continue;
    }
    // timer_stop
    if (deferred) settleDeferred(op.at, op.fields);
    else if (running && running.deviceId === deviceId) {
      actions.push({ type: "stop_timer", opId: op.id, endedAt: op.at, fields: op.fields, conflict: false });
      running = null;
    } else actions.push({ type: "skip", opId: op.id, reason: "no_timer" });
  }
  settleDeferred(null);
  return { actions, conflict };
}

/**
 * The timer as the offline device sees it: the last queued start without a later queued stop (null when the queue
 * holds no running offline timer). Shown as the running timer while offline.
 */
export function localTimerFromQueue(
  ops: readonly OfflineOp[],
): { readonly startedAt: number; readonly fields: OfflineTimerFields } | null {
  let current: { startedAt: number; fields: OfflineTimerFields } | null = null;
  for (const op of [...ops].sort((a, b) => a.at - b.at)) {
    if (op.kind === "timer_start") current = { startedAt: op.at, fields: op.fields };
    else if (op.kind === "timer_stop") current = null;
  }
  return current;
}
