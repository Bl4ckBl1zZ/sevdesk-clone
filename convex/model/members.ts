import {
  EXPIRED_REASON,
  MEMBER_MESSAGES_DE,
  validateExtension,
  validateRoleChange,
} from "../../src/domain/access/members";
import {
  DAY_MS,
  decideSignup,
  INVITE_MESSAGES_DE,
  INVITE_VALIDITY_DAYS,
  normalizeEmail,
  validateInviteInput,
} from "../../src/domain/access/signup";
import { encodeId } from "../../src/domain/api/ids";
import { components } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { env } from "../lib/env";
import { appError } from "../lib/errors";
import { appendAudit, auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";
import { emitEvent } from "./webhooks";

/**
 * Members and invites (03 §10, 02 §4.3). Written only here; every change is audited.
 */

export async function getMemberByAuthUserId(ctx: ReadCtx, authUserId: string): Promise<Doc<"members"> | null> {
  return ctx.db
    .query("members")
    .withIndex("by_authUserId", (q) => q.eq("authUserId", authUserId))
    .unique();
}

export async function getMemberByEmail(ctx: ReadCtx, email: string): Promise<Doc<"members"> | null> {
  return ctx.db
    .query("members")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .first();
}

/** "No user exists" (02 §4.3 bootstrap). Users and members are created in one transaction (trigger), so the
 *  members table is an exact proxy for the Better Auth user table. */
export async function anyMemberExists(ctx: ReadCtx): Promise<boolean> {
  return (await ctx.db.query("members").first()) !== null;
}

export async function invitesForEmail(ctx: ReadCtx, email: string): Promise<Doc<"invites">[]> {
  return ctx.db
    .query("invites")
    .withIndex("by_email", (q) => q.eq("email", normalizeEmail(email)))
    .collect();
}

/** The sign-up gate decision for `email` right now (used by the Better Auth hook and the trigger). */
export async function signupDecision(ctx: ReadCtx, email: string, now: number) {
  return decideSignup({
    email,
    ownerEmail: env("OWNER_EMAIL"),
    anyUserExists: await anyMemberExists(ctx),
    invites: await invitesForEmail(ctx, email),
    now,
  });
}

/**
 * Called from the Better Auth `user.onCreate` trigger, in the same transaction as the user insert: re-checks the
 * gate authoritatively, creates the member and consumes the invite. Throwing aborts the user creation too.
 * Actor: `system:auth` (03 §0.1).
 */
export async function createMemberFromSignup(
  ctx: ModelCtx,
  user: { authUserId: string; email: string; name?: string },
): Promise<Id<"members">> {
  const now = ctx.now();
  if (await getMemberByAuthUserId(ctx, user.authUserId)) throw appError("conflict", "Mitglied existiert bereits.");
  const decision = await signupDecision(ctx, user.email, now);
  if (!decision.allowed) throw appError("signup_forbidden", decision.message, { reason: decision.reason });

  const email = normalizeEmail(user.email);
  const name = user.name && user.name.trim() !== "" ? user.name : undefined;
  if (decision.kind === "bootstrap") {
    return auditedInsert(
      ctx,
      "members",
      {
        authUserId: user.authUserId,
        email,
        ...(name ? { name } : {}),
        role: "owner",
        totpEnabled: false,
        createdAt: now,
      },
      { action: "member.create", label: email },
    );
  }

  const invite = await ctx.db.get(decision.inviteId);
  if (!invite) throw appError("signup_forbidden");
  const memberId = await auditedInsert(
    ctx,
    "members",
    {
      authUserId: user.authUserId,
      email,
      ...(name ? { name } : {}),
      role: invite.role,
      ...(invite.memberExpiresAt !== undefined ? { expiresAt: invite.memberExpiresAt } : {}),
      ...(invite.auditor ? { auditor: { ...invite.auditor, extensions: [] } } : {}),
      totpEnabled: false,
      invitedBy: invite.createdBy,
      inviteId: invite._id,
      createdAt: now,
    },
    { action: "member.create", label: email },
  );
  await auditedPatch(
    ctx,
    "invites",
    invite._id,
    { acceptedAt: now, acceptedUserId: user.authUserId },
    { action: "invite.accept", label: email },
  );
  return memberId;
}

export interface InviteInput {
  email: string;
  role: "bookkeeper" | "viewer" | "auditor";
  memberExpiresAt?: number;
  auditor?: { organisation?: string; purpose: string; fiscalYears: number[] };
}

/** Owner creates an invite (02 §4.3). Older open invites for the same address are revoked. */
export async function createInvite(ctx: ModelCtx, input: InviteInput): Promise<Id<"invites">> {
  const now = ctx.now();
  const error = validateInviteInput(input, now);
  if (error) throw appError("invalid_input", INVITE_MESSAGES_DE[error], { reason: error });
  const email = normalizeEmail(input.email);
  if (await getMemberByEmail(ctx, email))
    throw appError("invalid_input", INVITE_MESSAGES_DE.already_member, {
      reason: "already_member",
    });
  for (const old of await invitesForEmail(ctx, email)) {
    if (old.acceptedAt === undefined && old.revokedAt === undefined) {
      await auditedPatch(
        ctx,
        "invites",
        old._id,
        { revokedAt: now },
        { action: "invite.revoke", label: email, reason: "superseded" },
      );
    }
  }
  const inviteId = await auditedInsert(
    ctx,
    "invites",
    {
      email,
      role: input.role,
      ...(input.memberExpiresAt !== undefined ? { memberExpiresAt: input.memberExpiresAt } : {}),
      ...(input.auditor ? { auditor: input.auditor } : {}),
      expiresAt: now + INVITE_VALIDITY_DAYS * DAY_MS,
      createdBy: ctx.actor,
      createdAt: now,
    },
    { action: "invite.create", label: email },
  );
  // F12 §7 member.invited: role and expiry only — no e-mail address
  await emitEvent(ctx, "member.invited", {
    id: encodeId("invites", inviteId),
    object: "invite",
    role: input.role,
    expires_at: new Date(now + INVITE_VALIDITY_DAYS * DAY_MS).toISOString(),
    updated_at: new Date(now).toISOString(),
  });
  return inviteId;
}

export async function revokeInvite(ctx: ModelCtx, inviteId: Id<"invites">): Promise<void> {
  const invite = await ctx.db.get(inviteId);
  if (!invite) throw appError("not_found");
  if (invite.acceptedAt !== undefined) throw appError("conflict", "Die Einladung wurde bereits angenommen.");
  if (invite.revokedAt !== undefined) return;
  await auditedPatch(
    ctx,
    "invites",
    inviteId,
    { revokedAt: ctx.now() },
    { action: "invite.revoke", label: invite.email },
  );
}

export async function recordInviteMail(ctx: ModelCtx, inviteId: Id<"invites">, ok: boolean): Promise<void> {
  const invite = await ctx.db.get(inviteId);
  if (!invite) return;
  await auditedPatch(
    ctx,
    "invites",
    inviteId,
    { sentAt: ctx.now(), mailOutcome: ok ? "ok" : "failed" },
    { action: invite.sentAt === undefined ? "invite.create" : "invite.resend", label: invite.email },
  );
}

/** Deletes every Better Auth session of the user (02 §4.3: removal/expiry revokes sessions immediately). */
export async function revokeSessions(ctx: ModelCtx, authUserId: string): Promise<void> {
  let cursor: string | null = null;
  for (;;) {
    const res: { isDone: boolean; continueCursor: string } = await ctx.runMutation(
      components.betterAuth.adapter.deleteMany,
      {
        input: { model: "session", where: [{ field: "userId", value: authUserId }] },
        paginationOpts: { numItems: 100, cursor },
      },
    );
    if (res.isDone) return;
    cursor = res.continueCursor;
  }
}

export async function disableMember(ctx: ModelCtx, memberId: Id<"members">, reason: string): Promise<void> {
  const member = await ctx.db.get(memberId);
  if (!member) throw appError("not_found");
  if (member.role === "owner") throw appError("invalid_input", "Der Inhaber kann nicht deaktiviert werden.");
  if (member.disabledAt !== undefined) return;
  await auditedPatch(
    ctx,
    "members",
    memberId,
    { disabledAt: ctx.now(), disabledReason: reason },
    { action: "member.disable", label: member.email, reason },
  );
  await revokeSessions(ctx, member.authUserId);
  await emitMemberRemoved(ctx, member, "disabled");
}

/** F12 §7 member.removed (deactivated or expired): ID and role only. */
async function emitMemberRemoved(ctx: ModelCtx, member: Doc<"members">, reason: "disabled" | "expired") {
  await emitEvent(ctx, "member.removed", {
    id: encodeId("members", member._id),
    object: "member",
    role: member.role,
    reason,
    updated_at: new Date(ctx.now()).toISOString(),
  });
}

/** `members.expire` cron (02 §7): members past `expiresAt` lose access and their sessions. */
export async function expireMembers(ctx: ModelCtx): Promise<number> {
  const now = ctx.now();
  let n = 0;
  for (const member of await ctx.db.query("members").collect()) {
    if (member.disabledAt !== undefined || member.expiresAt === undefined || member.expiresAt > now) continue;
    await auditedPatch(
      ctx,
      "members",
      member._id,
      { disabledAt: now, disabledReason: "expired" },
      { action: "member.expired", label: member.email },
    );
    await revokeSessions(ctx, member.authUserId);
    await emitMemberRemoved(ctx, member, "expired");
    n++;
  }
  return n;
}

/** Mirror of the twoFactor plugin state (03 §10 `members.totpEnabled`). */
export async function setTotpEnabled(ctx: ModelCtx, authUserId: string, enabled: boolean): Promise<void> {
  const member = await getMemberByAuthUserId(ctx, authUserId);
  if (!member || member.totpEnabled === enabled) return;
  await auditedPatch(
    ctx,
    "members",
    member._id,
    { totpEnabled: enabled },
    {
      action: enabled ? "auth.totp_enable" : "auth.totp_disable",
      label: member.email,
    },
  );
}

/** Sign-in / sign-out / passkey events from Better Auth triggers (02 §4.3). */
export async function auditAuthEvent(
  ctx: ModelCtx,
  action: "auth.sign_in" | "auth.sign_out" | "auth.passkey_add" | "auth.passkey_remove",
  authUserId: string,
  entity: { table: string; id: string },
): Promise<void> {
  const member = await getMemberByAuthUserId(ctx, authUserId);
  await appendAudit(ctx, { action, entity: { ...entity, ...(member ? { label: member.email } : {}) } });
}

/**
 * Better Auth facts for the member table (04 §4.10): registered passkeys and the last sign-in (newest session).
 * Read through the component adapter; sessions expire after 30 days, so `lastSignInAt` is null for members who
 * have not signed in within that window.
 */
export async function memberAuthFacts(
  ctx: ReadCtx,
  authUserId: string,
): Promise<{ passkeys: number; lastSignInAt: number | null }> {
  const page = async (model: "passkey" | "session") =>
    (
      (await ctx.runQuery(components.betterAuth.adapter.findMany, {
        model,
        where: [{ field: "userId", value: authUserId }],
        paginationOpts: { numItems: 100, cursor: null },
      })) as { page: { createdAt?: number }[] }
    ).page;
  const sessions = await page("session");
  const last = sessions.reduce<number | null>(
    (max, s) => (s.createdAt && (max === null || s.createdAt > max) ? s.createdAt : max),
    null,
  );
  return { passkeys: (await page("passkey")).length, lastSignInAt: last };
}

const memberError = (code: keyof typeof MEMBER_MESSAGES_DE) =>
  appError("invalid_input", MEMBER_MESSAGES_DE[code], { reason: code });

/**
 * „Rolle ändern" (04 §4.10): audited `member.role_change`. The member's sessions are ended so the next sign-in
 * runs with the new role (the wrappers read the role per request anyway; this also clears cached UI state).
 */
export async function changeMemberRole(
  ctx: ModelCtx,
  memberId: Id<"members">,
  change: {
    role: "bookkeeper" | "viewer" | "auditor";
    expiresAt?: number;
    auditor?: { organisation?: string; purpose: string; fiscalYears: number[] };
  },
): Promise<void> {
  const member = await ctx.db.get(memberId);
  if (!member) throw appError("not_found");
  const error = validateRoleChange(member, change, ctx.now());
  if (error) throw memberError(error);
  const auditor =
    change.role === "auditor"
      ? {
          ...(change.auditor ?? member.auditor ?? { purpose: "", fiscalYears: [] }),
          extensions: member.auditor?.extensions ?? [],
        }
      : undefined;
  await auditedPatch(
    ctx,
    "members",
    memberId,
    {
      role: change.role,
      ...(change.expiresAt !== undefined ? { expiresAt: change.expiresAt } : {}),
      auditor,
    },
    { action: "member.role_change", label: member.email },
  );
  await revokeSessions(ctx, member.authUserId);
}

/** „Verlängern" (04 §4.10, F12 AUD-022): new expiry; auditor grants keep the extension history. */
export async function extendMember(
  ctx: ModelCtx,
  memberId: Id<"members">,
  change: { expiresAt: number | null; reason?: string },
): Promise<void> {
  const member = await ctx.db.get(memberId);
  if (!member) throw appError("not_found");
  const now = ctx.now();
  const error = validateExtension(member, change, now);
  if (error) throw memberError(error);
  const reason = change.reason?.trim() || undefined;
  const reactivate = member.disabledAt !== undefined && member.disabledReason === EXPIRED_REASON;
  await auditedPatch(
    ctx,
    "members",
    memberId,
    {
      expiresAt: change.expiresAt ?? undefined,
      ...(reactivate ? { disabledAt: undefined, disabledReason: undefined } : {}),
      ...(member.auditor && change.expiresAt !== null
        ? {
            auditor: {
              ...member.auditor,
              extensions: [
                ...member.auditor.extensions,
                { at: now, expiresAt: change.expiresAt, reason: reason ?? "" },
              ],
            },
          }
        : {}),
    },
    { action: "member.extend", label: member.email, ...(reason ? { reason } : {}) },
  );
}

/** „Sitzungen abmelden" (04 §4.10): ends every session; the member stays active and can sign in again. */
export async function revokeMemberSessions(ctx: ModelCtx, memberId: Id<"members">): Promise<void> {
  const member = await ctx.db.get(memberId);
  if (!member) throw appError("not_found");
  await appendAudit(ctx, {
    action: "member.revoke_sessions",
    entity: { table: "members", id: memberId, label: member.email },
  });
  await revokeSessions(ctx, member.authUserId);
}
