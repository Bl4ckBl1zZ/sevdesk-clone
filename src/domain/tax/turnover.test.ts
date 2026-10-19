import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import {
  eightHundredKMonitor,
  gesamtumsatzContribution,
  gesamtumsatzOfYear,
  kuMonitor,
  ossBlock,
  ossRelevantNetCents,
  type TurnoverDoc,
} from "./turnover";

const D = (d: string) => d as CalendarDate;
/** formatEuro uses a no-break space before „€“. */
const nb = (s: string) => s.replace(/\u00a0/g, " ");
const doc = (over: Partial<TurnoverDoc> = {}): TurnoverDoc => ({
  type: "invoice",
  status: "finalized",
  documentDate: "2026-10-12",
  supplyEnd: "2026-10-09",
  netCents: 100_000,
  currency: "EUR",
  ...over,
});

describe("Gesamtumsatz (TAX-012, KU-01, DOC-56)", () => {
  test("DOC-56 TAX-012 net EUR per supply year: FX converted, Storno/credit negative, finals without their advances", () => {
    expect(gesamtumsatzContribution(doc({ currency: "USD", netCents: 108_310, fxRateToEur: { rate: "1.0831" } }))).toBe(
      100_000,
    );
    expect(gesamtumsatzContribution(doc({ status: "draft" }))).toBe(0);
    expect(gesamtumsatzContribution(doc({ type: "quote" }))).toBe(0);
    expect(gesamtumsatzContribution(doc({ type: "cancellation", netCents: -100_000 }))).toBe(-100_000);
    expect(gesamtumsatzContribution(doc({ type: "final_invoice", netCents: 500_000, deductedNetCents: 200_000 }))).toBe(
      300_000,
    );
    const docs = [
      doc(),
      doc({ type: "advance_invoice", netCents: 200_000 }),
      doc({ type: "final_invoice", netCents: 500_000, deductedNetCents: 200_000 }),
      // supplied in December 2025, invoiced in January 2026 → turnover of 2025
      doc({ supplyEnd: "2025-12-20", documentDate: "2026-01-05", netCents: 40_000 }),
      // a cancelled original still counts; its Storno takes it out again
      doc({ status: "cancelled", netCents: 70_000 }),
      doc({ type: "cancellation", netCents: -70_000 }),
    ];
    expect(gesamtumsatzOfYear(docs, 2026)).toBe(600_000);
    expect(gesamtumsatzOfYear(docs, 2025)).toBe(40_000);
  });

  test("TAX-012 KU-01 monitor bars: 80 % and 95 % warnings of 25 000 € (prior year) and 100 000 € (current year)", () => {
    const [prior, current] = kuMonitor({
      today: D("2026-10-12"),
      priorYearCents: 2_000_000,
      currentYearCents: 9_500_000,
    });
    expect(prior).toMatchObject({
      key: "ku_prior_year",
      year: 2025,
      limitCents: 2_500_000,
      bp: 8000,
      level: "warn_80",
    });
    expect(current).toMatchObject({ key: "ku_current_year", year: 2026, limitCents: 10_000_000, level: "warn_95" });
    expect(kuMonitor({ today: D("2026-10-12"), priorYearCents: 0, currentYearCents: 10_000_001 })[1]?.level).toBe(
      "exceeded",
    );
    expect(kuMonitor({ today: D("2026-10-12"), priorYearCents: 0, currentYearCents: 10_000_000 })[1]?.level).toBe(
      "warn_95",
    );
    // founding year: 25 000 € hard cap (EC-066)
    const founding = kuMonitor({
      today: D("2026-10-12"),
      priorYearCents: 0,
      currentYearCents: 2_500_001,
      foundedOn: "2026-03-01",
    });
    expect(founding[1]).toMatchObject({ limitCents: 2_500_000, level: "exceeded" });
  });
});

