/**
 * The posting engine (F08 ACC-002): pure function `event + context → balanced journal lines by role`, following
 * the versioned posting matrix §4.2 (`posting-2026.1`). It never sees account numbers — `resolve.ts` maps roles to
 * the chart of the fiscal year through the versioned role mapping (ACC-008). Convex `model/journal.ts` persists
 * the result; no other code path produces journal entries.
 *
 * Rules applied here:
 *  - explicit VAT lines, `taxKey` on the base line (DATEV collapses them later, F09);
 *  - Soll vs Ist only changes the VAT account (`vat.output.notdue.r`) and the transfer at payment (ACC-021);
 *  - tax point per §4.3 on base and VAT lines that are reported by tax point (Ist bases are reported from the
 *    payment allocations, §4.4, so Ist invoice lines carry none);
 *  - private postings of corporations go to `shareholder.clearing` (ACC-028).
 * EÜR effects are derived from allocations, never from this matrix (§4.2 intro).
 */
import type { LegalForm } from "../company/legal-forms";
import { formatBasisPoints, formatEuro } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { CalendarDate } from "../time/calendar-date";
import { calendarDate } from "../time/calendar-date";
import type {
  AdvancePaymentReceivedEvent,
  BankTransactionMarkedEvent,
  BusinessEvent,
  CashTransferEvent,
  CustomerRefundEvent,
  InvoiceCorrectedEvent,
  InvoiceFinalisedEvent,
  JournalSource,
  OpeningBalanceEvent,
  PaymentMeans,
  PaymentReceivedEvent,
  ReversalEvent,
  SalesTaxCase,
  TaxationMethod,
  VatGroup,
  WriteOffRecoveredEvent,
} from "./events";
import { sourceOf } from "./events";
import {
  type Dating,
  endOfMonth,
  icSupplyTaxPoint,
  periodOf,
  supplyEnd,
  taxPeriodOf,
  type UstvaPeriodKind,
} from "./period";
import { postVoucherBooked, postVoucherPaid } from "./post-vouchers";
import { shareOfSettlement } from "./pro-rata";
import { type AccountRole, bankRole, isCorporation, rateSuffix } from "./roles";

export const POSTING_RULE_VERSION = "posting-2026.1";

/** Settings snapshot valid for the event (built by the model from companyProfile). */
export interface PostingContext {
  /** Soll/Ist valid on the event date (ACC-022). */
  taxationMethod: TaxationMethod;
  legalForm: LegalForm;
  ustvaPeriod: readonly { year: number; period: UstvaPeriodKind }[];
}

/** A journal line by role (or explicit account). Exactly one of debit/credit is > 0. */
export interface RoleLine {
  role?: AccountRole;
  /** Explicit account (group revenue account, „other“ difference); resolved as given. */
  account?: string;
  debitCents: number;
  creditCents: number;
  contactId?: string;
  taxKey?: string;
  taxPointDate?: string;
  taxPeriod?: string;
}

export interface Posting {
  date: CalendarDate;
  /** ≤ 60 chars (DATEV Buchungstext, ACC-001). */
  text: string;
  /** Matrix row key for „Warum dieses Konto?“ (ACC-003), see EXPLANATIONS. */
  explanation: string;
  ruleVersion: string;
  source: JournalSource;
  lines: RoleLine[];
  /** Default dating for the period-lock rule (ACC-006). */
  dating: Dating;
}

export type PostingOutcome =
  | { kind: "entry"; posting: Posting }
  | { kind: "none"; reason: "advance_invoice" | "no_change" | "zero_amount" };

export type PostingIssueCode =
  | "invalid_event"
  | "rate_not_supported"
  | "tax_case_not_postable"
  | "vat_correction_required"
  | "private_withdrawal_corporation";

export type PostingIssue = Issue<PostingIssueCode>;

// ── explanations („Warum dieses Konto?“, ACC-003) ───────────────────────────────────────────────────────

