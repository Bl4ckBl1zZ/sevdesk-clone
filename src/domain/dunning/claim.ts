/**
 * The claim of one reminder on its document date — F05 DUN-005, DUN-023…026, MAHN-02/03. Pure.
 *
 * Fees, interest and the 40 € flat fee need default on the reminder date (DUN-026); interest runs from the default
 * start to the reminder date over the open principal history (DUN-023); the 40 € is B2B only and once per claim
 * (DUN-024). The printed deadline is shifted to the next business day (§ 193 BGB).
 */
import { formatEuro } from "../money/format";
import { err, type Issue, ok, type Result } from "../result";
import type { BasiszinssatzValue } from "../rules/basiszinssatz";
import { shiftToBusinessDay } from "../rules/holidays";
import type { RuleOverride } from "../rules/rule-table";
import { lookupVerzugSurcharges } from "../rules/thresholds";
import { addDays, type CalendarDate, formatGermanDate } from "../time/calendar-date";
import { type DefaultStart, inDefaultOn } from "./default-start";
import { computeInterest, type InterestSegment, type PrincipalChange } from "./interest";
import { B2C_FEE_WARNING_CENTS, MSG } from "./policy";

export interface ClaimStep {
  readonly level: number;
  readonly title: string;
  readonly feeCents: number;
  readonly addInterest: boolean;
  readonly addFlatFee40: boolean;
  readonly newDueDays: number;
}

export interface PrincipalHistory {
  /** Open principal (payable − settled) on the default start day, before changes dated after it. */
  readonly principalCents: number;
  /** Settlement changes after the default start (payments −, reversals +). */
  readonly changes: readonly PrincipalChange[];
}

export interface ClaimInput {
  readonly date: CalendarDate;
  readonly step: ClaimStep;
  readonly isConsumer: boolean;
  readonly defaultStart: DefaultStart | null;
  readonly openAmountCents: number;
  readonly history: PrincipalHistory;
  readonly flatFeeCharged: boolean;
  /** Company Bundesland for the § 193 shift. */
  readonly state?: string | undefined;
  readonly overrides?: readonly RuleOverride<BasiszinssatzValue>[];
  /** Document currency (default EUR). EC-DUN-27: fees/interest in it, the 40 € always in EUR. */
  readonly currency?: string | undefined;
}

export interface Claim {
  readonly level: number;
  readonly title: string;
  readonly inDefault: boolean;
  readonly feeCents: number;
  readonly interestCents: number;
  readonly interestSegments: readonly InterestSegment[];
  readonly flatFee40Cents: number;
  readonly flatFeeAlreadyClaimed: boolean;
  readonly openAmountCents: number;
  readonly newDueDate: CalendarDate;
  /** In the document currency; for a non-EUR invoice without the EUR flat fee (EC-DUN-27). */
  readonly totalCents: number;
  readonly defaultStartDate?: CalendarDate;
  /** EC-DUN-27: set for a non-EUR invoice — the claim is split by currency, the 40 € stays EUR. */
  readonly currency?: string;
  readonly flatFeeCurrency?: "EUR";
}

/** EC-DUN-27 / MISC-08: the § 288 Abs. 5 flat fee is a EUR amount; a foreign-currency claim shows it apart. */
export const FLAT_FEE_EUR_MESSAGE = "Pauschale nach § 288 Abs. 5 BGB wird in EUR ausgewiesen.";
const isForeign = (currency: string | undefined) => currency !== undefined && currency !== "EUR";
const totalOf = (c: Pick<Claim, "openAmountCents" | "currency">, fee: number, interest: number, flat: number) =>
  c.openAmountCents + fee + interest + (isForeign(c.currency) ? 0 : flat);

export function computeClaim(i: ClaimInput): Result<Claim, Issue> {
  const inDefault = inDefaultOn(i.defaultStart, i.date);
  let interestCents = 0;
  let interestSegments: readonly InterestSegment[] = [];
  if (i.step.addInterest && inDefault && i.defaultStart) {
    const r = computeInterest({
      principalCents: i.history.principalCents,
      changes: i.history.changes,
      from: i.defaultStart.date,
      to: i.date,
      margin: i.isConsumer ? "b2c" : "b2b",
      ...(i.overrides ? { overrides: i.overrides } : {}),
    });
    if (!r.ok) return err(r.error);
    interestCents = r.value.totalCents;
    interestSegments = r.value.printable ? r.value.segments : [];
  }
  let flatFee40Cents = 0;
  if (i.step.addFlatFee40 && !i.isConsumer && inDefault && !i.flatFeeCharged) {
    const s = lookupVerzugSurcharges(i.date);
    if (!s.ok) return err(s.error);
    flatFee40Cents = s.value.value.flatFeeB2bCents;
  }
  const feeCents = inDefault ? i.step.feeCents : 0;
  const newDueDate = shiftToBusinessDay(addDays(i.date, i.step.newDueDays), i.state);
  return ok({
    level: i.step.level,
    title: i.step.title,
    inDefault,
    feeCents,
    interestCents,
    interestSegments,
    flatFee40Cents,
    flatFeeAlreadyClaimed: !i.isConsumer && i.flatFeeCharged,
    openAmountCents: i.openAmountCents,
    newDueDate,
    totalCents: totalOf(
      { openAmountCents: i.openAmountCents, currency: i.currency },
      feeCents,
      interestCents,
      flatFee40Cents,
    ),
    ...(i.defaultStart ? { defaultStartDate: i.defaultStart.date } : {}),
    ...(isForeign(i.currency) ? { currency: i.currency as string, flatFeeCurrency: "EUR" as const } : {}),
  });
}

