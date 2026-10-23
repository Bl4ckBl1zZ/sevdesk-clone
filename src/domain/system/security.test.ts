import { describe, expect, test } from "vitest";
import {
  apiExposureChecks,
  certificateCheck,
  evaluateSecurity,
  type SecurityInput,
  startupSecretProblems,
} from "./security";

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
  authMail: { transport: "cloudflare", isTest: false },
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
      "debug-logs",
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
      detail: "Die Anmelde-Schlüssel sind älter als 12 Monate. Bitte erneuern (alle Sitzungen werden beendet).",
    });
  });

  test("E-AUD-23 BETTER_AUTH_SECRET/JWKS older than 12 months warn; exactly 12 months is still fine", () => {
    const at = (d: string) =>
      evaluateSecurity({ ...GOOD, secretsRotatedOn: d }, NOW).find((c) => c.id === "secret-age");
    expect(at("2025-10-12")).toMatchObject({ status: "ok", detail: "Zuletzt rotiert vor 365 Tagen." });
    expect(at("2025-10-11")).toMatchObject({
      status: "warning",
      detail: "Die Anmelde-Schlüssel sind älter als 12 Monate. Bitte erneuern (alle Sitzungen werden beendet).",
      remedy: "Geheimnisse jährlich rotieren (Runbook „Schlüssel rotieren“).",
    });
  });

  test("E-AUD-20 production start without a required web secret is refused with the SEC-01 log line", () => {
    expect(startupSecretProblems({ JWT_PRIVATE_KEY_PEM: "pem", APP_ENCRYPTION_KEY: "key" })).toEqual([]);
    expect(startupSecretProblems({ JWT_PRIVATE_KEY_PEM: " ", APP_ENCRYPTION_KEY: undefined })).toEqual([
      "JWT_PRIVATE_KEY_PEM fehlt – Start im Produktivmodus verweigert (SEC-01).",
      "APP_ENCRYPTION_KEY fehlt – Start im Produktivmodus verweigert (SEC-01).",
    ]);
  });

  test("E-AUD-22 api. serving an admin path or port 8443 serving more than /api/v1 is a critical finding", () => {
    expect(apiExposureChecks({ apiHost: "api.buero.example.de", adminStatus: 404, port8443AdminStatus: 404 })).toEqual([
      {
        id: "api-ui",
        label: "api.buero.example.de liefert keine Seiten der Oberfläche",
        status: "ok",
        detail: "HTTPS 404",
      },
    ]);
    const open = apiExposureChecks({ apiHost: "api.buero.example.de", adminStatus: 200, port8443AdminStatus: 404 });
    expect(open).toEqual([
      {
        id: "api-ui",
        label: "api.buero.example.de liefert keine Seiten der Oberfläche",
        status: "error",
        detail: "Admin-Seiten sind über api.buero.example.de erreichbar. Sofort Proxy-Konfiguration prüfen.",
        remedy: "Caddy-Konfiguration des api.-Hosts prüfen: nur /api/v1, /api/mcp, Dokumentation und Health (08 §4).",
      },
    ]);
    expect(apiExposureChecks({ apiHost: "api.x.de", adminStatus: 404, port8443AdminStatus: 302 })[0]).toMatchObject({
      status: "error",
      detail: "Admin-Seiten sind über api.x.de:8443 erreichbar. Sofort Proxy-Konfiguration prüfen.",
    });
    // unreachable is not a finding of this check (the host check reports it)
    expect(apiExposureChecks({ apiHost: "api.x.de", adminStatus: null })).toEqual([]);
  });

  test("E-AUD-30b the wildcard certificate expiring in < 14 days is an error with the expiry date", () => {
    const day = 86_400_000;
    expect(certificateCheck({ baseDomain: "buero.example.de", validTo: NOW + 30 * day }, NOW)).toMatchObject({
      id: "certificate",
      status: "ok",
    });
    expect(certificateCheck({ baseDomain: "buero.example.de", validTo: NOW + 13 * day }, NOW)).toEqual({
      id: "certificate",
      label: "Zertifikat *.buero.example.de",
      status: "error",
      detail: "Das Zertifikat für *.buero.example.de läuft am 25.10.2026 ab.",
      remedy: "Caddy-Zertifikatserneuerung (DNS-01) prüfen; Runbook „Zertifikat“.",
    });
    expect(certificateCheck({ baseDomain: "x.de", validTo: null }, NOW)).toMatchObject({ status: "unknown" });
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

  test("DSGVO-05 a dev auth-mail transport in production is flagged: no sign-in codes or addresses in debug logs", () => {
    const checks = evaluateSecurity({ ...GOOD, authMail: { transport: "console", isTest: false } }, NOW);
    const c = checks.find((x) => x.id === "debug-logs");
    expect(c).toMatchObject({ status: "error", remedy: expect.stringContaining("AUTH_MAIL_SENDER") });
    expect(
      statusOf(evaluateSecurity({ ...GOOD, authMail: { transport: "memory", isTest: true } }, NOW), "debug-logs"),
    ).toBe("ok");
  });
});
