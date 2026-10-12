import { afterEach, describe, expect, test } from "vitest";
import { zugriffskonzept, zugriffskonzeptMarkdown } from "../src/domain/docs/zugriffskonzept";
import { evaluateSecurity } from "../src/domain/system/security";
import { api } from "./_generated/api";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT } from "./test.setup";

const DAY = 86_400_000;
afterEach(() => {
  delete process.env.CLOUDFLARE_EMAIL_API_TOKEN;
  delete process.env.AUTH_MAIL_FROM;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
});

describe("AUD-020 security status inputs", () => {
  test("AUD-020 SEC-01 counts expired members that still hold sessions and stale invites; owner only", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    // An auditor whose access ended yesterday but whose session was never revoked (cron not yet run).
    await t.seedUser("auditor", { expiresAt: Date.now() - DAY, auditor: { purpose: "Az 1", fiscalYears: [2025] } });
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedInsert(
        ctx,
        "invites",
        {
          email: "alt@example.test",
          role: "viewer",
          expiresAt: Date.now() - DAY,
          createdBy: owner.actor,
          createdAt: Date.now() - 8 * DAY,
        },
        { action: "invite.create", label: "alt@example.test" },
      ),
    );
    const inputs = await owner.query(api.system.securityInputs, {});
    expect(inputs).toMatchObject({
      expiredMembersWithSessions: 1,
      staleInvites: 1,
      ownerPasskeys: 0,
      auth: { cookieCache: false, ipRateLimit: false, otpThrottle: true },
      authMail: { transport: "memory", isTest: true },
      convexEnv: { BETTER_AUTH_SECRET: true, JWKS: true, OWNER_EMAIL: true, CHECKPOINT_SIGNING_KEY_PEM: true },
    });
    const viewer = await t.asUser("viewer");
    expect(await viewer.query(api.system.securityInputs, {}).catch(errorCode)).toBe("forbidden_role");
  });

  test("AUD-020 GOBD-09 the evaluated page flags the expired session and the missing passkey", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await t.seedUser("viewer", { expiresAt: Date.now() - DAY });
    const i = await owner.query(api.system.securityInputs, {});
    const checks = evaluateSecurity(
      {
        ...i,
        sessionValid: true,
        webEnv: { JWT_PRIVATE_KEY_PEM: true, APP_ENCRYPTION_KEY: true },
        pins: { betterAuth: "1.6.33", convexImage: i.convexImage },
      },
      Date.now(),
    );
    expect(checks.find((c) => c.id === "expired-sessions")?.status).toBe("error");
    expect(checks.find((c) => c.id === "passkey")?.status).toBe("error");
    expect(checks.find((c) => c.id === "auth-config")?.status).toBe("ok");
  });
});

describe("SET-135 SEC-05 restore drills", () => {
  test("SET-135 SEC-05 AUD-027 recording a drill is logged append-only and resets the 31-day reminder", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect((await owner.query(api.system.overview, {})).restoreDrill).toMatchObject({ due: true });
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Berlin" }).format(Date.now());
    await owner.mutation(api.system.recordRestoreDrill, {
      date: today,
      backupObject: "postgres/2026-10-11.dump.zst",
      targetEnvironment: "Testinstanz lokal",
      integrityOk: true,
      headMatchesCheckpoint: true,
    });
    const overview = await owner.query(api.system.overview, {});
    expect(overview.restoreDrill.due).toBe(false);
    expect(overview.drills).toEqual([
      expect.objectContaining({ date: today, kind: "drill", integrityOk: true, headMatchesCheckpoint: true }),
    ]);
    const entry = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_seq")
        .order("desc")
        .filter((q) => q.eq(q.field("action"), "system.restore_drill"))
        .first(),
    );
    expect(entry?.entity.table).toBe("restoreDrills");
    expect(
      await owner
        .mutation(api.system.recordRestoreDrill, {
          date: "2999-01-01",
          backupObject: "x",
          targetEnvironment: "y",
          integrityOk: true,
          headMatchesCheckpoint: true,
        })
        .catch(errorCode),
    ).toBe("invalid_input");
  });
});

describe("SET-106 auth e-mail card", () => {
  test("SET-106 T-SET-052 SEC-06 sender and account are shown, the token only as „configured“", async () => {
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = "cf-secret-token-123";
    process.env.AUTH_MAIL_FROM = "Rechnungen <noreply@mail.example.de>";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc123";
    const t = makeT();
    const owner = await t.asUser("owner");
    const status = await owner.query(api.system.authMailStatus, {});
    expect(status).toMatchObject({
      from: "Rechnungen <noreply@mail.example.de>",
      accountId: "acc123",
      tokenConfigured: true,
      purposes: ["sign_in_codes", "invitations", "owner_notifications"],
    });
    expect(JSON.stringify(status)).not.toContain("cf-secret-token-123");
  });
});

describe("SET-047 Zugriffskonzept", () => {
  test("SET-047 T-SET-025 the chapter is generated from the recorded access concept and the members", async () => {
    const t = makeT();
    const owner = await t.asUser("owner", { email: "inhaber@firma.de" });
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        {
          accessConcept: {
            baseDomain: "buero.example.de",
            network: "tailnet",
            tailnetName: "firma.ts.net",
            confirmedAt: Date.now(),
          },
        },
        { action: "settings.access.update" },
      ),
    );
    const data = await owner.query(api.system.zugriffskonzeptData, {});
    const md = zugriffskonzeptMarkdown(zugriffskonzept(data));
    expect(md).toContain("app.buero.example.de");
    expect(md).toContain("| inhaber@firma.de | Inhaber | unbefristet |");
  });
});

describe("SET-131 Cloudflare token check", () => {
  test("SET-131 verifies the token without sending; a rejected token is an error; the token never leaves Convex", async () => {
    process.env.CLOUDFLARE_EMAIL_API_TOKEN = "cf-secret-token-123";
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc123";
    const calls: { url: string; auth: string | null }[] = [];
    const { vi } = await import("vitest");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        return Response.json({ success: true, result: { status: "active" } });
      }),
    );
    const t = makeT();
    const owner = await t.asUser("owner");
    const ok = await owner.action(api.system.verifyEmailToken, {});
    expect(ok).toMatchObject({ status: "ok", detail: "Token gültig und aktiv." });
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/tokens/verify");
    expect(JSON.stringify(ok)).not.toContain("cf-secret-token-123");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false }, { status: 401 })),
    );
    expect((await owner.action(api.system.verifyEmailToken, {})).status).toBe("error");
    vi.unstubAllGlobals();
  });
});
