/**
 * Steuernummer (UST-04, F01 SET-030): regional 10/11-digit format of a Land ↔ 13-digit ELSTER format
 * (4-digit Bundesfinanzamtsnummer + "0" + 8 digits Bezirk/Unterscheidungsnummer/Prüfziffer).
 *
 * Basic format check only: the Land-specific check-digit procedures are not verified here (a wrong check digit
 * is caught when the owner uses the number in Mein ELSTER).
 */
import { err, type Issue, issue, ok, type Result } from "../result";

interface StateFormat {
  /** ELSTER prefix (1 or 2 digits) that precedes the regional Finanzamt part. */
  readonly elsterPrefix: string;
  /** Regional Finanzamt part as written in the regional format (length 2 or 3), e.g. /^0\d\d$/ for "0FF". */
  readonly head: RegExp;
  /** Head → Finanzamt digits that follow the ELSTER prefix (BUFA = prefix + this, always 4 digits in total). */
  readonly headToBufa: (head: string) => string;
  /** BUFA digits after the prefix → regional head. */
  readonly bufaToHead: (rest: string) => string;
  /** Regional display: groups of the 10/11 regional digits. */
  readonly display: (digits: string) => string;
}

const same = (s: string) => s;
const slash = (a: number, b: number) => (d: string) => `${d.slice(0, a)}/${d.slice(a, a + b)}/${d.slice(a + b)}`;
const spaced = (a: number, b: number) => (d: string) => `${d.slice(0, a)} ${d.slice(a, a + b)} ${d.slice(a + b)}`;
const fffbbb = (d: string) => `${d.slice(0, 5)}/${d.slice(5)}`; // Baden-Württemberg "FFBBB/UUUUP"

export const TAX_NUMBER_STATES = {
  BW: { elsterPrefix: "28", head: /^\d{2}$/, headToBufa: same, bufaToHead: same, display: fffbbb },
  BY: { elsterPrefix: "9", head: /^\d{3}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
  BE: { elsterPrefix: "11", head: /^\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(2, 3) },
  BB: { elsterPrefix: "3", head: /^0\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
  HB: { elsterPrefix: "24", head: /^\d{2}$/, headToBufa: same, bufaToHead: same, display: spaced(2, 3) },
  HH: {
    elsterPrefix: "22",
    head: /^0?\d{2}$/, // "FF" or the newer "0FF"
    headToBufa: (h: string) => h.slice(-2),
    bufaToHead: same,
    display: slash(2, 3),
  },
  HE: {
    elsterPrefix: "26",
    head: /^0\d{2}$/,
    headToBufa: (h: string) => h.slice(1),
    bufaToHead: (r: string) => `0${r}`,
    display: spaced(3, 3),
  },
  MV: { elsterPrefix: "4", head: /^0\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
  NI: { elsterPrefix: "23", head: /^\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(2, 3) },
  NW: { elsterPrefix: "5", head: /^\d{3}$/, headToBufa: same, bufaToHead: same, display: slash(3, 4) },
  RP: { elsterPrefix: "27", head: /^\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(2, 3) },
  SL: { elsterPrefix: "1", head: /^0\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
  SN: { elsterPrefix: "3", head: /^2\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
  ST: { elsterPrefix: "3", head: /^1\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
  SH: { elsterPrefix: "21", head: /^\d{2}$/, headToBufa: same, bufaToHead: same, display: spaced(2, 3) },
  TH: { elsterPrefix: "4", head: /^1\d{2}$/, headToBufa: same, bufaToHead: same, display: slash(3, 3) },
} as const satisfies Record<string, StateFormat>;

export type Bundesland = keyof typeof TAX_NUMBER_STATES;

export interface TaxNumber {
  /** 13-digit ELSTER format (stored). */
  readonly elster: string;
  readonly state: Bundesland;
  /** Regional format for printing. */
  readonly display: string;
}

const invalid = () =>
  err(issue("tax_number_invalid", "Die Steuernummer passt nicht zum Format des gewählten Bundeslandes."));

function fromElster(digits: string): { state: Bundesland; display: string } | null {
  if (digits[4] !== "0") return null;
  for (const [state, f] of Object.entries(TAX_NUMBER_STATES) as [Bundesland, StateFormat][]) {
    const bufa = digits.slice(0, 4);
    if (!bufa.startsWith(f.elsterPrefix)) continue;
    const head = f.bufaToHead(bufa.slice(f.elsterPrefix.length));
    if (!f.head.test(head)) continue;
    const regional = `${head}${digits.slice(5)}`;
    return { state, display: f.display(regional) };
  }
  return null;
}

/** Accepts the regional format of `state` or the 13-digit ELSTER format (Land derived from the prefix). */
export function normalizeTaxNumber(input: string, state?: Bundesland): Result<TaxNumber, Issue<"tax_number_invalid">> {
  const digits = input.replace(/[\s/\-.]/g, "");
  if (!/^\d+$/.test(digits)) return invalid();
  if (digits.length === 13) {
    const found = fromElster(digits);
    if (!found || (state !== undefined && state !== found.state)) return invalid();
    return ok({ elster: digits, ...found });
  }
  if (state === undefined || (digits.length !== 10 && digits.length !== 11)) return invalid();
  const f: StateFormat = TAX_NUMBER_STATES[state];
  const head = digits.slice(0, digits.length - 8);
  if (!f.head.test(head)) return invalid();
  const elster = `${f.elsterPrefix}${f.headToBufa(head)}0${digits.slice(-8)}`;
  const back = fromElster(elster);
  return back ? ok({ elster, state, display: back.display }) : invalid();
}

/** German federal states with their names, for the Steuernummer Bundesland select (F01 SET-030). */
export const BUNDESLAND_NAMES: Readonly<Record<Bundesland, string>> = {
  BW: "Baden-Württemberg",
  BY: "Bayern",
  BE: "Berlin",
  BB: "Brandenburg",
  HB: "Bremen",
  HH: "Hamburg",
  HE: "Hessen",
  MV: "Mecklenburg-Vorpommern",
  NI: "Niedersachsen",
  NW: "Nordrhein-Westfalen",
  RP: "Rheinland-Pfalz",
  SL: "Saarland",
  SN: "Sachsen",
  ST: "Sachsen-Anhalt",
  SH: "Schleswig-Holstein",
  TH: "Thüringen",
};

export function isBundesland(code: string): code is Bundesland {
  return Object.hasOwn(TAX_NUMBER_STATES, code);
}
