/**
 * E-invoice format selection `decideEinvoiceFormat` (F04 §4.6.3, INV-17, CON-080) and the artifact plan per format
 * (§4.10.2, ER-03 "format decision"): ZUGFeRD hybrid PDF by default, XRechnung UBL for public authorities, a plain
 * PDF/A-3b for Kleinunternehmer without a preference; never `none` when ER-03 says `MUST_E` (EC-DOC-74).
 */
import type { EinvoiceFormat, Er03Decision, SalesDocType } from "../documents/snapshot";

/** Contact preference (F02 CON-080). */
export type PreferredFormat = "auto" | "zugferd" | "xrechnung_cii" | "xrechnung_ubl" | "pdf";

export interface FormatDecision {
  readonly format: EinvoiceFormat;
  /** Alternatives the editor may offer. */
  readonly allowed: readonly EinvoiceFormat[];
  /** Shown in the editor/finalise dialog, e.g. EC-090. */
  readonly notice?: string;
}

const E_FORMATS: readonly EinvoiceFormat[] = ["zugferd_en16931", "zugferd_xrechnung", "xrechnung_cii", "xrechnung_ubl"];
const NON_INVOICE: readonly SalesDocType[] = ["quote", "order_confirmation", "delivery_note", "proforma", "reminder"];

export function decideEinvoiceFormat(input: {
  readonly docType: SalesDocType;
  readonly decision: Er03Decision;
  readonly preferredFormat?: PreferredFormat | undefined;
  readonly isPublicAuthority: boolean;
  readonly isKleinunternehmer: boolean;
  /** Cancellation/correction: the format of the original (its format family is kept). */
  readonly originalFormat?: EinvoiceFormat | undefined;
}): FormatDecision {
  const pref = input.preferredFormat ?? "auto";
  const mustE = input.decision === "MUST_E";
  if (NON_INVOICE.includes(input.docType)) return { format: "none", allowed: [] };
  if ((input.docType === "cancellation" || input.docType === "correction") && input.originalFormat !== undefined) {
    if (input.originalFormat === "none" && mustE) return { format: "zugferd_en16931", allowed: E_FORMATS };
    return { format: input.originalFormat, allowed: [input.originalFormat] };
  }
  if (input.isPublicAuthority) {
    return { format: "xrechnung_ubl", allowed: ["xrechnung_ubl", "xrechnung_cii", "zugferd_xrechnung"] };
  }
  if (pref === "xrechnung_cii" || pref === "xrechnung_ubl") return { format: pref, allowed: E_FORMATS };
  if (pref === "pdf") {
    return mustE
      ? {
          format: "zugferd_en16931",
          allowed: E_FORMATS,
          notice: "E-Rechnung ist Pflicht – PDF-Wunsch des Kunden kann nicht erfüllt werden",
        }
      : { format: "none", allowed: ["none", ...E_FORMATS] };
  }
  if (input.isKleinunternehmer && pref === "auto" && !mustE) {
    // LEGAL-OPEN: 01 open item 2 — KU XML category/VATEX undecided by KoSIT/BMF; KU default stays a plain PDF.
    return { format: "none", allowed: ["none", "zugferd_en16931"] };
  }
  return { format: "zugferd_en16931", allowed: mustE ? E_FORMATS : [...E_FORMATS, "none"] };
}

/** Artifact kinds produced for a format (03 `documentArtifacts.kind`, §4.10.2 default export). */
export function artifactKindFor(format: EinvoiceFormat): "zugferd_pdf" | "xrechnung_xml" | "pdf" {
  if (format === "zugferd_en16931" || format === "zugferd_xrechnung") return "zugferd_pdf";
  if (format === "xrechnung_cii" || format === "xrechnung_ubl") return "xrechnung_xml";
  return "pdf";
}
