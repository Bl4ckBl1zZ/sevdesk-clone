import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { BASISZINSSATZ, defaultInterestRateBp, lookupBasiszinssatz } from "./basiszinssatz";
import { lookupNoteText, NOTE_TEXT_IDS, NOTE_TEXTS } from "./note-texts";
import { ALL_RULE_TABLES } from "./registry";
import { lookupRule } from "./rule-table";
import {
  isWithinKleinbetragLimit,
  KLEINBETRAG_LIMIT,
  KLEINUNTERNEHMER_LIMITS,
  lookupVerzugSurcharges,
  VERZUG_SURCHARGES,
} from "./thresholds";
import { checkStoredRate, isVatRateKey, lookupVatRate, lookupVatRateForPeriod, VAT_RATE_KEYS } from "./vat-rates";

const d = calendarDate;

function rate(key: string, date: string) {
  const r = lookupVatRate(key, d(date));
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe("VAT rate keys (PRD-020, UST-15)", () => {
  test("PRD-020 v1 ships the keys standard, reduced, restaurant_food, zero and exempt (data, not code)", () => {
    expect(Object.keys(VAT_RATE_KEYS).sort()).toEqual(["exempt", "reduced", "restaurant_food", "standard", "zero"]);
    expect(isVatRateKey("standard")).toBe(true);
    expect(isVatRateKey("super_reduced")).toBe(false);
    const unknown = lookupVatRate("super_reduced", d("2026-01-01"));
    expect(!unknown.ok && unknown.error.code).toBe("vat_key_invalid");
    expect(unknown.ok ? "" : unknown.error.message).toBe("Unbekannter Steuersatz-Schlüssel.");
  });

  test("UST-15 rates 19 / 7 / 0 (PV, category Z) / exempt (E) by supply date", () => {
    expect(rate("standard", "2026-10-12")).toMatchObject({ value: { category: "S", rateBp: 1900 } });
    expect(rate("reduced", "2026-10-12")).toMatchObject({ value: { category: "S", rateBp: 700 } });
    expect(rate("zero", "2026-10-12")).toMatchObject({ value: { category: "Z", rateBp: 0 } });
    expect(rate("exempt", "2026-10-12")).toMatchObject({ value: { category: "E", rateBp: 0 } });
    // PV zero rate only from 2023-01-01 (§ 12 Abs. 3 UStG)
    expect(rate("zero", "2023-01-01").value.rateBp).toBe(0);
    expect(lookupVatRate("zero", d("2022-12-31")).ok).toBe(false);
  });

  test("UST-15 restaurant food: 19 % until 2025-12-31, 7 % from 2026-01-01; drinks (standard) 19 % on both dates", () => {
    expect(rate("restaurant_food", "2025-12-31")).toMatchObject({ value: { rateBp: 1900 } });
    expect(rate("restaurant_food", "2026-01-01")).toMatchObject({
      rowId: "restaurant_food@2026-01-01",
      value: { category: "S", rateBp: 700 },
    });
    expect(rate("standard", "2025-12-31").value.rateBp).toBe(1900);
    expect(rate("standard", "2026-01-01").value.rateBp).toBe(1900);
  });

  test("MISC-09 the 2020-07-01..2020-12-31 reduction (16 % / 5 %) and the 2020–2023 restaurant rates are reproduced", () => {
    expect(rate("standard", "2020-06-30").value.rateBp).toBe(1900);
    expect(rate("standard", "2020-07-01").value.rateBp).toBe(1600);
    expect(rate("standard", "2020-12-31").value.rateBp).toBe(1600);
    expect(rate("standard", "2021-01-01").value.rateBp).toBe(1900);
    expect(rate("reduced", "2020-07-01").value.rateBp).toBe(500);
    expect(rate("reduced", "2021-01-01").value.rateBp).toBe(700);
    expect(rate("restaurant_food", "2020-06-30").value.rateBp).toBe(1900);
    expect(rate("restaurant_food", "2020-07-01").value.rateBp).toBe(500);
    expect(rate("restaurant_food", "2021-01-01").value.rateBp).toBe(700);
    expect(rate("restaurant_food", "2023-12-31").value.rateBp).toBe(700);
    expect(rate("restaurant_food", "2024-01-01").value.rateBp).toBe(1900);
  });

  test("PRD-021 a service period crossing the 2026-01-01 restaurant change is blocked (split by sub-period, EC-024)", () => {
    const month = lookupVatRateForPeriod("restaurant_food", d("2025-12-01"), d("2025-12-31"));
    expect(month.ok && month.value.value.rateBp).toBe(1900);
    const crossing = lookupVatRateForPeriod("restaurant_food", d("2025-12-15"), d("2026-01-15"));
    expect(!crossing.ok && crossing.error).toMatchObject({
      code: "rule_changes_in_period",
      params: { changeDate: "2026-01-01" },
    });
    // drinks do not change on 2026-01-01
    expect(lookupVatRateForPeriod("standard", d("2025-12-15"), d("2026-01-15")).ok).toBe(true);
    const unknown = lookupVatRateForPeriod("nope", d("2025-12-15"), d("2026-01-15"));
    expect(!unknown.ok && unknown.error.code).toBe("vat_key_invalid");
  });
});

describe("Basiszinssatz and default interest (§ 247, § 288 BGB)", () => {
  test("MAHN-02 default interest = Basiszinssatz + 5 (B2C) / + 9 (B2B) points; 1,52 % since 2026-07-01", () => {
    const b2b = (date: string) => {
      const r = defaultInterestRateBp(d(date), "b2b");
      return r.ok ? r.value.rateBp : r.error.code;
    };
    const b2c = (date: string) => {
      const r = defaultInterestRateBp(d(date), "b2c");
      return r.ok ? r.value.rateBp : r.error.code;
    };
    expect(b2b("2026-06-30")).toBe(1027);
    expect(b2b("2026-07-01")).toBe(1052);
    expect(b2c("2026-07-01")).toBe(652);
    expect(b2c("2026-06-30")).toBe(627);
    expect(b2b("2023-01-01")).toBe(1062);
    const r = defaultInterestRateBp(d("2026-08-01"), "b2b");
    expect(r.ok && r.value.basiszinsRowId).toBe("basiszinssatz@2026-07-01");
  });

  test("DUN-021 the table holds half-year rows (01-01 / 07-01) from the Bundesbank, with a source on every row", () => {
    for (const e of BASISZINSSATZ.entries) {
      expect(["01-01", "07-01"]).toContain(e.validFrom.slice(5));
      expect(["06-30", "12-31"]).toContain(e.validTo?.slice(5));
      expect(e.source).toMatch(/Bundesbank/);
    }
    const r = lookupBasiszinssatz(d("2024-03-01"));
    expect(r.ok && r.value.value.rateBp).toBe(362);
  });

  test("EC-DUN-11 negative Basiszinssatz is supported (−0,88 % → B2C 4,12 % in 2021)", () => {
    const base = lookupBasiszinssatz(d("2021-06-01"));
    expect(base.ok && base.value.value.rateBp).toBe(-88);
    const r = defaultInterestRateBp(d("2021-06-01"), "b2c");
    expect(r.ok && r.value.rateBp).toBe(412);
  });

  test("EC-127 a missing Basiszinssatz row for the half-year blocks the computation (no guess)", () => {
    const r = defaultInterestRateBp(d("2027-01-01"), "b2b");
    expect(!r.ok && r.error.code).toBe("basiszinssatz_missing");
    expect(r.ok ? "" : r.error.message).toBe(
      "Der Basiszinssatz ab 01.01.2027 ist nicht hinterlegt. Bitte unter Einstellungen › Regeln ergänzen.",
    );
    // an owner override (SET-121) closes the gap
    const withOverride = defaultInterestRateBp(d("2027-02-01"), "b2b", [
      {
        id: "ovr",
        validFrom: d("2027-01-01"),
        validTo: d("2027-06-30"),
        value: { rateBp: 140 },
        source: "Bundesbank PM",
      },
    ]);
    expect(withOverride.ok && withOverride.value).toMatchObject({ rateBp: 1040, basiszinsRowId: "override:ovr" });
  });

  test("MAHN-03 the 40 € flat fee and the 5/9-point surcharges are date-effective rows (§ 288 Abs. 1, 2, 5 BGB)", () => {
    const r = lookupVerzugSurcharges(d("2026-10-12"));
    expect(r.ok && r.value.value).toEqual({ b2cBp: 500, b2bBp: 900, flatFeeB2bCents: 4000 });
    expect(VERZUG_SURCHARGES.entries[0]?.source).toMatch(/§ 288/);
    expect(lookupVerzugSurcharges(d("2014-07-28")).ok).toBe(false);
    const missing = defaultInterestRateBp(d("2014-07-01"), "b2b");
    expect(!missing.ok && missing.error.code).toBe("rule_missing");
  });
});

describe("thresholds", () => {
  test("KU-01 Kleinunternehmer limits from 2025: prior year 25.000 €, current year 100.000 €, founding year 25.000 €", () => {
    const r = lookupRule(KLEINUNTERNEHMER_LIMITS, d("2025-01-01"));
    expect(r.ok && r.value.value).toEqual({
      priorYearLimitCents: 2_500_000,
      currentYearLimitCents: 10_000_000,
      foundingYearLimitCents: 2_500_000,
      warnAtBp: [8000, 9500],
    });
    expect(lookupRule(KLEINUNTERNEHMER_LIMITS, d("2024-12-31")).ok).toBe(false);
  });

  test("UST-14 Kleinbetragsrechnung: 250,00 € allowed, 250,01 € not (§ 33 UStDV, since 2017; 150 € before)", () => {
    const at = (cents: number, date: string) => {
      const r = isWithinKleinbetragLimit(cents, d(date));
      return r.ok ? r.value : r.error.code;
    };
    expect(at(25_000, "2026-10-12")).toBe(true);
    expect(at(25_001, "2026-10-12")).toBe(false);
    expect(at(15_000, "2016-12-31")).toBe(true);
    expect(at(15_001, "2016-12-31")).toBe(false);
    expect(at(20_000, "2017-01-01")).toBe(true);
    expect(at(100, "2006-12-31")).toBe("rule_missing");
    expect(KLEINBETRAG_LIMIT.entries.every((e) => e.source.includes("§ 33 UStDV"))).toBe(true);
  });
});

describe("mandatory note texts (F04 App. B)", () => {
  test("SET-036 the KU note is the rule row ku_note_19 with the KU-02 default text", () => {
    const r = lookupNoteText("ku_note_19", d("2026-10-12"));
    expect(r.ok && r.value).toMatchObject({
      rowId: "ku_note_19@2025-01-01",
      value: {
        de: "Steuerfreie Leistung gemäß § 19 Abs. 1 UStG (Kleinunternehmerregelung).",
        en: "VAT-exempt supply under Section 19 (1) German VAT Act (small business scheme).",
      },
    });
  });

  test("UST-13 the Ist-Versteuerer note applies only from 2028-01-01 (2027-12-31 → none)", () => {
    expect(lookupNoteText("ist_2028", d("2027-12-31")).ok).toBe(false);
    const r = lookupNoteText("ist_2028", d("2028-01-01"));
    expect(r.ok && r.value.value.de).toBe("Versteuerung nach vereinnahmten Entgelten.");
  });

  test("UST-10 every non-standard category note exists as a versioned row with German and English text", () => {
    for (const id of ["rc_eu", "igl", "export", "o_3a2", "o_3a4", "rc_13b", "exempt_4", "zero_pv"] as const) {
      const r = lookupNoteText(id, d("2026-10-12"));
      expect(r.ok, id).toBe(true);
      if (r.ok) {
        expect(r.value.value.de.length).toBeGreaterThan(10);
        expect(r.value.value.en.length).toBeGreaterThan(10);
      }
    }
    expect(lookupNoteText("rc_13b", d("2026-10-12")).ok && lookupNoteText("rc_13b", d("2026-10-12"))).toMatchObject({
      value: { value: { de: "Steuerschuldnerschaft des Leistungsempfängers (§ 13b Abs. 2 Nr. {nr}, Abs. 5 UStG)." } },
    });
    expect(lookupNoteText("zero_pv", d("2022-12-31")).ok).toBe(false);
    const unknown = lookupNoteText("nope" as never, d("2026-10-12"));
    expect(!unknown.ok && unknown.error.code).toBe("note_text_unknown");
    expect(NOTE_TEXT_IDS.length).toBe(Object.keys(NOTE_TEXTS).length);
  });

  test("SET-120 every shipped rule table validates at load time and cites a legal source on every row", () => {
    expect(ALL_RULE_TABLES.length).toBeGreaterThanOrEqual(5 + 4 + NOTE_TEXT_IDS.length);
    const ids = new Set<string>();
    for (const t of ALL_RULE_TABLES) {
      expect(ids.has(t.id), t.id).toBe(false);
      ids.add(t.id);
      expect(t.entries.length).toBeGreaterThan(0);
      for (const e of t.entries) expect(e.source.trim().length, `${t.id}@${e.validFrom}`).toBeGreaterThan(5);
    }
  });

  test("RI-22 a stored line rate must equal the rate valid at the supply date for its key (rate_not_valid_for_date)", () => {
    const ok = checkStoredRate("restaurant_food", d("2026-01-01"), d("2026-01-31"), { category: "S", rateBp: 700 });
    expect(ok.ok && ok.value).toBe("restaurant_food@2026-01-01");
    const wrong = checkStoredRate("restaurant_food", d("2026-01-10"), d("2026-01-10"), { category: "S", rateBp: 1900 });
    expect(!wrong.ok && wrong.error).toMatchObject({
      code: "rate_not_valid_for_date",
      message: "Der Steuersatz 19 % gilt nicht für das Leistungsdatum 10.01.2026 (richtig: 7 %).",
    });
    const wrongCategory = checkStoredRate("zero", d("2026-01-10"), d("2026-01-10"), { category: "E", rateBp: 0 });
    expect(!wrongCategory.ok && wrongCategory.error.code).toBe("rate_not_valid_for_date");
    const crossing = checkStoredRate("restaurant_food", d("2025-12-15"), d("2026-01-15"), {
      category: "S",
      rateBp: 700,
    });
    expect(!crossing.ok && crossing.error.code).toBe("rule_changes_in_period");
  });
});
