import { z } from "zod";

/**
 * Canonical actor identifiers (03 §0.1, 02 §4.4). The string `"<kind>:<id>"` is produced only by the
 * Convex wrappers from a verified JWT or the job registry, never from client input.
 */
export const ACTOR_KINDS = ["user", "api-key", "mcp", "portal", "system"] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** Kinds that may be minted while the customer portal (F10) is deferred. */
export const MINTABLE_ACTOR_KINDS = ["user", "api-key", "mcp", "system"] as const satisfies readonly ActorKind[];

export const ACTOR_RE = /^(user|api-key|mcp|portal|system):[A-Za-z0-9._-]+$/;

export const actorSchema = z.string().regex(ACTOR_RE, "invalid_actor");
export type Actor = `${ActorKind}:${string}`;

/** Member roles (03 §10 `members.role`). Roles are not actor kinds. */
export const MEMBER_ROLES = ["owner", "bookkeeper", "viewer", "auditor"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const memberRoleSchema = z.enum(MEMBER_ROLES);

/** Audit channel (03 §0.2). */
export const CHANNELS = ["ui", "api", "mcp", "portal", "cron", "import", "system"] as const;
export type Channel = (typeof CHANNELS)[number];

export function isActor(value: string): value is Actor {
  return ACTOR_RE.test(value);
}

export function parseActor(value: string): { kind: ActorKind; id: string } {
  if (!isActor(value)) throw new Error(`invalid_actor: ${value}`);
  const i = value.indexOf(":");
  return { kind: value.slice(0, i) as ActorKind, id: value.slice(i + 1) };
}

export function formatActor(kind: ActorKind, id: string): Actor {
  const actor = `${kind}:${id}`;
  if (!isActor(actor)) throw new Error(`invalid_actor: ${actor}`);
  return actor as Actor;
}
