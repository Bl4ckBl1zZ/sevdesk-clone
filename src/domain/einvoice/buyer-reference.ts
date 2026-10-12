/**
 * Buyer reference BT-10 (F02 CON-084, ER-10/ER-20): a valid Leitweg-ID for public authorities (mandatory, also for
 * direct orders ≤ 1.000 €, README A27); otherwise optional free text ≤ 100 characters.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import { type LeitwegIdIssueCode, validateLeitwegId } from "./leitweg-id";

export const BUYER_REFERENCE_MAX_LENGTH = 100;

export function validateBuyerReference(input: {
  readonly value: string | undefined | null;
  readonly isPublicAuthority: boolean;
}): Result<string | null, Issue<LeitwegIdIssueCode | "too_long">> {
  if (input.isPublicAuthority) return validateLeitwegId(input.value);
  const value = (input.value ?? "").trim();
  if (value === "") return ok(null);
  if (value.length > BUYER_REFERENCE_MAX_LENGTH) {
    return err(issue("too_long", "Die Käuferreferenz ist zu lang (max. 100 Zeichen)."));
  }
  return ok(value);
}
