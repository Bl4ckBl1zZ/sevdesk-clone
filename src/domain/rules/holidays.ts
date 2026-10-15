/**
 * Public holidays in Germany for the § 193 BGB shift of deadlines (F05 PAY-051, DUN-054, MAHN-01).
 *
 * Holidays are data: each row has a rule (fixed day, offset from Easter Sunday, or the Buß- und Bettag rule), the
 * Bundesländer it applies to ("all" = national), a validity range and the legal source. The company's Bundesland is
 * `companyProfile.taxNumberState`. Regional holidays that only apply in parts of a Land (Fronleichnam in parts of
 * Sachsen/Thüringen, Mariä Himmelfahrt in Bavarian municipalities, Augsburger Friedensfest) are included for the whole
 * Land: a deadline that moves one day later is always the safe side for a creditor's reminder.
 */
import type { Bundesland } from "../tax/tax-number";
import { addDays, type CalendarDate, fromEpochDay, toEpochDay } from "../time/calendar-date";

type HolidayRule =
  | { readonly kind: "fixed"; readonly monthDay: string }
  | { readonly kind: "easter"; readonly offset: number }
  | { readonly kind: "buss_und_bettag" };

export interface HolidayDef {
  readonly id: string;
  readonly name: string;
  readonly rule: HolidayRule;
  readonly states: "all" | readonly Bundesland[];
  readonly validFromYear: number;
  readonly validToYear?: number;
  readonly source: string;
}

const LAND = "Feiertagsgesetz des jeweiligen Landes";

export const PUBLIC_HOLIDAYS: readonly HolidayDef[] = [
  {
    id: "neujahr",
    name: "Neujahr",
    rule: { kind: "fixed", monthDay: "01-01" },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "heilige_drei_koenige",
    name: "Heilige Drei Könige",
    rule: { kind: "fixed", monthDay: "01-06" },
    states: ["BW", "BY", "ST"],
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "frauentag_be",
    name: "Internationaler Frauentag",
    rule: { kind: "fixed", monthDay: "03-08" },
    states: ["BE"],
    validFromYear: 2019,
    source: "Berliner Feiertagsgesetz i. d. F. vom 31.01.2019",
  },
  {
    id: "frauentag_mv",
    name: "Internationaler Frauentag",
    rule: { kind: "fixed", monthDay: "03-08" },
    states: ["MV"],
    validFromYear: 2023,
    source: "Feiertagsgesetz Mecklenburg-Vorpommern i. d. F. vom 16.11.2022",
  },
  {
    id: "karfreitag",
    name: "Karfreitag",
    rule: { kind: "easter", offset: -2 },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "ostermontag",
    name: "Ostermontag",
    rule: { kind: "easter", offset: 1 },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "tag_der_arbeit",
    name: "Tag der Arbeit",
    rule: { kind: "fixed", monthDay: "05-01" },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "christi_himmelfahrt",
    name: "Christi Himmelfahrt",
    rule: { kind: "easter", offset: 39 },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "pfingstmontag",
    name: "Pfingstmontag",
    rule: { kind: "easter", offset: 50 },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "fronleichnam",
    name: "Fronleichnam",
    rule: { kind: "easter", offset: 60 },
    states: ["BW", "BY", "HE", "NW", "RP", "SL", "SN", "TH"],
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "mariae_himmelfahrt",
    name: "Mariä Himmelfahrt",
    rule: { kind: "fixed", monthDay: "08-15" },
    states: ["BY", "SL"],
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "weltkindertag",
    name: "Weltkindertag",
    rule: { kind: "fixed", monthDay: "09-20" },
    states: ["TH"],
    validFromYear: 2019,
    source: "Thüringer Feiertagsgesetz i. d. F. vom 29.03.2019",
  },
  {
    id: "tag_der_deutschen_einheit",
    name: "Tag der Deutschen Einheit",
    rule: { kind: "fixed", monthDay: "10-03" },
    states: "all",
    validFromYear: 1990,
    source: "Einigungsvertrag Art. 2 Abs. 2",
  },
  {
    id: "reformationstag",
    name: "Reformationstag",
    rule: { kind: "fixed", monthDay: "10-31" },
    states: ["BB", "MV", "SN", "ST", "TH"],
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "reformationstag_nord",
    name: "Reformationstag",
    rule: { kind: "fixed", monthDay: "10-31" },
    states: ["HB", "HH", "NI", "SH"],
    validFromYear: 2018,
    source: LAND,
  },
  {
    id: "allerheiligen",
    name: "Allerheiligen",
    rule: { kind: "fixed", monthDay: "11-01" },
    states: ["BW", "BY", "NW", "RP", "SL"],
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "buss_und_bettag",
    name: "Buß- und Bettag",
    rule: { kind: "buss_und_bettag" },
    states: ["SN"],
    validFromYear: 1995,
    source: "Sächsisches Sonn- und Feiertagsgesetz",
  },
  {
    id: "weihnachtstag_1",
    name: "1. Weihnachtstag",
    rule: { kind: "fixed", monthDay: "12-25" },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
  {
    id: "weihnachtstag_2",
    name: "2. Weihnachtstag",
    rule: { kind: "fixed", monthDay: "12-26" },
    states: "all",
    validFromYear: 1990,
    source: LAND,
  },
];

/** Easter Sunday (anonymous Gregorian algorithm, Meeus/Jones/Butcher). */
export function easterSunday(year: number): CalendarDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` as CalendarDate;
}

/** 1970-01-01 was a Thursday; 0 = Monday … 6 = Sunday. */
const weekday = (date: CalendarDate): number => (((toEpochDay(date) + 3) % 7) + 7) % 7;

function dateOf(rule: HolidayRule, year: number): CalendarDate {
  if (rule.kind === "fixed") return `${year}-${rule.monthDay}` as CalendarDate;
  if (rule.kind === "easter") return addDays(easterSunday(year), rule.offset);
  // Wednesday before 23 November (§ 1 SächsSFG): the last Wednesday strictly before the 23rd.
  const nov23 = toEpochDay(`${year}-11-23` as CalendarDate);
  const wd = weekday(`${year}-11-23` as CalendarDate);
  const back = (wd - 2 + 7) % 7 || 7;
  return fromEpochDay(nov23 - back);
}

export interface PublicHoliday {
  readonly date: CalendarDate;
  readonly id: string;
  readonly name: string;
}

/** National holidays plus those of `state` (unknown/absent Land = national only). */
export function publicHolidaysOf(year: number, state: string | undefined): PublicHoliday[] {
  return PUBLIC_HOLIDAYS.filter(
    (h) =>
      year >= h.validFromYear &&
      (h.validToYear === undefined || year <= h.validToYear) &&
      (h.states === "all" || (state !== undefined && (h.states as readonly string[]).includes(state))),
  )
    .map((h) => ({ date: dateOf(h.rule, year), id: h.id, name: h.name }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function isBusinessDay(date: CalendarDate, state: string | undefined): boolean {
  if (weekday(date) >= 5) return false;
  return !publicHolidaysOf(Number(date.slice(0, 4)), state).some((h) => h.date === date);
}

/** § 193 BGB: a deadline on a Saturday, Sunday or public holiday ends on the next business day. */
export function shiftToBusinessDay(date: CalendarDate, state: string | undefined): CalendarDate {
  let d = date;
  for (let i = 0; i < 10 && !isBusinessDay(d, state); i++) d = addDays(d, 1);
  return d;
}
