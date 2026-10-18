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
    "artifacts_retry",
    "artifact_archived",
    "export",
    "mark_sent",
    "mark_sent_retracted",
    "cancel",
    "correct",
    // F04 §4.7/§4.8 (Storno, corrections, chains): effects on the original/related documents and the register.
    "cancelled",
    "create_correction",
    "create_chain_draft",
    "credited",
    "credit_reverted",
    "advance_deducted",
    "advance_released",
    "register_status",
    "accept",
    "reject",
    "withdraw",
    "download_original",
    // F04 quotes, orders, delivery notes, proforma and conversions (QUO-04…15, DOC-33)
    "convert",
    "revise",
    "supersede",
    "reopen",
    "expire",
    "mark_received",
    "progress",
    // F05 PAY-052 manual Zugang override
    "zugang_override",
    // F09 IMP-003 archived historic document from the sevdesk export
    "import",
  ],
  // F05 P1: refund of a credit balance, PAY-047 reconciliation of a manual payment, PAY-063 archived Quittung
  payment: ["record", "reverse", "receipt_print", "refund", "reconcile", "receipt"],
  voucher: ["create", "update", "finalize", "replace_file", "cancel"],
  bank: [
    "connect",
    "consent_renew",
    "disconnect",
    "import",
    "sync",
    "match",
    "unmatch",
    "mark",
    // F07 P1 statement import slice
    "unmark",
    "revision",
    "statement_pdf",
    "duplicate_resolve",
    "reversal_link",
    "rollback",
    // F07 P1 matching slice: BNK-046 rejected suggestion, BNK-048 learned alias
    "match_reject",
    "alias_learn",
  ],
  cash: ["transfer", "transfer_reverse"],
  // F05 dunning: policies, reminders, cases, runs (dunning.policy.*, dunning.reminder.*, dunning.case.*, dunning.run)
  dunning: "*",
  // F05 PAY-044 receivables.refreshOverdue
  receivables: ["overdue"],
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
  // `revoke_sessions`: „Sitzungen abmelden" (04 §4.10) without deactivating the member.
  member: ["create", "role_change", "extend", "expire", "expired", "disable", "revoke_sessions"],
  invite: ["create", "resend", "revoke", "accept"],
  export: ["datev", "gdpdu", "full", "csv"],
  // F09 sevdesk export import: project lifecycle, files, mapping, resolutions, preview, commit batches, presets.
  import: [
    "create",
    "files",
    "mapping",
    "resolutions",
    "preview",
    "commit",
    "discard",
    "finish",
    "fail",
    "record",
    "preset",
    "protocol", // IMP-024: the import protocol PDF attached to the committed import
  ],
  integrity: ["run", "checkpoint", "acknowledge"],
  security: ["write_rejected", "access_denied"],
  auditor: ["access"],
  dsgvo: "*", // dsgvo.request.* | restrict | export
  retention: ["purge", "anchor"],
  system: ["startup", "migration", "restore", "restore_drill"],
  // 03 §10 notifications / to-dos (F04 SND-21): created by `deadlines.notify`, closed by the resolving act.
  notification: ["create", "resolve", "read"],
  // F04 §3.4 recurring invoice templates (REC-01…16): configuration changes, skipped periods, generation runs.
  recurring: ["create", "update", "pause", "resume", "skip", "delete", "archive", "automation_confirm", "generate"],
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
