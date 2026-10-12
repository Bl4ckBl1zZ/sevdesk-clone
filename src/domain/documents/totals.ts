/**
 * Document totals (F04 DOC-09/DOC-10, App. E; 02 §5 "Rounding"; 10 RI-05).
 * One implementation for editor (live) and server (authoritative). BigInt intermediates, half-away rounding.
 *
 * Net mode (App. E.2): line net → group line sum → document allowance/charge per group → VAT per group.
 * Gross mode (App. E.3): line gross → group gross → largest net that fits (EC-053) → line nets allocated from it.
 * The result is always the net EN 16931 model (BT-106 … BT-115).
 */
import { allocateExact } from "../money/allocate";
import { formatBasisPoints, formatCents } from "../money/format";
import { type LineDiscount, lineAmountExact } from "../money/line";
import { roundHalfAway } from "../money/rounding";
import { fitsCents, MAX_QUANTITY_MILLI, MAX_UNIT_PRICE_MICROS } from "../money/units";
import { largestNetThatFits, vatExact } from "../money/vat";
import { err, type Issue, issue, ok, type Result } from "../result";
import { VAT_CATEGORY_ORDER, type VatCategory } from "../tax/vat-category";

export type { VatCategory };

export type PriceMode = "net" | "gross";

export interface TotalsLineInput {
  readonly quantityMilli: number;
  /** Net or gross unit price in 1/10,000, depending on the document's price mode. */
  readonly unitPriceMicros: number;
  readonly discount?: LineDiscount | undefined;
  readonly vatCategory: VatCategory;
  /** Resolved rate in basis points (0 for Z/E/AE/K/G/O/KU). */
  readonly rateBp: number;
  /** Optional quote positions are excluded from all totals (QUO-02). */
  readonly optional?: boolean | undefined;
}

/** Document-level discount (allowance, BG-20) or surcharge (charge, BG-21): percent per group or an amount. */
export type DocumentAdjustment =
  | { readonly type: "allowance" | "charge"; readonly percentBp: number }
  | { readonly type: "allowance" | "charge"; readonly amountCents: number };

export interface TotalsInput {
  readonly priceMode: PriceMode;
  readonly lines: readonly TotalsLineInput[];
  readonly adjustment?: DocumentAdjustment | undefined;
  /** Paid/deducted amount (BT-113), e.g. advances deducted in a final invoice. */
  readonly prepaidCents?: number | undefined;
}

export interface LineTotals {
  readonly included: boolean;
  /** Index into `groups`, null for excluded (optional) lines. */
  readonly groupIndex: number | null;
  /** Line net (BT-131). */
  readonly netCents: number;
  /** Entered line gross (gross mode only). */
  readonly grossCents: number | null;
}

export interface VatGroupTotals {
  readonly vatCategory: VatCategory;
  readonly rateBp: number;
  /** Σ line nets of the group. */
  readonly lineNetSumCents: number;
  readonly allowanceCents: number;
  readonly chargeCents: number;
  /** BT-116 = lineNetSum − allowance + charge. */
  readonly baseCents: number;
  /** BT-117 = round_half_away(base × rate). */
  readonly vatCents: number;
  /** Gross mode: the entered group gross G after document allowance/charge. */
  readonly enteredGrossCents?: number;
}

export interface DocumentTotals {
  readonly lines: readonly LineTotals[];
  readonly groups: readonly VatGroupTotals[];
  /** BT-106 */ readonly lineNetSumCents: number;
  /** BT-107 */ readonly allowanceTotalCents: number;
  /** BT-108 */ readonly chargeTotalCents: number;
  /** BT-109 */ readonly taxExclusiveCents: number;
  /** BT-110 */ readonly vatTotalCents: number;
  /** BT-112 */ readonly grossCents: number;
  /** BT-113 */ readonly prepaidCents: number;
  /** BT-114 — always 0: an unreachable gross keeps the 1-cent deviation (F04 9.12, README B6). */
  readonly roundingCents: number;
  /** BT-115 */ readonly payableCents: number;
  readonly warnings: readonly Issue<"gross_rounding_deviation">[];
}

export type TotalsErrorCode = "amount_invalid" | "amount_too_large";

const BP = 10_000n;

const invalid = (what: string) =>
  err(issue<TotalsErrorCode>("amount_invalid", "Ungültiger Betrag, Menge oder Prozentsatz.", { field: what }));
const tooLarge = () =>
  err(issue<TotalsErrorCode>("amount_too_large", "Der Betrag ist zu groß (maximal 99.999.999.999,99)."));

