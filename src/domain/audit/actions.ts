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
    // F04 DOC-18 / INV-30 attachments (drafts) and proofs (finalised documents)
    "attachment_add",
    "attachment_update",
    "attachment_remove",
    "evidence_add",
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
    // F09 E-EXP-10 DATEV-safe alias for a legacy document number
    "datev_alias",
    // F09 IMP-003 archived historic document from the sevdesk export
    "import",
  ],
  // F05 P1: refund of a credit balance, PAY-047 reconciliation of a manual payment, PAY-063 archived Quittung
  payment: ["record", "reverse", "receipt_print", "refund", "reconcile", "receipt"],
  // F06 P2: drafts, booking, corrections, files, approvals, duplicates, payment choice, supplier profiles,
  // recurring templates and receipt waivers (voucher.create, voucher.finalize, voucher.correct, …)
  voucher: "*",
  // F06 P2 receipt inbox: capture, e-mail-in parse/poll, classification steps, rejection, duplicate override, OCR calls
  inbox: [
    "capture",
    "file_index",
    "classify_start",
    "mail_parsed",
    "files_extracted",
    "classify_retry",
    "ocr_pending",
    "ocr_call",
    "classified",
    "redraft",
    "reject",
    "duplicate_override",
    "convert",
    "draft_deleted",
    "poll",
  ],
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
    // F07 P2 Enable Banking feed (BNK-011…117) and matching rules (BNK-050…054)
    "feed_setup",
    "feed_consent_start",
    "feed_consent_failed",
    "feed_account_map",
    "feed_backfill",
    "feed_poll",
    "feed_pending",
    "feed_status",
    "feed_reminder",
    "feed_confirmation",
    "feed_lost",
    "feed_account_update",
    "rule_create",
    "rule_update",
    "rule_delete",
    "rule_apply",
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
  rule_override: ["add", "delete"],
  api_key: ["create", "revoke"],
  webhook: "*", // webhook.endpoint.*
  auth: ["sign_in", "sign_out", "passkey_add", "passkey_remove", "totp_enable", "totp_disable", "otp_mail_failed"],
  // F12 lists `expire`; 02 §7 (members.expire cron) writes `member.expired` — both accepted.
  // `revoke_sessions`: „Sitzungen abmelden" (04 §4.10) without deactivating the member.
  member: ["create", "role_change", "extend", "expire", "expired", "disable", "revoke_sessions"],
  invite: ["create", "resend", "revoke", "accept"],
  // F09 EXP-016: `datev_acceptance` (advisor test import recorded), `datev_test_download` („Testexport“ confirmation)
  export: [
    "datev",
    "gdpdu",
    "full",
    "csv",
    "audit",
    "bulk",
    "datev_acceptance",
    "datev_test_download",
    "dsgvo",
    "gdpdu_download",
    "datev_download",
  ],
  // F09 EXP-026 background jobs (jobs table): lifecycle and the 30-day result expiry.
  job: ["create", "start", "progress", "done", "fail", "cancel", "expire"],
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
    // F09 EC-203 / E-IMP-37: a total corrected from the PDF before the commit (with the owner's reason)
    "corrected_total",
    "protocol", // IMP-024: the import protocol PDF attached to the committed import
  ],
  integrity: ["run", "checkpoint", "acknowledge"],
  security: ["write_rejected", "access_denied", "secret_screen"],
  auditor: ["access"],
  dsgvo: "*", // dsgvo.request.* | restrict | export
  // F12 PRV-003…009: scan, Betriebsprüfung-Modus, purge batch lifecycle, contact anonymisation, replay after restore
  retention: ["purge", "anchor", "scan", "hold", "hold_end", "batch", "anonymise", "replay"],
  verfahrensdoku: ["update_inputs", "release", "supersede"],
  system: ["startup", "migration", "restore", "restore_drill", "clock"],
  // 03 §10 notifications / to-dos (F04 SND-21): created by `deadlines.notify`, closed by the resolving act.
  notification: ["create", "update", "resolve", "read", "escalate", "purge", "deliver"],
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
