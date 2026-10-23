/**
 * RI-26 (10-edge-cases §2, MAIL-03): every document of a registered company (e.K., OHG, KG, GmbH & Co. KG, GmbH, UG,
 * AG, PartG, eGbR) was finalised with a Geschäftsbrief footer that contains the mandatory fields — checked on the
 * frozen seller block of the snapshot (the self-billing Gutschrift: the issuer block, F04 §4.9). The same matrix as
 * the finalisation guard (./validate.ts, F01 §5.2): Rechtsformzusatz, register court and number, seat,
 * representatives where required, the general partner of a GmbH & Co. KG and the AG's supervisory board chair.
 * Pure; convex/model/invariants.ts feeds it the snapshots.
 */
import type { FooterCompany } from "./footer";
import { fieldsFor } from "./legal-forms";
import { hasLegalFormSuffix } from "./validate";

export interface FooterInvariantFinding {
  readonly id: "RI-26";
  readonly severity: "ERROR";
  readonly message: string;
}

export function checkGeschaeftsbriefFooter(name: string, seller: FooterCompany): FooterInvariantFinding[] {
  const f = fieldsFor(seller.legalForm);
  if (!f.register) return [];
  const missing: string[] = [];
  if (f.nameSuffix && !hasLegalFormSuffix(seller.name.trim(), seller.legalForm)) missing.push("Rechtsformzusatz");
  if (!seller.register?.court.trim() || !seller.register.number.trim()) missing.push("Registergericht und -nummer");
  if (f.seat && !(seller.seat?.trim() || seller.address.city.trim())) missing.push("Sitz");
  if (f.representatives?.required && !seller.representatives.some((r) => r.name.trim() !== "")) {
    missing.push("Vertretungsberechtigte");
  }
  if (f.generalPartner) {
    const gp = seller.generalPartner;
    if (!gp?.name.trim() || !gp.registerNumber.trim() || !gp.managingDirectors.some((m) => m.trim() !== "")) {
      missing.push("persönlich haftende Gesellschafterin");
    }
  }
  if (seller.legalForm === "ag" && !seller.supervisoryBoardChair?.trim()) missing.push("Vorsitz des Aufsichtsrats");
  if (missing.length === 0) return [];
  return [
    {
      id: "RI-26",
      severity: "ERROR",
      message: `${name}: Geschäftsbrief-Pflichtangaben fehlen im festgeschriebenen Fußbereich (${missing.join(", ")}).`,
    },
  ];
}
