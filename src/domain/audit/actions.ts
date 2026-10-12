/**
 * Audit action taxonomy (F12 §4.1). Every audit entry's `action` must be listed here; groups written as
 * `contact.*` accept any sub-action. Part of the mutation inventory (AUD-012).
 */
const GROUPS: Record<string, readonly string[] | "*"> = {
  document: [
    "create_draft",
    "update_draft",
    "delete_draft",
    "finalize",
    "artifacts_ready",
    "artifacts_blocked",
    "export",
    "mark_sent",
    "mark_sent_retracted",
    "cancel",
    "correct",
    "accept",
    "reject",
    "withdraw",
    "download_original",
  ],
  payment: ["record", "reverse", "receipt_print"],
  voucher: ["create", "update", "finalize", "replace_file", "cancel"],
  bank: ["connect", "consent_renew", "disconnect", "import", "sync", "match", "unmatch", "mark"],
  cash: ["transfer", "transfer_reverse"],
  journal: ["post", "reverse", "manual", "opening_balance"],
  period: ["lock"],
  tax_filing: ["submit", "correct", "sondervorauszahlung"],
  asset: ["create", "depreciate", "dispose"],
  contact: "*",
  product: "*",
  project: "*",
  time_entry: "*",
  settings: "*", // settings.<section>.update
  rule_override: ["add"],
  api_key: ["create", "revoke"],
  webhook: "*", // webhook.endpoint.*
  auth: ["sign_in", "sign_out", "passkey_add", "passkey_remove", "totp_enable", "totp_disable", "otp_mail_failed"],
  // F12 lists `expire`; 02 §7 (members.expire cron) writes `member.expired` — both accepted.
  member: ["create", "role_change", "extend", "expire", "expired", "disable"],
  invite: ["create", "resend", "revoke", "accept"],
  export: ["datev", "gdpdu", "full", "csv"],
  import: ["create", "preview", "commit", "discard", "finish"],
  integrity: ["run", "checkpoint", "acknowledge"],
  security: ["write_rejected", "access_denied"],
  auditor: ["access"],
  dsgvo: "*", // dsgvo.request.* | restrict | export
  retention: ["purge", "anchor"],
  system: ["startup", "migration", "restore", "restore_drill"],
};

export function isAuditAction(action: string): boolean {
  const dot = action.indexOf(".");
  if (dot <= 0 || dot === action.length - 1) return false;
  const group = GROUPS[action.slice(0, dot)];
  if (group === undefined) return false;
  if (group === "*") return true;
  return group.includes(action.slice(dot + 1));
}

export function assertAuditAction(action: string): void {
  if (!isAuditAction(action)) throw new Error(`unknown_audit_action: ${action}`);
}
