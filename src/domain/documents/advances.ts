/**
 * Advance, partial and final invoices (F04 §4.7, INV-03…INV-09, UST-40/UST-41, App. E.4/E.5, RI-08). Pure.
 *
 * - `advanceGroups`: amount of an Abschlags-/Teilrechnung per VAT group of the order (percent / net / gross).
 * - `partialExceedsOrder`: Σ advances + partials ≤ the order per VAT group (EC-078).
 * - `deductionOf` / `finalDeductions`: what a final invoice deducts — the **received** amounts per (category, rate) of
 *   each non-cancelled advance: invoiced − Rechnungskorrekturen (EC-071) − accepted payment differences (Skonto,
 *   price reductions with VAT correction, App. E.4 case D).
 * - `finalChainFindings`: the §5.1.6 preconditions of a final invoice; an advance with an open amount blocks it
 *   (`advance_not_settled`, 10 EC-070/071 — there is no "nicht abziehen" option any more).
 * - `remainderCorrectionGroups`: the Rechnungskorrektur that reduces a partially paid advance to the received amount
 *   (`allocate(open, gross_g)`, net per App. E.3).
 *
 * An amount-based Teilrechnung is always an Anzahlung (F04 9.3, README A12): Mindest-Ist, deducted in the final.
 */
import { allocate } from "../money/allocate";
import { roundHalfAway } from "../money/rounding";
import { largestNetThatFits, vatCents } from "../money/vat";
import { VAT_CATEGORY_ORDER, type VatCategory } from "../tax/vat-category";
import { formatAmount } from "./i18n";
import type { SnapshotDeduction, TaxCase } from "./snapshot";
import { type Finding, finding } from "./validate/finding";

/** Net and VAT of one VAT group (signed as on the document). */
export interface GroupAmount {
  readonly category: VatCategory;
  readonly rateBp: number;
  readonly netCents: number;
  readonly vatCents: number;
}

const key = (x: Pick<GroupAmount, "category" | "rateBp">) => `${x.category}/${x.rateBp}`;
const gross = (x: GroupAmount) => x.netCents + x.vatCents;

/** Σ per (category, rate), canonical group order (S 19 before S 7 …), groups that sum to zero are dropped. */
export function sumGroups(...lists: readonly (readonly GroupAmount[])[]): GroupAmount[] {
  const m = new Map<string, GroupAmount>();
  for (const list of lists) {
    for (const x of list) {
      const prev = m.get(key(x));
      m.set(key(x), {
        category: x.category,
        rateBp: x.rateBp,
        netCents: (prev?.netCents ?? 0) + x.netCents,
        vatCents: (prev?.vatCents ?? 0) + x.vatCents,
      });
    }
  }
  return [...m.values()]
    .filter((x) => x.netCents !== 0 || x.vatCents !== 0)
    .sort(
      (a, b) => VAT_CATEGORY_ORDER.indexOf(a.category) - VAT_CATEGORY_ORDER.indexOf(b.category) || b.rateBp - a.rateBp,
    );
}

export const negateGroups = (list: readonly GroupAmount[]): GroupAmount[] =>
  list.map((x) => ({ ...x, netCents: -x.netCents, vatCents: -x.vatCents }));

// ── App. E.5 ────────────────────────────────────────────────────────────────────────────────────────────────────

export type AdvanceMode =
  | { readonly kind: "percent"; readonly bp: number }
  | { readonly kind: "net"; readonly cents: number }
  | { readonly kind: "gross"; readonly cents: number };

/** INV-03/INV-04: one amount per VAT group of the order. */
export function advanceGroups(order: readonly GroupAmount[], mode: AdvanceMode): GroupAmount[] {
  const withVat = (category: VatCategory, rateBp: number, net: number): GroupAmount => ({
    category,
    rateBp,
    netCents: net,
    vatCents: vatCents(net, rateBp),
  });
  if (mode.kind === "percent") {
    return order.map((o) =>
      withVat(o.category, o.rateBp, Number(roundHalfAway(BigInt(o.netCents) * BigInt(mode.bp), 10_000n))),
    );
  }
  if (mode.kind === "net") {
    const nets = allocate(
      mode.cents,
      order.map((o) => o.netCents),
    );
    return order.map((o, i) => withVat(o.category, o.rateBp, nets[i] ?? 0));
  }
  const grosses = allocate(
    mode.cents,
    order.map((o) => gross(o)),
  );
  return order.map((o, i) => {
    const n = largestNetThatFits(BigInt(grosses[i] ?? 0), o.rateBp);
    return { category: o.category, rateBp: o.rateBp, netCents: Number(n.net), vatCents: Number(n.vat) };
  });
}

