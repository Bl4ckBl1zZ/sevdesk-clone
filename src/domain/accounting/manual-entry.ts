/**
 * Manual journal entries (F08 ACC-011, GOBD-07; E-ACC-01/02/10/11). Pure.
 *
 * Lines are entered with explicit accounts, debit/credit, an optional tax key, cost centre and contact. A line with a
 * tax key is entered **gross** (DATEV automatism): the engine splits it into the net amount on the account (keeping
 * the key, which fills the UStVA base) and the VAT on `vat.output.*` / `vat.input.*` on the same side, with the entry
 * date as tax point. Balance is checked on the entered (gross) amounts, so the split keeps it balanced.
 */
import { formatCents, roundHalfAway } from "../money";
import { err, type Issue, issue, ok, type Result } from "../result";
import type { AccountType } from "../rules/accounting";
import { lookupVatRate } from "../rules/vat-rates";
import { type CalendarDate, isCalendarDate } from "../time/calendar-date";
import { futureDateNotice } from "./period";
import type { RoleLine } from "./post";

export const MANUAL_TAX_KEYS = ["USt19", "USt7", "VSt19", "VSt7"] as const;
export type ManualTaxKey = (typeof MANUAL_TAX_KEYS)[number];

export interface ManualLineInput {
  account: string;
  debitCents: number;
  creditCents: number;
  taxKey?: string;
  costCenterId?: string;
  contactId?: string;
}

export interface ManualEntryInput {
  date: string;
  text: string;
  lines: readonly ManualLineInput[];
  /** Number of attached voucher files (E-ACC-02). */
  attachmentCount: number;
}

export interface ManualContext {
  /** Type of a postable account, null = unknown. */
  accountType: (account: string) => AccountType | "bank" | null;
  /** Accounts behind the automatic VAT roles (E-ACC-10). */
  vatAccounts: ReadonlySet<string>;
  /** Warning codes the user confirmed. */
  acknowledged?: readonly string[];
  /** Today (Europe/Berlin) for the E-ACC-21 future-date notice; omitted → no notice. */
  today?: string;
}

export type ManualIssueCode =
  | "E-ACC-01"
  | "E-ACC-02"
  | "E-ACC-10"
  | "E-ACC-11"
  | "E-ACC-21"
  | "manual_invalid"
  | "rule_missing";
export type ManualIssue = Issue<ManualIssueCode>;

export const MANUAL_MESSAGES = {
  unbalanced: (diffCents: number) =>
    `Soll und Haben sind nicht ausgeglichen (Differenz: ${formatCents(Math.abs(diffCents))} €).`,
  attachment: "Jede Buchung braucht einen Beleg. Bitte Beleg anhängen oder Eigenbeleg erstellen (GoBD).",
  vatDirect:
    "Direktbuchung auf ein Umsatzsteuerkonto ohne Bemessungsgrundlage – die UStVA-Kennzahl wird nicht befüllt. Trotzdem buchen?",
  taxKey: (key: string, nr: string) => `Steuerschlüssel ${key} ist für Konto ${nr} nicht zulässig.`,
} as const;

const OUTPUT_TYPES: readonly string[] = ["revenue", "neutral"];
const INPUT_TYPES: readonly string[] = ["expense", "asset", "neutral"];

function rateKeyOf(key: ManualTaxKey): {
  rateKey: "standard" | "reduced";
  suffix: "19" | "7";
  side: "output" | "input";
} {
  return {
    rateKey: key.endsWith("19") ? "standard" : "reduced",
    suffix: key.endsWith("19") ? "19" : "7",
    side: key.startsWith("USt") ? "output" : "input",
  };
}

export interface ManualPosting {
  lines: RoleLine[];
  /** ⚑ warnings that need confirmation (E-ACC-10); the posting is refused while unacknowledged. */
  warnings: ManualIssue[];
  /** Non-blocking notices (E-ACC-21: date more than 30 days ahead — allowed, the period is open). */
  notices: ManualIssue[];
}

