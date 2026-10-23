/**
 * Outbound webhook event catalog (05 §5.3). Pure data: which event types exist, which are reserved for the deferred
 * portal/online payments (F10 — never emitted), which are security-relevant (always delivered to `*` endpoints),
 * and how a sales document type maps onto its event prefix.
 *
 * Events carry IDs, statuses and changed field NAMES only — never personal values (F02 §7, DSGVO-05); receivers fetch
 * the resource with their API key.
 */
export const WEBHOOK_EVENT_TYPES = [
  // F02 §7
  "contact.created",
  "contact.updated",
  "contact.archived",
  "contact.unarchived",
  "contact.merged",
  "contact.deleted",
  "contact.vat_id_checked",
  "contact.credit_changed",
  // F03 §7
  "product.created",
  "product.updated",
  "product.archived",
  "product.deleted",
  "product.price_scheduled",
  "product.stock_low",
  // F04 sales documents (SND-15)
  "quote.created",
  "quote.finalized",
  "quote.sent",
  "quote.sent_retracted",
  "quote.accepted",
  "quote.rejected",
  "quote.expired",
  "order_confirmation.finalized",
  "delivery_note.finalized",
  "invoice.created",
  "invoice.finalized",
  "invoice.sent",
  "invoice.sent_retracted",
  "invoice.paid",
  "invoice.partially_paid",
  "invoice.overdue",
  "invoice.cancelled",
  "invoice.corrected",
  "invoice.artifacts_ready",
  "invoice.artifacts_blocked",
  "reminder.finalized",
  "reminder.sent",
  "reminder.sent_retracted",
  // F05 PAY-060
  "dunning_case.paused",
  "dunning_case.handed_over",
  "payment.recorded",
  "payment.reversed",
  // F06
  "voucher.created",
  "voucher.finalized",
  "inbox_item.received",
  "inbox_item.needs_review",
  // F07 BNK-080
  "bank_transaction.imported",
  "bank_transaction.matched",
  "bank_transaction.reversal_linked",
  "bank_consent.expiring",
  "bank_consent.expired",
  "bank_statement.reconciled",
  "cash_movement.recorded",
  // F08 §7
  "period.locked",
  "tax_filing.submitted",
  "tax_filing.correction_required",
  "threshold.warning",
  // F01 §7.1
  "settings.company.updated",
  "settings.tax.updated",
  "settings.number_range.updated",
  // F10 (deferred) — reserved, never emitted
  "quote.viewed",
  "invoice.viewed",
  "quote.change_requested",
  "contract.withdrawn",
  "payment.pending",
  "payment.failed",
  "payment.disputed",
  "sepa.returned",
  // F11
  "time_entry.created",
  "project.budget_threshold",
  // F09 §7
  "export.completed",
  "import.previewed",
  "import.completed",
  "job.failed",
  // F12 §7 (AUD-015, EC-186)
  "integrity.check_failed",
  "api_key.revoked",
  "member.invited",
  "member.removed",
  "dsgvo.request_overdue",
  "backup.stale",
  // „Test senden"
  "test.ping",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

/** 05 §5.3: portal and online-payment events are reserved while F10 is deferred and are never emitted. */
export const RESERVED_EVENT_TYPES: readonly WebhookEventType[] = [
  "quote.viewed",
  "invoice.viewed",
  "quote.change_requested",
  "contract.withdrawn",
  "payment.pending",
  "payment.failed",
  "payment.disputed",
  "sepa.returned",
];

/** 05 §5.3: security-relevant events — always sent to every endpoint subscribed to `*`. */
export const SECURITY_EVENT_TYPES: readonly WebhookEventType[] = ["integrity.check_failed", "api_key.revoked"];

/** Event types an endpoint may subscribe to (catalog minus reserved; `test.ping` is sent on demand only). */
export const SUBSCRIBABLE_EVENT_TYPES: readonly WebhookEventType[] = WEBHOOK_EVENT_TYPES.filter(
  (t) => !RESERVED_EVENT_TYPES.includes(t) && t !== "test.ping",
);

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

export function isReservedEventType(type: string): boolean {
  return (RESERVED_EVENT_TYPES as readonly string[]).includes(type);
}

/** True when an endpoint with these subscriptions receives `type` (`*` = every event). */
export function endpointSubscribes(events: readonly string[], type: WebhookEventType): boolean {
  if (type === "test.ping") return false; // sent explicitly to one endpoint, never fanned out
  return events.includes("*") || events.includes(type);
}

/**
 * Validates an endpoint's subscription list: `*` alone, or known, non-reserved event types. Returns the normalised
 * (deduplicated, sorted) list or an error text (German, for the form and the REST problem).
 */
export function normaliseSubscriptions(events: readonly string[]): { ok: true; events: string[] } | { ok: false; error: string } {
  const unique = [...new Set(events.map((e) => e.trim()).filter(Boolean))];
  if (unique.length === 0) return { ok: false, error: "Bitte mindestens ein Ereignis oder „Alle Ereignisse“ wählen." };
  if (unique.includes("*")) return { ok: true, events: ["*"] };
  for (const e of unique) {
    if (isReservedEventType(e)) {
      return { ok: false, error: `Das Ereignis ${e} ist für das Kundenportal reserviert und wird nicht gesendet.` };
    }
    if (!isWebhookEventType(e) || e === "test.ping") return { ok: false, error: `Unbekanntes Ereignis: ${e}` };
  }
  return { ok: true, events: unique.sort() };
}

/** Event prefix of a sales document type (05 §5.3); null = the type has no events (proforma, Storno, self-billing). */
export function documentEventPrefix(type: string): "quote" | "order_confirmation" | "delivery_note" | "invoice" | "reminder" | null {
  switch (type) {
    case "quote":
      return "quote";
    case "order_confirmation":
      return "order_confirmation";
    case "delivery_note":
      return "delivery_note";
    case "invoice":
    case "advance_invoice":
    case "partial_invoice":
    case "final_invoice":
    case "correction":
      return "invoice";
    case "reminder":
      return "reminder";
    default:
      return null;
  }
}

/** `${prefix}.${suffix}` for a document type, or null when the catalog has no such event (e.g. `delivery_note.sent`). */
export function documentEvent(type: string, suffix: string): WebhookEventType | null {
  const prefix = documentEventPrefix(type);
  if (!prefix) return null;
  const name = `${prefix}.${suffix}`;
  return isWebhookEventType(name) ? name : null;
}

/** Settlement events of a receivable (PAY-060): `paid` / `partially_paid` when the payment status changed to it. */
export function settlementEvent(
  docType: string,
  before: string | undefined,
  after: string | undefined,
): WebhookEventType | null {
  if (before === after || documentEventPrefix(docType) !== "invoice") return null;
  if (after === "paid") return "invoice.paid";
  if (after === "partially_paid") return "invoice.partially_paid";
  return null;
}