export const EXPLANATIONS: Readonly<Record<string, string>> = {
  S1: "Rechnung fertiggestellt (Soll-Versteuerung): Forderung an Erlöse und Umsatzsteuer; die Steuer entsteht mit Ablauf des Leistungszeitraums.",
  "S1-ist":
    "Rechnung fertiggestellt (Ist-Versteuerung): Forderung an Erlöse und „Umsatzsteuer nicht fällig“; fällig wird die Steuer erst mit der Zahlung.",
  S2: "Rechnung mit mehreren Steuersätzen/-arten: je Gruppe ein Erlös- und Steuerpaar, genau wie auf der Rechnung ausgewiesen.",
  "S2-ist": "Rechnung mit mehreren Steuersätzen (Ist-Versteuerung): je Gruppe Erlöse und „Umsatzsteuer nicht fällig“.",
  S3: "Kleinunternehmer-Rechnung (§ 19 UStG): Forderung an Erlöse ohne Umsatzsteuer.",
  S4: "EU-Dienstleistung an Unternehmer: der Leistungsempfänger schuldet die Steuer (Kz 21, ZM „S“).",
  S5: "Innergemeinschaftliche Lieferung: steuerfrei nach § 4 Nr. 1b UStG (Kz 41, ZM „L“).",
  S6: "Leistung nach § 13b UStG im Inland: der Leistungsempfänger schuldet die Steuer (Kz 60).",
  S7: "Ausfuhr, nicht steuerbarer oder steuerfreier Umsatz: Erlöse ohne Umsatzsteuer (Kz 43/45/48).",
  S8: "Nullsteuersatz Photovoltaik (§ 12 Abs. 3 UStG, Kz 87).",
  S11: "Schlussrechnung: Gesamtleistung als Forderung, erhaltene Anzahlungen und ihre Umsatzsteuer werden verrechnet (§ 14 Abs. 5 UStG).",
  "S11-ist":
    "Schlussrechnung (Ist-Versteuerung): Restbetrag mit „Umsatzsteuer nicht fällig“, Anzahlungen werden verrechnet.",
  S12: "Stornorechnung: Generalumkehr der ursprünglichen Buchung im Zeitraum des Stornos (§ 17 UStG).",
  S13: "Rechnungskorrektur: Minderung von Erlösen und Umsatzsteuer im Zeitraum der Korrektur (§ 17 UStG).",
  "S13-ist": "Rechnungskorrektur (Ist-Versteuerung): Minderung von Erlösen und „Umsatzsteuer nicht fällig“.",
  S10: "Zahlung auf eine Abschlagsrechnung: erhaltene Anzahlung; die Umsatzsteuer entsteht mit der Vereinnahmung (Mindest-Ist).",
  P1: "Zahlungseingang auf dem Bankkonto: Forderung ausgeglichen.",
  "P1-ist": "Zahlungseingang (Ist-Versteuerung): Forderung ausgeglichen, der Steueranteil der Zahlung wird fällig.",
  P3: "Barzahlung einer Rechnung („Bar bezahlt“): Kasse an Forderung.",
  "P3-ist": "Barzahlung (Ist-Versteuerung): Kasse an Forderung, der Steueranteil der Zahlung wird fällig.",
  P6: "Überzahlung: Guthaben des Kunden auf dem Forderungskonto.",
  P8: "Forderungsausfall: Minderung der Bemessungsgrundlage nach § 17 Abs. 2 Nr. 1 UStG.",
  P9: "Zahlungseingang auf eine abgeschriebene Forderung: die Umsatzsteuer entsteht erneut (§ 17 Abs. 2 Nr. 1 S. 2 UStG).",
  P10: "Zahlungsstorno: Generalumkehr der Zahlungsbuchung, die Rechnung ist wieder offen.",
  P11: "Erstattung an den Kunden (Guthaben oder Rechnungskorrektur): Debitor an Bank/Kasse.",
  "P11-ist":
    "Erstattung einer Rechnungskorrektur (Ist-Versteuerung): Debitor an Bank/Kasse, die Steuerminderung des erstatteten Anteils wird wirksam.",
  P12: "Verrechnung eines Kundenguthabens mit einer Rechnung: Debitor an Debitor.",
  "P12-ist":
    "Verrechnung eines Kundenguthabens (Ist-Versteuerung): Debitor an Debitor, der Steueranteil des verrechneten Betrags wird fällig.",
  T5: "Bareinzahlung auf die Bank: Kasse an Geldtransit.",
  "T5-bank": "Bankgutschrift der Bareinzahlung: Bank an Geldtransit.",
  T8: "Privatentnahme aus der Kasse.",
  "T8-corp":
    "Entnahme aus der Kasse über das Verrechnungskonto Gesellschafter (Kapitalgesellschaft, keine Privatentnahme).",
  T9: "Bargeldabhebung in die Kasse: Bank an Geldtransit an Kasse.",
  T10: "Storno einer Barbewegung: Generalumkehr der ursprünglichen Buchung.",
  T1: "Privatentnahme laut Kontoauszug: Privatentnahmen an Bank (der Kontoauszug ist der Beleg).",
  "T1-corp":
    "Entnahme laut Kontoauszug über das Verrechnungskonto Gesellschafter (Kapitalgesellschaft, keine Privatentnahme).",
  T2: "Privateinlage laut Kontoauszug: Bank an Privateinlagen.",
  "T2-corp": "Einlage laut Kontoauszug über das Verrechnungskonto Gesellschafter (Kapitalgesellschaft).",
  "T4-out": "Geldtransit: Abgang vom Bankkonto auf ein eigenes Konto (Gegenbuchung im Zielkonto).",
  "T4-in": "Geldtransit: Zugang von einem eigenen Konto (Gegenbuchung im Ursprungskonto).",
  "BNK-mark-reversal": "Markierung aufgehoben: Generalumkehr der Buchung des Bankumsatzes.",
  "ACC-013-cash": "Eröffnungsbilanz: Anfangsbestand der Kasse gegen Saldenvorträge Sachkonten.",
  "ACC-013-bank": "Eröffnungsbilanz: Anfangsbestand des Bankkontos gegen Saldenvorträge Sachkonten.",
  "ACC-013-receivables": "Eröffnungsbilanz: offene Forderungen je Rechnung gegen Saldenvorträge Debitoren.",
  // ── purchase vouchers (F08 §4.2.3, §4.2.4, §4.2.6) ──
  V1: "Eingangsrechnung mit Vorsteuerabzug: Aufwand und abziehbare Vorsteuer an Verbindlichkeiten; die Vorsteuer ist abziehbar, sobald Leistung und Rechnung vorliegen.",
  V2: "Zahlung einer Eingangsrechnung vom Bankkonto: Verbindlichkeit ausgeglichen.",
  "V2+V3":
    "Zahlung mit Skontoabzug: Verbindlichkeit ausgeglichen, erhaltener Skonto mindert Aufwand und Vorsteuer anteilig je Steuersatz (§ 17 UStG).",
  V4: "Beleg ohne Vorsteuerabzug (Kleinunternehmer, ausländische USt, nicht abziehbar oder Eigenbeleg): der Bruttobetrag ist Aufwand.",
  V5: "Bewirtung von Geschäftspartnern: 70 % abziehbare und 30 % nicht abziehbare Bewirtungskosten (§ 4 Abs. 5 Nr. 2 EStG), Vorsteuer zu 100 % abziehbar.",
  V6: "Reverse Charge EU (§ 13b Abs. 1 UStG): Sie schulden die Umsatzsteuer und ziehen sie als Vorsteuer wieder ab (Kz 46/47, 67).",
  "V6-ku":
    "Reverse Charge EU als Kleinunternehmer: Sie schulden die Umsatzsteuer, dürfen sie aber nicht als Vorsteuer abziehen (Aufwand).",
  V7: "Leistung eines ausländischen Unternehmers (§ 13b Abs. 2 Nr. 1 UStG): Steuerschuld und Vorsteuer (Kz 84/85, 67).",
  "V7-ku": "Leistung eines ausländischen Unternehmers als Kleinunternehmer: Steuerschuld ohne Vorsteuerabzug.",
  V8: "Inländische Leistung nach § 13b UStG (z. B. Bauleistung): Steuerschuld und Vorsteuer (Kz 84/85, 67).",
  "V8-ku": "Inländische Leistung nach § 13b UStG als Kleinunternehmer: Steuerschuld ohne Vorsteuerabzug.",
  V9: "Innergemeinschaftlicher Erwerb (§ 1a UStG): Erwerbsteuer und Vorsteuer (Kz 89/93, 61).",
  "V9-ku": "Innergemeinschaftlicher Erwerb als Kleinunternehmer: Erwerbsteuer ohne Vorsteuerabzug.",
  V10: "Einfuhrumsatzsteuer laut Zollbescheid: abziehbar als Vorsteuer (Kz 62), kein Aufwand.",
  V13: "Anschaffung eines Anlageguts: Anlagenkonto (GWG, Sammelposten oder Anlage) und Vorsteuer an Verbindlichkeiten.",
  VE: "Einnahmebeleg (keine eigene Rechnung): Forderung an Ertrag und ggf. Umsatzsteuer.",
  "VE-pay": "Zahlungseingang auf einen Einnahmebeleg: Forderung ausgeglichen.",
  T6: "Beleg bar bezahlt: Verbindlichkeit an Kasse.",
  "T6+V3": "Beleg bar bezahlt mit Skontoabzug: Verbindlichkeit an Kasse und erhaltene Skonti.",
  T7: "Beleg privat bezahlt (Privateinlage): Verbindlichkeit an Privateinlagen, keine Kassen- oder Bankbewegung.",
  "T7+V3": "Beleg privat bezahlt mit Skontoabzug: Verbindlichkeit an Privateinlagen und erhaltene Skonti.",
  "T7-corp": "Auslage durch Gesellschafter: Verbindlichkeit an Verrechnungskonto Gesellschafter (Kapitalgesellschaft).",
  "T7-corp+V3": "Auslage durch Gesellschafter mit Skontoabzug: Verrechnungskonto Gesellschafter und erhaltene Skonti.",
  X1: "Umsatzsteuer-Vorauszahlung an das Finanzamt.",
  X2: "Umsatzsteuer-Erstattung vom Finanzamt.",
  X3: "Sondervorauszahlung (1/11) für die Dauerfristverlängerung.",
  X4: "Umsatzsteuer-Jahreszahlung bzw. -erstattung für ein Vorjahr.",
  X5: "Gewerbesteuer (Betriebsausgabe, außerbilanziell nicht abziehbar).",
  X6: "Einkommensteuer, Kirchensteuer, Soli vom Geschäftskonto: Privatsteuern (keine Betriebsausgabe).",
  X7: "Körperschaftsteuer (Kapitalgesellschaft).",
  "V-storno": "Storno eines Belegs: Generalumkehr der Buchung im offenen Zeitraum (§ 17 UStG).",
  "V-correction":
    "Belegkorrektur: Generalumkehr der bisherigen Buchung, danach Neubuchung mit den korrigierten Werten.",
};

