/**
 * Posting rows for purchase vouchers (F08 §4.2.3 V1–V14, §4.2.4 T6/T7, §4.2.6 X1–X7; F06 VOU-020…027, VOU-061,
 * VOU-132, VOU-137/138, TAX-018). Called by `postEvent` in post.ts; speaks only in roles and the line accounts the
 * owner chose — `resolve.ts` maps roles to SKR accounts.
 *
 *  - V1 input VAT deductible: S expense N · S `vat.input.r` V · H `payable` G (tax point max(supply end, receipt)).
 *  - V4 no input VAT (KU company, `no_input_vat`, KU supplier, Eigenbeleg): S expense G · H `payable` G.
 *  - V5 Bewirtung: 70 % `expense.entertainment` / 30 % `expense.entertainment.nd` of the net (KU: of the gross) per
 *    line incl. the tip; VAT 100 % deductible; `arbeitnehmer` → `expense.staff_events` 100 %.
 *  - V6/V7/V8 §13b and V9 igE: S expense N · S `vat.input.13b|ige.r` V · H `vat.output.13b|ige.r` V · H `payable` N;
 *    KU: the self-assessed VAT is owed but not deductible → S `expense.vat_nondeductible` (golden V2).
 *  - V10 import VAT: lines on the `vat.import` account → S `vat.import`; other lines (duty) S expense.
 *  - V13 asset: GWG → `asset.gwg`, Sammelposten → `asset.pool`, Anlage → the chosen fixed-asset account.
 *  - private share (VOU-027, non-Bewirtung): expense and VAT reduced by the share, the share → `private.withdrawal`
 *    (`shareholder.clearing` for corporations, ACC-028).
 *  - X1–X7 tax payments: S tax role · H `payable` (refunds mirrored).
 *  - income vouchers (VOU-010): S `receivable` G · H revenue N · H `vat.output.r` V (Ist: `vat.output.notdue.r`).
 *  - V2/T6/T7 payment: S `payable` · H bank / `cash` / `private.deposit` (`shareholder.clearing`); V3 Skonto received
 *    H `skonto.received.r` N · H `vat.input.r` V; fees S `expense.bank_fees`.
 */
import { err, issue, ok, type Result } from "../result";
import type { RateAmount, VoucherBookedEvent, VoucherPaidEvent, VoucherPostingLine } from "./events";
import { endOfMonth, icSupplyTaxPoint, periodOf, supplyEnd } from "./period";
import type { PostingIssue, RoleLine } from "./post";
import { shareOfSettlement } from "./pro-rata";
import { bankRole, rateSuffix } from "./roles";

type Target = { role: string } | { account: string };
type Extra = Pick<
  RoleLine,
  "contactId" | "taxKey" | "taxPointDate" | "currency" | "amountFx" | "fxRate" | "costCenterId"
>;

function debit(target: Target, cents: number, extra: Extra = {}): RoleLine[] {
  if (cents === 0) return [];
  const sides = cents > 0 ? { debitCents: cents, creditCents: 0 } : { debitCents: 0, creditCents: -cents };
  const clean: Extra = {};
  if (extra.contactId !== undefined) clean.contactId = extra.contactId;
  if (extra.taxKey !== undefined) clean.taxKey = extra.taxKey;
  if (extra.taxPointDate !== undefined) clean.taxPointDate = extra.taxPointDate;
  if (extra.currency !== undefined) clean.currency = extra.currency;
  if (extra.amountFx !== undefined) clean.amountFx = extra.amountFx;
  if (extra.fxRate !== undefined) clean.fxRate = extra.fxRate;
  if (extra.costCenterId !== undefined) clean.costCenterId = extra.costCenterId;
  return [{ ...target, ...sides, ...clean }];
}

/** ACC-023: FX fields of the open item of a foreign-currency voucher (none for EUR). */
const fxOf = (e: VoucherBookedEvent): Extra =>
  e.fx ? { currency: e.fx.currency, amountFx: e.fx.grossFxCents, fxRate: e.fx.fxRate } : {};
const credit = (target: Target, cents: number, extra: Extra = {}) => debit(target, -cents, extra);
const R = (role: string): Target => ({ role });
/** ACC-019: the line's cost centre on its expense/revenue line only (not VAT, private share or open item). */
const kstOf = (l: VoucherPostingLine): Extra => (l.costCenterId ? { costCenterId: l.costCenterId } : {});

