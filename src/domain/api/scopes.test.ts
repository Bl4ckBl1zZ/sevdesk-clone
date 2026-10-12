import { describe, expect, test } from "vitest";
import { apiKeyCreateSchema, validateExpiry } from "../schemas/api-keys";
import { SCOPES } from "../schemas/scopes";
import { calendarDate } from "../time/calendar-date";
import { keyRateLimit, rateLimitHeaders, rateLimitState } from "./rate-limit";
import {
  GRANTABLE_SCOPES,
  matchingPreset,
  presetScopes,
  SCOPE_GROUPS,
  SCOPE_LABELS,
  SCOPE_PRESET_KEYS,
} from "./scopes";

describe("scopes and presets (05 §2.2)", () => {
  test("API-002 the reserved portal:manage scope is never grantable", () => {
    expect(GRANTABLE_SCOPES).not.toContain("portal:manage");
    expect(GRANTABLE_SCOPES.length).toBe(SCOPES.length - 1);
  });

  test("API-002 Website preset = contacts r/w, products r, documents r/w, payments r", () => {
    expect(presetScopes("website")).toEqual(
      ["contacts:read", "contacts:write", "documents:read", "documents:write", "payments:read", "products:read"].sort(),
    );
  });

  test("API-002 Claude safe = all :read + contacts/products/documents/vouchers write; no legal-act scopes", () => {
    const safe = presetScopes("claude_safe");
    for (const s of GRANTABLE_SCOPES.filter((x) => x.endsWith(":read"))) expect(safe).toContain(s);
    for (const s of ["contacts:write", "products:write", "documents:write", "vouchers:write"])
      expect(safe).toContain(s);
    for (const s of ["invoices:finalize", "invoices:send", "invoices:cancel", "payments:write", "dunning:write"])
      expect(safe).not.toContain(s);
  });

  test("API-002 Claude full = safe + finalize/send/cancel/payments:write/dunning:write, never dunning:manage", () => {
    const full = presetScopes("claude_full");
    expect(full).toEqual(
      [
        ...new Set([
          ...presetScopes("claude_safe"),
          "invoices:finalize",
          "invoices:send",
          "invoices:cancel",
          "payments:write",
          "dunning:write",
        ]),
      ].sort(),
    );
    expect(full).not.toContain("dunning:manage");
  });

  test("API-002 Read-only = all :read and nothing else", () => {
    expect(presetScopes("read_only").every((s) => s.endsWith(":read"))).toBe(true);
  });

  test("API-002 matchingPreset recognises an exact preset only", () => {
    for (const p of SCOPE_PRESET_KEYS) expect(matchingPreset([...presetScopes(p)].reverse())).toBe(p);
    expect(matchingPreset(["contacts:read"])).toBeNull();
  });

  test("API-002 every grantable scope is in exactly one checkbox group and has a German label", () => {
    const grouped = SCOPE_GROUPS.flatMap((g) => g.scopes);
    expect([...grouped].sort()).toEqual([...GRANTABLE_SCOPES].sort());
    for (const s of SCOPES) expect(SCOPE_LABELS[s]).toBeTruthy();
  });
});

describe("key creation input (05 §2.1)", () => {
  const base = { name: "Website", channel: "api", scopes: ["contacts:read"], expiresOn: "", rateLimitPerMinute: "" };

  test("API-002 valid input is normalised (scopes deduplicated and sorted)", () => {
    const r = apiKeyCreateSchema.parse({ ...base, scopes: ["products:read", "contacts:read", "products:read"] });
    expect(r.scopes).toEqual(["contacts:read", "products:read"]);
  });

  test("API-002 empty name, no scopes, reserved or unknown scopes, bad rate limit are refused", () => {
    expect(apiKeyCreateSchema.safeParse({ ...base, name: " " }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: [] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["portal:manage"] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, scopes: ["members:manage"] }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, rateLimitPerMinute: "0" }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, rateLimitPerMinute: "abc" }).success).toBe(false);
    expect(apiKeyCreateSchema.safeParse({ ...base, rateLimitPerMinute: "600" }).success).toBe(true);
    expect(apiKeyCreateSchema.safeParse({ ...base, expiresOn: "2026-02-30" }).success).toBe(false);
  });

  test("API-002 the expiry must be after today (Berlin)", () => {
    const today = calendarDate("2026-10-13");
    expect(validateExpiry("", today)).toBeNull();
    expect(validateExpiry("2026-10-14", today)).toBeNull();
    expect(validateExpiry("2026-10-13", today)).toMatch(/Zukunft/);
  });
});

describe("rate limit per key (05 §3)", () => {
  test("API-007 default 120/min with burst 30; custom rates get a quarter as burst", () => {
    expect(keyRateLimit(undefined)).toEqual({ kind: "token bucket", rate: 120, period: 60_000, capacity: 30 });
    expect(keyRateLimit(10).capacity).toBe(3);
    expect(keyRateLimit(1).capacity).toBe(1);
  });

  test("API-007 RateLimit-* headers; Retry-After only when refused", () => {
    const cfg = keyRateLimit(undefined);
    const ok = rateLimitState(cfg, { ok: true, value: 29 });
    expect(rateLimitHeaders(ok)).toEqual({
      "RateLimit-Limit": "30",
      "RateLimit-Remaining": "29",
      "RateLimit-Reset": "1",
    });
    const refused = rateLimitState(cfg, { ok: false, value: 0, retryAfterMs: 1500 });
    expect(rateLimitHeaders(refused)).toEqual({
      "RateLimit-Limit": "30",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "2",
      "Retry-After": "2",
    });
  });
});
