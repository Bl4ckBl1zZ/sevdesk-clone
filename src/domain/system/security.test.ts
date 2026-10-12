import { describe, expect, test } from "vitest";
import { evaluateSecurity, type SecurityInput } from "./security";

const NOW = Date.UTC(2026, 9, 12, 10);
const GOOD: SecurityInput = {
  today: "2026-10-12",
  sessionValid: true,
  ownerPasskeys: 1,
  convexEnv: {
    BETTER_AUTH_SECRET: true,
    JWKS: true,
    OWNER_EMAIL: true,
    SERVER_JWKS: true,
    CHECKPOINT_SIGNING_KEY_PEM: true,
  },
  webEnv: { JWT_PRIVATE_KEY_PEM: true, APP_ENCRYPTION_KEY: true },
  secretsRotatedOn: "2026-03-01",
  auth: { cookieCache: false, ipRateLimit: false, otpThrottle: true },
  accessConcept: { baseDomain: "buero.example.de", confirmedAt: NOW },
  expiredMembersWithSessions: 0,
  staleInvites: 0,
  integrity: { lastRunAt: NOW - 3_600_000, lastRunOk: true },
  checkpoint: { lastUploadedAt: NOW - 3_600_000 },
  serverLocation: { countryCode: "DE", isEu: true },
  integrationsWithoutAvv: [],
  pins: { betterAuth: "1.6.33", convexImage: "72ce13c379fe6dbdfc305bc8ad699c5663c68c2a" },
  clock: { status: "ok", detail: "Abweichung 0,1 s." },
  probes: [{ id: "api-ui", label: "api. liefert keine Seiten", status: "ok" }],
};
const statusOf = (checks: ReturnType<typeof evaluateSecurity>, id: string) => checks.find((c) => c.id === id)?.status;

describe("AUD-020 GOBD-09 security status page", () => {
  test("AUD-020 GOBD-09 a correctly set up instance is green: passkey login, tailnet access concept, roles, integrity, backups", () => {
    const checks = evaluateSecurity(GOOD, NOW);
    expect(checks.filter((c) => c.status !== "ok")).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual([
      "session",
      "passkey",
      "convex-env",
      "web-env",
      "secret-age",
      "auth-config",
      "access-concept",
      "expired-sessions",
      "stale-invites",
      "integrity",
      "checkpoint",
      "location",
      "dpa",
      "pin-better-auth",
      "pin-convex",
      "clock",
      "api-ui",
    ]);
  });

  test("AUD-020 SEC-06 missing secrets, no passkey and a cookie cache are errors with remedies", () => {
    const checks = evaluateSecurity(
      {
        ...GOOD,
        ownerPasskeys: 0,
        convexEnv: { ...GOOD.convexEnv, JWKS: false },
        webEnv: { ...GOOD.webEnv, APP_ENCRYPTION_KEY: false },
        auth: { cookieCache: true, ipRateLimit: false, otpThrottle: true },
      },
      NOW,
    );
    expect(checks.find((c) => c.id === "convex-env")).toMatchObject({ status: "error", detail: "Fehlt: JWKS" });
    expect(checks.find((c) => c.id === "web-env")).toMatchObject({
      status: "error",
      detail: "Fehlt: APP_ENCRYPTION_KEY",
    });
    expect(statusOf(checks, "passkey")).toBe("error");
    expect(checks.find((c) => c.id === "auth-config")).toMatchObject({
      status: "error",
      detail: "Cookie-Cache ist eingeschaltet",
    });
    for (const c of checks.filter((x) => x.status === "error")) expect(c.remedy, c.id).toBeTruthy();
  });

  test("AUD-020 SEC-01 expired members holding sessions must be 0; stale invites warn; yearly secret rotation", () => {
    const checks = evaluateSecurity(
      { ...GOOD, expiredMembersWithSessions: 1, staleInvites: 2, secretsRotatedOn: "2025-09-01" },
      NOW,
    );
    expect(statusOf(checks, "expired-sessions")).toBe("error");
    expect(statusOf(checks, "stale-invites")).toBe("warning");
    expect(checks.find((c) => c.id === "secret-age")).toMatchObject({
      status: "warning",
      detail: "Zuletzt rotiert vor 406 Tagen.",
    });
  });

  test("AUD-020 AO-06 DSGVO-04 non-EU location and services without AVV are errors; pins are checked", () => {
    const checks = evaluateSecurity(
      {
        ...GOOD,
        serverLocation: { countryCode: "US", isEu: false },
        integrationsWithoutAvv: ["claude"],
        pins: { betterAuth: "^1.6.0" },
        integrity: { lastRunAt: NOW, lastRunOk: false },
        checkpoint: { lastUploadedAt: NOW - 5 * 86_400_000 },
        probes: [],
      },
      NOW,
    );
    expect(statusOf(checks, "location")).toBe("error");
    expect(checks.find((c) => c.id === "dpa")).toMatchObject({
      status: "error",
      detail: "Ohne AVV oder außerhalb der EU: claude",
    });
    expect(statusOf(checks, "pin-better-auth")).toBe("error");
    expect(statusOf(checks, "pin-convex")).toBe("unknown");
    expect(statusOf(checks, "integrity")).toBe("error");
    expect(statusOf(checks, "checkpoint")).toBe("warning");
    expect(checks.at(-1)).toMatchObject({ id: "probes", status: "unknown" });
  });
});