export const explanationText = (key: string): string => EXPLANATIONS[key] ?? key;

// ── line helpers ────────────────────────────────────────────────────────────────────────────────────────

type LineTarget = { role: AccountRole } | { account: string };
type LineExtra = Pick<RoleLine, "contactId" | "taxKey" | "taxPointDate">;

/** Signed amount on the debit side (negative → credit). Zero → no line. */
function debit(target: LineTarget, cents: number, extra: LineExtra = {}): RoleLine[] {
  if (cents === 0) return [];
  const sideAmounts = cents > 0 ? { debitCents: cents, creditCents: 0 } : { debitCents: 0, creditCents: -cents };
  return [{ ...target, ...sideAmounts, ...clean(extra) }];
}

const credit = (target: LineTarget, cents: number, extra: LineExtra = {}): RoleLine[] => debit(target, -cents, extra);

function clean(extra: LineExtra): LineExtra {
  const out: LineExtra = {};
  if (extra.contactId !== undefined) out.contactId = extra.contactId;
  if (extra.taxKey !== undefined) out.taxKey = extra.taxKey;
  if (extra.taxPointDate !== undefined) out.taxPointDate = extra.taxPointDate;
  return out;
}

const R = (role: AccountRole): LineTarget => ({ role });

/** Merges lines with the same target, side and attributes (one revenue/VAT pair per group, S2). */
export function mergeLines(lines: readonly RoleLine[]): RoleLine[] {
  const out: RoleLine[] = [];
  const keyOf = (l: RoleLine) =>
    JSON.stringify([l.role, l.account, l.debitCents > 0, l.contactId, l.taxKey, l.taxPointDate, l.taxPeriod]);
  const index = new Map<string, number>();
  for (const l of lines) {
    const k = keyOf(l);
    const i = index.get(k);
    if (i === undefined) {
      index.set(k, out.length);
      out.push({ ...l });
    } else {
      const m = out[i] as RoleLine;
      m.debitCents += l.debitCents;
      m.creditCents += l.creditCents;
    }
  }
  return out;
}

function withTaxPeriods(lines: RoleLine[], ctx: PostingContext): RoleLine[] {
  return lines.map((l) => {
    if (!l.taxPointDate) return l;
    const tp = taxPeriodOf(l.taxPointDate, ctx.ustvaPeriod);
    return tp ? { ...l, taxPeriod: tp } : l;
  });
}

const truncate = (s: string) => (s.length <= 60 ? s : `${s.slice(0, 59)}…`);
const textWith = (head: string, name?: string) => truncate(name ? `${head} ${name}` : head);

const invalid = (message: string): PostingIssue => issue("invalid_event", message);

const isInt = (n: number) => Number.isSafeInteger(n);

// ── sales documents ─────────────────────────────────────────────────────────────────────────────────────

const RATE_UNSUPPORTED = (rateBp: number): PostingIssue =>
  // LEGAL-OPEN: F08-Q1 — historical rates (16 %/5 %, Kz 35/36) have no shipped role; block rather than guess.
  issue(
    "rate_not_supported",
    `Für den Steuersatz ${formatBasisPoints(rateBp)} % gibt es keine Kontenrolle. Bitte die Buchung manuell erfassen lassen.`,
    { rateBp },
  );

interface GroupRoles {
  revenue: AccountRole;
  taxKey: string;
  /** S: VAT role suffix. */
  suffix?: "19" | "7";
  /** Reported by tax point also under Ist (AE EU service, igL). */
  istTaxPoint?: boolean;
}

function groupRoles(g: VatGroup, taxCase: SalesTaxCase): Result<GroupRoles, PostingIssue> {
  if (!isInt(g.netCents) || !isInt(g.vatCents) || !isInt(g.rateBp))
    return err(invalid("Beträge müssen ganze Cent sein."));
  if (g.category !== "S" && g.vatCents !== 0) {
    return err(invalid(`Die Steuerart ${g.category} darf keine Umsatzsteuer ausweisen.`));
  }
  switch (g.category) {
    case "S": {
      const suffix = rateSuffix(g.rateBp);
      if (!suffix) return err(RATE_UNSUPPORTED(g.rateBp));
      return ok({ revenue: `revenue.domestic.${suffix}`, taxKey: `USt${suffix}`, suffix });
    }
    case "Z":
      return ok({ revenue: "revenue.zero_pv", taxKey: "USt0" });
    case "E":
      return ok({ revenue: "revenue.exempt_4", taxKey: "Stfrei4" });
    case "AE":
      return taxCase === "eu_b2b_service"
        ? ok({ revenue: "revenue.eu_service_rc", taxKey: "EU-RC", istTaxPoint: true })
        : ok({ revenue: "revenue.13b_domestic", taxKey: "13b" });
    case "K":
      return ok({ revenue: "revenue.icsupply", taxKey: "igL", istTaxPoint: true });
    case "G":
      return ok({ revenue: "revenue.export", taxKey: "Ausfuhr" });
    case "O":
      return ok({ revenue: "revenue.not_taxable", taxKey: "nStb" });
    case "KU":
      return ok({ revenue: "revenue.ku", taxKey: "KU" });
  }
}