const invalid = (message: string): PostingIssue => issue("invalid_event", message);
const rateUnsupported = (rateBp: number): PostingIssue =>
  // LEGAL-OPEN: F08-Q1 — historical rates (16 %/5 %) and 7 % under §13b have no shipped role; block rather than guess.
  issue(
    "rate_not_supported",
    `Für den Steuersatz ${(rateBp / 100).toLocaleString("de-DE")} % gibt es keine Kontenrolle. Bitte die Buchung manuell erfassen lassen.`,
    { rateBp },
  );

const isInt = (n: number) => Number.isSafeInteger(n);

const SELF_ASSESSMENT: Record<
  string,
  { family: "13b" | "ige"; key: string; row: string; tp: "month_end" | "invoice" }
> = {
  reverse_charge_eu: { family: "13b", key: "13b-EU", row: "V6", tp: "month_end" },
  reverse_charge_non_eu: { family: "13b", key: "13b-Ausl", row: "V7", tp: "invoice" },
  reverse_charge_13b_de: { family: "13b", key: "13b-Inl", row: "V8", tp: "invoice" },
  intra_community_acquisition: { family: "ige", key: "igE", row: "V9", tp: "invoice" },
};

const TAX_PAYMENT: Record<string, { role: string; row: string }> = {
  ust_prepayment: { role: "vat.prepayment", row: "X1" },
  sondervorauszahlung: { role: "vat.special_prepayment", row: "X3" },
  ust_annual: { role: "vat.prior_year", row: "X4" },
  gewerbesteuer: { role: "expense.trade_tax", row: "X5" },
  est_private: { role: "private.taxes", row: "X6" },
  kst: { role: "expense.corp_tax", row: "X7" },
};

/** VOU-027 split of a share: [business, share], the share rounded half-up (away from zero). */
function share(amount: number, bp: number): [number, number] {
  if (!bp) return [amount, 0];
  const part = Number(roundShare(amount, bp));
  return [amount - part, part];
}

/**
 * F08 AST-002: what an expense line debits to its base account (net if input VAT is deducted or self-assessed,
 * else gross; minus a private share) — the acquisition cost of the asset created from the line (E-AST-12).
 */
export function voucherLineBaseCents(
  l: Pick<VoucherPostingLine, "netCents" | "vatCents" | "nonDeductibleShareBp">,
  taxRule: string,
  companyIsKu: boolean,
): number {
  const deductible = !companyIsKu && taxRule === "input_vat_deductible";
  const base = deductible || SELF_ASSESSMENT[taxRule] ? l.netCents : l.netCents + l.vatCents;
  return share(base, l.nonDeductibleShareBp ?? 0)[0];
}

/** Input VAT on the line was deducted (§ 3 Abs. 1b S. 2 UStG: a later withdrawal is taxable). */
export const voucherInputVatDeducted = (taxRule: string, companyIsKu: boolean): boolean =>
  !companyIsKu && (taxRule === "input_vat_deductible" || SELF_ASSESSMENT[taxRule] !== undefined);

export interface VoucherPostingResult {
  lines: RoleLine[];
  explanation: string;
  text: string;
}

const truncate = (s: string) => (s.length <= 60 ? s : `${s.slice(0, 59)}…`);
const textWith = (head: string, name?: string) => truncate(name ? `${head} ${name}` : head);

/** Base target of a line (asset decisions, explicit role). */
function baseTarget(l: VoucherPostingLine): Target {
  if (l.role) return R(l.role);
  if (l.assetDecision === "gwg") return R("asset.gwg");
  if (l.assetDecision === "pool") return R("asset.pool");
  return { account: l.account };
}

