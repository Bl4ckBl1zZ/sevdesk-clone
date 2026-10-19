import { v } from "convex/values";
import { restoreDrillStatus } from "../src/domain/system/health";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { internal } from "./_generated/api";
import { action, mutation, query, systemAction, systemMutation } from "./functions";
import { clockOffsetMs } from "./lib/clock";
import { env, isTest } from "./lib/env";
import { clockView, recordClockReading } from "./model/clock";
import { getCompanyProfile } from "./model/companyProfile";
import { getIntegration } from "./model/integrations";
import {
  latestRestoreDrills,
  recordRestoreDrill as recordRestoreDrillModel,
  securityInputs as securityInputsModel,
} from "./model/system";

/**
 * System pages (F01 SET-106/130/135, F12 AUD-020). Reads only, except the owner's restore-drill record.
 */

/** AUD-020: Convex-side inputs of /einstellungen/system/sicherheit (owner only, never via REST/MCP). */
export const securityInputs = query({
  permission: "system.security",
  args: {},
  handler: async (ctx) => securityInputsModel(ctx, ctx.now()),
});

/** SET-135: server location, access concept and the restore-drill reminder for /einstellungen/system. */
export const overview = query({
  permission: "settings.read",
  args: {},
  handler: async (ctx) => {
    const profile = await getCompanyProfile(ctx);
    const today = berlinCalendarDate(ctx.now());
    return {
      serverLocation: profile?.serverLocation ?? null,
      accessConcept: profile?.accessConcept
        ? { baseDomain: profile.accessConcept.baseDomain, tailnetName: profile.accessConcept.tailnetName ?? null }
        : null,
      restoreDrill: restoreDrillStatus(profile?.lastRestoreDrillOn, today),
      lastRestoreDrillOn: profile?.lastRestoreDrillOn ?? null,
      drills: (await latestRestoreDrills(ctx, 5)).map((d) => ({
        date: d.date,
        kind: d.kind,
        backupObject: d.backupObject,
        targetEnvironment: d.targetEnvironment,
        integrityOk: d.integrityOk,
        headMatchesCheckpoint: d.headMatchesCheckpoint,
      })),
    };
  },
});

/** SEC-05 / SET-135: the owner records a restore drill (runbook deploy/runbooks/restore.md). */
export const recordRestoreDrill = mutation({
  permission: "settings.ownerOnly",
  args: {
    date: v.string(),
    backupObject: v.string(),
    targetEnvironment: v.string(),
    integrityOk: v.boolean(),
    headMatchesCheckpoint: v.boolean(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => recordRestoreDrillModel(ctx, { ...args, kind: "drill" }),
});

/**
 * SET-106: the auth e-mail card (read-only; configuration lives in the Convex env, 08 §5.2). The API token is never
 * returned — only whether it is configured (SEC-06, T-SET-052).
 */
export const authMailStatus = query({
  permission: "integrations.manage",
  args: {},
  handler: async (ctx) => {
    const integration = await getIntegration(ctx, "cloudflare_email");
    return {
      from: env("AUTH_MAIL_FROM") ?? null,
      accountId: env("CLOUDFLARE_ACCOUNT_ID") ?? null,
      tokenConfigured: env("CLOUDFLARE_EMAIL_API_TOKEN") !== undefined,
      lastTestAt: integration?.lastTestAt ?? null,
      lastTestOk: integration?.lastTestOk ?? null,
      lastTestDetail: integration?.lastTestDetail ?? null,
      purposes: ["sign_in_codes", "invitations", "owner_notifications"] as const,
    };
  },
});

/** SET-047: data of the generated Verfahrensdokumentation chapter „Zugriffskonzept“ (owner). */
export const zugriffskonzeptData = query({
  permission: "members.read",
  args: {},
  handler: async (ctx) => {
    const profile = await getCompanyProfile(ctx);
    const members = (await ctx.db.query("members").collect()).filter((m) => m.disabledAt === undefined);
    const keys = (await ctx.db.query("apiKeys").collect()).filter((k) => k.revokedAt === undefined);
    return {
      today: berlinCalendarDate(ctx.now()),
      accessConcept: profile?.accessConcept
        ? {
            baseDomain: profile.accessConcept.baseDomain,
            network: "tailnet" as const,
            ...(profile.accessConcept.tailnetName ? { tailnetName: profile.accessConcept.tailnetName } : {}),
            confirmedAt: profile.accessConcept.confirmedAt,
          }
        : undefined,
      members: members.map((m) => ({
        email: m.email,
        role: m.role,
        expiresAt: m.expiresAt ?? null,
        totp: m.totpEnabled ?? false,
      })),
      apiKeys: keys.map((k) => ({
        name: k.name,
        scopes: k.scopes,
        kind: k.channel === "mcp" ? ("mcp" as const) : ("api" as const),
      })),
    };
  },
});

/**
 * SET-131: Cloudflare Email API token check without sending (token verify endpoint). The token stays in the Convex
 * env; only the outcome is returned.
 */
export const verifyEmailToken = action({
  permission: "integrations.manage",
  args: {},
  handler: async (): Promise<{
    id: string;
    label: string;
    status: "ok" | "warning" | "error";
    detail: string;
    latencyMs?: number;
  }> => {
    const label = "Cloudflare Email API";
    const accountId = env("CLOUDFLARE_ACCOUNT_ID");
    const token = env("CLOUDFLARE_EMAIL_API_TOKEN");
    if (!accountId || !token) {
      return {
        id: "cloudflare",
        label,
        status: "error",
        detail: "E-Mail-Versand ist nicht eingerichtet (Cloudflare-Zugang fehlt).",
      };
    }
    const start = Date.now();
    try {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/tokens/verify`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      const latencyMs = Date.now() - start;
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { status?: string } };
      if (res.ok && body.success && body.result?.status === "active") {
        return { id: "cloudflare", label, status: "ok", detail: "Token gültig und aktiv.", latencyMs };
      }
      return {
        id: "cloudflare",
        label,
        status: "error",
        detail: "Cloudflare lehnt den API-Token ab (Berechtigung „Email Sending“ prüfen).",
        latencyMs,
      };
    } catch {
      return {
        id: "cloudflare",
        label,
        status: "error",
        detail: "Cloudflare ist nicht erreichbar. Ausgehende Verbindung des Servers prüfen.",
      };
    }
  },
});

// ── AUD-019 clock monitoring ─────────────────────────────────────────────────────────────────────────

export const recordClock = systemMutation({
  job: "cron.system.clock",
  args: { offsetMs: v.union(v.number(), v.null()), reference: v.string() },
  handler: async (ctx, args) => recordClockReading(ctx, args),
});

/** Every 10 minutes: Convex runtime clock vs. CLOCK_REFERENCE_URL (HTTP Date); skipped when not configured. */
export const clockCron = systemAction({
  job: "cron.system.clock",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }): Promise<string | null> => {
    if (isTest() && !force) return null;
    const reference = env("CLOCK_REFERENCE_URL");
    if (!reference) return null;
    return ctx.runMutation(internal.system.recordClock, { offsetMs: await clockOffsetMs(), reference });
  },
});

/** SET-132 / GOBD-22: the latest clock reading for the integrity panel and the banner. */
export const clock = query({
  permission: "integrity.read",
  args: {},
  handler: async (ctx) => clockView(ctx),
});
