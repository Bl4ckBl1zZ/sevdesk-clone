/**
 * RI-17 (10-edge-cases §2, KU-01/02/03): invoices finalised while the Kleinunternehmerregelung applied show no VAT;
 * invoices finalised after the KU limit was crossed show VAT. Pure, evaluated on the frozen snapshot;
 * convex/model/invariants.ts feeds it every finalised invoice-type document.
 *
 * - ERROR: the snapshot contradicts itself — the seller block says KU (status at the supply date, KU-02) but the
 *   document charges VAT or uses a regular tax case, or the seller is not KU but the document is a KU document
 *   (tax case `kleinunternehmer` / category KU, i.e. VAT withheld without the § 19 basis).
 * - WARN: the KU history as stored today disagrees with the snapshot (a retroactive entry, e.g. EC-061: the prior
 *   year turned out > 25.000 € after closing). F01 SET-034 allows that only with a reason and lists the affected
 *   documents for a Rechnungsberichtigung or Storno — the warning keeps them visible. Storno and corrections copy the
 *   original's seller block (F01 SET-022) and the self-billing Gutschrift carries the supplier's status, so those are
 *   not compared with our history.
 */
import { type DocumentSnapshot, isInvoiceType, type SalesDocType, supplyEnd } from "../documents/snapshot";

export interface KuInvariantFinding {
  readonly id: "RI-17";
  readonly severity: "ERROR" | "WARN";
  readonly message: string;
}

export interface KuInvariantDoc {
  readonly name: string;
  readonly type: SalesDocType;
  readonly imported?: boolean | undefined;
  readonly snapshot: Pick<DocumentSnapshot, "seller" | "taxCase" | "totals" | "supplyDate" | "documentDate">;
}

/** Date the KU status is resolved by (F04: end of the supply date, else the document date). */
function kuReferenceDate(s: KuInvariantDoc["snapshot"]): string {
  return s.supplyDate ? supplyEnd(s.supplyDate) : s.documentDate;
}

function kuAt(history: readonly { readonly validFrom: string; readonly isKU: boolean }[], date: string): boolean {
  let found: boolean | undefined;
  for (const e of [...history].sort((a, b) => a.validFrom.localeCompare(b.validFrom))) {
    if (e.validFrom <= date) found = e.isKU;
  }
  return found ?? false;
}

const COPIES_SELLER: readonly SalesDocType[] = ["cancellation", "correction", "self_billing"];

export function checkKleinunternehmerDocument(
  d: KuInvariantDoc,
  history: readonly { readonly validFrom: string; readonly isKU: boolean }[],
): KuInvariantFinding[] {
  if (d.imported || !isInvoiceType(d.type) || d.snapshot.taxCase === "unknown_imported") return [];
  const s = d.snapshot;
  const out: KuInvariantFinding[] = [];
  const err = (message: string) => out.push({ id: "RI-17", severity: "ERROR", message });
  const groups = s.totals.byGroup;
  const kuDocument = s.taxCase === "kleinunternehmer" || groups.some((g) => g.category === "KU");
  if (s.seller.kleinunternehmer) {
    if (s.totals.vatCents !== 0 || groups.some((g) => g.vatCents !== 0 || g.rateBp !== 0)) {
      err(`${d.name}: als Kleinunternehmer festgeschrieben, weist aber Umsatzsteuer aus (§ 19 UStG).`);
    }
    if (s.taxCase === "domestic" || groups.some((g) => g.category === "S")) {
      err(`${d.name}: als Kleinunternehmer festgeschrieben, aber mit regulärem Steuerfall.`);
    }
  } else if (kuDocument) {
    err(
      `${d.name}: ohne Kleinunternehmerstatus festgeschrieben, aber als Kleinunternehmer-Rechnung ohne Umsatzsteuer.`,
    );
  }
  if (!COPIES_SELLER.includes(d.type) && history.length > 0) {
    const date = kuReferenceDate(s);
    const now = kuAt(history, date);
    if (now !== s.seller.kleinunternehmer) {
      out.push({
        id: "RI-17",
        severity: "WARN",
        message: now
          ? `${d.name}: Laut Kleinunternehmer-Historie galt am ${date} die Kleinunternehmerregelung, die Rechnung weist aber Umsatzsteuer aus — Rechnungsberichtigung prüfen.`
          : `${d.name}: Laut Kleinunternehmer-Historie war die Grenze am ${date} überschritten, die Rechnung weist keine Umsatzsteuer aus — Rechnungsberichtigung prüfen.`,
      });
    }
  }
  return out;
}
