/**
 * Rate limits per API key (05 §3 „Rate limits", 02 §4.1): token bucket, default 120 requests/min with a burst of 30,
 * configurable per key (`apiKeys.rateLimitPerMinute`). Never per client IP — behind the tailnet edge every request
 * has the proxy's address. REST and MCP share the key's bucket (06 §1).
 */
export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
export const MIN_RATE_LIMIT_PER_MINUTE = 1;
export const MAX_RATE_LIMIT_PER_MINUTE = 6000;
const MINUTE_MS = 60_000;

export interface KeyRateLimitConfig {
  kind: "token bucket";
  rate: number;
  period: number;
  capacity: number;
}

/** Burst = a quarter of the per-minute rate (120 → 30, as 05 §3), at least 1. */
export function keyRateLimit(perMinute: number | undefined): KeyRateLimitConfig {
  const rate = perMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  return { kind: "token bucket", rate, period: MINUTE_MS, capacity: Math.max(1, Math.round(rate / 4)) };
}

export interface RateLimitState {
  ok: boolean;
  /** Bucket size (RateLimit-Limit). */
  limit: number;
  /** Tokens left after this request (RateLimit-Remaining). */
  remaining: number;
  /** Seconds until the bucket is full again / until the next token when limited (RateLimit-Reset, Retry-After). */
  resetSeconds: number;
}

/**
 * RateLimit-* header values (IETF draft „RateLimit header fields", 05 §3). `value` = tokens left after the request,
 * `retryAfterMs` from the limiter when refused.
 */
export function rateLimitState(
  config: KeyRateLimitConfig,
  result: { ok: boolean; retryAfterMs?: number; value: number },
): RateLimitState {
  const remaining = Math.max(0, Math.floor(result.value));
  const msPerToken = config.period / config.rate;
  const resetMs = result.ok ? (config.capacity - remaining) * msPerToken : (result.retryAfterMs ?? msPerToken);
  return { ok: result.ok, limit: config.capacity, remaining, resetSeconds: Math.max(0, Math.ceil(resetMs / 1000)) };
}

export function rateLimitHeaders(s: RateLimitState): Record<string, string> {
  return {
    "RateLimit-Limit": String(s.limit),
    "RateLimit-Remaining": String(s.remaining),
    "RateLimit-Reset": String(s.resetSeconds),
    ...(s.ok ? {} : { "Retry-After": String(Math.max(1, s.resetSeconds)) }),
  };
}
