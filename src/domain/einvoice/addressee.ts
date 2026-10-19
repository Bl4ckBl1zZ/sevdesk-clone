/**
 * Addressee check of a received E-Rechnung (F06 INB-044, EC-INB-08, ER-02): BT-44 (buyer name) and BT-48 (buyer
 * VAT ID) are compared with the company profile. Names are normalised like supplier names (VOU-040: case, umlauts,
 * punctuation, legal-form tokens); a name that contains the other (e.g. with a trade-name suffix) still matches.
 * A differing VAT ID is always a mismatch. Without any buyer data there is nothing to check. Pure.
 */
import { normaliseSupplierName } from "../vouchers/supplier-key";
import type { ReceivedInvoice } from "./received";

export interface AddresseeWarning {
  code: "einvoice_wrong_addressee";
  message: string;
}

const normVat = (s: string) => s.replace(/[\s.-]+/g, "").toUpperCase();

function nameMatches(buyer: string, company: readonly string[]): boolean {
  const b = normaliseSupplierName(buyer);
  if (!b) return true;
  return company.some((c) => {
    const n = normaliseSupplierName(c);
    return n !== "" && (n === b || b.includes(n) || n.includes(b));
  });
}

export function checkAddressee(
  buyer: ReceivedInvoice["buyer"],
  company: { name: string; tradeName?: string; vatId?: string },
): AddresseeWarning | null {
  const vatMismatch = !!buyer.vatId && !!company.vatId && normVat(buyer.vatId) !== normVat(company.vatId);
  const names = [company.name, ...(company.tradeName ? [company.tradeName] : [])];
  const nameMismatch = !!buyer.name && !nameMatches(buyer.name, names);
  if (!vatMismatch && !nameMismatch) return null;
  const label = [buyer.name, buyer.vatId].filter(Boolean).join(", ");
  return {
    code: "einvoice_wrong_addressee",
    message: `Die Rechnung ist nicht an Ihr Unternehmen adressiert (Empfänger: ${label}). Vorsteuerabzug gefährdet.`,
  };
}
