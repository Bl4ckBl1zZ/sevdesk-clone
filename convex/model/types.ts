import type { Actor, Channel, MemberRole } from "../../src/domain/schemas/actor";
import type { MutationCtx, QueryCtx } from "../_generated/server";

/**
 * Who performs a write (02 §4.4). Built only by the wrappers in convex/functions.ts (verified JWT or job
 * registry) and by the Better Auth triggers in convex/auth.ts.
 */
export interface ActorContext {
  actor: Actor;
  /** Member role at the time of the action (user: actors only) → auditLog.actorRole. */
  role?: MemberRole;
  /** Display data at write time (user e-mail, key name) → auditLog.actorLabel. */
  label?: string;
  channel: Channel;
  sessionId?: string;
  client?: { name: string; version: string };
  /** api-key:/mcp: actors. */
  scopes?: string[];
  userAgent?: string;
  requestId?: string;
}

/** What the wrappers add to every ctx. */
export interface ActorFields {
  /** Canonical actor string `"<kind>:<id>"`. */
  actor: Actor;
  /** Member role for user: actors; undefined for keys and system jobs. */
  role: MemberRole | undefined;
  actorContext: ActorContext;
  now: () => number;
}

/** Context every model write function receives: a mutation ctx whose db is the guarded db (model/db.ts). */
export type ModelCtx = MutationCtx & ActorFields;

export type ReadCtx = QueryCtx | MutationCtx;
