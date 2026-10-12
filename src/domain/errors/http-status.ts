/**
 * Error code → HTTP status for REST problem+json responses and MCP structured errors (05 §3). The codes are the
 * stable snake_case codes of `convex/lib/errors.ts` and the domain issues; unknown codes are server errors.
 */
const STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  session_invalid: 401,
  key_revoked: 401,
  not_a_member: 403,
  member_expired: 403,
  member_disabled: 403,
  forbidden_role: 403,
  forbidden_scope: 403,
  owner_only: 403,
  // A fresh session is a UI concept (API keys never need it); a stale session is refused, not unauthenticated.
  reauth_required: 403,
  totp_required: 401,
  not_found: 404,
  invalid_input: 422,
  conflict: 409,
  version_conflict: 409,
  immutable_record: 409,
  setup_incomplete: 409,
  // F08 journal (ACC-006 409 period_locked, CSH-026 cash_negative, E-ACC-05/09/13/14)
  period_locked: 409,
  posting_rejected: 422,
  role_unmapped: 409,
  account_unknown: 422,
  cash_negative: 409,
  already_posted: 409,
  already_reversed: 409,
  chart_locked: 409,
  bookkeeping_start_locked: 409,
  otp_throttled: 429,
  not_configured: 503,
};

export function httpStatusFor(code: string): number {
  return STATUS[code] ?? 500;
}
