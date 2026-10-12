import { v } from "convex/values";
import { mutation } from "./functions";
import { issueConfirmToken } from "./model/confirmTokens";

/**
 * Confirm tokens (06 §2.3). `issue` is called by the MCP preview tools (`preview_action`, later `document_preview`
 * and `dunning_preview`) as the key's own `mcp:` actor; it checks that the key holds the scope of the guarded action
 * and binds the token to the canonical arguments and the current entity versions. Consumption happens inside the
 * guarded mutation (convex/functions.ts `withConfirmToken`).
 */
export const issue = mutation({
  permission: "apiKeys.self",
  args: {
    intent: v.string(),
    args: v.any(),
    entities: v.array(v.object({ table: v.string(), id: v.string() })),
    tokenHash: v.string(),
  },
  handler: async (ctx, input) =>
    issueConfirmToken(ctx, {
      intent: input.intent,
      args: (input.args ?? {}) as Record<string, unknown>,
      entities: input.entities,
      tokenHash: input.tokenHash,
    }),
});
