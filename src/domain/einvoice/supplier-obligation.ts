/**
 * E-Rechnung obligation of the supplier (F06 INB-047, EC-INB-10, EC-102): the inverse use of ER-03
 * `requiresERechnung` with the supplier as issuer and us as the (domestic, business) recipient. A PDF or paper
 * invoice for a supply whose ER-03 decision is MUST_E for every supplier (rule R11, the mandatory phase from the
 * `einvoice_obligation` table, supply date — not invoice date — per § 27 Abs. 38 UStG) gets a warning: the input VAT
 * deduction needs an E-Rechnung. In the turnover-threshold phase (R10u: the supplier's prior-year turnover is unknown
 * to us) only an info is shown. Kleinbetrag (§ 33 UStDV, date-effective limit), KU suppliers, foreign suppliers,
 * non-business supplies and Fahrausweise are never warned. No date or amount is hard-coded here. Pure.
 */
import { requiresERechnung } from "./er03";

export interface SupplierObligationInput {
  /** The received document is a structured E-Rechnung (not MINIMUM/BASIC-WL, not a Formatfehler). */
  isEInvoice: boolean;
  supplierCountryCode?: string;
  supplierIsKu: boolean;
  /** B2B supply (the voucher is a business expense); false for private purchases. */
  b2b: boolean;
  /** End of the supply (BT-72, BG-14 end, or the invoice date if unknown). */
  supplyEnd: string;
  grossEurCents: number;
  /** Fahrausweise (§ 34 UStDV) are exempt from the E-Rechnung obligation. */
  isFahrausweis?: boolean;
}

export interface SupplierObligationNote {
  severity: "warning" | "info";
  code: "einvoice_required_from_supplier" | "einvoice_transition_info";
  message: string;
}

export const SUPPLIER_OBLIGATION_MESSAGES = {
  warning:
    "Für Leistungen ab 01.01.2028 muss ein inländischer Lieferant eine E-Rechnung ausstellen. Eine PDF-Rechnung berechtigt nicht zum Vorsteuerabzug. Bitte E-Rechnung anfordern.",
  info: "Übergangszeit: Lieferanten mit mehr als 800.000 € Vorjahresumsatz müssen für diese Leistung bereits eine E-Rechnung ausstellen. Bitte ggf. E-Rechnung anfordern.",
} as const;

export function supplierEinvoiceObligation(input: SupplierObligationInput): SupplierObligationNote | null {
  if (input.isEInvoice || !input.b2b || input.isFahrausweis) return null;
  const country = (input.supplierCountryCode ?? "DE").toUpperCase();
  if (country !== "DE") return null;
  const r = requiresERechnung({
    docType: "invoice",
    taxCase: "domestic",
    issuer: { isKleinunternehmer: input.supplierIsKu, priorYearTurnover: null },
    recipient: { countryCode: "DE", isConsumer: false, isPublicAuthority: false },
    refDate: input.supplyEnd,
    grossEurCents: input.grossEurCents,
  });
  if (r.decision !== "MUST_E") return null;
  if (r.ruleId === "R11") {
    return {
      severity: "warning",
      code: "einvoice_required_from_supplier",
      message: SUPPLIER_OBLIGATION_MESSAGES.warning,
    };
  }
  // LEGAL-OPEN: F06 Q-01 resolved as info — the supplier's prior-year turnover (800.000 € threshold) is unknown.
  return { severity: "info", code: "einvoice_transition_info", message: SUPPLIER_OBLIGATION_MESSAGES.info };
}
