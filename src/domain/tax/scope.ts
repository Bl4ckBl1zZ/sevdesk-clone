/**
 * Which tax/annual reports a company gets (F08 TAX-014; 01 AO-01, AO-07). Legal forms with mandatory double-entry
 * bookkeeping (§ 238 HGB / § 140 AO: GmbH, UG, AG, OHG, KG, GmbH & Co. KG) and companies that chose the Bilanz get
 * no EÜR and no EÜR filing; the journal, SuSa, BWA-light and the DATEV export stay. UStVA/ZM sheets and submission
 * records work for every legal form.
 */
import { fieldsFor } from "../company/legal-forms";

export const AO07_NOTICE =
  "Jahresabschluss und E-Bilanz sind nicht Teil dieser Software (AO-07). Dafür benötigen Sie ein externes Programm oder einen Steuerberater.";

export const EUER_BLOCKED_NOTICE =
  "Für Ihr Unternehmen ist keine Einnahmenüberschussrechnung möglich: Es besteht Buchführungspflicht (Bilanz).";

export interface TaxScope {
  /** EÜR report and EÜR filing (TAX-015/022) are offered. */
  readonly euerAvailable: boolean;
  /** UStVA and ZM (TAX-003/009) — every legal form. */
  readonly vatFilingsAvailable: true;
  /** Notice shown on every tax page for Bilanz companies (AO-07); null for EÜR companies. */
  readonly notice: string | null;
}

export function taxScope(input: {
  readonly legalForm: string | undefined;
  /** Profit method of the fiscal year in question (`profitMethod` history, F01 SET-039). */
  readonly profitMethod?: "euer" | "bilanz" | undefined;
}): TaxScope {
  const bilanz = fieldsFor(input.legalForm).euerBlocked || input.profitMethod === "bilanz";
  return { euerAvailable: !bilanz, vatFilingsAvailable: true, notice: bilanz ? AO07_NOTICE : null };
}
