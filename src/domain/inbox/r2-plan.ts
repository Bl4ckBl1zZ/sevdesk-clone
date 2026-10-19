/**
 * Planning of one `inbox.pollR2` run (F06 INB-049/052, 02 §7, EC-INB-23/27/28/29/32). Pure: the action lists the
 * bucket, this module decides what to import and what to report.
 *
 *  - only `inbox/…*.eml` objects are imported, oldest first, at most 50 per run (the rest next run);
 *  - other keys are ignored and logged, never deleted (EC-INB-32);
 *  - an object still present 60 min after `LastModified` is stale → notification (EC-INB-28);
 *  - 401/403 pauses polling (EC-INB-29); 3 consecutive failed runs → notification (EC-INB-28).
 */

export const INBOX_POLL = {
  batch: 50,
  staleMinutes: 60,
  failedRunsAlert: 3,
  /** Cloudflare Email Routing's own limit; larger mails are bounced by the Worker (EC-INB-25). */
  maxRawBytes: 25 * 1024 * 1024,
} as const;

export interface BucketObject {
  key: string;
  /** Epoch ms (R2 `LastModified`, the time of Zugang at the Worker). */
  lastModified: number;
  size: number;
  etag?: string;
}

/** `inbox/<name>.eml` as written by the Worker `receipts-inbox` (INB-048). */
export const isInboxObjectKey = (key: string): boolean =>
  key.startsWith("inbox/") && key.toLowerCase().endsWith(".eml") && key.length > "inbox/.eml".length;

export function planPoll<O extends BucketObject>(
  objects: readonly O[],
  now: number,
  opts: { batch?: number } = {},
): { batch: O[]; ignored: string[]; staleCount: number; oldestStaleAt?: number } {
  const limit = opts.batch ?? INBOX_POLL.batch;
  const ignored: string[] = [];
  const eligible: O[] = [];
  for (const o of objects) {
    if (isInboxObjectKey(o.key)) eligible.push(o);
    else ignored.push(o.key);
  }
  eligible.sort((a, b) => a.lastModified - b.lastModified || a.key.localeCompare(b.key));
  const staleBefore = now - INBOX_POLL.staleMinutes * 60_000;
  const stale = eligible.filter((o) => o.lastModified <= staleBefore);
  return {
    batch: eligible.slice(0, limit),
    ignored,
    staleCount: stale.length,
    ...(stale[0] ? { oldestStaleAt: stale[0].lastModified } : {}),
  };
}

export type PollOutcome = "ok" | "failed" | "unauthorized";

/** Health after a run: consecutive failures, pause on 401/403, alert at the third failed run in a row. */
export function pollHealth(
  prev: { consecutiveFailures: number },
  outcome: PollOutcome,
): { consecutiveFailures: number; pause: boolean; alert: "failed_runs" | "unauthorized" | null } {
  if (outcome === "ok") return { consecutiveFailures: 0, pause: false, alert: null };
  const consecutiveFailures = prev.consecutiveFailures + 1;
  if (outcome === "unauthorized") return { consecutiveFailures, pause: true, alert: "unauthorized" };
  return {
    consecutiveFailures,
    pause: false,
    alert: consecutiveFailures === INBOX_POLL.failedRunsAlert ? "failed_runs" : null,
  };
}
