import { v } from "convex/values";
import { PERMISSIONS, type Permission } from "../src/domain/access/permissions";
import { internalQuery } from "./_generated/server";
import { resolveActor } from "./lib/actor";
import { appError } from "./lib/errors";
import type { ActorContext } from "./model/types";

/**
 * Actor resolution for actions (actions have no db; the identity propagates into this query).
 * Part of the wrapper machinery in convex/functions.ts — the one internal function built with the raw builder.
 */
export const resolveForAction = internalQuery({
  args: { permission: v.string() },
  handler: async (ctx, args): Promise<ActorContext> => {
    if (!(args.permission in PERMISSIONS)) throw appError("invalid_input", `unknown permission ${args.permission}`);
    return resolveActor(ctx, args.permission as Permission, { checkSession: true, now: Date.now() });
  },
});