function invoiceExplanation(groups: readonly VatGroup[], taxCase: SalesTaxCase, ist: boolean): string {
  const kinds = new Set(groups.map((g) => `${g.category}:${g.rateBp}`));
  const hasS = groups.some((g) => g.category === "S");
  const suffix = ist && hasS ? "-ist" : "";
  if (kinds.size > 1) return `S2${suffix}`;
  const c = groups[0]?.category;
  if (c === "KU") return "S3";
  if (c === "AE") return taxCase === "eu_b2b_service" ? "S4" : "S6";
  if (c === "K") return "S5";
  if (c === "Z") return "S8";
  if (c === "G" || c === "O" || c === "E") return "S7";
  return `S1${suffix}`;
}

/** Revenue + VAT lines of the groups (S1–S8, S13). `taxPoint` null = Ist base (allocation-based). */
function salesLines(
  groups: readonly VatGroup[],
  taxCase: SalesTaxCase,
  method: TaxationMethod,
  taxPointFor: (r: GroupRoles) => string | undefined,
): Result<{ lines: RoleLine[]; grossCents: number; vatByRate: Map<"19" | "7", number> }, PostingIssue> {
  const lines: RoleLine[] = [];
  let gross = 0;
  const vatByRate = new Map<"19" | "7", number>();
  for (const g of groups) {
    const roles = groupRoles(g, taxCase);
    if (!roles.ok) return roles;
    const r = roles.value;
    const tp = taxPointFor(r);
    const target: LineTarget = g.revenueAccount ? { account: g.revenueAccount } : R(r.revenue);
    lines.push(...credit(target, g.netCents, { taxKey: r.taxKey, ...(tp ? { taxPointDate: tp } : {}) }));
    if (r.suffix && g.vatCents !== 0) {
      vatByRate.set(r.suffix, (vatByRate.get(r.suffix) ?? 0) + g.vatCents);
      if (method === "soll")
        lines.push(...credit(R(`vat.output.${r.suffix}`), g.vatCents, tp ? { taxPointDate: tp } : {}));
      else lines.push(...credit(R(`vat.output.notdue.${r.suffix}`), g.vatCents));
    }
    gross += g.netCents + g.vatCents;
  }
  return ok({ lines, grossCents: gross, vatByRate });
}

function postInvoice(e: InvoiceFinalisedEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  // S9: an Abschlagsrechnung and an amount-based Teilrechnung (an Anzahlung, UST-40 b) post nothing; VAT on receipt.
  if (e.documentType === "advance_invoice" || e.documentType === "partial_invoice") {
    return ok({ kind: "none", reason: "advance_invoice" });
  }
  if (e.taxCase === "unknown_imported") {
    return err(
      issue("tax_case_not_postable", "Archivierte Importbelege mit unbekannter Steuerart werden nicht gebucht."),
    );
  }
  if (e.vatGroups.length === 0) return err(invalid("Die Rechnung hat keine Umsatzsteuergruppen."));
  const deductions = e.advanceDeductions ?? [];
  if (deductions.length > 0 && e.documentType !== "final_invoice") {
    return err(invalid("Anzahlungen können nur in einer Schlussrechnung verrechnet werden."));
  }
  const ist = ctx.taxationMethod === "ist";
  const soll = supplyEnd(e.supplyDate);
  const taxPointFor = (r: GroupRoles): string | undefined => {
    if (r.taxKey === "igL") return icSupplyTaxPoint(e.date, e.supplyDate);
    if (r.taxKey === "EU-RC") return endOfMonth(periodOf(soll));
    if (r.taxKey === "KU") return undefined;
    return ist ? undefined : soll;
  };
  const sales = salesLines(e.vatGroups, e.taxCase, ist && deductions.length === 0 ? "ist" : "soll", taxPointFor);
  if (!sales.ok) return sales;
  const contact = { contactId: e.contactId };
  let lines: RoleLine[] = [...debit(R("receivable"), sales.value.grossCents, contact)];

  if (deductions.length === 0) {
    lines.push(...sales.value.lines);
  } else {
    // S11: VAT lines per rate — Soll: total VAT, then the advance VAT is cleared; Ist: only the remainder becomes
    // „nicht fällig“, a negative remainder (rate change, UST-41/EC-073) corrects the declared advance VAT.
    const advVat = new Map<"19" | "7", number>();
    const clearing: RoleLine[] = [];
    let advGross = 0;
    for (const d of deductions) {
      const suffix = rateSuffix(d.rateBp);
      if (!suffix) return err(RATE_UNSUPPORTED(d.rateBp));
      if (!isInt(d.netCents) || !isInt(d.vatCents)) return err(invalid("Beträge müssen ganze Cent sein."));
      advVat.set(suffix, (advVat.get(suffix) ?? 0) + d.vatCents);
      clearing.push(...debit(R(`advance.received.${suffix}`), d.netCents));
      advGross += d.netCents + d.vatCents;
    }
    const baseLines = sales.value.lines.filter((l) => !l.role?.startsWith("vat.output"));
    lines.push(...baseLines);
    const tp = ist ? undefined : soll;
    const rates = new Set([...sales.value.vatByRate.keys(), ...advVat.keys()]);
    for (const suffix of ["19", "7"] as const) {
      if (!rates.has(suffix)) continue;
      const total = sales.value.vatByRate.get(suffix) ?? 0;
      const adv = advVat.get(suffix) ?? 0;
      if (!ist) {
        lines.push(...credit(R(`vat.output.${suffix}`), total, tp ? { taxPointDate: tp } : {}));
        clearing.push(...debit(R(`vat.output.${suffix}`), adv, { taxPointDate: soll }));
      } else if (total - adv >= 0) {
        lines.push(...credit(R(`vat.output.notdue.${suffix}`), total - adv));
      } else {
        lines.push(...debit(R(`vat.output.${suffix}`), adv - total, { taxPointDate: e.date }));
      }
    }
    lines.push(...clearing, ...credit(R("receivable"), advGross, contact));
  }
  lines = withTaxPeriods(mergeLines(lines), ctx);
  const explanation =
    deductions.length > 0 ? (ist ? "S11-ist" : "S11") : invoiceExplanation(e.vatGroups, e.taxCase, ist);
  return entry(e, ctx, {
    date: e.date,
    text: textWith(`Rechnung ${e.documentNumber}`, e.counterpartyName),
    explanation,
    lines,
    dating: "user",
  });
}

