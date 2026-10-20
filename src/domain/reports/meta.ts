/**
 * Report header facts (F08 RPT-001, GOBD-01, GOBD-22; E-RPT-01): every report shows its parameters, the generation
 * time (Europe/Berlin), the rule versions used and the lock status of the covered months — „vorläufig“ while any of
 * them is not festgeschrieben. Pure.
 */

export const PROVISIONAL_NOTICE = "Vorläufig – Zeitraum nicht festgeschrieben.";

export interface ReportMeta {
  report: string;
  params: Record<string, string | number | boolean | null>;
  generatedAt: number;
  ruleVersions: string[];
  months: string[];
  lockedMonths: string[];
  provisional: boolean;
  notice: string | null;
}

/** `YYYY-MM` of every month between two dates (inclusive). */
export function monthsOfRange(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const ey = Number(to.slice(0, 4));
  const em = Number(to.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

export function reportMeta(input: {
  report: string;
  params: ReportMeta["params"];
  generatedAt: number;
  ruleVersions: readonly string[];
  from: string;
  to: string;
  lockedMonths: Iterable<string>;
}): ReportMeta {
  const months = monthsOfRange(input.from, input.to);
  const locked = new Set(input.lockedMonths);
  const lockedMonths = months.filter((m) => locked.has(m));
  const provisional = lockedMonths.length < months.length;
  return {
    report: input.report,
    params: input.params,
    generatedAt: input.generatedAt,
    ruleVersions: [...input.ruleVersions],
    months,
    lockedMonths,
    provisional,
    notice: provisional ? PROVISIONAL_NOTICE : null,
  };
}

const DATE_TIME = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

/** Footer lines for CSV/PDF: Erstellt am, Parameter, Regelversionen, Festschreibung. */
export function metaLines(m: ReportMeta): [string, string][] {
  const params = Object.entries(m.params)
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return [
    ["Erstellt am", DATE_TIME.format(m.generatedAt)],
    ["Parameter", params || "—"],
    ["Regelversionen", m.ruleVersions.join(", ") || "—"],
    [
      "Festschreibung",
      m.provisional
        ? `vorläufig (${m.lockedMonths.length} von ${m.months.length} Monaten festgeschrieben)`
        : "festgeschrieben",
    ],
  ];
}