const isInt = (v: number) => Number.isSafeInteger(v);
const isBp = (v: number) => isInt(v) && v >= 0 && v <= 10_000;

function validate(input: TotalsInput): Result<true, Issue<TotalsErrorCode>> {
  for (const [i, l] of input.lines.entries()) {
    if (!isInt(l.quantityMilli) || !isInt(l.unitPriceMicros)) return invalid(`lines[${i}]`);
    if (Math.abs(l.quantityMilli) > MAX_QUANTITY_MILLI || Math.abs(l.unitPriceMicros) > MAX_UNIT_PRICE_MICROS) {
      return tooLarge();
    }
    if (!isBp(l.rateBp)) return invalid(`lines[${i}].rateBp`);
    if (l.discount?.kind === "percent" && !isBp(l.discount.bp)) return invalid(`lines[${i}].discount`);
    if (l.discount?.kind === "amount" && !isInt(l.discount.cents)) return invalid(`lines[${i}].discount`);
  }
  const a = input.adjustment;
  if (a && "percentBp" in a && !isBp(a.percentBp)) return invalid("adjustment");
  if (a && "amountCents" in a && !isInt(a.amountCents)) return invalid("adjustment");
  if (input.prepaidCents !== undefined && !isInt(input.prepaidCents)) return invalid("prepaidCents");
  return ok(true);
}

interface Group {
  readonly vatCategory: VatCategory;
  readonly rateBp: number;
  readonly members: number[]; // line indexes
}

function groupLines(lines: readonly TotalsLineInput[]): Group[] {
  const map = new Map<string, Group>();
  lines.forEach((l, i) => {
    if (l.optional) return;
    const key = `${l.vatCategory}|${l.rateBp}`;
    const g = map.get(key) ?? { vatCategory: l.vatCategory, rateBp: l.rateBp, members: [] };
    g.members.push(i);
    map.set(key, g);
  });
  return [...map.values()].sort(
    (a, b) =>
      VAT_CATEGORY_ORDER.indexOf(a.vatCategory) - VAT_CATEGORY_ORDER.indexOf(b.vatCategory) || b.rateBp - a.rateBp,
  );
}

/** Per-group allowance/charge amounts on the given group sums (percent per group or `allocate`). */
function adjustmentPerGroup(adjustment: DocumentAdjustment | undefined, sums: readonly bigint[]): bigint[] {
  if (!adjustment) return sums.map(() => 0n);
  if ("percentBp" in adjustment) return sums.map((s) => roundHalfAway(s * BigInt(adjustment.percentBp), BP));
  return allocateExact(BigInt(adjustment.amountCents), sums);
}

interface ExactGroup {
  vatCategory: VatCategory;
  rateBp: number;
  lineNetSum: bigint;
  allowance: bigint;
  charge: bigint;
  base: bigint;
  vat: bigint;
  enteredGross?: bigint;
}

/** Gross-mode line nets: allocate N(G_lines) over the line grosses (App. E.3 step 4). */
function grossLineNets(lineGross: readonly bigint[], netSum: bigint, rateBp: number): bigint[] {
  const grossSum = lineGross.reduce((a, b) => a + b, 0n);
  if (grossSum !== 0n) return allocateExact(netSum, lineGross);
  // Spec gap: lines cancel out within the group (Σ gross = 0). Give each line its own N(gross) and put the
  // residual (N(0) = 0 − Σ) on the largest line, so every line keeps a meaningful net and the sum stays exact.
  const own = lineGross.map((g) => largestNetThatFits(g, rateBp).net);
  const residual = netSum - own.reduce((a, b) => a + b, 0n);
  const fix = allocateExact(residual, lineGross);
  return own.map((n, i) => n + (fix[i] ?? 0n));
}

