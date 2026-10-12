import { type Actor, isActor, parseActor } from "../schemas/actor";
import { isScope, type Scope } from "../schemas/scopes";

/**
 * Identity → actor mapping (02 §4.4). Convex verifies the JWT against one of the two providers in
 * `convex/auth.config.ts`; this pure function turns the verified identity into the canonical actor.
 *
 * - Better Auth provider (issuer = CONVEX_SITE_URL): `user:<sub>`; role comes from `members` later.
 * - Server JWT provider (issuer = https://api.<BASE_DOMAIN>): `sub` is the full actor string
 *   `api-key:<keyId>` or `mcp:<keyId>`, with `scopes`, `keyName` and (MCP) `client` claims.
 *
 * Anything else is rejected. The actor is never taken from function arguments.
 */
export const SERVER_JWT_AUDIENCE = "rechnungen-server";

export interface IdentityLike {
  issuer: string;
  subject: string;
  [claim: string]: unknown;
}

export type ResolvedIdentity =
  | {
      kind: "user";
      actor: Actor;
      authUserId: string;
      sessionId?: string;
      email?: string;
      name?: string;
    }
  | {
      kind: "api-key" | "mcp";
      actor: Actor;
      keyId: string;
      scopes: Scope[];
      keyName?: string;
      client?: { name: string; version: string };
      /** SHA-256 of the API key the request came with; Convex compares it with `apiKeys.hash` (05 §2.1). */
      keyHash?: string;
      requestId?: string;
      userAgent?: string;
    };

export type IdentityError = "unknown_issuer" | "invalid_subject";

export function resolveIdentity(
  identity: IdentityLike,
  issuers: { user: string | undefined; server: string | undefined },
): ResolvedIdentity | { error: IdentityError } {
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);

  if (issuers.user && identity.issuer === issuers.user) {
    const actor = `user:${identity.subject}`;
    if (!isActor(actor)) return { error: "invalid_subject" };
    return {
      kind: "user",
      actor,
      authUserId: identity.subject,
      ...(str(identity.sessionId) ? { sessionId: str(identity.sessionId) } : {}),
      ...(str(identity.email) ? { email: str(identity.email) } : {}),
      ...(str(identity.name) ? { name: str(identity.name) } : {}),
    };
  }

  if (issuers.server && identity.issuer === issuers.server) {
    if (!isActor(identity.subject)) return { error: "invalid_subject" };
    const { kind, id } = parseActor(identity.subject);
    if (kind !== "api-key" && kind !== "mcp") return { error: "invalid_subject" };
    const rawScopes = Array.isArray(identity.scopes) ? identity.scopes : [];
    const scopes = rawScopes.filter((s): s is Scope => typeof s === "string" && isScope(s));
    const client = identity.client as { name?: unknown; version?: unknown } | undefined;
    return {
      kind,
      actor: identity.subject,
      keyId: id,
      scopes,
      ...(str(identity.keyName) ? { keyName: str(identity.keyName) } : {}),
      ...(str(identity.keyHash) ? { keyHash: str(identity.keyHash) } : {}),
      ...(str(identity.requestId) ? { requestId: str(identity.requestId)?.slice(0, 100) } : {}),
      ...(str(identity.ua) ? { userAgent: str(identity.ua)?.slice(0, 200) } : {}),
      ...(kind === "mcp" && client && str(client.name)
        ? { client: { name: str(client.name) as string, version: str(client.version) ?? "" } }
        : {}),
    };
  }

  return { error: "unknown_issuer" };
}
