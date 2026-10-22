/**
 * Finalisation check of a voucher („Buchen“, F06 VOU-001…028, VOU-060…065; exhaustive rules F06 §5.2/§5.3).
 *
 * Returns blocking errors (E), warnings (W; `acknowledge: true` = ⚑, must be acknowledged via
 * `acknowledgeWarnings` / API `acknowledge_warnings`) and infos, plus the derived values the model stores at
 * booking: the effective tax rule (KU replacement, VOU-026), totals (document currency) and EUR lines/totals
 * (VOU-028) and the „Vorsteuerabzug gefährdet“ list (VOU-006, `inputVatAtRisk`). Pure; `today` passed in.
 */

import { supplyEnd } from "../accounting/period";
import { type Issue, issue } from "../result";
import { lookupRule } from "../rules/rule-table";
import { KLEINBETRAG_LIMIT } from "../rules/thresholds";
import { type CalendarDate, calendarDate, isCalendarDate } from "../time/calendar-date";
import { type AccountContext, checkLineAccount, isFixedAssetAccount, looksLikeOwnSales } from "./accounts";
import { checkAssetDecisions } from "./assets";
import { BEWIRTUNG_MESSAGES, type BewirtungData, checkBewirtungLines } from "./bewirtung";
import { activeOriginals, CAPTURE_MESSAGES, hasBeleg } from "./capture";
import { type DuplicateFinding, duplicateMessage } from "./duplicates";
import { EIGENBELEG_MESSAGES, type EigenbelegData, eigenbelegVolumeInfo } from "./eigenbeleg";
import {
  checkLineVat,
  checkStatedTotals,
  convertLinesToEur,
  type EurLine,
  type StatedTotals,
  voucherTotals,
} from "./lines";
import { checkTaxPayment } from "./tax-payment";
import { checkTaxRule, checkVoucherRate, deductsInputVat, effectiveTaxRule, KU_INPUT_VAT_INFO } from "./tax-rules";
import {
  isIncomeRule,
  isSelfAssessment,
  type SupplyDate,
  type TaxPaymentSubtype,
  type TaxRule,
  type VoucherDirection,
  type VoucherKind,
  type VoucherLine,
  type VoucherTotals,
  type VoucherTotalsEur,
} from "./types";

export interface VoucherDraft {
  direction: VoucherDirection;
  kind: VoucherKind;
  taxRule: TaxRule;
  supplierName?: string;
  supplierContactId?: string;
  supplierVatId?: string;
  supplierTaxNumber?: string;
  /** The supplier's postal address is known (contact or document). */
  supplierHasAddress?: boolean;
  documentNumber?: string;
  documentDate?: string;
  supplyDate?: SupplyDate;
  currency: string;
  fxRateToEur?: { rate: string };
  lines: readonly VoucherLine[];
  statedTotals?: StatedTotals;
  originalFiles: readonly { replacedBy?: number }[];
  bewirtung?: BewirtungData;
  eigenbeleg?: EigenbelegData;
  taxPayment?: { subtype: TaxPaymentSubtype; period?: string };
  creditNoteOfId?: string;
  /** Recurring voucher with a linked reference document (rental contract) — counts as Beleg (EC-VOU-01). */
  recurringReference?: boolean;
  /** The bank statement line is the Beleg (bank fees, VOU-013). */
  statementIsBeleg?: boolean;
}

export interface ValidationContext {
  today: CalendarDate;
  /** KU on the supply date (KU-01). */
  companyIsKu: boolean;
  ownVatId?: string;
  corporation: boolean;
  accounts: AccountContext;
  duplicates?: readonly DuplicateFinding[];
  /** Eigenbelege in the month of this voucher (incl. this one), EC-EIG-03. */
  eigenbelegCountInMonth?: number;
  /** E-Rechnung BT-111 (VAT in EUR), EC-VOU-32. */
  statedVatEurCents?: number;
  /** Locked/locking periods (ACC-006, EC-VOU-09). */
  closedPeriods?: ReadonlySet<string>;
}

export interface VoucherWarning {
  code: string;
  message: string;
  acknowledge: boolean;
}

