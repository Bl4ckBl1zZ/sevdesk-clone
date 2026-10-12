import { v } from "convex/values";
import { internal } from "./_generated/api";
import { mutation, query } from "./functions";
import { createInvite, revokeInvite } from "./model/members";
import { vAuditorScope, vInviteRole } from "./validators";

/**
 * Invites (02 §4.3): owner only, never via API (05 §2.2). The invite mail is sent by a scheduled action
 * (Cloudflare Email Sending); the outcome is stored on the invite (`sentAt`, `mailOutcome`).
 */
export const list = query({
  permission: "members.read",
  args: {},
  handler: async (ctx) => {
    const now = ctx.now();
    return (await ctx.db.query("invites").order("desc").take(200)).map((i) => ({
      inviteId: i._id,
      email: i.email,
      role: i.role,
      createdAt: i.createdAt,
      expiresAt: i.expiresAt,
      memberExpiresAt: i.memberExpiresAt ?? null,
      auditor: i.auditor ?? null,
      sentAt: i.sentAt ?? null,
      mailOutcome: i.mailOutcome ?? null,
      status: i.acceptedAt
        ? ("accepted" as const)
        : i.revokedAt
          ? ("revoked" as const)
          : i.expiresAt <= now
            ? ("expired" as const)
            : ("open" as const),
    }));
  },
});

export const create = mutation({
  permission: "invites.manage",
  args: {
    email: v.string(),
    role: vInviteRole,
    memberExpiresAt: v.optional(v.number()),
    auditor: v.optional(vAuditorScope),
  },
  handler: async (ctx, args) => {
    const inviteId = await createInvite(ctx, args);
    await ctx.scheduler.runAfter(0, internal.authMail.sendInvite, { inviteId });
    return inviteId;
  },
});

export const resend = mutation({
  permission: "invites.manage",
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    await ctx.scheduler.runAfter(0, internal.authMail.sendInvite, { inviteId });
  },
});

export const revoke = mutation({
  permission: "invites.manage",
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => revokeInvite(ctx, inviteId),
});
