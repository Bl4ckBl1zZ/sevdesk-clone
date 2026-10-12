import { currentEuEeaCountries } from "../../src/domain/rules/eu-eea";
import { CONVEX_SECRET_ENV } from "../../src/domain/system/security";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { AUTH_HARDENING } from "../lib/authHardening";
import { configuredTransport } from "../lib/authMail";
import { env, isTest } from "../lib/env";
import { appError } from "../lib/errors";
import { RATE_LIMIT_CONFIG } from "../lib/rateLimits";
import { auditedInsert } from "./audit";
import { getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import { latestCheckpoint, latestRun } from "./integrity";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * System and security status (F01 SET-130/135, F12 AUD-020). Convex-side inputs of the security page — the web
 * server adds its own env, pins and clock; live DNS/TLS probes run in `settings.runAccessChecks`.
 */

async function sessionsOf(ctx: ReadCtx, authUserId: string): Promise<number> {
  const res = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "session",
    where: [{ field: "userId", value: authUserId }],
    paginationOpts: { numItems: 1, cursor: null },
  })) as { page: unknown[] };
  return res.page.length;
}

async function passkeysOf(ctx: ReadCtx, authUserId: string): Promise<number> {
  const res = (await ctx.runQuery(components.betterAuth.adapter.findMany, {
    model: "passkey",
    where: [{ field: "userId", value: authUserId }],
    paginationOpts: { numItems: 20, cursor: null },
  })) as { page: unknown[] };
  return res.page.length;
}

export async function securityInputs(ctx: ReadCtx, now: number) {
  const members = await ctx.db.query("members").collect();
  const owner = members.find((m) => m.role === "owner");
  let expiredMembersWithSessions = 0;
  for (const m of members) {
    const expired = m.disabledAt !== undefined || (m.expiresAt !== undefined && m.expiresAt <= now);
    if (expired && (await sessionsOf(ctx, m.authUserId)) > 0) expiredMembersWithSessions += 1;
  }
  const staleInvites = (await ctx.db.query("invites").collect()).filter(
    (i) => i.acceptedAt === undefined && i.revokedAt === undefined && i.expiresAt < now,
  ).length;
  const profile = await getCompanyProfile(ctx);
  const run = await latestRun(ctx);
  const checkpoint = await latestCheckpoint(ctx);
  const integrations = await ctx.db.query("integrations").collect();
  const eu = currentEuEeaCountries();
  const location = profile?.serverLocation;
  return {
    today: berlinCalendarDate(now),
    ownerPasskeys: owner ? await passkeysOf(ctx, owner.authUserId) : 0,
    convexEnv: Object.fromEntries(CONVEX_SECRET_ENV.map((n) => [n, env(n) !== undefined])) as Record<
      (typeof CONVEX_SECRET_ENV)[number],
      boolean
    >,
    secretsRotatedOn: env("SECRETS_ROTATED_ON"),
    auth: { ...AUTH_HARDENING, otpThrottle: AUTH_HARDENING.otpThrottle && "otpPerHour" in RATE_LIMIT_CONFIG },
    authMail: { transport: configuredTransport(), isTest: isTest() },
    accessConcept: profile?.accessConcept
      ? { baseDomain: profile.accessConcept.baseDomain, confirmedAt: profile.accessConcept.confirmedAt }
      : undefined,
    expiredMembersWithSessions,
    staleInvites,
    integrity: run ? { lastRunAt: run.at, lastRunOk: run.ok || run.acknowledgedAt !== undefined } : {},
    checkpoint: checkpoint
      ? {
          ...(checkpoint.uploadStatus === "uploaded" ? { lastUploadedAt: checkpoint.at } : {}),
          lastStatus: checkpoint.uploadStatus,
        }
      : {},
    serverLocation: location
      ? { countryCode: location.countryCode, isEu: eu.includes(location.countryCode) }
      : undefined,
    integrationsWithoutAvv: integrations
      .filter(
        (i) =>
          i.enabled && i.region !== undefined && !eu.includes(i.region.toUpperCase()) && i.dpaConfirmedAt === undefined,
      )
      .map((i) => i.kind),
    convexImage: env("CONVEX_SHA"),
  };
}

export interface RestoreDrillInput {
  date: string;
  backupObject: string;
  targetEnvironment: string;
  integrityOk: boolean;
  headMatchesCheckpoint: boolean;
  notes?: string | undefined;
  kind: "drill" | "production_restore";
}

/** SEC-05 / AUD-027: restores are logged (append-only); the profile mirrors the latest drill date (SET-135). */
export async function recordRestoreDrill(ctx: ModelCtx, input: RestoreDrillInput): Promise<void> {
  const today = berlinCalendarDate(ctx.now());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || input.date > today) {
    throw appError("invalid_input", "Bitte ein Datum bis heute angeben.", { reason: "DATE_INVALID" });
  }
  if (!input.backupObject.trim() || !input.targetEnvironment.trim()) {
    throw appError("invalid_input", "Bitte Sicherung und Zielumgebung angeben.", {
      reason: "RESTORE_DRILL_INCOMPLETE",
    });
  }
  await auditedInsert(
    ctx,
    "restoreDrills",
    {
      date: input.date,
      backupObject: input.backupObject.trim(),
      targetEnvironment: input.targetEnvironment.trim(),
      integrityOk: input.integrityOk,
      headMatchesCheckpoint: input.headMatchesCheckpoint,
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
      kind: input.kind,
      actor: ctx.actor,
      at: ctx.now(),
    },
    { action: input.kind === "drill" ? "system.restore_drill" : "system.restore", label: input.date },
  );
  const profile = await getCompanyProfile(ctx);
  if (input.kind === "drill" && (profile?.lastRestoreDrillOn ?? "") < input.date) {
    await patchCompanyProfile(ctx, { lastRestoreDrillOn: input.date }, { action: "settings.restore_drill.update" });
  }
}

export async function latestRestoreDrills(ctx: ReadCtx, n: number): Promise<Doc<"restoreDrills">[]> {
  return ctx.db.query("restoreDrills").withIndex("by_date").order("desc").take(n);
}
