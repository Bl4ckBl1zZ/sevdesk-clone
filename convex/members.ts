import { v } from "convex/values";
import { memberAccess } from "../src/domain/access/signup";
import { mutation, query, systemMutation } from "./functions";
import { isTest } from "./lib/env";
import { disableMember, expireMembers, getMemberByAuthUserId, memberAuthFacts } from "./model/members";

/**
 * Members (02 §4.3). Public functions for the UI; members are created only by the sign-up trigger.
 */

/** The signed-in member (any role): role, expiry, TOTP mirror — drives navigation and banners. */
export const me = query({
  permission: "session.self",
  args: {},
  handler: async (ctx) => {
    if (ctx.actorContext.actor.startsWith("user:") === false) return null;
    const member = await getMemberByAuthUserId(ctx, ctx.actor.slice("user:".length));
    if (!member) return null;
    return {
      actor: ctx.actor,
      memberId: member._id,
      email: member.email,
      name: member.name ?? null,
      role: member.role,
      expiresAt: member.expiresAt ?? null,
      totpEnabled: member.totpEnabled,
      auditor: member.auditor
        ? {
            organisation: member.auditor.organisation ?? null,
            purpose: member.auditor.purpose,
            fiscalYears: member.auditor.fiscalYears,
          }
        : null,
    };
  },
});

/** Owner: member list (04 §4.10). */
export const list = query({
  permission: "members.read",
  args: {},
  handler: async (ctx) => {
    const now = ctx.now();
    const members = await ctx.db.query("members").collect();
    const facts = await Promise.all(members.map((m) => memberAuthFacts(ctx, m.authUserId)));
    return members.map((m, i) => ({
      memberId: m._id,
      hasPasskey: (facts[i]?.passkeys ?? 0) > 0,
      lastSignInAt: facts[i]?.lastSignInAt ?? null,
      email: m.email,
      name: m.name ?? null,
      role: m.role,
      createdAt: m.createdAt,
      expiresAt: m.expiresAt ?? null,
      disabledAt: m.disabledAt ?? null,
      access: memberAccess(m, now),
      totpEnabled: m.totpEnabled,
    }));
  },
});

/** Owner: deactivate a member immediately; all sessions are revoked (02 §4.3, E-AUD-31). */
export const disable = mutation({
  permission: "members.manage",
  args: { memberId: v.id("members"), reason: v.string() },
  handler: async (ctx, { memberId, reason }) => disableMember(ctx, memberId, reason.trim() || "deaktiviert"),
});

/** `members.expire` (02 §7, hourly): expired members lose access and their sessions. */
export const expireCron = systemMutation({
  job: "cron.members.expire",
  args: { force: v.optional(v.boolean()) },
  handler: async (ctx, { force }) => {
    if (isTest() && !force) return 0;
    return expireMembers(ctx);
  },
});