export interface VoucherCheck {
  errors: Issue[];
  warnings: VoucherWarning[];
  infos: Issue[];
  effectiveTaxRule: TaxRule;
  totals: VoucherTotals;
  totalsEur: VoucherTotalsEur;
  eurLines: EurLine[];
  inputVatAtRisk: string[];
  supplyEndDate: CalendarDate | null;
}

export const VOUCHER_MESSAGES = {
  header: "Belegdatum, Lieferant und mindestens eine Position sind erforderlich.",
  future: "Das Belegdatum darf nicht in der Zukunft liegen.",
  zero: "Ein Beleg mit Betrag 0 kann nicht gebucht werden.",
  privateCorporation: "Kapitalgesellschaften haben kein Privatkonto. Bitte Verrechnungskonto Gesellschafter verwenden.",
  privateNoInputVat: "Private Ausgaben werden ohne Vorsteuerabzug als Privatentnahme gebucht.",
  privateIncome: "Private Belege sind nur als Ausgabe möglich.",
  ownSales: "Erlöse aus eigenen Leistungen bitte über eine Rechnung erfassen (fortlaufende Rechnungsnummer).",
  creditNoteLink: "Gutschrift/Korrektur des Lieferanten ohne Bezug zum Originalbeleg.",
  importVatReference: "Einfuhrumsatzsteuer nur mit Einfuhrabgabenbescheid abziehbar. Bitte Bescheid hochladen.",
  incomeRule:
    "Einnahmebelege brauchen eine Einnahme-Steuerregel (umsatzsteuerpflichtig, steuerfrei oder nicht steuerbar).",
  expenseRule: "Für Ausgaben ist diese Steuerregel nicht zulässig.",
  kuOutputVat:
    "Als Kleinunternehmer weisen Sie keine Umsatzsteuer aus. Bitte ‚Steuerfreie‘ oder ‚Nicht steuerbare Einnahme‘ wählen.",
  inputVatAtRisk: (fields: string) => `Vorsteuerabzug gefährdet: ${fields} fehlen auf der Rechnung (§ 14 Abs. 4 UStG).`,
  bankFees:
    "Bankgebühren sind in der Regel steuerfreie Finanzdienstleistungen (§ 4 Nr. 8 UStG). Vorsteuer oder Reverse Charge nur mit Rechnung, die Umsatzsteuer bzw. Reverse Charge ausweist. Bitte Rechnung anhängen und Grund angeben.",
  assetAccount: (position: number) => `Für Position ${position} als Anlage bitte ein Anlagenkonto wählen.`,
  lockedPeriod: (period: string, open: string) =>
    `Der Zeitraum ${period.slice(5, 7)}/${period.slice(0, 4)} ist festgeschrieben. Der Beleg wird im Zeitraum ${open.slice(5, 7)}/${open.slice(0, 4)} gebucht. Die Vorsteuer gehört zur bereits übermittelten UStVA ${period.slice(5, 7)}/${period.slice(0, 4)} – im aktuellen Zeitraum geltend machen oder berichtigte Voranmeldung erstellen?`,
} as const;

/** VOU-006 field labels (§ 14 Abs. 4 UStG). */
export const INPUT_VAT_FIELDS = {
  supplier: "Name und Anschrift des Lieferanten",
  taxId: "Steuernummer oder USt-IdNr des Lieferanten",
  number: "Rechnungsnummer",
  date: "Rechnungsdatum",
  description: "Leistungsbeschreibung",
  vat: "Steuerbetrag je Steuersatz",
} as const;

/** VOU-005/VOU-006: missing §14 Abs. 4 items for invoices above the Kleinbetrag limit with input-VAT deduction. */
export function inputVatContentGaps(d: VoucherDraft, grossEurCents: number, date: CalendarDate): string[] {
  const limit = lookupRule(KLEINBETRAG_LIMIT, date);
  if (!limit.ok || grossEurCents <= limit.value.value.limitCents) return []; // Kleinbetragsrechnung (UST-14)
  const out: string[] = [];
  if (!d.supplierName?.trim() || d.supplierHasAddress === false) out.push(INPUT_VAT_FIELDS.supplier);
  if (!d.supplierTaxNumber?.trim() && !d.supplierVatId?.trim()) out.push(INPUT_VAT_FIELDS.taxId);
  if (!d.documentNumber?.trim()) out.push(INPUT_VAT_FIELDS.number);
  if (!d.documentDate) out.push(INPUT_VAT_FIELDS.date);
  if (d.lines.some((l) => !l.description?.trim())) out.push(INPUT_VAT_FIELDS.description);
  if (d.lines.some((l) => l.vatRateBp > 0 && l.vatCents === 0)) out.push(INPUT_VAT_FIELDS.vat);
  return out;
}

