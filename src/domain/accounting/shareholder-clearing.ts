/**
 * Shareholder clearing account — „Verrechnungskonto Gesellschafter“ (F01 SET-045a, F08 ACC-028, README A31). Pure.
 *
 * Corporations (GmbH, UG, AG, GmbH & Co. KG) have no private accounts: private withdrawals/deposits post to the role
 * `shareholder.clearing`, which ships unmapped. The tax step asks for the shareholders and creates one custom
 * liability account per shareholder; the role is mapped to the first one. Sole proprietors and partnerships keep
 * `private.withdrawal` / `private.deposit` and never see this step.
 *
 * LEGAL-OPEN: F08 §6 roles table `shareholder.clearing` (UNSURE account numbers) — the proposed numbers (SKR03 from
 * 0755, SKR04 from 3510, „Verbindlichkeiten gegenüber Gesellschaftern“) are only a default; the owner confirms or
 * enters other numbers within the liability range of the chart (E-ACC-07). Choosing the shareholder per posting when
 * there are several is not decided (F08 open item 14): the role maps to the first shareholder's account.
 */
import type { LegalForm } from "../company/legal-forms";
import { err, type Issue, issue, ok, type Result } from "../result";
import { ACCOUNT_TYPE_LABEL, inAccountRange } from "../rules/accounting/ranges";
import type { Chart } from "../rules/accounting/types";
import { isCorporation } from "./roles";

export const SHAREHOLDER_ROLE = "shareholder.clearing";

/** First proposed number per chart (owner-confirmed, see LEGAL-OPEN above). */
export const SHAREHOLDER_ACCOUNT_START: Readonly<Record<Chart, number>> = { SKR03: 755, SKR04: 3510 };

/** DATEV account names are limited to 40 characters (custom-accounts.ts, DATEV-02). */
const MAX_NAME = 40;
const PREFIX = "Verrechnungskonto Gesellschafter ";
const SHORT_PREFIX = "Verr.-Kto. Ges. ";

export const SHAREHOLDER_MESSAGES = {
  notCorporation:
    "Ein Verrechnungskonto Gesellschafter gibt es nur bei Kapitalgesellschaften (GmbH, UG, AG, GmbH & Co. KG). Einzelunternehmen und Personengesellschaften buchen auf Privatentnahmen/-einlagen.",
  missing: "Bitte mindestens einen Gesellschafter angeben.",
  name: "Bitte den Namen jedes Gesellschafters angeben.",
  duplicate: (nr: string) => `Die Kontonummer ${nr} ist doppelt vergeben.`,
  range: (nr: string, chart: Chart) =>
    `Kontonummer ${nr} liegt nicht im zulässigen Bereich für ${ACCOUNT_TYPE_LABEL.liability} (${chart}).`,
  taken: (nr: string) => `Konto ${nr} ist bereits vorhanden.`,
} as const;

export type ShareholderIssue = Issue<
  "not_corporation" | "shareholders_missing" | "account_invalid" | "E-ACC-07" | "account_exists"
>;

/** SET-045a: the step is shown (and the role used) only for corporations. */
export const shareholderClearingApplies = (legalForm: LegalForm): boolean => isCorporation(legalForm);

/**
 * „Verrechnungskonto Gesellschafter {Name}“ within 40 characters: the full name, else the surname (last word), else
 * the abbreviated prefix with the name cut to fit.
 */
export function shareholderAccountName(shareholder: string): string {
  const name = shareholder.trim().replace(/\s+/g, " ");
  if ((PREFIX + name).length <= MAX_NAME) return PREFIX + name;
  const surname = name.split(" ").at(-1) ?? name;
  if ((PREFIX + surname).length <= MAX_NAME) return PREFIX + surname;
  return (SHORT_PREFIX + name).slice(0, MAX_NAME).trimEnd();
}

export interface ShareholderAccountPlan {
  readonly shareholder: string;
  readonly number: string;
  readonly name: string;
}

const pad4 = (n: number) => String(n).padStart(4, "0");

export function planShareholderAccounts(input: {
  legalForm: LegalForm;
  chart: Chart;
  shareholders: readonly { readonly name: string; readonly number?: string | undefined }[];
  /** Numbers already used (seeded chart, custom accounts, bank ledger accounts). */
  taken: ReadonlySet<string>;
}): Result<ShareholderAccountPlan[], ShareholderIssue> {
  if (!shareholderClearingApplies(input.legalForm))
    return err(issue("not_corporation", SHAREHOLDER_MESSAGES.notCorporation));
  if (input.shareholders.length === 0) return err(issue("shareholders_missing", SHAREHOLDER_MESSAGES.missing));
  const used = new Set(input.taken);
  const out: ShareholderAccountPlan[] = [];
  let next = SHAREHOLDER_ACCOUNT_START[input.chart];
  for (const s of input.shareholders) {
    const name = s.name.trim();
    if (!name) return err(issue("account_invalid", SHAREHOLDER_MESSAGES.name));
    let number = s.number?.trim();
    if (number) {
      if (!inAccountRange(input.chart, "liability", number))
        return err(issue("E-ACC-07", SHAREHOLDER_MESSAGES.range(number, input.chart), { number }));
      if (used.has(number)) return err(issue("account_exists", SHAREHOLDER_MESSAGES.taken(number), { number }));
    } else {
      while (next <= 9999 && (used.has(pad4(next)) || !inAccountRange(input.chart, "liability", pad4(next)))) next += 1;
      if (next > 9999) return err(issue("E-ACC-07", SHAREHOLDER_MESSAGES.range(pad4(next), input.chart)));
      number = pad4(next);
    }
    used.add(number);
    out.push({ shareholder: name, number, name: shareholderAccountName(name) });
  }
  return ok(out);
}
