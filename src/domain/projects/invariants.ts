/**
 * P4 regulatory invariants (10-edge-cases §2), pure over rows the caller loads:
 *  - RI-30 (F03 PRD-090/092): every product's cached `stock.quantityMilli` equals Σ of its stock movements, and every
 *    `correction` that reverses a movement has the opposite quantity.
 *  - RI-31 (F11 PRJ-012/019): every `invoiced` time entry points at a line of a finalised document that lists the
 *    entry, carries `lockedAt` and the document's `retentionUntil`; every `in_draft` entry is listed by a line of its
 *    (still draft) document.
 */
export interface InvariantFinding {
  readonly id: "RI-30" | "RI-31";
  readonly severity: "ERROR" | "WARN";
  readonly message: string;
}

export function checkStockCaches(
  products: readonly { id: string; label: string; quantityMilli?: number | undefined }[],
  movements: readonly { id: string; productId: string; quantityMilli: number; reversesId?: string | undefined }[],
): InvariantFinding[] {
  const out: InvariantFinding[] = [];
  const sums = new Map<string, number>();
  const byId = new Map(movements.map((m) => [m.id, m]));
  for (const m of movements) {
    sums.set(m.productId, (sums.get(m.productId) ?? 0) + m.quantityMilli);
    if (m.reversesId) {
      const original = byId.get(m.reversesId);
      if (!original || original.quantityMilli !== -m.quantityMilli || original.productId !== m.productId) {
        out.push({
          id: "RI-30",
          severity: "ERROR",
          message: `Bestandskorrektur ${m.id} kehrt ${m.reversesId} nicht exakt um.`,
        });
      }
    }
  }
  for (const p of products) {
    const sum = sums.get(p.id) ?? 0;
    if ((p.quantityMilli ?? 0) !== sum) {
      out.push({
        id: "RI-30",
        severity: "ERROR",
        message: `Bestand von ${p.label} (${p.quantityMilli ?? 0}) weicht von der Summe der Buchungen (${sum}) ab.`,
      });
    }
  }
  return out;
}

export interface EntryRow {
  readonly id: string;
  readonly status: "open" | "in_draft" | "invoiced";
  readonly draftDocumentId?: string | undefined;
  readonly invoicedLineId?: string | undefined;
  readonly invoicedDocumentId?: string | undefined;
  readonly lockedAt?: number | undefined;
  readonly retentionUntil?: string | undefined;
}

export function checkTimeEntryLocks(
  entries: readonly EntryRow[],
  lines: ReadonlyMap<string, { documentId: string; timeEntryIds: readonly string[] }>,
  docs: ReadonlyMap<string, { status: string; retentionUntil?: string | undefined; lineEntryIds: ReadonlySet<string> }>,
): InvariantFinding[] {
  const out: InvariantFinding[] = [];
  const bad = (e: EntryRow, why: string) =>
    out.push({ id: "RI-31", severity: "ERROR", message: `Zeiteintrag ${e.id}: ${why}` });
  for (const e of entries) {
    if (e.status === "invoiced") {
      const line = e.invoicedLineId ? lines.get(e.invoicedLineId) : undefined;
      const doc = line ? docs.get(line.documentId) : undefined;
      if (!line?.timeEntryIds.includes(e.id)) bad(e, "abgerechnet ohne passende Rechnungsposition.");
      else if (!doc || doc.status === "draft" || line.documentId !== e.invoicedDocumentId) {
        bad(e, "abgerechnet, aber die Rechnung ist nicht fertiggestellt.");
      } else if (e.lockedAt === undefined || e.retentionUntil !== doc.retentionUntil) {
        bad(e, "abgerechnet ohne Sperre oder Aufbewahrungsfrist der Rechnung.");
      }
    } else if (e.status === "in_draft") {
      const doc = e.draftDocumentId ? docs.get(e.draftDocumentId) : undefined;
      if (doc?.status !== "draft" || !doc.lineEntryIds.has(e.id)) {
        bad(e, "als „Im Entwurf“ markiert, aber in keinem Rechnungsentwurf enthalten.");
      }
    }
  }
  return out;
}