export function buildManualLines(input: ManualEntryInput, ctx: ManualContext): Result<ManualPosting, ManualIssue> {
  if (!isCalendarDate(input.date)) return err(issue("manual_invalid", "Bitte ein gültiges Buchungsdatum angeben."));
  const text = input.text.trim();
  if (text.length === 0 || text.length > 60) {
    return err(issue("manual_invalid", "Bitte einen Buchungstext mit höchstens 60 Zeichen angeben."));
  }
  if (input.attachmentCount <= 0) return err(issue("E-ACC-02", MANUAL_MESSAGES.attachment));
  if (input.lines.length < 2) return err(issue("manual_invalid", "Eine Buchung braucht mindestens zwei Zeilen."));
  let debit = 0;
  let credit = 0;
  const warnings: ManualIssue[] = [];
  const out: RoleLine[] = [];
  for (const [i, l] of input.lines.entries()) {
    const n = i + 1;
    const oneSided =
      Number.isSafeInteger(l.debitCents) &&
      Number.isSafeInteger(l.creditCents) &&
      l.debitCents >= 0 &&
      l.creditCents >= 0 &&
      l.debitCents > 0 !== l.creditCents > 0;
    if (!oneSided) return err(issue("manual_invalid", `Zeile ${n}: bitte entweder Soll oder Haben (ganze Cent > 0).`));
    const type = ctx.accountType(l.account);
    if (type === null) return err(issue("manual_invalid", `Zeile ${n}: Konto ${l.account} ist nicht vorhanden.`));
    debit += l.debitCents;
    credit += l.creditCents;
    const extra = {
      ...(l.contactId ? { contactId: l.contactId } : {}),
      ...(l.costCenterId ? { costCenterId: l.costCenterId } : {}),
    };
    if (ctx.vatAccounts.has(l.account) && !(ctx.acknowledged ?? []).includes("E-ACC-10")) {
      if (!warnings.some((w) => w.code === "E-ACC-10")) warnings.push(issue("E-ACC-10", MANUAL_MESSAGES.vatDirect));
    }
    if (!l.taxKey) {
      out.push({ account: l.account, debitCents: l.debitCents, creditCents: l.creditCents, ...extra });
      continue;
    }
    if (!(MANUAL_TAX_KEYS as readonly string[]).includes(l.taxKey)) {
      return err(issue("E-ACC-11", MANUAL_MESSAGES.taxKey(l.taxKey, l.account)));
    }
    const key = rateKeyOf(l.taxKey as ManualTaxKey);
    const allowed = key.side === "output" ? OUTPUT_TYPES : INPUT_TYPES;
    if (!allowed.includes(type)) return err(issue("E-ACC-11", MANUAL_MESSAGES.taxKey(l.taxKey, l.account)));
    const rate = lookupVatRate(key.rateKey, input.date as CalendarDate);
    if (!rate.ok) return err(issue("rule_missing", rate.error.message));
    const rateBp = rate.value.value.rateBp;
    if (String(rateBp / 100) !== key.suffix) {
      return err(issue("E-ACC-11", `Steuerschlüssel ${l.taxKey} passt nicht zum Steuersatz am Buchungsdatum.`));
    }
    const gross = l.debitCents || l.creditCents;
    const net = Number(roundHalfAway(BigInt(gross) * 10_000n, BigInt(10_000 + rateBp)));
    const vat = gross - net;
    const side = (cents: number) =>
      l.debitCents > 0 ? { debitCents: cents, creditCents: 0 } : { debitCents: 0, creditCents: cents };
    out.push({ account: l.account, ...side(net), taxKey: l.taxKey, ...extra });
    if (vat > 0) out.push({ role: `vat.${key.side}.${key.suffix}`, ...side(vat), taxPointDate: input.date });
  }
  if (debit !== credit)
    return err(issue("E-ACC-01", MANUAL_MESSAGES.unbalanced(debit - credit), { diffCents: debit - credit }));
  const future = ctx.today ? futureDateNotice(input.date, ctx.today) : null;
  return ok({ lines: out, warnings, notices: future ? [future] : [] });
}

/**
 * ACC-011 templates (F08 §3.1): each line names a role (resolved with the role mapping), the default bank account
 * (`bank`), a suggested account per chart, or nothing (the user picks); amounts are entered by the user.
 */
export interface ManualTemplateLine {
  role?: string;
  bank?: true;
  accounts?: { SKR03: string; SKR04: string };
  side: "debit" | "credit";
  taxKey?: ManualTaxKey;
}

export interface ManualTemplate {
  key: string;
  label: string;
  text: string;
  lines: ManualTemplateLine[];
  hint?: string;
}

const LOAN = { SKR03: "0630", SKR04: "3150" } as const;
const INTEREST = { SKR03: "2100", SKR04: "7300" } as const;
const WAGES = { SKR03: "4110", SKR04: "6010" } as const;

export const MANUAL_TEMPLATES: readonly ManualTemplate[] = [
  {
    key: "loan_payout",
    label: "Darlehen Auszahlung",
    text: "Darlehensauszahlung",
    lines: [
      { bank: true, side: "debit" },
      { accounts: LOAN, side: "credit" },
    ],
  },
  {
    key: "loan_repayment",
    label: "Darlehen Tilgung",
    text: "Darlehenstilgung",
    lines: [
      { accounts: LOAN, side: "debit" },
      { bank: true, side: "credit" },
    ],
  },
  {
    key: "loan_interest",
    label: "Darlehen Zinsen",
    text: "Darlehenszinsen",
    lines: [
      { accounts: INTEREST, side: "debit" },
      { bank: true, side: "credit" },
    ],
  },
  {
    key: "transfer",
    label: "Umbuchung",
    text: "Umbuchung",
    lines: [{ side: "debit" }, { side: "credit" }],
  },
  {
    key: "payroll_net",
    label: "Lohn (Nettomethode)",
    text: "Lohn",
    lines: [
      { accounts: WAGES, side: "debit" },
      { bank: true, side: "credit" },
    ],
    hint: "Nettolohn an Bank; Lohnsteuer und Sozialabgaben als eigene Zeilen gegen die Verbindlichkeiten buchen.",
  },
  {
    key: "private_withdrawal_goods",
    label: "Privatentnahme Sachwert",
    text: "Sachentnahme",
    lines: [
      { role: "private.withdrawal", side: "debit" },
      { role: "revenue.withdrawal.19", side: "credit", taxKey: "USt19" },
    ],
  },
  {
    key: "car_private_use",
    label: "Kfz-Privatnutzung (1 %-Regelung, Eigenbeleg)",
    text: "Kfz-Privatnutzung 1 %",
    lines: [
      { role: "private.withdrawal", side: "debit" },
      { role: "revenue.withdrawal.19", side: "credit", taxKey: "USt19" },
    ],
    hint: "1 % des Bruttolistenpreises je Monat; der Anteil ohne Vorsteuerabzug (pauschal 20 %) ist als eigene Zeile ohne Steuerschlüssel zu buchen. Eigenbeleg anhängen.",
  },
];
