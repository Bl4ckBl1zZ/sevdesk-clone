import { v } from "convex/values";
import { ACTOR_KINDS, AUDIT_PRESETS } from "../src/domain/audit/viewer";
import { mutation, query } from "./functions";
import {
  entityHistory as entityHistoryModel,
  exportAudit,
  latestExternalChange as latestExternalChangeModel,
  recordAccess as recordAccessModel,
  searchAudit,
} from "./model/auditViewer";

/**
 * Audit log viewer (F12 AUD-006), per-record „Verlauf" (AUD-007), export (AUD-008) and the logged reads of AUD-009.
 * Reading needs `audit.read` (every role incl. auditors; API scope `audit:read`).
 */

const vFilter = {
  preset: v.optional(v.union(...AUDIT_PRESETS.map((p) => v.literal(p)))),
  apiKeyActor: v.optional(v.string()),
  from: v.optional(v.number()),
  to: v.optional(v.number()),
  actorKind: v.optional(v.union(...ACTOR_KINDS.map((k) => v.literal(k)))),
  actor: v.optional(v.string()),
  channel: v.optional(v.string()),
  actions: v.optional(v.array(v.string())),
  entityTable: v.optional(v.string()),
  entityId: v.optional(v.string()),
  text: v.optional(v.string()),
};

export const search = query({
  permission: "audit.read",
  args: { ...vFilter, beforeSeq: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => searchAudit(ctx, args),
});

export const entityHistory = query({
  permission: "audit.read",
  args: { table: v.string(), id: v.string() },
  handler: async (ctx, { table, id }) => entityHistoryModel(ctx, table, id),
});

/** AUD-008: a mutation because the export itself is logged (AUD-009). */
export const exportLog = mutation({
  permission: "audit.read",
  args: { ...vFilter, format: v.union(v.literal("csv"), v.literal("json")) },
  handler: async (ctx, args) => exportAudit(ctx, args),
});

/** AUD-009: called by the app shell on every page for auditors, and by the secrets screens for everyone. */
export const recordAccess = mutation({
  permission: "session.self",
  args: { path: v.string(), secretScreen: v.optional(v.string()) },
  handler: async (ctx, args) => recordAccessModel(ctx, args),
});

/** API keys and MCP keys for the „API-Schlüssel {name}" preset (names only). */
export const actors = query({
  permission: "audit.read",
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("apiKeys").collect()).flatMap((k) =>
      (k.channel === "both" ? (["api-key", "mcp"] as const) : ([k.channel === "mcp" ? "mcp" : "api-key"] as const)).map(
        (kind) => ({ actor: `${kind}:${k.prefix}`, name: kind === "mcp" ? `${k.name} (MCP)` : k.name }),
      ),
    ),
});

/** DOC-41: the latest API/MCP change; the shell shows „Aktualisiert durch Claude (MCP)" when it changes. */
export const latestExternalChange = query({
  permission: "audit.read",
  args: {},
  handler: async (ctx) => latestExternalChangeModel(ctx),
});
