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

/** The company's Kleinunternehmer history (F01 SET-033, `companyProfile.kleinunternehmer`), sorted or not. */
export type KuHistory = readonly { readonly validFrom: string; readonly isKU: boolean }[];

export const rowRefOf = (fileId: string, line: number): string => `${fileId}:${line}`;

/**
 * F09 IMP-007 / EC-201 / EC-204: an imported document that was archived without a journal entry — its receivable (if
 * any) is the F08 opening item. Documents posted at import (`origin.posted`, E-IMP-10) are receivables of their own.
 */
export const isArchiveOnlyImport = (d: {
  readonly imported?: boolean;
  readonly origin?: { readonly posted?: boolean };
}): boolean => d.imported === true && d.origin?.posted !== true;

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
