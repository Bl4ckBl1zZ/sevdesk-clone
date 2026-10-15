/**
 * Document state machines (F04 DOC-02, §4.2; 03 §4 "Allowed stored status per type"; INV-02, QUO-03).
 *
 * One table per document type: `(from, event) → to`. Every status change of a sales document goes through
 * `transition()` in the model layer; pairs that are not listed throw `illegal_transition` (409). `delete` is the only
 * event without a target status (the draft row is removed and its content written to the audit log, DOC-03).
 *
 * The P1 invoice slice uses the invoice family (`finalize`, `mark_sent`, `retract_mark`, `delete`); the rows for
 * quotes, orders, delivery notes, proforma, Storno, corrections and reminders are specified here already so the later
 * slices only add their model functions (the matrix is data, T-DOC-001 exercises every pair).
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import type { SalesDocType } from "./snapshot";

export type SalesDocStatus =
  | "draft"
  | "finalized"
  | "sent"
  | "cancelled"
  | "accepted"
  | "rejected"
  | "expired"
  | "superseded"
  | "partially_invoiced"
  | "invoiced"
  | "withdrawn";

export const SALES_DOC_STATUSES: readonly SalesDocStatus[] = [
  "draft",
  "finalized",
  "sent",
  "cancelled",
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "partially_invoiced",
  "invoiced",
  "withdrawn",
];

export type LifecycleEvent =
  | "finalize"
  | "delete"
  | "mark_sent"
  | "retract_mark"
  | "cancel"
  | "accept"
  | "accept_late"
  | "reject"
  | "reopen"
  | "expire"
  | "supersede"
  | "withdraw"
  | "mark_received"
  | "invoiced_partially"
  | "invoiced_fully"
  | "invoice_reverted"
  | "invoice_reverted_sent"
  | "invoice_reverted_unsent";

export const LIFECYCLE_EVENTS: readonly LifecycleEvent[] = [
  "finalize",
  "delete",
  "mark_sent",
  "retract_mark",
  "cancel",
  "accept",
  "accept_late",
  "reject",
  "reopen",
  "expire",
  "supersede",
  "withdraw",
  "mark_received",
  "invoiced_partially",
  "invoiced_fully",
  "invoice_reverted",
  "invoice_reverted_sent",
  "invoice_reverted_unsent",
];

/** `null` target = the record is removed (draft deletion). */
type Table = Readonly<
  Partial<Record<SalesDocStatus, Readonly<Partial<Record<LifecycleEvent, SalesDocStatus | null>>>>>
>;

const DRAFT = { finalize: "finalized", delete: null } as const;

/** §4.2.5 invoice family: draft → finalized → sent (manual mark only), Storno → cancelled. No reset to draft. */
const INVOICE_FAMILY: Table = {
  draft: DRAFT,
  finalized: { mark_sent: "sent", cancel: "cancelled" },
  sent: { retract_mark: "finalized", cancel: "cancelled" },
};

/** §4.2.6 Storno: created finalised; optional mark; nothing else (EC-075). */
const CANCELLATION: Table = {
  finalized: { mark_sent: "sent" },
  sent: { retract_mark: "finalized" },
};

/** §4.2.1 quote (incl. revisions, late acceptance, reopening). */
const QUOTE: Table = {
  draft: DRAFT,
  finalized: {
    mark_sent: "sent",
    accept: "accepted",
    reject: "rejected",
    expire: "expired",
    supersede: "superseded",
    withdraw: "cancelled",
  },
  sent: {
    retract_mark: "finalized",
    accept: "accepted",
    reject: "rejected",
    expire: "expired",
    supersede: "superseded",
    withdraw: "cancelled",
  },
  expired: { accept_late: "accepted", reject: "rejected", supersede: "superseded" },
  rejected: { reopen: "sent", supersede: "superseded" },
  accepted: { withdraw: "cancelled", invoiced_partially: "partially_invoiced", invoiced_fully: "invoiced" },
  partially_invoiced: { invoiced_fully: "invoiced", invoice_reverted: "accepted" },
  invoiced: { invoiced_partially: "partially_invoiced", invoice_reverted: "accepted" },
};

