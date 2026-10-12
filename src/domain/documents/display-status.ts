/**
 * Display status (F04 §4.2.9, DOC-55): one pure function shared by lists, the API field `display_status` and MCP.
 * "Überfällig" is derived here and never stored (03 §4). `today` is the Europe/Berlin calendar date.
 */
import type { SalesDocStatus } from "./lifecycle";
import type { SalesDocType } from "./snapshot";

export type PaymentStatus = "open" | "partially_paid" | "paid" | "credited" | "written_off";
export type ArtifactStatus = "pending" | "ready" | "blocked";

export type DisplayStatus =
  | "draft"
  | "cancellation"
  | "cancelled"
  | "blocked"
  | "accepted"
  | "rejected"
  | "expired"
  | "superseded"
  | "partially_invoiced"
  | "invoiced"
  | "paid"
  | "written_off"
  | "refund_open"
  | "overdue"
  | "partially_paid"
  | "open"
  | "unsent";

export interface DisplayStatusInput {
  type: SalesDocType;
  status: SalesDocStatus;
  paymentStatus?: PaymentStatus;
  artifactStatus?: ArtifactStatus;
  openAmountCents?: number;
  dueDate?: string;
  correctionKind?: "credit" | "rectification";
}

export interface DisplayStatusResult {
  token: DisplayStatus;
  label: string;
  /** „Überfällig“ of a partially paid invoice also shows „Teilbezahlt“. */
  partiallyPaid?: boolean;
}

const QUOTE_LIKE: ReadonlyArray<SalesDocStatus> = [
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "partially_invoiced",
  "invoiced",
];

export const DISPLAY_STATUS_LABELS: Readonly<Record<DisplayStatus, string>> = {
  draft: "Entwurf",
  cancellation: "Storno",
  cancelled: "Storniert",
  blocked: "Gesperrt (E-Rechnung)",
  accepted: "Angenommen",
  rejected: "Abgelehnt",
  expired: "Abgelaufen",
  superseded: "Ersetzt",
  partially_invoiced: "Teilberechnet",
  invoiced: "Berechnet",
  paid: "Bezahlt",
  written_off: "Abgeschrieben",
  refund_open: "Erstattung offen",
  overdue: "Überfällig",
  partially_paid: "Teilbezahlt",
  open: "Offen",
  unsent: "Nicht versendet",
};

const result = (token: DisplayStatus, label = DISPLAY_STATUS_LABELS[token]): DisplayStatusResult => ({
  token,
  label,
});

/** §4.2.9: first matching row wins. */
export function displayStatus(doc: DisplayStatusInput, today: string): DisplayStatusResult {
  if (doc.status === "draft") return result("draft");
  if (doc.type === "cancellation") return result("cancellation");
  if (doc.status === "cancelled") return result("cancelled");
  if (doc.artifactStatus === "blocked") return result("blocked");
  if (QUOTE_LIKE.includes(doc.status)) {
    const token = doc.status as DisplayStatus;
    if (doc.type === "delivery_note" && doc.status === "accepted") return result("accepted", "Erhalten");
    return result(token);
  }
  if (doc.paymentStatus === "paid" || doc.paymentStatus === "credited") {
    return result("paid", doc.type === "correction" ? "Erstattet" : DISPLAY_STATUS_LABELS.paid);
  }
  if (doc.paymentStatus === "written_off") return result("written_off");
  if ((doc.openAmountCents ?? 0) < 0) return result("refund_open");
  const unpaid = doc.paymentStatus === "open" || doc.paymentStatus === "partially_paid";
  if (unpaid && doc.dueDate !== undefined && doc.dueDate < today) {
    return doc.paymentStatus === "partially_paid"
      ? { token: "overdue", label: DISPLAY_STATUS_LABELS.overdue, partiallyPaid: true }
      : result("overdue");
  }
  if (doc.paymentStatus === "partially_paid") return result("partially_paid");
  if (doc.status === "sent") return result("open");
  return result("unsent");
}
