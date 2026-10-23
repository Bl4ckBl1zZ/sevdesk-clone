/**
 * Delivery rules of outbound webhooks (05 §5.1/§5.2, Standard Webhooks). Pure: `now` and the random source are
 * passed in.
 *
 *  - success = any 2xx within 15 s; redirects are not followed (a 3xx is a failure);
 *  - 410 Gone disables the endpoint at once;
 *  - retries: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h — each delay with ±10 % jitter;
 *    a `Retry-After` header postpones the next attempt (never earlier than the schedule, capped at 24 h);
 *  - an endpoint failing for 3 days without a success is disabled and the owner is notified;
 *  - the delivery log keeps 30 days.
 */
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

/** Delay before attempt n+1 after attempt n failed (index 0 = before the 2nd attempt; the 1st is immediate). */
export const RETRY_DELAYS_MS: readonly number[] = [5 * S, 5 * MIN, 30 * MIN, 2 * H, 5 * H, 10 * H, 14 * H, 20 * H, 24 * H];
/** 1 immediate attempt + 9 retries. */
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const DELIVERY_TIMEOUT_MS = 15 * S;
export const DISABLE_AFTER_FAILING_MS = 3 * 24 * H;
export const DELIVERY_LOG_RETENTION_MS = 30 * 24 * H;
export const SECRET_ROLL_OVERLAP_MS = 24 * H;
export const RETRY_AFTER_CAP_MS = 24 * H;
export const JITTER_RATIO = 0.1;
/** Request and response snippets stored in the delivery log. */
export const SNIPPET_CHARS = 1024;

export type AttemptOutcome = "success" | "gone" | "retry";

/** Classifies one attempt: a status (null = network error/timeout/refused address). */
export function classifyAttempt(status: number | null): AttemptOutcome {
  if (status !== null && status >= 200 && status < 300) return "success";
  if (status === 410) return "gone";
  return "retry";
}

/** Parses `Retry-After` (seconds or an HTTP date) into milliseconds from `now`; null if absent or invalid. */
export function parseRetryAfter(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * S;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/**
 * When to make the next attempt after `attempt` (1-based) failed; null = give up. `random` ∈ [0, 1) gives the jitter
 * (±10 %); `retryAfterMs` from the receiver postpones but never shortens the schedule.
 */
export function nextAttemptDelay(attempt: number, random: number, retryAfterMs: number | null = null): number | null {
  const base = RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return null;
  const jittered = Math.round(base * (1 + JITTER_RATIO * (2 * random - 1)));
  if (retryAfterMs === null) return jittered;
  return Math.max(jittered, Math.min(retryAfterMs, RETRY_AFTER_CAP_MS));
}

/** True when an endpoint failing since `failingSince` must be disabled (3 days of consecutive failures). */
export function shouldDisableForFailures(failingSince: number | undefined, now: number): boolean {
  return failingSince !== undefined && now - failingSince >= DISABLE_AFTER_FAILING_MS;
}

export function snippet(text: string | undefined | null): string | undefined {
  if (!text) return undefined;
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text;
}

/** Standard Webhooks body (05 §5.2). `previous` holds the changed fields (names only where values are personal). */
export interface WebhookBody {
  type: string;
  id: string;
  created_at: string;
  data: { object: Record<string, unknown>; previous?: Record<string, unknown> };
}

export function eventBody(e: {
  type: string;
  eventId: string;
  createdAt: number;
  object: Record<string, unknown>;
  previous?: Record<string, unknown>;
}): WebhookBody {
  return {
    type: e.type,
    id: e.eventId,
    created_at: new Date(e.createdAt).toISOString(),
    data: { object: e.object, ...(e.previous && Object.keys(e.previous).length > 0 ? { previous: e.previous } : {}) },
  };
}
