/**
 * Better Auth hardening switches (02 §4.2, research 14 §2.2) — one source for convex/auth.ts and the security status
 * page (F12 AUD-020): the cookie cache stays off (#434: it mints JWTs for deleted sessions), Better Auth's IP rate
 * limit stays off (meaningless behind the proxy, #432); OTP sends are throttled per address (convex/lib/rateLimits).
 */
export const AUTH_HARDENING = { cookieCache: false, ipRateLimit: false, otpThrottle: true } as const;
