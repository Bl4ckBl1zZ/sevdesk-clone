import { endOfMonth } from "../../src/domain/accounting/period";
import { ustAnnualMappingFor } from "../../src/domain/rules/ust-annual";
import { ustvaMappingFor } from "../../src/domain/rules/ustva";
import { computeUstAnnual, type FiledUstva } from "../../src/domain/tax/ust-annual";
import { entryContributions, monthsOfFilingPeriod, sheetHash } from "../../src/domain/tax/ustva";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { appError } from "../lib/errors";
import { getCompanyProfile } from "./companyProfile";
import { checklistFor } from "./periodLock";
import { activeFiling, drillDownLabels, filingsOf, taxJournalEntries } from "./taxFilings";
import type { ReadCtx } from "./types";
import { kuOn } from "./vouchers";

/**
 * USt-Jahreserklärung worksheet read model (F08 TAX-023, §6 /steuern/ust-jahr): year totals per USt 2 A line from the
 * journal by tax point, reconciled with the UStVA in force per filing period; Mein ELSTER guide. Read-only — no
 * submission record and no lock (the months are locked by the UStVA records).
 */
export async function ustAnnualView(ctx: ReadCtx, year: number, now: number) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw appError("invalid_input", "Ungültiges Jahr.");
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const kind = profile.ustvaPeriod.find((p) => p.year === year)?.period ?? "quarterly";
  const periods =
    kind === "monthly"
      ? Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`)
      : kind === "quarterly"
        ? [1, 2, 3, 4].map((q) => `${year}-Q${q}`)
        : [String(year)];
  const ustva = ustvaMappingFor(year);
  const entries = await taxJournalEntries(ctx);
  const contributions = ustva ? entries.flatMap((e) => entryContributions(e, ustva)) : [];
  const filed: FiledUstva[] = [];
  for (const p of periods) {
    const active = activeFiling(await filingsOf(ctx, "ustva", p));
    if (!active) continue;
    filed.push({
      period: p,
      values: Object.fromEntries(active.values.map((v) => [v.kz, v.cents])),
      submittedAt: active.submittedAt ?? 0,
      ...(active.submittedValuesDiffer ? { submittedValuesDiffer: true } : {}),
      ...(active.elsterReportedTotalCents !== undefined
        ? { elsterReportedTotalCents: active.elsterReportedTotalCents }
        : {}),
    });
  }
  const checklist = await checklistFor(ctx, monthsOfFilingPeriod(String(year)), now);
  const blockers = checklist.blockers.map((b) =>
    b.code === "drafts"
      ? `Es gibt ${b.count ?? 0} Entwürfe mit Leistungsdatum im Jahr ${year}. Bitte fertigstellen oder löschen.`
      : b.message,
  );
  const lastDay = endOfMonth(`${year}-12`);
  const { yearSheet, ...sheet } = computeUstAnnual({
    year,
    periods,
    contributions,
    recordedAt: new Map(entries.map((e) => [e.id, e.recordedAt])),
    ustva,
    annual: ustAnnualMappingFor(year),
    filed,
    ku: kuOn(profile, lastDay),
    ended: berlinCalendarDate(now) > lastDay,
    blockers,
  });
  sheet.guide.sheetHash = await sheetHash({
    form: "ust_annual",
    period: String(year),
    ruleVersions: [sheet.mappingVersion ?? "", sheet.ustvaMappingVersion ?? ""],
    values: Object.fromEntries(sheet.rows.filter((r) => r.kz).map((r) => [`${r.zeile}:${r.kz}`, r.valueCents])),
  });
  return {
    year,
    periodKind: kind,
    periods: periods.map((p) => ({ period: p, filed: filed.some((f) => f.period === p) })),
    sheet,
    /** UStVA Kennzahl → contributing journal entries of the year (drill-down of the worksheet rows). */
    drillDown: await drillDownLabels(ctx, yearSheet?.drillDown ?? {}),
  };
}