function postCorrection(e: InvoiceCorrectedEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  if (e.taxCase === "unknown_imported") {
    return err(
      issue("tax_case_not_postable", "Archivierte Importbelege mit unbekannter Steuerart werden nicht gebucht."),
    );
  }
  const groups = e.vatGroups.filter((g) => g.netCents !== 0 || g.vatCents !== 0);
  if (groups.length === 0) return ok({ kind: "none", reason: "no_change" });
  const method = e.taxedAs ?? ctx.taxationMethod;
  // §17 UStG: the correction is reported in the period of the correction event (§4.3).
  const tp = (r: GroupRoles) => (r.taxKey === "KU" || (method === "ist" && !r.istTaxPoint) ? undefined : e.date);
  const sales = salesLines(groups, e.taxCase, method, tp);
  if (!sales.ok) return sales;
  const lines = withTaxPeriods(
    mergeLines([...debit(R("receivable"), sales.value.grossCents, { contactId: e.contactId }), ...sales.value.lines]),
    ctx,
  );
  return entry(e, ctx, {
    date: e.date,
    text: textWith(`Korrektur ${e.documentNumber}`, e.counterpartyName),
    explanation: method === "ist" ? "S13-ist" : "S13",
    lines,
    dating: "user",
  });
}

// ── payments ────────────────────────────────────────────────────────────────────────────────────────────

function meansRole(m: PaymentMeans): AccountRole | null {
  if (m.kind === "bank_account") return bankRole(m.bankAccountId);
  if (m.kind === "cash") return "cash";
  if (m.kind === "customer_credit") return "receivable";
  return null;
}

const meansDating = (m: PaymentMeans): Dating => (m.kind === "bank_account" ? "external" : "user");

function vatRole(suffix: "19" | "7", method: TaxationMethod) {
  return method === "ist" ? `vat.output.notdue.${suffix}` : `vat.output.${suffix}`;
}

function postPayment(e: PaymentReceivedEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  if (!isInt(e.amountCents) || e.amountCents < 0) return err(invalid("Der Zahlbetrag muss ≥ 0 sein (ganze Cent)."));
  const means = meansRole(e.means);
  if (means === null && e.amountCents !== 0)
    return err(invalid("Eine Zahlung ohne Zahlungsweg darf keinen Betrag haben."));
  if (means !== null && e.amountCents === 0) return err(invalid("Der Zahlbetrag muss größer als 0 sein."));
  const diffs = e.differences ?? [];
  if (e.target.kind === "contactCredit" && diffs.length > 0) {
    return err(invalid("Ein Kundenguthaben kann keine Differenzen enthalten."));
  }
  if (e.target.kind === "contactCredit" && e.means.kind === "customer_credit") {
    return err(invalid("Ein Guthaben kann nicht mit sich selbst verrechnet werden."));
  }
  const ist = e.ist !== undefined && e.target.kind !== "contactCredit";
  const method: TaxationMethod = ist ? "ist" : "soll";
  const contact = { contactId: e.contactId };
  const lines: RoleLine[] = [];
  if (means) lines.push(...debit(R(means), e.amountCents, means === "receivable" ? contact : {}));

  let settled = e.amountCents;
  const corrVat = new Map<"19" | "7", number>();
  let writeOff = false;
  for (const d of diffs) {
    if (!isInt(d.amountCents) || d.amountCents === 0)
      return err(invalid("Differenzbeträge müssen ganze Cent ≠ 0 sein."));
    settled += d.amountCents;
    switch (d.reason) {
      case "bank_fees":
        lines.push(...debit(R("expense.bank_fees"), d.amountCents));
        break;
      case "dunning_fees":
        lines.push(...debit(R("income.other_nontaxable"), d.amountCents));
        break;
      case "default_interest":
        lines.push(...debit(R("income.interest_default"), d.amountCents));
        break;
      case "fx_difference":
        lines.push(
          ...(d.amountCents > 0
            ? debit(R("expense.fx_loss"), d.amountCents)
            : debit(R("income.fx_gain"), d.amountCents)),
        );
        break;
      case "skonto":
      case "write_off":
      case "other": {
        if (d.reason === "other" && !d.account)
          return err(invalid("Für „Sonstige Differenz“ ist ein Konto anzugeben."));
        if (d.reason !== "other" && !d.vatCorrection) {
          return err(
            issue(
              "vat_correction_required",
              "Für Skonto und Forderungsausfall ist die Umsatzsteuerkorrektur je Steuersatz anzugeben.",
            ),
          );
        }
        if (d.reason === "write_off") writeOff = true;
        const corr = d.vatCorrection ?? [];
        if (corr.length === 0) {
          lines.push(...debit({ account: d.account as string }, d.amountCents));
          break;
        }
        const sum = corr.reduce((s, c) => s + c.netCents + c.vatCents, 0);
        if (sum !== d.amountCents) return err(invalid("Die Umsatzsteuerkorrektur ergibt nicht den Differenzbetrag."));
        for (const c of corr) {
          const suffix = rateSuffix(c.rateBp);
          if (c.rateBp !== 0 && !suffix) return err(RATE_UNSUPPORTED(c.rateBp));
          if (!suffix && c.vatCents !== 0) return err(invalid("Ohne Steuersatz keine Umsatzsteuerkorrektur."));
          const base: LineTarget =
            d.reason === "other"
              ? { account: d.account as string }
              : d.reason === "skonto"
                ? R(`skonto.granted.${suffix ?? "19"}`)
                : R(`writeoff.${suffix ?? "0"}`);
          if (d.reason === "skonto" && !suffix) return err(RATE_UNSUPPORTED(c.rateBp));
          lines.push(...debit(base, c.netCents, suffix ? { taxKey: `USt${suffix}` } : {}));
          if (suffix && c.vatCents !== 0) {
            corrVat.set(suffix, (corrVat.get(suffix) ?? 0) + c.vatCents);
            lines.push(
              ...debit(R(vatRole(suffix, method)), c.vatCents, method === "soll" ? { taxPointDate: e.date } : {}),
            );
          }
        }
        break;
      }
    }
  }
  if (settled < 0) return err(invalid("Die Differenzen übersteigen den Zahlbetrag."));
  lines.push(...credit(R("receivable"), settled, contact));

  if (ist && e.ist) {
    const basis = e.ist.notDueVat.filter((v) => v.vatCents !== 0);
    for (const v of basis) if (!rateSuffix(v.rateBp)) return err(RATE_UNSUPPORTED(v.rateBp));
    const shares = shareOfSettlement(
      basis.map((v) => v.vatCents),
      e.ist.payableCents,
      e.ist.settledBeforeCents,
      settled,
    );
    basis.forEach((v, i) => {
      const suffix = rateSuffix(v.rateBp) as "19" | "7";
      const transfer = (shares[i] ?? 0) - (corrVat.get(suffix) ?? 0);
      lines.push(...debit(R(`vat.output.notdue.${suffix}`), transfer));
      lines.push(...credit(R(`vat.output.${suffix}`), transfer, { taxPointDate: e.date }));
    });
  }

  const head =
    e.target.kind === "contactCredit"
      ? "Guthaben"
      : means === null
        ? `Ausfall ${e.target.number ?? ""}`.trim()
        : e.means.kind === "customer_credit"
          ? `Verrechnung ${e.target.number ?? ""}`.trim()
          : `Zahlung ${e.target.number ?? ""}`.trim();
  const explanation =
    e.target.kind === "contactCredit"
      ? "P6"
      : writeOff && means === null
        ? "P8"
        : `${e.means.kind === "customer_credit" ? "P12" : e.means.kind === "cash" ? "P3" : "P1"}${ist ? "-ist" : ""}`;
  return entry(e, ctx, {
    date: e.date,
    text: textWith(head, e.counterpartyName),
    explanation,
    lines: withTaxPeriods(mergeLines(lines), ctx),
    dating: meansDating(e.means),
  });
}