// ── manual reminder (DUN-008) ────────────────────────────────────────────────────────────────────────────────────

export interface ManualAmounts {
  readonly feeCents?: number | undefined;
  readonly interestCents?: number | undefined;
  readonly interestReason?: string | undefined;
  readonly includeFlatFee?: boolean | undefined;
  readonly newDueDate?: string | undefined;
}

export interface DunningFinding {
  readonly code: string;
  readonly severity: "E" | "W";
  readonly message: string;
  readonly rule?: string;
  readonly field?: string;
}

export interface ManualClaimResult {
  readonly claim: Claim;
  readonly findings: readonly DunningFinding[];
}

/**
 * Applies the editable amounts of a manual reminder to the computed claim and checks EC-DUN-01…08. Errors (E) block;
 * warnings (W) must be acknowledged (⚑).
 */
export function applyManualAmounts(
  computed: Claim,
  m: ManualAmounts,
  ctx: {
    readonly isConsumer: boolean;
    readonly flatFeeCharged: boolean;
    readonly flatFeeReminderNumber?: string;
    readonly date: CalendarDate;
  },
): ManualClaimResult {
  const findings: DunningFinding[] = [];
  const feeCents = m.feeCents ?? computed.feeCents;
  const interestCents = m.interestCents ?? computed.interestCents;
  const wantFlat = m.includeFlatFee ?? computed.flatFee40Cents > 0;
  let flatFee40Cents = 0;
  if (wantFlat) {
    if (ctx.isConsumer) {
      findings.push({
        code: "flat_fee_consumer",
        severity: "E",
        rule: "MAHN-03",
        message: MSG.flatFeeConsumer,
        field: "includeFlatFee",
      });
    } else if (ctx.flatFeeCharged) {
      findings.push({
        code: "flat_fee_already_charged",
        severity: "E",
        rule: "MAHN-03",
        field: "includeFlatFee",
        message: `Die 40-€-Pauschale wurde für diese Forderung bereits mit Mahnung ${ctx.flatFeeReminderNumber ?? "–"} geltend gemacht.`,
      });
    } else if (!computed.inDefault) {
      findings.push({
        code: "flat_fee_not_in_default",
        severity: "E",
        rule: "MAHN-03",
        field: "includeFlatFee",
        message: computed.defaultStartDate
          ? `Die Pauschale setzt Verzug voraus. Verzug beginnt am ${formatGermanDate(computed.defaultStartDate)}.`
          : "Die Pauschale setzt Verzug voraus. Ein Verzugsbeginn steht noch nicht fest.",
      });
    } else {
      const s = lookupVerzugSurcharges(ctx.date);
      flatFee40Cents = s.ok ? s.value.value.flatFeeB2bCents : 4000;
    }
  }
  if (feeCents < 0 || interestCents < 0) {
    findings.push({ code: "amount_negative", severity: "E", message: "Beträge dürfen nicht negativ sein." });
  }
  if ((feeCents > 0 || interestCents > 0) && !computed.inDefault) {
    findings.push({
      code: "not_in_default",
      severity: "W",
      rule: "MAHN-01",
      message: "Der Schuldner ist noch nicht im Verzug – Mahngebühren und Zinsen können noch nicht verlangt werden.",
    });
  }
  if (ctx.isConsumer && feeCents > B2C_FEE_WARNING_CENTS) {
    findings.push({ code: "b2c_fee_high", severity: "W", rule: "MAHN-05", message: MSG.b2cFee, field: "feeCents" });
  }
  if (!ctx.isConsumer && feeCents > 0 && (ctx.flatFeeCharged || flatFee40Cents > 0)) {
    findings.push({
      code: "own_fee_with_flat_fee",
      severity: "W",
      rule: "MAHN-03",
      message: MSG.ownFeeWithFlat,
      field: "feeCents",
    });
  }
  if (interestCents > computed.interestCents && !(m.interestReason ?? "").trim()) {
    findings.push({
      code: "interest_above_computed",
      severity: "E",
      rule: "MAHN-02",
      field: "interestReason",
      message: `Die Zinsen übersteigen den berechneten Betrag (${formatEuro(computed.interestCents)}). Bitte Grund angeben.`,
    });
  }
  if (flatFee40Cents > 0 && isForeign(computed.currency)) {
    findings.push({ code: "flat_fee_eur", severity: "W", rule: "MAHN-03", message: FLAT_FEE_EUR_MESSAGE });
  }
  let newDueDate = computed.newDueDate;
  if (m.newDueDate) {
    if (m.newDueDate <= ctx.date) {
      findings.push({
        code: "deadline_not_after_date",
        severity: "E",
        field: "newDueDate",
        message: "Die neue Frist muss nach dem Datum der Mahnung liegen.",
      });
    } else newDueDate = m.newDueDate as CalendarDate;
  }
  const interestSegments = interestCents === computed.interestCents ? computed.interestSegments : [];
  return {
    claim: {
      ...computed,
      feeCents,
      interestCents,
      interestSegments,
      flatFee40Cents,
      newDueDate,
      totalCents: totalOf(computed, feeCents, interestCents, flatFee40Cents),
    },
    findings,
  };
}
