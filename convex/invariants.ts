import { systemQuery } from "./functions";
import { checkInvariants, type InvariantViolation } from "./model/invariants";

/**
 * `invariants.check` (02 §7, 10 §2): evaluates the regulatory invariants over the whole database.
 * Called by `assertInvariants()` after every Convex and integration test (07 §5a). The daily cron that stores the
 * result in `integrityRuns` and blocks finalisation on ERROR findings follows with P1 (paginated).
 */
export const check = systemQuery({
  job: "cron.invariants.check",
  args: {},
  handler: async (ctx): Promise<InvariantViolation[]> => checkInvariants(ctx),
});
