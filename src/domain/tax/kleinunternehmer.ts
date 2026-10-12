/**
 * Entering the Kleinunternehmerregelung (KU-01, F01 SET-033, §5.3): a KU entry may start only on 1 January or on
 * the founding date, and only if the prior-year total turnover does not exceed the limit valid on the start date
 * (rule table `kleinunternehmer_limits`). Waiver locks and retroactive entries (SET-033/034, KU-04) are checked
 * with the document history (P1).
 */
import { formatEuro } from "../money";
import { type Issue, issue } from "../result";
import { lookupRule } from "../rules/rule-table";
import { KLEINUNTERNEHMER_LIMITS } from "../rules/thresholds";
import { type CalendarDate, isCalendarDate } from "../time/calendar-date";

export type KuStartIssueCode = "ku_start_invalid" | "ku_prior_year_exceeded" | "ku_prior_year_missing" | "rule_missing";

export interface KuStartInput {
  validFrom: string;
  foundedOn?: string;
  /** Prior calendar year (validFrom.year − 1) total turnover; undefined = not entered. */
  priorYearTurnoverCents?: number;
}

export interface KuStartCheck {
  errors: Issue<KuStartIssueCode>[];
  warnings: Issue<KuStartIssueCode>[];
}

export function checkKuStart(input: KuStartInput): KuStartCheck {
  const errors: Issue<KuStartIssueCode>[] = [];
  const warnings: Issue<KuStartIssueCode>[] = [];
  if (!isCalendarDate(input.validFrom)) {
    errors.push(issue("ku_start_invalid", "Bitte das Datum angeben."));
    return { errors, warnings };
  }
  const isFoundingDate = input.foundedOn !== undefined && input.foundedOn === input.validFrom;
  if (!input.validFrom.endsWith("-01-01") && !isFoundingDate) {
    errors.push(
      issue("ku_start_invalid", "Die Kleinunternehmerregelung kann nur ab 1. Januar oder ab Gründung beginnen."),
    );
  }
  const foundingYear = input.foundedOn?.slice(0, 4) === input.validFrom.slice(0, 4);
  if (input.priorYearTurnoverCents === undefined) {
    if (!foundingYear) {
      warnings.push(
        issue(
          "ku_prior_year_missing",
          "Vorjahresumsatz fehlt — bitte unter Steuern › Umsätze eintragen, damit die Grenze geprüft werden kann.",
        ),
      );
    }
    return { errors, warnings };
  }
  const limits = lookupRule(KLEINUNTERNEHMER_LIMITS, input.validFrom as CalendarDate);
  if (!limits.ok) {
    errors.push(limits.error);
    return { errors, warnings };
  }
  if (input.priorYearTurnoverCents > limits.value.value.priorYearLimitCents) {
    errors.push(
      issue(
        "ku_prior_year_exceeded",
        `Kleinunternehmerregelung nicht möglich: Der Vorjahresumsatz von ${formatEuro(input.priorYearTurnoverCents)} liegt über ${formatEuro(limits.value.value.priorYearLimitCents)}.`,
        { amountCents: input.priorYearTurnoverCents },
      ),
    );
  }
  return { errors, warnings };
}
