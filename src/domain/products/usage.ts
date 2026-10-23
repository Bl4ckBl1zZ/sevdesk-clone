import { toEurCents } from "../contacts/stats";

/**
 * F03 PRD-074: product usage tab — every document whose lines reference the product (`documentLines.productId`, any
 * status), plus units sold and net revenue (EUR) this and last calendar year from the lines of **finalised** invoices
 * (Storno and Rechnungskorrektur lines count with their sign; quotes, orders, delivery notes and drafts do not).
 */
export interface UsageLine {
  readonly documentId: string;
  readonly number?: string | undefined;
  readonly type: string;
  readonly status: string;
  readonly documentDate?: string | undefined;
  readonly contactName?: string | undefined;
  readonly currency: string;
  readonly fxRateToEur?: string | undefined;
  readonly quantityMilli: number;
  readonly netCents: number;
}

export interface ProductUsage {
  readonly documents: readonly {
    readonly documentId: string;
    readonly number: string | null;
    readonly type: string;
    readonly status: string;
    readonly documentDate: string | null;
    readonly contactName: string | null;
    readonly quantityMilli: number;
  }[];
  readonly thisYear: { readonly unitsMilli: number; readonly revenueCents: number };
  readonly lastYear: { readonly unitsMilli: number; readonly revenueCents: number };
}

const SOLD = new Set(["invoice", "partial_invoice", "final_invoice", "cancellation", "correction"]);

export function productUsage(lines: readonly UsageLine[], today: string): ProductUsage {
  const year = Number(today.slice(0, 4));
  const byDoc = new Map<string, ProductUsage["documents"][number]>();
  const thisYear = { unitsMilli: 0, revenueCents: 0 };
  const lastYear = { unitsMilli: 0, revenueCents: 0 };
  for (const l of lines) {
    const prev = byDoc.get(l.documentId);
    byDoc.set(l.documentId, {
      documentId: l.documentId,
      number: l.number ?? null,
      type: l.type,
      status: l.status,
      documentDate: l.documentDate ?? null,
      contactName: l.contactName ?? null,
      quantityMilli: (prev?.quantityMilli ?? 0) + l.quantityMilli,
    });
    if (!SOLD.has(l.type) || l.status === "draft" || !l.documentDate) continue;
    const y = Number(l.documentDate.slice(0, 4));
    const bucket = y === year ? thisYear : y === year - 1 ? lastYear : null;
    if (!bucket) continue;
    bucket.unitsMilli += l.quantityMilli;
    bucket.revenueCents += toEurCents(l.netCents, l);
  }
  const documents = [...byDoc.values()].sort((a, b) =>
    (b.documentDate ?? "9999").localeCompare(a.documentDate ?? "9999"),
  );
  return { documents, thisYear, lastYear };
}
