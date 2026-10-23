/**
 * Technical data that is not business data and therefore not part of the audit trail (F12 AUD-001 scope, RI-15):
 *
 * - whole tables: the dev mailbox, the API access log (05 §7, one row per REST/MCP request), idempotency records
 *   (05 §3, 24 h) and MCP confirm tokens (06 §2.3, 10 min) — short-lived, purged by `cron.api.cleanup`;
 * - single fields: `apiKeys.lastUsedAt` (debounced usage stamp, 05 §2.1) and the `updatedAt` sync stamps of
 *   contacts and products (05 §3 `updated_since`).
 *
 * Writes to them need no audit entry (convex/model/db.ts) and the RI-15 replay ignores them.
 */
export const TECHNICAL_TABLES: readonly string[] = [
  "devMailbox",
  "apiRequestLog",
  "idempotencyKeys",
  "confirmTokens",
  // F12 AUD-019: rolling 7-day log of the clock check (status changes are audited as system.clock)
  "clockReadings",
  // F01 SET-134: latest run per cron job (status table on Einstellungen › System)
  "cronRuns",
  // 05 §5.2 outbound webhooks: the outbox and the delivery log (30 days, purged by cron.webhooks.sweep)
  "webhookEvents",
  "webhookDeliveries",
];

export const TECHNICAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  apiKeys: ["lastUsedAt"],
  // 05 §5.1: delivery health of a webhook endpoint (an automatic disable is audited)
  webhookEndpoints: ["failingSince", "lastSuccessAt", "lastFailureAt"],
  contacts: ["updatedAt"],
  products: ["updatedAt"],
};

export function isTechnicalTable(table: string): boolean {
  return TECHNICAL_TABLES.includes(table);
}

/** True when a patch touches technical fields of `table` only (and at least one field). */
export function isTechnicalPatch(table: string, patch: Record<string, unknown>): boolean {
  const fields = TECHNICAL_FIELDS[table];
  const keys = Object.keys(patch);
  return fields !== undefined && keys.length > 0 && keys.every((k) => fields.includes(k));
}

export function technicalFields(table: string): readonly string[] {
  return TECHNICAL_FIELDS[table] ?? [];
}