/** UST-40 EC-078: Σ (earlier advances/partials + this one) ≤ the order net per VAT group. */
export function partialExceedsOrder(
  order: readonly GroupAmount[],
  earlier: readonly (readonly GroupAmount[])[],
  next: readonly GroupAmount[],
): Finding[] {
  const sum = sumGroups(...earlier, next);
  const out: Finding[] = [];
  for (const s of sum) {
    const o = order.find((x) => key(x) === key(s));
    const limit = o?.netCents ?? 0;
    if (s.netCents > limit) {
      const group = s.category === "S" ? `${s.rateBp / 100} %` : s.category;
      out.push(
        finding(
          "partial_exceeds_order",
          "E",
          "UST-40",
          "pflichtangaben",
          `Die Abschlags-/Teilrechnungen übersteigen den Auftragswert (${group}: ${formatAmount(s.netCents, "EUR", "de")} von ${formatAmount(limit, "EUR", "de")}).`,
          { field: "lines", params: { group, sum: s.netCents, order: limit } },
        ),
      );
    }
  }
  return out;
}

// ── App. E.4 ────────────────────────────────────────────────────────────────────────────────────────────────────

/** An advance/partial invoice of the chain as the final invoice sees it (read by the model layer). */
export interface ChainAdvance {
  readonly id: string;
  readonly type: "advance_invoice" | "partial_invoice";
  readonly number: string;
  readonly date: string;
  /** Stored lifecycle status (`cancelled` = Storno; never deducted). */
  readonly status: string;
  readonly currency: string;
  readonly taxCase: TaxCase;
  /** `salesDocuments.openAmountCents` (payments slice is the source of truth). */
  readonly openCents: number;
  /** VAT groups as invoiced. */
  readonly groups: readonly GroupAmount[];
  /** Σ of the finalised, non-cancelled Rechnungskorrekturen of this advance (negative amounts). */
  readonly corrections: readonly GroupAmount[];
  /** Accepted payment differences with VAT correction (Skonto, price reductions; positive = reduces the base). */
  readonly differences: readonly GroupAmount[];
  /** Date of the (last) payment (BT-22 deduction line). */
  readonly paidOn?: string | undefined;
  /** The non-cancelled final invoice (other than the one being built) that already deducted it. */
  readonly deductedIn?: { readonly id: string; readonly number: string } | undefined;
}

export interface FinalChain {
  readonly advances: readonly ChainAdvance[];
  /** A non-cancelled final invoice of the chain other than the one being built (`final_exists`). */
  readonly otherFinal?: { readonly number: string } | undefined;
}

const active = (a: ChainAdvance) => a.status !== "cancelled" && a.status !== "draft";

/** Received amounts of one advance per (category, rate): invoiced + corrections − differences (RI-08). */
export function deductionOf(a: ChainAdvance): SnapshotDeduction {
  const byGroup = sumGroups(a.groups, a.corrections, negateGroups(a.differences)).map((x) => ({
    category: x.category,
    rateBp: x.rateBp,
    netCents: x.netCents,
    vatCents: x.vatCents,
    grossCents: gross(x),
  }));
  return {
    advanceNumber: a.number,
    advanceDate: a.date,
    ...(a.paidOn ? { paidOn: a.paidOn } : {}),
    byGroup,
    deductedGrossCents: byGroup.reduce((s, x) => s + x.grossCents, 0),
    partiallyPaid: a.corrections.some((c) => c.netCents !== 0 || c.vatCents !== 0),
  };
}

/** INV-06: one deduction per non-cancelled advance that is not deducted in another final, in chain order. */
export function finalDeductions(chain: FinalChain): SnapshotDeduction[] {
  return chain.advances
    .filter((a) => active(a) && !a.deductedIn)
    .map(deductionOf)
    .filter((d) => d.byGroup.length > 0);
}

/** Per-group tax effect of a final invoice = final group − Σ deductions of that group (INV-08, UStVA/journal). */
export function finalTaxEffect(
  finalGroups: readonly GroupAmount[],
  deductions: readonly SnapshotDeduction[],
): GroupAmount[] {
  return sumGroups(finalGroups, negateGroups(deductions.flatMap((d) => d.byGroup)));
}