describe("OSS threshold (UVA-07, TAX-017, EC-057)", () => {
  const consumerAt = { isConsumer: true, countryCode: "AT" };
  const date = D("2026-10-12");

  test("TAX-017 only B2C distance sales of goods and electronic services into another EU state count", () => {
    const lines = [
      { productType: "good" as const, netEurCents: 30_000 },
      { productType: "service" as const, placeOfSupplyRule: "electronic", netEurCents: 20_000 },
      { productType: "service" as const, placeOfSupplyRule: "general", netEurCents: 50_000 },
    ];
    expect(ossRelevantNetCents({ buyer: consumerAt, lines, date })).toBe(50_000);
    // German consumer, business buyer, valid VAT ID, non-EU consumer → nothing counts
    expect(ossRelevantNetCents({ buyer: { isConsumer: true, countryCode: "DE" }, lines, date })).toBe(0);
    expect(ossRelevantNetCents({ buyer: { isConsumer: false, countryCode: "AT" }, lines, date })).toBe(0);
    expect(ossRelevantNetCents({ buyer: { ...consumerAt, hasValidVatId: true }, lines, date })).toBe(0);
    expect(ossRelevantNetCents({ buyer: { isConsumer: true, countryCode: "CH" }, lines, date })).toBe(0);
    // goods follow the delivery address: a German consumer receiving goods in France counts, French goods to DE not
    expect(
      ossRelevantNetCents({ buyer: { isConsumer: true, countryCode: "DE" }, deliveryCountry: "FR", lines, date }),
    ).toBe(30_000);
    expect(ossRelevantNetCents({ buyer: consumerAt, deliveryCountry: "DE", lines, date })).toBe(20_000);
  });

  test("UVA-07 EC-057 boundary: 10 000,00 € passes, 10 000,01 € is blocked; once the prior year exceeded, every one", () => {
    expect(ossBlock({ thisNetEurCents: 100_000, priorYearEurCents: 0, currentYearEurCents: 900_000, date })).toBeNull();
    const over = ossBlock({ thisNetEurCents: 100_001, priorYearEurCents: 0, currentYearEurCents: 900_000, date });
    if (over) Object.assign(over, { message: nb(over.message) });
    expect(over).toMatchObject({
      code: "oss_threshold_exceeded",
      message:
        "Ihre EU-Fernverkäufe an Privatkunden überschreiten 10.000,00 €. Das OSS-Verfahren wird erst in einer späteren Version unterstützt; diese Rechnung kann nicht mit deutscher Umsatzsteuer ausgestellt werden.",
    });
    expect(ossBlock({ thisNetEurCents: 1, priorYearEurCents: 1_000_001, currentYearEurCents: 0, date })?.code).toBe(
      "oss_threshold_exceeded",
    );
    // documents without OSS-relevant sales are never blocked
    expect(
      ossBlock({ thisNetEurCents: 0, priorYearEurCents: 5_000_000, currentYearEurCents: 5_000_000, date }),
    ).toBeNull();
  });
});

describe("800k monitors (TAX-013, AO-01, ER-03, UVA-06)", () => {
  const base = {
    today: D("2026-10-12"),
    priorYearCents: 0,
    currentYearCents: 0,
    taxationMethod: "soll" as const,
    bookkeepingDuty: false,
  };

  test("TAX-013 (a) § 141 AO info, (b) ER-03 for 2027, (c) § 20 UStG Ist limit — boundaries at 800 000,00 €", () => {
    expect(eightHundredKMonitor({ ...base, priorYearCents: 80_000_000 })).toEqual([]);
    const a = eightHundredKMonitor({ ...base, priorYearCents: 80_000_001 });
    expect(a.map((n) => n.code)).toEqual(["bookkeeping_duty_info"]);
    expect(a[0]?.message).toContain("Buchführungspflicht beginnt erst nach Mitteilung durch das Finanzamt");
    expect(eightHundredKMonitor({ ...base, priorYearProfitCents: 8_000_001 }).map((n) => n.code)).toEqual([
      "bookkeeping_duty_info",
    ]);
    expect(eightHundredKMonitor({ ...base, priorYearCents: 80_000_001, bookkeepingDuty: true })).toEqual([]);
    // (b) the running 2026 total decides the 2027 obligation (EC-029)
    const b = eightHundredKMonitor({ ...base, currentYearCents: 80_000_001 });
    expect(b.map((n) => n.code)).toEqual(["er03_mandatory_next_year"]);
    expect(nb(b[0]?.message ?? "")).toBe(
      "Gesamtumsatz 2026: 800.000,01 € (über 800.000,00 €). Ab 01.01.2027 müssen Sie B2B-Rechnungen im Inland als E-Rechnung ausstellen.",
    );
    // in 2027 the obligation for 2028 no longer depends on turnover (mandatory for everyone)
    expect(
      eightHundredKMonitor({ ...base, today: D("2027-05-01"), currentYearCents: 90_000_000 }).map((n) => n.code),
    ).toEqual([]);
    // (c) Ist-Versteuerung
    const c = eightHundredKMonitor({ ...base, taxationMethod: "ist", currentYearCents: 80_000_001 });
    expect(c.map((n) => n.code)).toContain("ist_limit_exceeded");
    expect(c.find((n) => n.code === "ist_limit_exceeded")?.message).toContain("ab 2027 nicht mehr zulässig");
  });
});