function postAdvancePayment(e: AdvancePaymentReceivedEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  const means = meansRole(e.means);
  if (!means || !isInt(e.amountCents) || e.amountCents <= 0) {
    return err(invalid("Eine Anzahlung braucht einen Zahlungsweg und einen Betrag > 0."));
  }
  const groups = e.advance.vatGroups;
  for (const g of groups) if (!rateSuffix(g.rateBp)) return err(RATE_UNSUPPORTED(g.rateBp));
  const gross = shareOfSettlement(
    groups.map((g) => g.netCents + g.vatCents),
    e.advance.payableCents,
    e.advance.settledBeforeCents,
    e.amountCents,
  );
  const vat = shareOfSettlement(
    groups.map((g) => g.vatCents),
    e.advance.payableCents,
    e.advance.settledBeforeCents,
    e.amountCents,
  );
  const lines: RoleLine[] = [...debit(R(means), e.amountCents)];
  let covered = 0;
  groups.forEach((g, i) => {
    const suffix = rateSuffix(g.rateBp) as "19" | "7";
    const v = vat[i] ?? 0;
    const n = (gross[i] ?? 0) - v;
    covered += n + v;
    lines.push(...credit(R(`advance.received.${suffix}`), n, { taxKey: `USt${suffix}` }));
    lines.push(...credit(R(`vat.output.${suffix}`), v, { taxPointDate: e.date }));
  });
  if (covered !== e.amountCents)
    return err(invalid("Die Anzahlung übersteigt den offenen Betrag der Abschlagsrechnung."));
  return entry(e, ctx, {
    date: e.date,
    text: textWith(`Anzahlung ${e.advance.number ?? ""}`.trim(), e.counterpartyName),
    explanation: "S10",
    lines: withTaxPeriods(mergeLines(lines), ctx),
    dating: meansDating(e.means),
  });
}

function postRefund(e: CustomerRefundEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  if (!isInt(e.amountCents) || e.amountCents <= 0) return err(invalid("Der Erstattungsbetrag muss größer als 0 sein."));
  const means = meansRole(e.means) as AccountRole;
  const lines: RoleLine[] = [
    ...debit(R("receivable"), e.amountCents, { contactId: e.contactId }),
    ...credit(R(means), e.amountCents),
  ];
  // LEGAL-OPEN (F08 §4.2.2 P11-ist): under Ist the S13 correction parks its VAT reduction on
  // `vat.output.notdue.*`; the reduction takes effect when the Entgelt is paid back (§ 17 UStG with § 13 Abs. 1
  // Nr. 1 b UStG), so the refund releases its pro-rata share — mirror of the P1-ist transfer.
  const ist = e.ist ? e.ist.notDueVat.filter((v) => v.vatCents !== 0) : [];
  if (e.ist && ist.length > 0) {
    for (const v of ist) if (!rateSuffix(v.rateBp)) return err(RATE_UNSUPPORTED(v.rateBp));
    const shares = shareOfSettlement(
      ist.map((v) => v.vatCents),
      e.ist.payableCents,
      e.ist.settledBeforeCents,
      e.amountCents,
    );
    ist.forEach((v, i) => {
      const suffix = rateSuffix(v.rateBp) as "19" | "7";
      lines.push(...debit(R(`vat.output.${suffix}`), shares[i] ?? 0, { taxPointDate: e.date }));
      lines.push(...credit(R(`vat.output.notdue.${suffix}`), shares[i] ?? 0));
    });
  }
  return entry(e, ctx, {
    date: e.date,
    text: textWith(`Erstattung${e.target?.number ? ` ${e.target.number}` : ""}`, e.counterpartyName),
    explanation: ist.length > 0 ? "P11-ist" : "P11",
    lines: withTaxPeriods(mergeLines(lines), ctx),
    dating: meansDating(e.means),
  });
}

function postRecovery(e: WriteOffRecoveredEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  if (e.recovered.length === 0) return err(invalid("Es fehlt der wiedereingegangene Betrag."));
  const means = meansRole(e.means) as AccountRole;
  const lines: RoleLine[] = [];
  let gross = 0;
  for (const r of e.recovered) {
    const suffix = rateSuffix(r.rateBp);
    if (r.rateBp !== 0 && !suffix) return err(RATE_UNSUPPORTED(r.rateBp));
    lines.push(...credit(R("writeoff.recovery"), r.netCents));
    if (suffix) lines.push(...credit(R(`vat.output.${suffix}`), r.vatCents, { taxPointDate: e.date }));
    gross += r.netCents + r.vatCents;
  }
  if (gross <= 0) return err(invalid("Der wiedereingegangene Betrag muss größer als 0 sein."));
  return entry(e, ctx, {
    date: e.date,
    text: textWith(`Eingang abgeschr. Forderung ${e.documentNumber ?? ""}`.trim(), e.counterpartyName),
    explanation: "P9",
    lines: withTaxPeriods(mergeLines([...debit(R(means), gross), ...lines]), ctx),
    dating: meansDating(e.means),
  });
}

// ── cash transfers ──────────────────────────────────────────────────────────────────────────────────────

const LEGAL_FORM_DE: Partial<Record<LegalForm, string>> = {
  gmbh: "GmbH",
  ug: "UG (haftungsbeschränkt)",
  ag: "AG",
  gmbh_co_kg: "GmbH & Co. KG",
};