/**
 * EC-071 / App. E.4 case E: the Rechnungskorrektur of a partially paid advance, per group
 * `correctionGross_g = allocate(open, gross_g)` with the net that fits (App. E.3). Negative amounts.
 */
export function remainderCorrectionGroups(groups: readonly GroupAmount[], openCents: number): GroupAmount[] {
  const shares = allocate(
    openCents,
    groups.map((x) => gross(x)),
  );
  return groups
    .map((x, i) => {
      const n = largestNetThatFits(BigInt(shares[i] ?? 0), x.rateBp);
      return { category: x.category, rateBp: x.rateBp, netCents: -Number(n.net), vatCents: -Number(n.vat) };
    })
    .filter((x) => x.netCents !== 0 || x.vatCents !== 0);
}

/** F04 §5.1.6: the preconditions of a final invoice (blocking findings for the compliance panel and the commit). */
export function finalChainFindings(
  final: { readonly documentDate: string; readonly currency: string; readonly taxCase: TaxCase },
  chain: FinalChain,
): Finding[] {
  const out: Finding[] = [];
  const de = (d: string) => d.split("-").reverse().join(".");
  if (chain.otherFinal) {
    out.push(
      finding(
        "final_exists",
        "E",
        "UST-41",
        "pflichtangaben",
        `Für diesen Auftrag gibt es bereits die Schlussrechnung ${chain.otherFinal.number}.`,
        { params: { number: chain.otherFinal.number } },
      ),
    );
  }
  const advances = chain.advances.filter(active);
  if (advances.length === 0) {
    out.push(
      finding(
        "final_without_advances",
        "E",
        "UST-41",
        "pflichtangaben",
        "Eine Schlussrechnung setzt mindestens eine Abschlags- oder Teilrechnung voraus. Bitte eine normale Rechnung erstellen.",
      ),
    );
    return out;
  }
  for (const a of advances) {
    const money = (c: number) => formatAmount(c, a.currency, "de");
    if (a.deductedIn) {
      out.push(
        finding(
          "advance_already_deducted",
          "E",
          "UST-41",
          "pflichtangaben",
          `Abschlagsrechnung ${a.number} wurde bereits in Schlussrechnung ${a.deductedIn.number} abgezogen.`,
          { params: { number: a.number, final: a.deductedIn.number } },
        ),
      );
      continue;
    }
    if (a.openCents > 0) {
      const invoiced = sumGroups(a.groups, a.corrections).reduce((s, x) => s + gross(x), 0);
      const received = Math.max(0, invoiced - a.openCents);
      out.push(
        finding(
          "advance_not_settled",
          "E",
          "UST-41",
          "pflichtangaben",
          `Abschlagsrechnung ${a.number} ist nicht vollständig bezahlt (offen: ${money(a.openCents)}). Vor der Schlussrechnung muss sie storniert (keine Zahlung) oder per Rechnungskorrektur auf den erhaltenen Betrag (${money(received)}) reduziert werden. Abgezogen werden nur tatsächlich erhaltene Zahlungen.`,
          { params: { number: a.number, advanceId: a.id, open: a.openCents, received } },
        ),
      );
    }
    if (a.currency !== final.currency) {
      out.push(
        finding(
          "chain_currency_mismatch",
          "E",
          "UST-41",
          "pflichtangaben",
          `Alle Dokumente einer Abschlags-/Schlussrechnungskette müssen dieselbe Währung haben (${a.currency}).`,
          { field: "currency", params: { currency: a.currency } },
        ),
      );
    }
    if (a.taxCase !== final.taxCase) {
      out.push(
        finding(
          "chain_tax_case_mismatch",
          "E",
          "UST-41",
          "steuern",
          `Der Steuerfall der Schlussrechnung (${final.taxCase}) weicht von Abschlagsrechnung ${a.number} (${a.taxCase}) ab.`,
          { params: { a: final.taxCase, number: a.number, b: a.taxCase } },
        ),
      );
    }
    if (final.documentDate < a.date) {
      out.push(
        finding(
          "final_date_before_advance",
          "E",
          "UST-41",
          "pflichtangaben",
          `Das Datum der Schlussrechnung darf nicht vor dem Datum der Abschlagsrechnung ${a.number} (${de(a.date)}) liegen.`,
          { field: "documentDate", params: { number: a.number, date: a.date } },
        ),
      );
    }
  }
  return out;
}
