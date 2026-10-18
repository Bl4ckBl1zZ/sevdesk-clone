/** Shared shapes of the sevdesk export import (F09 §4.3, §5.3). */

export type FindingSeverity = "error" | "warning" | "info";

/**
 * One preview finding. `error` blocks the row (or the whole file when no `line` is set) until the owner fixes the
 * mapping, resolves it or excludes the row; warnings and infos are listed in the preview and the import report.
 * `code` is the F09 §5.3 case (E-IMP-xx) or EC-190 for rule deviations of historic documents.
 */
export interface ImportFinding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly message: string;
  readonly fileId?: string;
  readonly fileName?: string;
  readonly line?: number;
  /** Stable record key (`invoice:RE-1001`, contact number, article number). */
  readonly key?: string;
  /** Row reference `<fileId>:<line>` used for exclusions. */
  readonly rowRef?: string;
}

export const rowRefOf = (fileId: string, line: number): string => `${fileId}:${line}`;

/** Document types the invoice list maps to (§4.3.1; drafts and reminders are not imported). */
export type ImportedDocType =
  | "invoice"
  | "advance_invoice"
  | "partial_invoice"
  | "final_invoice"
  | "correction"
  | "cancellation";

export const IMPORTED_DOC_TYPE_LABELS: Readonly<Record<ImportedDocType, string>> = {
  invoice: "Rechnung",
  advance_invoice: "Abschlagsrechnung",
  partial_invoice: "Teilrechnung",
  final_invoice: "Schlussrechnung",
  correction: "Gutschrift/Rechnungskorrektur",
  cancellation: "Stornorechnung",
};
