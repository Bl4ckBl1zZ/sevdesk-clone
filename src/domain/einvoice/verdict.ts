/**
 * Validation verdict of a received E-Rechnung (F06 INB-024, ER-02, ER-12; EC-INB-11, EC-103, F06 Q-02). Pure.
 *
 * BMF categories (BMF 15.10.2025): **Formatfehler** — not parseable / schema (XSD) violations, the document is no
 * E-Rechnung; **Geschäftsregelfehler** — Schematron rules (EN 16931 BR-*, XRechnung BR-DE-*, PEPPOL-*);
 * **Inhaltsfehler** — § 14 Abs. 4 UStG content missing (our own check, `contentFindings`). Booking is never blocked;
 * any finding is a ⚑ warning and marks the input VAT at risk (Q-02). LEGAL-OPEN: F06-Q-02 (blocking vs warning).
 */
import { KLEINBETRAG_LIMIT, lookupRule } from "../rules";
import type { CalendarDate } from "../time/calendar-date";
import type { ReceivedInvoice } from "./received";

export type FindingCategory = "format" | "business_rule" | "content";

export interface Finding {
  ruleId: string;
  text: string;
  category: FindingCategory;
}

export const CATEGORY_LABEL_DE: Readonly<Record<FindingCategory | "ok", string>> = {
  ok: "ohne Befund",
  format: "Formatfehler",
  business_rule: "Geschäftsregelfehler",
  content: "Inhaltsfehler",
};

const SCHEMATRON = /^(BR-|PEPPOL-|UBL-|CII-|FX-|ZF-|SCH-|XR-)/i;

/** KoSIT / Mustang rule id → BMF category: Schematron ids are business rules; everything else (XSD, XML) is format. */
export function findingCategory(ruleId: string): FindingCategory {
  return SCHEMATRON.test(ruleId.trim()) ? "business_rule" : "format";
}

/**
 * Inhaltsfehler: § 14 Abs. 4 UStG mandatory content that the XML may carry syntactically but leaves empty — supplier
 * name and address, VAT ID or tax number, invoice number and date, supply date or period, a description per line,
 * the VAT breakdown. Kleinbetragsrechnungen (§ 33 UStDV, gross ≤ 250 €) only need name/address, date, description and
 * amounts. The limit comes from the date-effective rule `KLEINBETRAG_LIMIT` (`kleinbetragLimitOn`).
 */
export function contentFindings(inv: ReceivedInvoice, kleinbetragLimitCents: number): Finding[] {
  const out: Finding[] = [];
  const add = (ruleId: string, text: string) => out.push({ ruleId, text, category: "content" });
  const small = Math.abs(inv.totals.taxInclusiveCents) <= kleinbetragLimitCents;
  if (!inv.seller.name.trim()) add("UStG-14-4-1", "Name des leistenden Unternehmers fehlt.");
  const a = inv.seller.address;
  if (!a.city?.trim() || !(a.line1?.trim() || a.postalCode?.trim())) {
    add("UStG-14-4-1", "Anschrift des leistenden Unternehmers fehlt oder ist unvollständig.");
  }
  if (!small && !inv.seller.vatId && !inv.seller.taxNumber) {
    add("UStG-14-4-2", "Steuernummer oder USt-IdNr. des leistenden Unternehmers fehlt.");
  }
  if (!inv.number.trim() && !small) add("UStG-14-4-4", "Rechnungsnummer fehlt.");
  if (!inv.issueDate) add("UStG-14-4-3", "Rechnungsdatum fehlt.");
  if (!small && !inv.supplyDate && !inv.period) {
    add("UStG-14-4-6", "Zeitpunkt der Lieferung oder Leistung fehlt (Leistungsdatum/-zeitraum).");
  }
  if (inv.lines.length === 0 || inv.lines.some((l) => !l.name.trim())) {
    add("UStG-14-4-5", "Menge und Art der Lieferung bzw. Umfang und Art der Leistung fehlen.");
  }
  if (!small && inv.vatBreakdown.length === 0) add("UStG-14-4-8", "Aufschlüsselung der Umsatzsteuer fehlt.");
  return out;
}

export interface Verdict {
  acceptable: boolean;
  category: "ok" | FindingCategory;
  findings: Finding[];
}

/** Worst category wins: format > business rule > content > ok. Acceptable only if the tool passed and no finding. */
export function verdictOf(toolAcceptable: boolean, findings: readonly Finding[]): Verdict {
  const has = (c: FindingCategory) => findings.some((f) => f.category === c);
  const category = has("format")
    ? "format"
    : has("business_rule")
      ? "business_rule"
      : has("content")
        ? "content"
        : "ok";
  const acceptable = toolAcceptable && findings.length === 0;
  return {
    acceptable,
    category: !acceptable && category === "ok" ? "business_rule" : category,
    findings: [...findings],
  };
}

/** EC-INB-11 (⚑): Formatfehler → „keine E-Rechnung“, Geschäftsregel/Inhalt → „fehlerhafte E-Rechnung“. */
export function faultyMessage(v: Pick<Verdict, "category" | "findings">): string {
  const label = CATEGORY_LABEL_DE[v.category];
  return `E-Rechnung fehlerhaft (${label}): ${v.findings.length} Fehler. Vorsteuerabzug ggf. gefährdet – Korrektur beim Lieferanten anfordern?`;
}

/** § 33 UStDV limit on the invoice date (rule table `KLEINBETRAG_LIMIT`); no row → 0 (no relaxation, conservative). */
export function kleinbetragLimitOn(date: CalendarDate): number {
  const r = lookupRule(KLEINBETRAG_LIMIT, date);
  return r.ok ? r.value.value.limitCents : 0;
}