export function postVoucherBooked(
  e: VoucherBookedEvent,
  ctx: { corporation: boolean; taxationMethod: "soll" | "ist" },
): Result<VoucherPostingResult, PostingIssue> {
  if (e.lines.length === 0) return err(invalid("Der Beleg hat keine Positionen."));
  for (const l of e.lines) {
    if (![l.netCents, l.vatCents, l.vatRateBp, l.selfAssessedVatCents ?? 0].every(isInt)) {
      return err(invalid("Beträge müssen ganze Cent sein."));
    }
  }
  const contact = e.contactId ? { contactId: e.contactId } : {};
  const head = `Beleg ${e.number}`;
  const privateRole = ctx.corporation ? "shareholder.clearing" : "private.withdrawal";
  const lines: RoleLine[] = [];
  let payable = 0;

  // ── tax payments (X1–X7) ────────────────────────────────────────────────────────────────────────────
  if (e.voucherKind === "tax_payment") {
    const tp = TAX_PAYMENT[e.taxPaymentSubtype ?? ""];
    if (!tp) return err(invalid("Bitte die Art der Steuerzahlung angeben."));
    if (tp.role === "private.taxes" && ctx.corporation) {
      return err(issue("private_withdrawal_corporation", "Kapitalgesellschaften zahlen keine Einkommensteuer."));
    }
    const gross = e.lines.reduce((s, l) => s + l.netCents + l.vatCents, 0);
    if (e.direction === "income") {
      lines.push(...debit(R("receivable"), gross, contact), ...credit(R(tp.role), gross));
    } else lines.push(...debit(R(tp.role), gross), ...credit(R("payable"), gross, contact));
    return ok({
      lines,
      explanation: e.direction === "income" && tp.row === "X1" ? "X2" : tp.row,
      text: textWith(head, e.counterpartyName),
    });
  }

  // ── private vouchers (F06 VOU-066): a private expense paid from business money is a Privatentnahme ──
  // S `private.withdrawal` (gross, no input VAT — the business is not the recipient) · H `payable`; the bank debit
  // or cash payment then settles the payable like any voucher. Corporations have no Privatentnahmen (EC-VOU-17).
  if (e.voucherKind === "private") {
    if (e.direction !== "expense") return err(invalid("Private Belege sind nur als Ausgabe möglich."));
    if (ctx.corporation) {
      return err(
        issue(
          "private_withdrawal_corporation",
          "Kapitalgesellschaften haben kein Privatkonto. Bitte Verrechnungskonto Gesellschafter verwenden.",
        ),
      );
    }
    const gross = e.lines.reduce((s, l) => s + l.netCents + l.vatCents, 0);
    lines.push(...debit(R("private.withdrawal"), gross), ...credit(R("payable"), gross, { ...contact, ...fxOf(e) }));
    return ok({ lines, explanation: "V-private", text: textWith(head, e.counterpartyName) });
  }

  // ── income vouchers (VOU-010) ───────────────────────────────────────────────────────────────────────
  if (e.direction === "income") {
    let gross = 0;
    for (const l of e.lines) {
      const suffix = rateSuffix(l.vatRateBp);
      if (e.taxRule === "output_vat") {
        if (l.vatRateBp !== 0 && !suffix) return err(rateUnsupported(l.vatRateBp));
        const tp = supplyEnd(e.supplyDate);
        lines.push(
          ...credit(baseTarget(l), l.netCents, { ...(suffix ? { taxKey: `USt${suffix}` } : {}), ...kstOf(l) }),
        );
        if (suffix && l.vatCents !== 0) {
          if (ctx.taxationMethod === "ist") lines.push(...credit(R(`vat.output.notdue.${suffix}`), l.vatCents));
          else lines.push(...credit(R(`vat.output.${suffix}`), l.vatCents, { taxPointDate: tp }));
        }
      } else {
        if (l.vatCents !== 0)
          return err(invalid("Steuerfreie oder nicht steuerbare Einnahmen haben keine Umsatzsteuer."));
        lines.push(...credit(baseTarget(l), l.netCents, kstOf(l)));
      }
      gross += l.netCents + l.vatCents;
    }
    lines.push(...debit(R("receivable"), gross, { ...contact, ...fxOf(e) }));
    return ok({ lines, explanation: "VE", text: textWith(head, e.counterpartyName) });
  }

  // ── expense vouchers ────────────────────────────────────────────────────────────────────────────────
  const rule = e.taxRule;
  const ku = e.companyIsKu;
  const sa = SELF_ASSESSMENT[rule];
  const deductible = !ku && rule === "input_vat_deductible";
  const inputTp = [supplyEnd(e.supplyDate), e.receivedDate].sort().at(-1) as string;
  const bewirtung = e.voucherKind === "bewirtung";
  const occasion = e.bewirtungOccasion ?? "geschaeftlich";

  for (const l of e.lines) {
    const gross = l.netCents + l.vatCents;
    payable += gross;
    const suffix = rateSuffix(l.vatRateBp);

    if (l.role === "vat.import") {
      if (ku) return err(invalid("Als Kleinunternehmer ist die Einfuhrumsatzsteuer nicht abziehbar."));
      lines.push(...debit(R("vat.import"), gross, { taxKey: "EUSt", taxPointDate: e.date }));
      continue;
    }

    // Base amount: net when VAT is deducted (or self-assessed), gross otherwise.
    const base = deductible || sa ? l.netCents : gross;
    const vatDeducted = deductible ? l.vatCents : 0;
    if (deductible && l.vatCents !== 0 && !suffix) return err(rateUnsupported(l.vatRateBp));

    if (bewirtung) {
      if (occasion === "arbeitnehmer") {
        lines.push(
          ...debit(R("expense.staff_events"), base, {
            ...(deductible && suffix ? { taxKey: `VSt${suffix}` } : {}),
            ...kstOf(l),
          }),
        );
      } else {
        const nd = Number(roundShare(base, l.nonDeductibleShareBp ?? 3000));
        const taxKey = { ...(deductible && suffix ? { taxKey: `VSt${suffix}` } : {}), ...kstOf(l) };
        lines.push(...debit(R("expense.entertainment"), base - nd, taxKey));
        lines.push(...debit(R("expense.entertainment.nd"), nd, taxKey));
      }
      if (vatDeducted !== 0) {
        lines.push(...debit(R(`vat.input.${suffix}`), vatDeducted, { taxPointDate: inputTp }));
      }
      continue;
    }

    const [bizBase, privBase] = share(base, l.nonDeductibleShareBp ?? 0);
    const [bizVat, privVat] = share(vatDeducted, l.nonDeductibleShareBp ?? 0);
    if (sa) {
      const vat = l.selfAssessedVatCents ?? 0;
      const sfx = rateSuffix(l.vatRateBp);
      if (!sfx || (sa.family === "13b" && sfx !== "19")) return err(rateUnsupported(l.vatRateBp));
      const tp =
        sa.tp === "month_end" ? endOfMonth(periodOf(supplyEnd(e.supplyDate))) : icSupplyTaxPoint(e.date, e.supplyDate);
      lines.push(...debit(baseTarget(l), bizBase, { taxKey: `${sa.key}${sfx}`, ...kstOf(l) }));
      if (privBase !== 0) lines.push(...debit(R(privateRole), privBase));
      lines.push(...credit(R(`vat.output.${sa.family}.${sfx}`), vat, { taxPointDate: tp }));
      if (ku) lines.push(...debit(R("expense.vat_nondeductible"), vat));
      else lines.push(...debit(R(`vat.input.${sa.family}.${sfx}`), vat, { taxPointDate: tp }));
      continue;
    }
    lines.push(
      ...debit(baseTarget(l), bizBase, {
        ...(deductible && suffix && l.vatRateBp !== 0 ? { taxKey: `VSt${suffix}` } : {}),
        ...kstOf(l),
      }),
    );
    if (bizVat !== 0) lines.push(...debit(R(`vat.input.${suffix}`), bizVat, { taxPointDate: inputTp }));
    if (privBase + privVat !== 0) lines.push(...debit(R(privateRole), privBase + privVat));
  }
  lines.push(...credit(R("payable"), payable, { ...contact, ...fxOf(e) }));

  const explanation = bewirtung
    ? "V5"
    : sa
      ? `${sa.row}${ku ? "-ku" : ""}`
      : rule === "import_vat"
        ? "V10"
        : deductible
          ? e.lines.every((l) => l.assetDecision === "gwg" || l.assetDecision === "pool" || l.assetDecision === "asset")
            ? "V13"
            : "V1"
          : "V4";
  return ok({ lines, explanation, text: textWith(head, e.counterpartyName) });
}

