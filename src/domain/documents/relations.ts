/**
 * Related documents of a draft (F04 §5.1.6, §4.7, §4.8): the chain of an advance/partial/final invoice and the
 * original of a Storno or correction. The model layer reads them (convex/model/documentRelations.ts) and passes
 * them in `DocumentContext.relations`; the validator, the einvoice plan and the snapshot input use them. Pure types
 * and helpers.
 */
import type { FinalChain, GroupAmount } from "./advances";
import type { DocumentSnapshot, EinvoiceFormat, SalesDocType } from "./snapshot";
import type { VatGroupTotals } from "./totals";

/** What an advance/partial/final invoice refers to: the order/quote of the chain, or a standalone order reference. */
export interface ChainContext {
  readonly rootId: string;
  readonly orderLabel: { readonly de: string; readonly en: string };
  /** Number of the order/quote, or the standalone order reference (`chainOrder.number`). */
  readonly orderNumber: string;
  readonly orderDate: string;
  /** 1-based position among the advances/partials of the chain ("2. Abschlagsrechnung"). */
  readonly index: number;
  /** Net/VAT per group of the order (EC-078 limit); absent for standalone chains. */
  readonly orderGroups?: readonly GroupAmount[] | undefined;
  /** VAT groups of the other non-cancelled advances/partials of the chain (EC-078). */
  readonly earlierAdvances: readonly (readonly GroupAmount[])[];
  /** Final invoice: the advances to deduct and a competing final (INV-06/07). */
  readonly final: FinalChain;
}

/** The original of a Storno/correction (INV-10…15). */
export interface OriginalContext {
  readonly id: string;
  readonly type: SalesDocType;
  readonly status: string;
  readonly number: string;
  readonly documentDate: string;
  readonly correctionKind?: "credit" | "rectification" | undefined;
  readonly currency: string;
  /** VAT groups of the original's snapshot. */
  readonly groups: readonly GroupAmount[];
  /** The original carried an XML (an E-Rechnung): its corrections must be E-Rechnungen too (ER-03 R1). */
  readonly hadXml: boolean;
  readonly format: EinvoiceFormat;
  /** ER-03 reference date of the original. */
  readonly er03RefDate: string;
  /** Finalised, non-cancelled credit corrections of the same original (RI-07). */
  readonly earlierCredits: readonly (readonly GroupAmount[])[];
  /** Earlier corrections of the same original (INV-15: extra BG-3 entries). */
  readonly earlierCorrections: readonly { readonly number: string; readonly date: string }[];
  /** Frozen data of the original, for the Berichtigung comparison (INV-13). */
  readonly snapshot: Pick<DocumentSnapshot, "buyer" | "seller" | "supplyDate" | "lines" | "references" | "delivery">;
}

export interface DocumentRelations {
  readonly chain?: ChainContext | undefined;
  readonly original?: OriginalContext | undefined;
}

export const CHAIN_TYPES: readonly SalesDocType[] = ["advance_invoice", "partial_invoice", "final_invoice"];
export const isChainType = (t: SalesDocType): boolean => CHAIN_TYPES.includes(t);
export const isAdvanceType = (t: SalesDocType): boolean => t === "advance_invoice" || t === "partial_invoice";

/** Resolved totals → net/VAT per group (signed). */
export const groupsOfTotals = (groups: readonly VatGroupTotals[]): GroupAmount[] =>
  groups.map((g) => ({ category: g.vatCategory, rateBp: g.rateBp, netCents: g.baseCents, vatCents: g.vatCents }));

/** Snapshot VAT breakdown → net/VAT per group. */
export const groupsOfSnapshot = (s: Pick<DocumentSnapshot, "totals">): GroupAmount[] =>
  s.totals.byGroup.map((g) => ({
    category: g.category,
    rateBp: g.rateBp,
    netCents: g.baseCents,
    vatCents: g.vatCents,
  }));

/** Label of the chain root in the advance/final notes ("zu Auftrag AB-2026-0007 vom …"). */
export function chainOrderLabel(rootType: SalesDocType | "standalone"): { de: string; en: string } {
  if (rootType === "quote") return { de: "Angebot", en: "quote" };
  return { de: "Auftrag", en: "order" };
}