/** §4.2.2 order confirmation. */
const ORDER: Table = {
  draft: DRAFT,
  finalized: {
    mark_sent: "sent",
    withdraw: "cancelled",
    invoiced_partially: "partially_invoiced",
    invoiced_fully: "invoiced",
  },
  sent: {
    retract_mark: "finalized",
    withdraw: "cancelled",
    invoiced_partially: "partially_invoiced",
    invoiced_fully: "invoiced",
  },
  partially_invoiced: { invoiced_fully: "invoiced", invoice_reverted: "sent", invoice_reverted_unsent: "finalized" },
  invoiced: {
    invoiced_partially: "partially_invoiced",
    invoice_reverted: "sent",
    invoice_reverted_unsent: "finalized",
  },
};

/** §4.2.3 delivery note ("accepted" = UI „Erhalten"). */
const DELIVERY_NOTE: Table = {
  draft: DRAFT,
  finalized: { mark_sent: "sent", mark_received: "accepted", invoiced_fully: "invoiced", withdraw: "cancelled" },
  sent: { retract_mark: "finalized", mark_received: "accepted", invoiced_fully: "invoiced", withdraw: "cancelled" },
  accepted: { invoiced_fully: "invoiced", withdraw: "cancelled" },
  // „previous status“ (§4.2.3): received → accepted, else sent or finalized.
  invoiced: { invoice_reverted: "accepted", invoice_reverted_sent: "sent", invoice_reverted_unsent: "finalized" },
};

/** §4.2.4 proforma. */
const PROFORMA: Table = {
  draft: DRAFT,
  finalized: { mark_sent: "sent", invoiced_fully: "invoiced", withdraw: "cancelled" },
  sent: { retract_mark: "finalized", invoiced_fully: "invoiced", withdraw: "cancelled" },
};

/** §4.2.7 correction (credit and rectification). */
const CORRECTION: Table = INVOICE_FAMILY;

/** F05 reminders: same pipeline, "gegenstandslos" = cancelled (DUN-009). */
const REMINDER: Table = INVOICE_FAMILY;

const TABLES: Readonly<Record<SalesDocType, Table>> = {
  invoice: INVOICE_FAMILY,
  advance_invoice: INVOICE_FAMILY,
  partial_invoice: INVOICE_FAMILY,
  final_invoice: INVOICE_FAMILY,
  self_billing: INVOICE_FAMILY,
  cancellation: CANCELLATION,
  correction: CORRECTION,
  quote: QUOTE,
  order_confirmation: ORDER,
  delivery_note: DELIVERY_NOTE,
  proforma: PROFORMA,
  reminder: REMINDER,
};

const STATUS_LABEL_DE: Readonly<Record<SalesDocStatus, string>> = {
  draft: "Entwurf",
  finalized: "fertiggestellt",
  sent: "versendet",
  cancelled: "storniert",
  accepted: "angenommen",
  rejected: "abgelehnt",
  expired: "abgelaufen",
  superseded: "ersetzt",
  partially_invoiced: "teilberechnet",
  invoiced: "berechnet",
  withdrawn: "widerrufen",
};

export type IllegalTransition = Issue<"illegal_transition">;

/** The status after `event`, `null` for a deleted draft, or `illegal_transition`. */
export function transition(
  type: SalesDocType,
  from: SalesDocStatus,
  event: LifecycleEvent,
): Result<SalesDocStatus | null, IllegalTransition> {
  const row = TABLES[type][from];
  if (row && event in row) return ok(row[event] as SalesDocStatus | null);
  return err(
    issue(
      "illegal_transition",
      `Diese Aktion ist für ein Dokument im Status „${STATUS_LABEL_DE[from]}“ nicht möglich.`,
      { type, from, event },
    ),
  );
}

/** Whether `(from, event)` is allowed for `type`. */
export const canTransition = (type: SalesDocType, from: SalesDocStatus, event: LifecycleEvent): boolean =>
  transition(type, from, event).ok;

/** Stored statuses a type can have (03 §4 table). */
export function statusesOf(type: SalesDocType): SalesDocStatus[] {
  const table = TABLES[type];
  const out = new Set<SalesDocStatus>(Object.keys(table) as SalesDocStatus[]);
  for (const row of Object.values(table)) {
    for (const to of Object.values(row ?? {})) if (to) out.add(to);
  }
  return SALES_DOC_STATUSES.filter((s) => out.has(s));
}

/** Types whose finalised documents are invoices in the sense of § 14 UStG (journal, payment status, ER-03). */
export const INVOICE_FAMILY_TYPES: readonly SalesDocType[] = [
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
];