function roundShare(amount: number, bp: number): bigint {
  const big = BigInt(amount) * BigInt(bp);
  const q = big / 10_000n;
  const r = big % 10_000n;
  return (r < 0n ? -r : r) * 2n >= 10_000n ? q + (big < 0n ? -1n : 1n) : q;
}

function meansTarget(e: VoucherPaidEvent): Target {
  if (e.means.kind === "bank_account") return R(bankRole(e.means.bankAccountId));
  if (e.means.kind === "cash") return R("cash");
  return R(e.corporation ? "shareholder.clearing" : "private.deposit");
}

/** V2/V3/T6/T7 (and the income mirror). */
export function postVoucherPaid(e: VoucherPaidEvent): Result<VoucherPostingResult, PostingIssue> {
  if (!isInt(e.amountCents) || e.amountCents === 0) return err(invalid("Der Zahlbetrag muss ungleich 0 sein."));
  if (e.direction === "income" && e.means.kind === "private") {
    return err(invalid("Einnahmen können nicht privat bezahlt werden."));
  }
  const contact = e.contactId ? { contactId: e.contactId } : {};
  const means = meansTarget(e);
  const lines: RoleLine[] = [];
  let settled = e.amountCents;
  const diffs = e.differences ?? [];
  const income = e.direction === "income";
  for (const d of diffs) {
    if (!isInt(d.amountCents) || d.amountCents === 0)
      return err(invalid("Differenzbeträge müssen ganze Cent ≠ 0 sein."));
    settled += d.amountCents;
    if (d.reason === "bank_fees") {
      // Expense: we paid more than the voucher (amount < 0); income: the bank kept a fee (amount > 0).
      lines.push(...debit(R("expense.bank_fees"), income ? d.amountCents : -d.amountCents));
    } else if (d.reason === "fx_difference") {
      // EC-BNK-76 (PAY-018 mirrored): realised exchange difference, no VAT. The side decides loss or gain.
      const lossSide = income ? d.amountCents > 0 : d.amountCents < 0;
      const role = R(lossSide ? "expense.fx_loss" : "income.fx_gain");
      lines.push(...(income ? debit(role, d.amountCents) : credit(role, d.amountCents)));
    } else if (d.reason === "other") {
      if (!d.account) return err(invalid("Für „Sonstige Differenz“ ist ein Konto anzugeben."));
      lines.push(
        ...(income ? debit({ account: d.account }, d.amountCents) : credit({ account: d.account }, d.amountCents)),
      );
    } else {
      if (income) return err(invalid("Skonto auf Einnahmebelege wird nicht unterstützt."));
      const corr: readonly RateAmount[] = d.vatCorrection ?? [{ rateBp: 0, netCents: d.amountCents, vatCents: 0 }];
      if (corr.reduce((s, c) => s + c.netCents + c.vatCents, 0) !== d.amountCents) {
        return err(invalid("Die Umsatzsteuerkorrektur ergibt nicht den Differenzbetrag."));
      }
      for (const c of corr) {
        const suffix = rateSuffix(c.rateBp) ?? "19";
        if (c.rateBp !== 0 && !rateSuffix(c.rateBp)) return err(rateUnsupported(c.rateBp));
        if (e.inputVatDeducted && c.vatCents !== 0) {
          lines.push(...credit(R(`skonto.received.${suffix}`), c.netCents, { taxKey: `VSt${suffix}` }));
          lines.push(...credit(R(`vat.input.${suffix}`), c.vatCents, { taxPointDate: e.date }));
        } else {
          // LEGAL-OPEN: F08-Q1 — without input-VAT deduction the Skonto reduces the gross expense; booked on the
          // Skonto account of the rate (no VAT line).
          lines.push(...credit(R(`skonto.received.${suffix}`), c.netCents + c.vatCents));
        }
      }
    }
  }
  if (income) {
    lines.unshift(...debit(means, e.amountCents));
    lines.push(...credit(R("receivable"), settled, contact));
    if (e.ist) {
      const basis = e.ist.notDueVat.filter((v) => v.vatCents !== 0);
      for (const v of basis) if (!rateSuffix(v.rateBp)) return err(rateUnsupported(v.rateBp));
      const shares = shareOfSettlement(
        basis.map((v) => v.vatCents),
        e.ist.payableCents,
        e.ist.settledBeforeCents,
        settled,
      );
      basis.forEach((v, i) => {
        const suffix = rateSuffix(v.rateBp) as "19" | "7";
        lines.push(...debit(R(`vat.output.notdue.${suffix}`), shares[i] ?? 0));
        lines.push(...credit(R(`vat.output.${suffix}`), shares[i] ?? 0, { taxPointDate: e.date }));
      });
    }
  } else {
    lines.unshift(...debit(R("payable"), settled, contact));
    lines.push(...credit(means, e.amountCents));
  }
  const row =
    e.means.kind === "cash"
      ? "T6"
      : e.means.kind === "private"
        ? e.corporation
          ? "T7-corp"
          : "T7"
        : income
          ? "VE-pay"
          : "V2";
  const head = `${income ? "Eingang" : "Zahlung"} ${e.voucher.number ?? ""}`.trim();
  return ok({
    lines,
    explanation: diffs.some((d) => d.reason === "skonto") ? `${row}+V3` : row,
    text: textWith(head, e.counterpartyName),
  });
}