const nextOpen = (period: string, closed: ReadonlySet<string>) => {
  let p = period;
  while (closed.has(p)) {
    const y = Number(p.slice(0, 4));
    const m = Number(p.slice(5, 7));
    p = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return p;
};

export function validateVoucher(d: VoucherDraft, ctx: ValidationContext): VoucherCheck {
  const errors: Issue[] = [];
  const warnings: VoucherWarning[] = [];
  const infos: Issue[] = [];
  const warn = (i: Issue, acknowledge = true) => warnings.push({ code: i.code, message: i.message, acknowledge });

  // ── header (EC-VOU-02/08) ───────────────────────────────────────────────────────────────────────────
  const hasSupplier = !!(d.supplierName?.trim() || d.supplierContactId);
  const needsSupplier = d.kind !== "tax_payment" && d.kind !== "eigenbeleg";
  if (!d.documentDate || !isCalendarDate(d.documentDate) || (needsSupplier && !hasSupplier) || d.lines.length === 0) {
    errors.push(issue("voucher_header_missing", VOUCHER_MESSAGES.header));
  }
  const docDate = d.documentDate && isCalendarDate(d.documentDate) ? (d.documentDate as CalendarDate) : null;
  if (docDate && docDate > ctx.today) errors.push(issue("voucher_date_future", VOUCHER_MESSAGES.future));
  const supply: SupplyDate | undefined = d.supplyDate ?? (docDate ? { kind: "date", date: docDate } : undefined);
  let supplyEndDate: CalendarDate | null = null;
  try {
    supplyEndDate = supply ? supplyEnd(supply) : null;
  } catch {
    errors.push(issue("voucher_supply_invalid", "Bitte ein gültiges Leistungsdatum angeben."));
  }
  const rateDate = supplyEndDate ?? docDate ?? ctx.today;

  // ── tax rule (VOU-010, VOU-023/025/026) ─────────────────────────────────────────────────────────────
  if (d.direction === "income" && !isIncomeRule(d.taxRule) && d.kind !== "tax_payment") {
    errors.push(issue("voucher_rule_direction", VOUCHER_MESSAGES.incomeRule));
  }
  if (d.direction === "expense" && isIncomeRule(d.taxRule)) {
    errors.push(issue("voucher_rule_direction", VOUCHER_MESSAGES.expenseRule));
  }
  let rule = d.taxRule;
  if (d.kind === "eigenbeleg") {
    if (d.taxRule === "input_vat_deductible" || d.lines.some((l) => l.vatCents !== 0 && d.taxRule !== "no_input_vat")) {
      errors.push(issue("eigenbeleg_input_vat", EIGENBELEG_MESSAGES.inputVat));
    }
    rule = "no_input_vat";
  }
  // VOU-066: a private expense is a Privatentnahme of the gross — never input VAT (the business is not the recipient).
  if (d.kind === "private") {
    if (d.direction !== "expense") errors.push(issue("private_income", VOUCHER_MESSAGES.privateIncome));
    infos.push(issue("private_no_input_vat", VOUCHER_MESSAGES.privateNoInputVat));
    rule = "no_input_vat";
  }
  const eff = effectiveTaxRule(rule, ctx.companyIsKu);
  if (eff.info) infos.push(issue("ku_no_input_vat", KU_INPUT_VAT_INFO));
  rule = eff.rule;
  if (ctx.companyIsKu && rule === "output_vat" && d.lines.some((l) => l.vatCents !== 0)) {
    errors.push(issue("ku_output_vat", VOUCHER_MESSAGES.kuOutputVat));
  }
  const vatShown = d.lines.reduce((s, l) => s + Math.abs(l.vatCents), 0);
  const tr = checkTaxRule({
    taxRule: rule,
    vatShownCents: vatShown,
    ...(d.supplierVatId ? { supplierVatId: d.supplierVatId } : {}),
    ...(ctx.ownVatId ? { ownVatId: ctx.ownVatId } : {}),
  });
  errors.push(...tr.errors);
  for (const w of tr.warnings) warn(w);

  // ── kind specifics ──────────────────────────────────────────────────────────────────────────────────
  if (d.kind === "private" && ctx.corporation) {
    errors.push(issue("private_corporation", VOUCHER_MESSAGES.privateCorporation));
  }
  if (d.kind === "tax_payment") {
    if (!d.taxPayment) errors.push(issue("tax_payment_subtype", "Bitte die Art der Steuerzahlung angeben."));
    else {
      const t = checkTaxPayment({
        subtype: d.taxPayment.subtype,
        ...(d.taxPayment.period ? { period: d.taxPayment.period } : {}),
        corporation: ctx.corporation,
      });
      if (t) errors.push(t);
    }
  }
  if (d.kind === "bewirtung") {
    if (!d.bewirtung?.approvedAt) errors.push(issue("bewirtung_not_approved", BEWIRTUNG_MESSAGES.notApproved));
    if (d.bewirtung) {
      const b = checkBewirtungLines(d.lines, d.bewirtung, rateDate);
      errors.push(...b.errors);
      for (const w of b.warnings) warn(w, false);
    }
  }
  if (d.kind === "eigenbeleg") {
    if (!d.eigenbeleg?.approvedAt) errors.push(issue("eigenbeleg_not_approved", EIGENBELEG_MESSAGES.notApproved));
  }

  // ── lines (VOU-002/004, EC-VOU-04/05/06/37/38) ──────────────────────────────────────────────────────
  d.lines.forEach((l, i) => {
    const position = i + 1;
    // Tax payments and private vouchers post to fixed roles; the line account is only a category there.
    if (d.kind !== "tax_payment" && d.kind !== "private") {
      const a = checkLineAccount(l.account, { direction: d.direction, taxRule: rule }, ctx.accounts);
      if (a) errors.push(a);
    }
    const r = checkVoucherRate(l.vatRateBp, rule, rateDate);
    if (r) errors.push(r);
    if (!isSelfAssessment(rule) && (l.vatCents !== 0 || l.vatRateBp !== 0)) {
      const v = checkLineVat(l, position);
      if (v) errors.push(v);
    }
    if (l.assetDecision === "asset") {
      const seed = ctx.accounts.accounts.find((a) => a.number === l.account);
      if (!seed || !isFixedAssetAccount(seed)) {
        errors.push(issue("asset_account_required", VOUCHER_MESSAGES.assetAccount(position), { position }));
      }
    }
  });
  const bankFeeAccount = ctx.accounts.roleAccounts["expense.bank_fees"];
  if (
    bankFeeAccount &&
    rule !== "no_input_vat" &&
    d.direction === "expense" &&
    d.lines.some((l) => l.account === bankFeeAccount)
  ) {
    if (activeOriginals(d.originalFiles).length === 0) errors.push(issue("bank_fee_vat", VOUCHER_MESSAGES.bankFees));
    else warn(issue("bank_fee_vat", VOUCHER_MESSAGES.bankFees));
  }
  const importVatAccount = ctx.accounts.roleAccounts["vat.import"];
  if (importVatAccount && d.lines.some((l) => l.account === importVatAccount)) {
    if (ctx.companyIsKu) {
      errors.push(
        issue(
          "import_vat_ku",
          "Als Kleinunternehmer ist die Einfuhrumsatzsteuer nicht abziehbar. Bitte ein Aufwandskonto wählen.",
        ),
      );
    } else if (!d.documentNumber?.trim()) warn(issue("import_vat_reference", VOUCHER_MESSAGES.importVatReference));
  }

  // ── totals (VOU-003, EC-VOU-03/35), FX (VOU-028, EC-VOU-16/32) ──────────────────────────────────────
  const totals = voucherTotals(d.lines);
  if (d.lines.length > 0 && totals.grossCents === 0 && totals.selfAssessedVatCents === 0) {
    errors.push(issue("voucher_zero", VOUCHER_MESSAGES.zero));
  }
  const stated = checkStatedTotals(totals, d.statedTotals);
  if (stated) errors.push(stated);
  const fx = convertLinesToEur(d.lines, d.currency, d.fxRateToEur, ctx.statedVatEurCents);
  let eurLines: EurLine[] = d.lines.map((l) => ({
    netEurCents: l.netCents,
    vatEurCents: l.vatCents,
    selfAssessedVatEurCents: l.selfAssessedVatCents ?? 0,
  }));
  let totalsEur: VoucherTotalsEur = {
    netCents: totals.netCents,
    vatCents: totals.vatCents,
    grossCents: totals.grossCents,
    selfAssessedVatCents: totals.selfAssessedVatCents,
  };
  if (!fx.ok) errors.push(fx.error);
  else {
    eurLines = fx.value.lines;
    totalsEur = fx.value.totals;
    if (fx.value.warning) warn(fx.value.warning, false);
  }

  // ── Beleg (EC-VOU-01), §14 content (VOU-006), assets (VOU-065), duplicates (VOU-052) ────────────────
  const beleg = hasBeleg({
    files: d.originalFiles,
    kind: d.kind,
    ...(d.eigenbeleg?.approvedAt ? { eigenbelegApproved: true } : {}),
    ...(d.recurringReference || d.statementIsBeleg ? { recurringReference: true } : {}),
  });
  if (!beleg) errors.push(issue("voucher_file_missing", CAPTURE_MESSAGES.noFile));
  let inputVatAtRisk: string[] = [];
  if (rule === "input_vat_deductible" && docDate) {
    inputVatAtRisk = inputVatContentGaps(d, Math.abs(totalsEur.grossCents), docDate);
    if (inputVatAtRisk.length > 0) {
      warn(issue("input_vat_at_risk", VOUCHER_MESSAGES.inputVatAtRisk(inputVatAtRisk.join(", "))));
    }
  }
  if (d.direction === "expense" && d.kind !== "tax_payment" && d.kind !== "private") {
    errors.push(
      ...checkAssetDecisions(
        d.lines.map((l) => ({
          account: l.account,
          ...(l.quantityMilli !== undefined ? { quantityMilli: l.quantityMilli } : {}),
          netCents: l.netCents,
          grossCents: l.grossCents,
          ...(l.assetDecision ? { assetDecision: l.assetDecision } : {}),
        })),
        { chart: ctx.accounts.chart, date: rateDate, deductible: deductsInputVat(rule, ctx.companyIsKu) },
      ),
    );
  }
  for (const f of ctx.duplicates ?? []) {
    const message = duplicateMessage(f);
    if (f.level === "strong") errors.push(issue("duplicate_strong", message, { of: f.id }));
    else warnings.push({ code: `duplicate_${f.level}`, message, acknowledge: true });
  }

  // ── income, credit notes, Eigenbeleg volume, locked period ──────────────────────────────────────────
  if (d.direction === "income" && d.lines.some((l) => looksLikeOwnSales(l.account, ctx.accounts))) {
    warn(issue("income_own_sales", VOUCHER_MESSAGES.ownSales));
  }
  if (totals.grossCents < 0 && !d.creditNoteOfId)
    warn(issue("credit_note_unlinked", VOUCHER_MESSAGES.creditNoteLink), false);
  if (d.kind === "eigenbeleg" && ctx.eigenbelegCountInMonth !== undefined) {
    const info = eigenbelegVolumeInfo({
      countInMonth: ctx.eigenbelegCountInMonth,
      grossEurCents: totalsEur.grossCents,
    });
    if (info) infos.push(info);
  }
  if (docDate && ctx.closedPeriods?.has(docDate.slice(0, 7))) {
    const period = docDate.slice(0, 7);
    warn(issue("period_locked_late", VOUCHER_MESSAGES.lockedPeriod(period, nextOpen(period, ctx.closedPeriods))));
  }

  return {
    errors,
    warnings,
    infos,
    effectiveTaxRule: rule,
    totals,
    totalsEur,
    eurLines,
    inputVatAtRisk,
    supplyEndDate: supplyEndDate ? calendarDate(supplyEndDate) : null,
  };
}

/** ⚑ warnings not acknowledged by code. */
export const unacknowledgedWarnings = (check: Pick<VoucherCheck, "warnings">, acknowledged: readonly string[]) =>
  check.warnings.filter((w) => w.acknowledge && !acknowledged.includes(w.code));