function postCashTransfer(e: CashTransferEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  if (!isInt(e.amountCents) || e.amountCents <= 0) return err(invalid("Der Betrag muss größer als 0 sein."));
  const amount = e.amountCents;
  const needBank = (): Result<AccountRole, PostingIssue> =>
    e.bankAccountId ? ok(bankRole(e.bankAccountId)) : err(invalid("Bitte das Bankkonto angeben."));
  switch (e.transferKind) {
    case "deposit_to_bank": {
      if ((e.leg ?? "cash") === "cash") {
        return entry(e, ctx, {
          date: e.date,
          text: "Bareinzahlung auf die Bank",
          explanation: "T5",
          lines: [...debit(R("transit"), amount), ...credit(R("cash"), amount)],
          dating: "user",
        });
      }
      const bank = needBank();
      if (!bank.ok) return bank;
      return entry(e, ctx, {
        date: e.date,
        text: "Gutschrift Bareinzahlung",
        explanation: "T5-bank",
        lines: [...debit(R(bank.value), amount), ...credit(R("transit"), amount)],
        dating: "external",
      });
    }
    case "private_withdrawal": {
      if (isCorporation(ctx.legalForm)) {
        if (!e.shareholder?.name.trim() || !e.shareholder.note.trim()) {
          return err(
            issue(
              "private_withdrawal_corporation",
              `Bei einer ${LEGAL_FORM_DE[ctx.legalForm] ?? "Kapitalgesellschaft"} gibt es keine Privatentnahmen. Die Buchung erfolgt über das Verrechnungskonto Gesellschafter.`,
            ),
          );
        }
        return entry(e, ctx, {
          date: e.date,
          text: textWith("Entnahme Verrechnung", e.shareholder.name),
          explanation: "T8-corp",
          lines: [...debit(R("shareholder.clearing"), amount), ...credit(R("cash"), amount)],
          dating: "user",
        });
      }
      return entry(e, ctx, {
        date: e.date,
        text: "Privatentnahme aus der Kasse",
        explanation: "T8",
        lines: [...debit(R("private.withdrawal"), amount), ...credit(R("cash"), amount)],
        dating: "user",
      });
    }
    case "bank_withdrawal_to_cash": {
      const bank = needBank();
      if (!bank.ok) return bank;
      const fee = e.feeCents ?? 0;
      if (!isInt(fee) || fee < 0) return err(invalid("Die Gebühr ist ungültig."));
      return entry(e, ctx, {
        date: e.date,
        text: "Bargeldabhebung in die Kasse",
        explanation: "T9",
        lines: [
          ...debit(R("transit"), amount),
          ...debit(R("expense.bank_fees"), fee),
          ...credit(R(bank.value), amount + fee),
          ...debit(R("cash"), amount),
          ...credit(R("transit"), amount),
        ],
        dating: "external",
      });
    }
  }
}

// ── marked bank transactions (T1/T2/T4) ─────────────────────────────────────────────────────────────────

function postBankMark(e: BankTransactionMarkedEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  const fee = e.feeCents ?? 0;
  if (
    !isInt(e.amountCents) ||
    e.amountCents === 0 ||
    !isInt(fee) ||
    fee < 0 ||
    (e.amountCents < 0 && fee >= -e.amountCents)
  ) {
    return err(invalid("Der Betrag des Bankumsatzes ist ungültig."));
  }
  const bank = R(bankRole(e.bankAccountId));
  const out = e.amountCents < 0;
  // Principal = what left/reached the counter account; the fee is always borne by the business (R5).
  const principal = out ? -e.amountCents - fee : e.amountCents + fee;
  const feeLines = debit(R("expense.bank_fees"), fee);
  let counter: AccountRole;
  let explanation: string;
  let text: string;
  if (e.mark === "transfer") {
    counter = "transit";
    explanation = out ? "T4-out" : "T4-in";
    text = out ? "Geldtransit an eigenes Konto" : "Geldtransit von eigenem Konto";
  } else if (isCorporation(ctx.legalForm)) {
    if (!e.shareholder?.name.trim() || !e.shareholder.note.trim()) {
      return err(
        issue(
          "private_withdrawal_corporation",
          `Bei einer ${LEGAL_FORM_DE[ctx.legalForm] ?? "Kapitalgesellschaft"} gibt es keine Privatentnahmen. Die Buchung erfolgt über das Verrechnungskonto Gesellschafter.`,
        ),
      );
    }
    counter = "shareholder.clearing";
    explanation = out ? "T1-corp" : "T2-corp";
    text = textWith(out ? "Entnahme Verrechnung" : "Einlage Verrechnung", e.shareholder.name);
  } else {
    counter = out ? "private.withdrawal" : "private.deposit";
    explanation = out ? "T1" : "T2";
    text = out ? "Privatentnahme laut Kontoauszug" : "Privateinlage laut Kontoauszug";
  }
  const lines = out
    ? [...debit(R(counter), principal), ...feeLines, ...credit(bank, -e.amountCents)]
    : [...debit(bank, e.amountCents), ...feeLines, ...credit(R(counter), principal)];
  return entry(e, ctx, { date: e.date, text, explanation, lines, dating: "external" });
}

// ── opening balances ────────────────────────────────────────────────────────────────────────────────────

