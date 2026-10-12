import { type Issue, issue } from "../result";

/**
 * F01 SET-005 (MAIL-03): until the setup wizard is complete (`companyProfile.setupCompletedAt`), every finalise
 * action — UI, REST, MCP — is refused with `SETUP_INCOMPLETE` (HTTP 409, ../errors/http-status). Drafts may be
 * created. The P1 finalisation pipeline (02 §6 step 1) calls this first, then SET-012 `validateCompanyForDocuments`.
 */
export const SETUP_INCOMPLETE_MESSAGE =
  "Die Einrichtung ist noch nicht abgeschlossen. Dokumente können erst danach fertiggestellt werden; Entwürfe sind möglich.";

export function checkSetupComplete(
  profile: { setupCompletedAt?: number | undefined } | null,
): Issue<"setup_incomplete"> | null {
  return profile?.setupCompletedAt === undefined ? issue("setup_incomplete", SETUP_INCOMPLETE_MESSAGE) : null;
}
