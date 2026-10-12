import { HOUR, RateLimiter } from "@convex-dev/rate-limiter";
import { components } from "../_generated/api";

/**
 * Rate limits (02 §2): per e-mail address for OTP sends (02 §4.2: 5/hour, 20/day; E-AUD-27) and, later, per API
 * key. Never per client IP — behind the fork's socat proxies every request has the same source address.
 */
export const RATE_LIMIT_CONFIG = {
  otpPerHour: { kind: "fixed window", rate: 5, period: HOUR },
  otpPerDay: { kind: "fixed window", rate: 20, period: 24 * HOUR },
} as const;

export const rateLimiter = new RateLimiter(components.rateLimiter, RATE_LIMIT_CONFIG);

export function otpThrottleMessage(retryAfterMs: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterMs / 60_000));
  return `Zu viele Codes angefordert — bitte in ${minutes} Minuten erneut versuchen.`;
}
