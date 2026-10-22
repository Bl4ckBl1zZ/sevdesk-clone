/**
 * ER-03 decision and e-invoice format for a draft (INV-17/INV-18, §4.6.3, App. D). Shared by the editor badge,
 * `validateDocument` (`einvoice_required`), the finalise commit (stored in `einvoice.decision`) and the dialogs.
 */
import { type Er03Result, er03RefDate, requiresERechnung } from "../../einvoice/er03";
import { decideEinvoiceFormat, type FormatDecision } from "../../einvoice/format";
import { lookupExemptionReason } from "../../rules/exemption-reasons";
import type { CalendarDate } from "../../time/calendar-date";
import type { DocumentContext, DraftDocument, ResolvedDraft } from "../draft";
import { type EinvoiceFormat, supplyEnd } from "../snapshot";

export interface EinvoicePlan {
  readonly er03: Er03Result;
  readonly formatDecision: FormatDecision;
  /** The format the document gets: the draft's choice if allowed, else the default. */
  readonly format: EinvoiceFormat;
  /** The draft chose a format that is not allowed (e.g. `none` under MUST_E). */
  readonly chosenNotAllowed: boolean;
}

/** § 4 Nr. 8–29 UStG (R7): "8 Buchst. a" → 8. */
function exemptNr(code: string | undefined, date: CalendarDate): number | null {
  if (!code) return null;
  const r = lookupExemptionReason(code, date);
  return r.ok ? Number.parseInt(r.value.ustgNr, 10) : null;
}

export function planEinvoice(draft: DraftDocument, ctx: DocumentContext, resolved: ResolvedDraft): EinvoicePlan {
  const refDate = er03RefDate({
    docType: draft.type,
    documentDate: resolved.documentDate,
    supplyDate: resolved.supplyDate,
  });
  const original = ctx.relations?.original;
  const isAdvance = draft.type === "advance_invoice" || draft.type === "partial_invoice";
  const expectedSupplyEnd = isAdvance && resolved.supplyDate ? supplyEnd(resolved.supplyDate) : undefined;
  const priorYear = Number(refDate.slice(0, 4)) - 1;
  const turnover = ctx.company.priorYearTurnover.find((t) => t.year === priorYear);
  const c = ctx.contact;
  const items = resolved.lines;
  const allExempt4Nr8to29 =
    items.length > 0 &&
    items.every((l) => {
      if (l.vatCategory !== "E") return false;
      const nr = exemptNr(draft.lines[l.index]?.exemptionReasonCode, refDate as CalendarDate);
      return nr !== null && nr >= 8 && nr <= 29;
    });
  const er03 = requiresERechnung({
    docType: draft.type,
    taxCase: resolved.taxCase,
    hasAeLine: items.some((l) => l.vatCategory === "AE"),
    issuer: {
      isKleinunternehmer: resolved.kleinunternehmer,
      priorYearTurnover: turnover ? { cents: turnover.amountCents, final: !turnover.provisional } : null,
      ...(ctx.company.foundedOn ? { foundedOn: ctx.company.foundedOn } : {}),
    },
    recipient: {
      countryCode: c?.countryCode ?? "DE",
      isConsumer: c?.isConsumer ?? false,
      isPublicAuthority: c?.isPublicAuthority ?? false,
    },
    refDate,
    grossEurCents: Math.abs(resolved.grossEurCents ?? 0),
    allExempt4Nr8to29,
    // LEGAL-OPEN: 01 open item 11 — advances use the stricter of document date and expected supply date.
    ...(expectedSupplyEnd ? { expectedSupplyEnd } : {}),
    ...(original ? { original: { hadXml: original.hadXml, refDate: original.er03RefDate } } : {}),
  });
  const formatDecision = decideEinvoiceFormat({
    docType: draft.type,
    decision: er03.decision,
    preferredFormat: c?.preferredFormat,
    isPublicAuthority: c?.isPublicAuthority ?? false,
    isKleinunternehmer: resolved.kleinunternehmer,
    ...(original ? { originalFormat: original.format } : {}),
  });
  const chosen = draft.einvoiceFormat;
  const allowed = formatDecision.allowed.length === 0 ? [formatDecision.format] : formatDecision.allowed;
  const chosenOk = chosen !== undefined && allowed.includes(chosen);
  return {
    er03,
    formatDecision,
    format: chosenOk ? chosen : formatDecision.format,
    chosenNotAllowed: chosen !== undefined && !chosenOk,
  };
}

export const isXRechnungFormat = (f: EinvoiceFormat): boolean =>
  f === "xrechnung_cii" || f === "xrechnung_ubl" || f === "zugferd_xrechnung";

export const hasXml = (f: EinvoiceFormat): boolean => f !== "none";
