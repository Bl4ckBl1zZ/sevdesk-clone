/**
 * F04 §5.1.6 chain and correction findings: advance/partial/final invoices (INV-03…08, EC-070/071/078) and
 * Storno/Rechnungskorrektur/Rechnungsberichtigung drafts (INV-12/13, RI-07). Called by `validateDocument()`.
 */
import { lookupVatRate } from "../../rules/vat-rates";
import { type CalendarDate, formatGermanDate } from "../../time/calendar-date";
import { finalChainFindings, partialExceedsOrder } from "../advances";
import { creditCapFindings, detectRectifiedFields, rectificationFindings } from "../corrections";
import type { DocumentContext, DraftDocument, ResolvedDraft } from "../draft";
import { lineSupplyRange } from "../draft";
import { htmlToPlainText } from "../finalize";
import { groupsOfTotals, isAdvanceType, isChainType } from "../relations";
import type { DocumentSnapshot, SnapshotLine } from "../snapshot";
import { type Finding, finding } from "./finding";

const de = (d: string) => formatGermanDate(d as CalendarDate);

export function chainFindings(draft: DraftDocument, ctx: DocumentContext, resolved: ResolvedDraft): Finding[] {
  const out: Finding[] = [];
  const rel = ctx.relations;
  const groups = resolved.totals ? groupsOfTotals(resolved.totals.groups) : [];

  if (isChainType(draft.type)) {
    const chain = rel?.chain;
    if (!chain) {
      out.push(
        finding(
          "chain_reference_missing",
          "E",
          "UST-41",
          "pflichtangaben",
          "Für Abschlags-, Teil- und Schlussrechnungen fehlt der Auftragsbezug (Auftrag/Angebot oder Bestellnummer mit Datum).",
          { field: "chainOrder" },
        ),
      );
      return out;
    }
    if (isAdvanceType(draft.type)) {
      if (chain.orderGroups) out.push(...partialExceedsOrder(chain.orderGroups, chain.earlierAdvances, groups));
      out.push(...advanceRateFindings(draft, resolved));
    } else {
      out.push(
        ...finalChainFindings(
          { documentDate: resolved.documentDate, currency: draft.currency, taxCase: resolved.taxCase },
          chain.final,
        ),
      );
    }
  }

  if (draft.type === "correction" || draft.type === "cancellation") {
    const o = rel?.original;
    if (!o) {
      out.push(
        finding(
          "original_reference_missing",
          "E",
          "UST-30",
          "pflichtangaben",
          "Für Storno und Korrekturen fehlt die Originalrechnung.",
        ),
      );
      return out;
    }
    if (resolved.documentDate < o.documentDate) {
      out.push(
        finding(
          "date_before_original",
          "E",
          "UST-30",
          "pflichtangaben",
          `Das Datum darf nicht vor dem Datum der Originalrechnung ${o.number} (${de(o.documentDate)}) liegen.`,
          { field: "documentDate", params: { number: o.number, date: o.documentDate } },
        ),
      );
    }
    if (draft.currency !== o.currency) {
      out.push(
        finding(
          "correction_currency_mismatch",
          "E",
          "UST-30",
          "pflichtangaben",
          `Die Korrektur muss in der Währung der Originalrechnung (${o.currency}) erstellt werden.`,
          { field: "currency", params: { currency: o.currency } },
        ),
      );
    }
    if (draft.type === "correction" && draft.correctionKind === "rectification") {
      const changed = detectRectifiedFields(o.snapshot, rectificationView(draft, ctx, resolved, o.snapshot));
      out.push(...rectificationFindings(o.groups, groups, changed));
    } else if (draft.type === "correction") {
      out.push(...creditCapFindings(o.groups, o.earlierCredits, groups, o.currency));
    }
  }
  return out;
}

/** §4.7: advances use the rate at their document date; warn if the expected supply date resolves differently. */
function advanceRateFindings(draft: DraftDocument, resolved: ResolvedDraft): Finding[] {
  const supply = resolved.supplyDate;
  if (!supply) return [];
  const out: Finding[] = [];
  for (const line of resolved.lines) {
    const l = draft.lines[line.index];
    if (!l || line.vatCategory !== "S") continue;
    const range = lineSupplyRange(l, supply);
    if (!range) continue;
    const at = lookupVatRate(l.vatRateKey ?? "standard", range.to as CalendarDate);
    if (at.ok && at.value.value.rateBp !== line.vatRateBp) {
      out.push(
        finding(
          "advance_rate_differs",
          "W",
          "UST-41",
          "steuern",
          `Position ${line.position}: Zum voraussichtlichen Leistungszeitpunkt (${de(range.to)}) gilt ${at.value.value.rateBp / 100} % statt ${line.vatRateBp / 100} %. Die Abschlagsrechnung verwendet den Satz am Rechnungsdatum; die Schlussrechnung korrigiert die Steuer.`,
          { field: `lines.${line.index}`, params: { n: line.position, rate: at.value.value.rateBp, date: range.to } },
        ),
      );
    }
  }
  return out;
}

/** The formal data the Berichtigung would freeze, in the shape `detectRectifiedFields` compares (INV-13). */
export function rectificationView(
  draft: DraftDocument,
  ctx: DocumentContext,
  resolved: ResolvedDraft,
  original: Pick<DocumentSnapshot, "buyer" | "seller" | "supplyDate" | "lines" | "references" | "delivery">,
): Pick<DocumentSnapshot, "buyer" | "seller" | "supplyDate" | "lines" | "references" | "delivery"> {
  const lines: SnapshotLine[] = draft.lines.map((l) => {
    if (l.kind === "heading" || l.kind === "text") return { kind: l.kind, text: l.name ?? l.description ?? "" };
    if (l.kind === "subtotal") return { kind: "subtotal", text: l.name ?? "", amountCents: 0 };
    return {
      kind: "item",
      name: l.name ?? "",
      ...(l.description ? { description: htmlToPlainText(l.description) } : {}),
      quantityMilli: l.quantityMilli ?? 0,
      unitCode: l.unitCode ?? "C62",
      unitPriceMicros: l.unitPriceMicros ?? 0,
      ...(l.linePeriod ? { period: l.linePeriod } : {}),
    } as SnapshotLine;
  });
  const ref = (v: string | undefined) => (v?.trim() ? v.trim() : undefined);
  return {
    buyer: ctx.contact?.buyer ?? original.buyer,
    seller: { ...original.seller, taxNumber: ctx.company.seller.taxNumber, vatId: ctx.company.seller.vatId },
    ...(resolved.supplyDate ? { supplyDate: resolved.supplyDate } : {}),
    lines,
    references: {
      ...original.references,
      buyerReference: ref(draft.buyerReference) ?? original.references.buyerReference,
      orderReference: ref(draft.orderReference),
      contractReference: ref(draft.contractReference),
    },
    ...(draft.deliveryAddress ? { delivery: { address: draft.deliveryAddress } } : {}),
  } as Pick<DocumentSnapshot, "buyer" | "seller" | "supplyDate" | "lines" | "references" | "delivery">;
}