export function computeTotals(input: TotalsInput): Result<DocumentTotals, Issue<TotalsErrorCode>> {
  const valid = validate(input);
  if (!valid.ok) return valid;

  const amounts = input.lines.map((l) => lineAmountExact(l.quantityMilli, l.unitPriceMicros, l.discount));
  if (!amounts.every(fitsCents)) return tooLarge();

  const groups = groupLines(input.lines);
  const sums = groups.map((g) => g.members.reduce((a, i) => a + (amounts[i] ?? 0n), 0n));
  const adj = adjustmentPerGroup(input.adjustment, sums);
  const isCharge = input.adjustment?.type === "charge";
  const lineNets = new Map<number, bigint>();
  const exact: ExactGroup[] = [];
  const warnings: Issue<"gross_rounding_deviation">[] = [];

  groups.forEach((g, gi) => {
    const sum = sums[gi] ?? 0n;
    const a = adj[gi] ?? 0n;
    if (input.priceMode === "net") {
      for (const i of g.members) lineNets.set(i, amounts[i] ?? 0n);
      const allowance = isCharge ? 0n : a;
      const charge = isCharge ? a : 0n;
      const base = sum - allowance + charge;
      exact.push({ ...g, lineNetSum: sum, allowance, charge, base, vat: vatExact(base, g.rateBp) });
      return;
    }
    const entered = isCharge ? sum + a : sum - a;
    const linesNet = largestNetThatFits(sum, g.rateBp).net;
    const fitted = largestNetThatFits(entered, g.rateBp);
    const nets = grossLineNets(
      g.members.map((i) => amounts[i] ?? 0n),
      linesNet,
      g.rateBp,
    );
    g.members.forEach((i, k) => {
      lineNets.set(i, nets[k] ?? 0n);
    });
    const allowance = isCharge ? 0n : linesNet - fitted.net;
    const charge = isCharge ? fitted.net - linesNet : 0n;
    exact.push({
      ...g,
      lineNetSum: linesNet,
      allowance,
      charge,
      base: fitted.net,
      vat: fitted.vat,
      enteredGross: entered,
    });
    if (fitted.deviation !== 0n && fitsCents(entered)) {
      const computed = Number(fitted.net + fitted.vat);
      warnings.push(
        issue(
          "gross_rounding_deviation",
          `Durch die Umrechnung in Nettobeträge (E-Rechnung) beträgt die Summe ${formatBasisPoints(g.rateBp)} % ${formatCents(computed)} € statt ${formatCents(Number(entered))} €. Tipp: Bruttopreis um 0,01 € anpassen.`,
          { vatCategory: g.vatCategory, rateBp: g.rateBp, enteredCents: Number(entered), computedCents: computed },
        ),
      );
    }
  });

  const total = (pick: (g: ExactGroup) => bigint) => exact.reduce((acc, g) => acc + pick(g), 0n);
  const lineNetSum = total((g) => g.lineNetSum);
  const allowanceTotal = total((g) => g.allowance);
  const chargeTotal = total((g) => g.charge);
  const taxExclusive = total((g) => g.base);
  const vatTotal = total((g) => g.vat);
  const gross = taxExclusive + vatTotal;
  const prepaid = BigInt(input.prepaidCents ?? 0);
  const payable = gross - prepaid;
  const everything = [
    ...exact.flatMap((g) => [g.lineNetSum, g.allowance, g.charge, g.base, g.vat, g.enteredGross ?? 0n]),
    lineNetSum,
    allowanceTotal,
    chargeTotal,
    taxExclusive,
    vatTotal,
    gross,
    prepaid,
    payable,
  ];
  if (!everything.every(fitsCents)) return tooLarge();

  const groupIndexOfLine = new Map<number, number>();
  groups.forEach((g, gi) => {
    for (const i of g.members) groupIndexOfLine.set(i, gi);
  });

  return ok({
    lines: input.lines.map((l, i) => {
      const groupIndex = groupIndexOfLine.get(i) ?? null;
      const amount = amounts[i] ?? 0n;
      // Excluded (optional) lines are shown with their own net: as entered, or N(line gross) in gross mode.
      const ownNet = input.priceMode === "net" ? amount : largestNetThatFits(amount, l.rateBp).net;
      return {
        included: groupIndex !== null,
        groupIndex,
        netCents: Number(lineNets.get(i) ?? ownNet),
        grossCents: input.priceMode === "gross" ? Number(amount) : null,
      };
    }),
    groups: exact.map((g) => ({
      vatCategory: g.vatCategory,
      rateBp: g.rateBp,
      lineNetSumCents: Number(g.lineNetSum),
      allowanceCents: Number(g.allowance),
      chargeCents: Number(g.charge),
      baseCents: Number(g.base),
      vatCents: Number(g.vat),
      ...(g.enteredGross === undefined ? {} : { enteredGrossCents: Number(g.enteredGross) }),
    })),
    lineNetSumCents: Number(lineNetSum),
    allowanceTotalCents: Number(allowanceTotal),
    chargeTotalCents: Number(chargeTotal),
    taxExclusiveCents: Number(taxExclusive),
    vatTotalCents: Number(vatTotal),
    grossCents: Number(gross),
    prepaidCents: Number(prepaid),
    roundingCents: 0,
    payableCents: Number(payable),
    warnings,
  });
}
