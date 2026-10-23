/**
 * F09 IMP-026 / §4.3.2 input (2): revenue account of sevdesk's DATEV export → our tax case, by reverse lookup through
 * F08's versioned account-role table (`ROLE_MAPPING_ROWS`). Versioned data: a new role or a changed mapping is a new
 * row and a new version, never new code. Only revenue roles whose tax case is unambiguous are listed; an account not
 * listed here refines nothing.
 */

import type { TaxCase } from "../../tax/tax-case";
import type { VatCategory } from "../../tax/vat-category";
import { ROLE_MAPPING_ROWS, ROLE_MAPPING_VERSION } from "../accounting/role-mapping";
import type { Chart } from "../accounting/types";

export const DATEV_REVENUE_ROLES_VERSION = `datev-revenue-roles@2026-10-23/${ROLE_MAPPING_VERSION}`;

export interface RevenueTaxHint {
  readonly role: string;
  readonly taxCase: Exclude<TaxCase, "unknown_imported">;
  readonly category: VatCategory;
  /** VAT rate of the role; 0 for every non-domestic case. */
  readonly rateBp: number;
}

const ROLE_TAX: Readonly<Record<string, Omit<RevenueTaxHint, "role">>> = {
  "revenue.domestic.19": { taxCase: "domestic", category: "S", rateBp: 1900 },
  "revenue.domestic.7": { taxCase: "domestic", category: "S", rateBp: 700 },
  "revenue.icsupply": { taxCase: "intra_community_supply", category: "K", rateBp: 0 },
  "revenue.export": { taxCase: "export", category: "G", rateBp: 0 },
  "revenue.eu_service_rc": { taxCase: "eu_b2b_service", category: "AE", rateBp: 0 },
  "revenue.13b_domestic": { taxCase: "reverse_charge_13b", category: "AE", rateBp: 0 },
  "revenue.not_taxable": { taxCase: "not_taxable_domestic", category: "O", rateBp: 0 },
  "revenue.exempt_4": { taxCase: "exempt_4", category: "E", rateBp: 0 },
  "revenue.ku": { taxCase: "kleinunternehmer", category: "KU", rateBp: 0 },
};

/** Revenue account number (as in the DATEV file) → tax hint for the chart; `null` = not a mapped revenue account. */
export function revenueTaxHint(chart: Chart, account: string): RevenueTaxHint | null {
  const row = ROLE_MAPPING_ROWS.find((r) => r[chart] === account && ROLE_TAX[r.role]);
  if (!row) return null;
  const tax = ROLE_TAX[row.role];
  return tax ? { role: row.role, ...tax } : null;
}
