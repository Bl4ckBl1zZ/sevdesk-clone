import { v } from "convex/values";
import { inviteMail, testMail } from "../src/emails/auth-mails";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import { action, actorMutation, systemAction, systemMutation, systemQuery } from "./functions";
import { configuredTransport, senderFromEnv } from "./lib/authMail";
import { appName, siteUrl } from "./lib/env";
import { appError } from "./lib/errors";
import { recordIntegrationTest } from "./model/integrations";
import { recordInviteMail } from "./model/members";

/**
 * Auth mail actions (02 §9, F01 §3.10/§4.6). Sign-in codes are sent directly from the Better Auth callback
 * (convex/auth.ts); invitations and the owner's test mail go through here.
 */

function senderFor(ctx: Pick<ActionCtx, "runMutation">) {
  return senderFromEnv(async (mail) => {
    await ctx.runMutation(internal.signup.storeDevMail, {
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      kind: mail.kind,
    });
  });
}

export const companyName = systemQuery({
  job: "auth",
  args: {},
  handler: async (ctx): Promise<string> => (await ctx.db.query("companyProfile").first())?.name ?? appName(),
});

export const inviteForMail = systemQuery({
  job: "auth",
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const invite = await ctx.db.get(inviteId);
    const company = await ctx.db.query("companyProfile").first();
    return invite ? { invite, companyName: company?.name ?? appName() } : null;
  },
});

export const recordInviteOutcome = systemMutation({
  job: "auth",
  args: { inviteId: v.id("invites"), ok: v.boolean() },
  handler: async (ctx, { inviteId, ok }) => recordInviteMail(ctx, inviteId, ok),
});

/** Scheduled by invites.create / invites.resend. */
export const sendInvite = systemAction({
  job: "auth",
  args: { inviteId: v.id("invites") },
  handler: async (ctx, { inviteId }) => {
    const data = await ctx.runQuery(internal.authMail.inviteForMail, { inviteId });
    if (!data || data.invite.acceptedAt !== undefined || data.invite.revokedAt !== undefined) return false;
    const expiresOn = new Date(data.invite.expiresAt).toLocaleDateString("de-DE", { timeZone: "Europe/Berlin" });
    const content = inviteMail({
      appName: appName(),
      companyName: data.companyName,
      role: data.invite.role,
      signInUrl: `${siteUrl() ?? ""}/anmelden`,
      expiresOn,
    });
    const result = await senderFor(ctx).send({ to: data.invite.email, kind: "invite", ...content });
    await ctx.runMutation(internal.authMail.recordInviteOutcome, { inviteId, ok: result.ok });
    return result.ok;
  },
});

export const recordMailTest = actorMutation({
  permission: "integrations.manage",
  args: { ok: v.boolean(), detail: v.string() },
  handler: async (ctx, { ok, detail }) => recordIntegrationTest(ctx, "cloudflare_email", { ok, detail }),
});

/** F01 SET-107 „Test-Code senden": test mail to the signed-in owner; the result is stored and audited. */
export const sendTest = action({
  permission: "integrations.manage",
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; message: string; transport: string }> => {
    const to = ctx.actorContext.label;
    if (!to) throw appError("invalid_input", "Keine E-Mail-Adresse für das angemeldete Konto.");
    const company: string = await ctx.runQuery(internal.authMail.companyName, {});
    const result = await senderFor(ctx).send({
      to,
      kind: "test",
      ...testMail({ appName: appName(), companyName: company }),
    });
    const message = result.ok ? `Testnachricht an ${to} gesendet.` : result.message;
    await ctx.runMutation(internal.authMail.recordMailTest, {
      actorContext: ctx.actorContext,
      ok: result.ok,
      detail: result.ok ? `ok (${result.transport})` : `${result.code}: ${result.detail}`,
    });
    return { ok: result.ok, message, transport: configuredTransport() };
  },
});
