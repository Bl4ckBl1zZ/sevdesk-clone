import { checkSetupComplete } from "../../src/domain/settings/finalize-guard";
import { appError } from "../lib/errors";
import { getCompanyProfile } from "./companyProfile";
import type { ReadCtx } from "./types";

/**
 * Finalisation guard, step 1 (F01 SET-005, 02 §6). Every finalise path — the UI mutation, REST
 * `POST /invoices/{id}/finalize` and the MCP `document_finalize` tool all end in the same Convex function (P1) —
 * calls this before anything is numbered or written: `setup_incomplete` (HTTP 409) while the wizard is open.
 */
export async function assertSetupComplete(ctx: ReadCtx): Promise<void> {
  const issue = checkSetupComplete(await getCompanyProfile(ctx));
  if (issue) throw appError("setup_incomplete", issue.message, { reason: "SETUP_INCOMPLETE", httpStatus: 409 });
}
