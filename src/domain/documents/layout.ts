/**
 * Layout rules (F01 SET-014, SET-070…075, §6.6). Pure; the Convex model stores layouts and immutable versions.
 */

/** Sales document types that have a layout (03 `SalesDocType` minus P3 self-billing). */
export const SALES_DOC_TYPES = [
  "quote",
  "order_confirmation",
  "delivery_note",
  "proforma",
  "invoice",
  "advance_invoice",
  "partial_invoice",
  "final_invoice",
  "cancellation",
  "correction",
  "reminder",
] as const;
export type LayoutDocType = (typeof SALES_DOC_TYPES)[number];

/**
 * The print-option switches of §6.6. There is deliberately **no footer switch** (SET-014): the Geschäftsbrief
 * footer is always printed; the only exception is the audited letterhead confirmation `footerInLetterhead` (SET-075).
 */
export const PRINT_OPTION_KEYS = [
  "foldMarks",
  "pageNumbers",
  "senderLine",
  "vatPerLine",
  "productNumbers",
  "lineDescriptions",
  "grossLineTotals",
  "epcQr",
  "portalQr",
  "allInvoiceAccountsInFooter",
] as const;

/** SET-014/075: the footer is hidden only when the letterhead confirmation covers every legal-form item. */
export function footerVisible(
  printOptions: { footerInLetterhead: { confirmedAt: number; items: readonly string[] } | null },
  requiredItems: readonly string[],
): boolean {
  const c = printOptions.footerInLetterhead;
  if (!c) return true;
  return !requiredItems.every((i) => c.items.includes(i));
}

export interface LayoutRef<Id extends string = string> {
  id: Id;
  isDefaultFor: readonly string[];
}

/** SET-074: a draft's chosen layout (if it still exists), else the default for its type, else the first layout. */
export function resolveLayoutId<Id extends string>(
  layouts: readonly LayoutRef<Id>[],
  docType: string,
  chosen?: string,
): Id | null {
  if (chosen) {
    const c = layouts.find((l) => l.id === chosen);
    if (c) return c.id;
  }
  return (layouts.find((l) => l.isDefaultFor.includes(docType)) ?? layouts[0])?.id ?? null;
}

/** SET-074: `layoutId` becomes the default for `docTypes`; they are removed from every other layout. */
export function setDefaultLayout<Id extends string>(
  layouts: readonly LayoutRef<Id>[],
  layoutId: Id,
  docTypes: readonly string[],
): LayoutRef<Id>[] {
  return layouts.map((l) =>
    l.id === layoutId
      ? { id: l.id, isDefaultFor: [...new Set([...l.isDefaultFor, ...docTypes])] }
      : { id: l.id, isDefaultFor: l.isDefaultFor.filter((t) => !docTypes.includes(t)) },
  );
}

/** SET-073: sample types offered by the layout preview. */
export const PREVIEW_SAMPLE_TYPES = ["invoice", "quote", "reminder", "delivery_note"] as const;
export type PreviewSampleType = (typeof PREVIEW_SAMPLE_TYPES)[number];
