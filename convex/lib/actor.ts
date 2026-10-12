import { resolveIdentity } from "../../src/domain/access/identity";
import { canDo, canKeyDo, type Permission, ROLE_LABEL_DE } from "../../src/domain/access/permissions";
import { memberAccess } from "../../src/domain/access/signup";
import { components } from "../_generated/api";
import type { QueryCtx } from "../_generated/server";
import { getMemberByAuthUserId } from "../model/members";
import type { ActorContext } from "../model/types";
import { betterAuthIssuer, serverJwtIssuer } from "./env";
import { appError } from "./errors";

/**
 * Resolves the caller of a public function into an `ActorContext` and enforces the function's permission
 * (02 §4.3/§4.4, F12 AUD-021). Fails closed: no identity, unknown issuer, no member, expired/disabled member,
 * revoked key, missing role or scope → error. The actor is never read from function arguments.
 *
 * `checkSession` (writes): the Better Auth session row must still exist and be unexpired — a bare JWT stays
 * valid up to 15 min after sign-out (02 §4.4 `safeGetAuthUser`).
 */
export async function resolveActor(
  ctx: QueryCtx,
  permission: Permission,
  opts: { checkSession: boolean; now: number },
): Promise<ActorContext> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw appError("unauthenticated");
  const resolved = resolveIdentity(identity as unknown as { issuer: string; subject: string }, {
    user: betterAuthIssuer(),
    server: serverJwtIssuer(),
  });
  if ("error" in resolved) throw appError("unauthenticated", undefined, { reason: resolved.error });

  if (resolved.kind === "user") {
    const member = await getMemberByAuthUserId(ctx, resolved.authUserId);
    if (!member) throw appError("not_a_member");
    const access = memberAccess(member, opts.now);
    if (access === "expired") throw appError("member_expired");
    if (access === "disabled") throw appError("member_disabled");
    if (opts.checkSession) {
      const session = resolved.sessionId
        ? await ctx.runQuery(components.betterAuth.adapter.findOne, {
            model: "session",
            where: [
              { field: "_id", value: resolved.sessionId },
              { field: "expiresAt", operator: "gt", value: opts.now },
            ],
          })
        : null;
      if (!session || (session as { userId?: string }).userId !== resolved.authUserId)
        throw appError("session_invalid");
    }
    // TODO(P1, E-AUD-30a): sessions created by e-mail OTP for members with totpEnabled are `totp_required`
    // until twoFactor.verifyTotp succeeded. Needs a per-session factor marker; see docs/adr/0002.
    if (!canDo(member.role, permission)) {
      throw appError("forbidden_role", `Ihre Rolle (${ROLE_LABEL_DE[member.role]}) erlaubt diese Aktion nicht.`, {
        role: member.role,
        permission,
      });
    }
    return {
      actor: resolved.actor,
      role: member.role,
      label: member.email,
      channel: "ui",
      ...(resolved.sessionId ? { sessionId: resolved.sessionId } : {}),
    };
  }

  const key = await ctx.db
    .query("apiKeys")
    .withIndex("by_prefix", (q) => q.eq("prefix", resolved.keyId))
    .unique();
  const channelOk = key && (key.channel === "both" || key.channel === (resolved.kind === "mcp" ? "mcp" : "api"));
  if (!key || !channelOk || key.revokedAt !== undefined || (key.expiresAt !== undefined && key.expiresAt <= opts.now)) {
    throw appError("key_revoked");
  }
  // The stored key is authoritative: a token can never carry more scopes than the key has now.
  const scopes = resolved.scopes.filter((s) => key.scopes.includes(s));
  if (!canKeyDo(scopes, permission)) throw appError("forbidden_scope", undefined, { permission });
  return {
    actor: resolved.actor,
    label: key.name,
    channel: resolved.kind === "mcp" ? "mcp" : "api",
    scopes,
    ...(resolved.kind === "mcp" && resolved.client ? { client: resolved.client } : {}),
  };
}