function postOpening(e: OpeningBalanceEvent, ctx: PostingContext): Result<PostingOutcome, PostingIssue> {
  const p = e.part;
  const base = { date: e.date, dating: "user" as const };
  if (p.kind === "cash") {
    if (!isInt(p.amountCents) || p.amountCents < 0) {
      return err(invalid("Der Kassenbestand kann nicht negativ sein (Kasse nie im Minus)."));
    }
    if (p.amountCents === 0) return ok({ kind: "none", reason: "zero_amount" });
    return entry(e, ctx, {
      ...base,
      text: `Eröffnungsbilanz ${e.fiscalYear} Kasse`,
      explanation: "ACC-013-cash",
      lines: [...debit(R("cash"), p.amountCents), ...credit(R("opening.gl"), p.amountCents)],
    });
  }
  if (p.kind === "bank") {
    if (!isInt(p.amountCents)) return err(invalid("Beträge müssen ganze Cent sein."));
    if (p.amountCents === 0) return ok({ kind: "none", reason: "zero_amount" });
    return entry(e, ctx, {
      ...base,
      text: `Eröffnungsbilanz ${e.fiscalYear} Bank`,
      explanation: "ACC-013-bank",
      lines: [...debit(R(bankRole(p.bankAccountId)), p.amountCents), ...credit(R("opening.gl"), p.amountCents)],
    });
  }
  if (p.items.length === 0) return err(invalid("Es sind keine offenen Forderungen angegeben."));
  const lines: RoleLine[] = [];
  for (const it of p.items) {
    if (!isInt(it.openCents) || it.openCents <= 0) {
      return err(invalid(`Offener Betrag von ${it.number} muss größer als 0 sein.`));
    }
    const contact = it.contactId ? { contactId: it.contactId } : {};
    lines.push(...debit(R("receivable"), it.openCents, contact), ...credit(R("opening.debtors"), it.openCents));
    if (it.taxedAs === "ist") {
      for (const v of it.notDueVat ?? []) {
        const suffix = rateSuffix(v.rateBp);
        if (!suffix) return err(RATE_UNSUPPORTED(v.rateBp));
        lines.push(...debit(R("opening.gl"), v.vatCents), ...credit(R(`vat.output.notdue.${suffix}`), v.vatCents));
      }
    }
  }
  return entry(e, ctx, {
    ...base,
    text: `Eröffnungsbilanz ${e.fiscalYear} offene Forderungen`,
    explanation: "ACC-013-receivables",
    lines,
  });
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────────────

function entry(
  e: BusinessEvent,
  _ctx: PostingContext,
  p: Omit<Posting, "source" | "ruleVersion" | "date"> & { date: string },
): Result<PostingOutcome, PostingIssue> {
  const check = checkBalanced(p.lines);
  if (!check.ok) return err(invalid(check.error.message));
  return ok({
    kind: "entry",
    posting: { ...p, date: calendarDate(p.date), source: sourceOf(e), ruleVersion: POSTING_RULE_VERSION },
  });
}

/**
 * The posting matrix for every non-reversal event. Reversals (Storno S12, payment reversal P10, cash transfer
 * reversal T10) mirror the stored entries — see `reversalPosting`.
 */
export function postEvent(
  e: Exclude<BusinessEvent, ReversalEvent>,
  ctx: PostingContext,
): Result<PostingOutcome, PostingIssue> {
  switch (e.kind) {
    case "voucher_booked": {
      const r = postVoucherBooked(e, {
        corporation: isCorporation(ctx.legalForm),
        taxationMethod: ctx.taxationMethod,
      });
      if (!r.ok) return r;
      return entry(e, ctx, {
        date: e.date,
        text: r.value.text,
        explanation: r.value.explanation,
        lines: withTaxPeriods(mergeLines(r.value.lines), ctx),
        dating: "external",
      });
    }
    case "voucher_paid": {
      const r = postVoucherPaid({ ...e, corporation: e.corporation ?? isCorporation(ctx.legalForm) });
      if (!r.ok) return r;
      return entry(e, ctx, {
        date: e.date,
        text: r.value.text,
        explanation: r.value.explanation,
        lines: withTaxPeriods(mergeLines(r.value.lines), ctx),
        dating: e.means.kind === "bank_account" ? "external" : "user",
      });
    }
    case "invoice_finalised":
      return postInvoice(e, ctx);
    case "invoice_corrected":
      return postCorrection(e, ctx);
    case "payment_received":
      return postPayment(e, ctx);
    case "advance_payment_received":
      return postAdvancePayment(e, ctx);
    case "customer_refund":
      return postRefund(e, ctx);
    case "writeoff_recovered":
      return postRecovery(e, ctx);
    case "cash_transfer":
      return postCashTransfer(e, ctx);
    case "bank_transaction_marked":
      return postBankMark(e, ctx);
    case "opening_balance":
      return postOpening(e, ctx);
  }
}

// ── reversals (Generalumkehr, ACC-004) ──────────────────────────────────────────────────────────────────

const REVERSAL_EXPLANATION: Record<ReversalEvent["kind"], string> = {
  voucher_reversed: "V-storno",
  invoice_cancelled: "S12",
  payment_reversed: "P10",
  cash_transfer_reversed: "T10",
  bank_transaction_mark_reversed: "BNK-mark-reversal",
};

/** Mirrored lines: same accounts, sides swapped; VAT lines are reported in the reversal's period (§17 UStG). */
export function mirrorLines<L extends RoleLine>(lines: readonly L[], reversalDate: string, ctx: PostingContext): L[] {
  return lines.map((l) => {
    const { taxPeriod: _tp, ...rest } = l;
    const m = { ...rest, debitCents: l.creditCents, creditCents: l.debitCents } as L;
    if (l.taxPointDate !== undefined) {
      m.taxPointDate = reversalDate;
      const tp = taxPeriodOf(reversalDate, ctx.ustvaPeriod);
      if (tp) m.taxPeriod = tp;
    }
    return m;
  });
}

export function reversalPosting(
  e: ReversalEvent,
  original: { lines: readonly RoleLine[]; text: string },
  ctx: PostingContext,
): Posting {
  const head = e.kind === "invoice_cancelled" ? `Storno ${e.documentNumber}` : `Storno: ${original.text}`;
  // VOU-008: a correction mirrors the booking with its original tax points (Generalumkehr in the same period), the
  // re-post follows; a cancellation (VOU-009) reports the reversal in its own period (§ 17 UStG).
  const keepTaxPoints = e.kind === "voucher_reversed" && e.mode === "correction";
  return {
    date: calendarDate(e.date),
    text: truncate(head),
    explanation:
      e.kind === "voucher_reversed" && e.mode === "correction" ? "V-correction" : REVERSAL_EXPLANATION[e.kind],
    ruleVersion: POSTING_RULE_VERSION,
    source: sourceOf(e),
    lines: keepTaxPoints
      ? original.lines.map((l) => ({ ...l, debitCents: l.creditCents, creditCents: l.debitCents }))
      : mirrorLines(original.lines, e.date, ctx),
    // Storno/reversal of possibly locked records → first open period (ACC-006 b).
    dating: "external",
  };
}

// ── balance check (ACC-001, RI-12) ──────────────────────────────────────────────────────────────────────

export type BalanceIssue = Issue<"journal_unbalanced" | "journal_invalid_line">;

/** Σ debit = Σ credit > 0, ≥ 2 lines, every line one-sided with whole non-negative cents (E-ACC-01). */
export function checkBalanced(
  lines: readonly { debitCents: number; creditCents: number }[],
): Result<{ totalCents: number }, BalanceIssue> {
  if (lines.length < 2) return err(issue("journal_invalid_line", "Eine Buchung braucht mindestens zwei Zeilen."));
  let d = 0;
  let c = 0;
  for (const l of lines) {
    const valid =
      isInt(l.debitCents) &&
      isInt(l.creditCents) &&
      l.debitCents >= 0 &&
      l.creditCents >= 0 &&
      (l.debitCents === 0) !== (l.creditCents === 0);
    if (!valid) {
      return err(
        issue("journal_invalid_line", "Jede Buchungszeile hat genau einen Soll- oder Haben-Betrag in ganzen Cent."),
      );
    }
    d += l.debitCents;
    c += l.creditCents;
  }
  if (d !== c || d <= 0) {
    const diff = Math.abs(d - c);
    return err(
      issue("journal_unbalanced", `Soll und Haben sind nicht ausgeglichen (Differenz: ${formatEuro(diff)}).`, {
        diffCents: diff,
      }),
    );
  }
  return ok({ totalCents: d });
}
