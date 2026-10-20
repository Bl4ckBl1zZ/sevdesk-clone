import { describe, expect, test } from "vitest";
import type { RuleOverride } from "../rules/rule-table";
import { lookupVatRate, type VatRateValue } from "../rules/vat-rates";
import { type CalendarDate, calendarDate } from "../time/calendar-date";
import {
  type BillableEntry,
  checkSelection,
  checkSupplyCoversEntries,
  exactTimeNetCents,
  planTimeInvoice,
  rateMissingMessage,
  selectableForInvoicing,
  timeQuantity,
} from "./invoicing";
import { hourlyFromUnitPrice, RATE_SOURCE_LABELS, resolveHourlyRate, roundingLabel, roundMinutes } from "./rates";

const d = calendarDate;
const RATE_90 = 900_000; // 90,00 €/h in micros

const entry = (id: string, date: string, minutes: number, over: Partial<BillableEntry> = {}): BillableEntry => ({
  id,
  date: d(date),
  durationMinutes: minutes,
  description: `Konzeption ${id}`,
  contactId: "c1",
  currency: "EUR",
  hourlyRateMicros: RATE_90,
  vatRateKey: "standard",
  billable: true,
  status: "open",
  ...over,
});

describe("PRJ-008 rate resolution", () => {
  test("PRJ-008 TST-PRJ-05 chain: override → project → customer price → product → default", () => {
    const all = { overrideMicros: 1, projectMicros: 2, customerPriceMicros: 3, productMicros: 4, defaultMicros: 5 };
    expect(resolveHourlyRate(all)).toEqual({ hourlyRateMicros: 1, source: "override" });
    expect(resolveHourlyRate({ ...all, overrideMicros: undefined })?.source).toBe("project");
    expect(resolveHourlyRate({ customerPriceMicros: 3, productMicros: 4, defaultMicros: 5 })?.source).toBe(
      "customer_price",
    );
    expect(resolveHourlyRate({ productMicros: 4, defaultMicros: 5 })?.source).toBe("product");
    expect(resolveHourlyRate({ defaultMicros: 5 })).toEqual({ hourlyRateMicros: 5, source: "default" });
    expect(resolveHourlyRate({})).toBeNull();
    expect(resolveHourlyRate({ overrideMicros: -1, projectMicros: 0 })?.source).toBe("project");
    expect(RATE_SOURCE_LABELS.customer_price).toBe("Kundenpreis");
  });

  test("PRJ-008 product prices per hour or per minute become hourly rates; other units do not apply", () => {
    expect(hourlyFromUnitPrice("HUR", 950_000)).toBe(950_000);
    expect(hourlyFromUnitPrice("MIN", 15_000)).toBe(900_000);
    expect(hourlyFromUnitPrice("C62", 15_000)).toBeUndefined();
  });
});

describe("PRJ-009 rounding rules", () => {
  test("PRJ-009 TST-PRJ-06 15 min up on 7, 16, 31 min → 15, 30, 45; raw durations unchanged", () => {
    const rule = { incrementMinutes: 15, mode: "up" } as const;
    const raw = [7, 16, 31];
    expect(raw.map((m) => roundMinutes(m, rule))).toEqual([15, 30, 45]);
    expect(raw).toEqual([7, 16, 31]);
    const plan = planTimeInvoice(
      raw.map((m, i) => entry(`e${i}`, `2026-09-0${i + 1}`, m)),
      { grouping: "per_entry", rounding: rule },
    );
    expect(plan.ok && plan.value.roundedByEntry).toEqual({ e0: 15, e1: 30, e2: 45 });
    expect(plan.ok && plan.value.lines.map((l) => l.rawMinutes)).toEqual([7, 16, 31]);
    expect(plan.ok && plan.value.rounding).toEqual({ incrementMinutes: 15, mode: "up", perGroup: false });
  });

  test("PRJ-009 nearest (half up), minimum per entry, none, and per-group rounding", () => {
    const nearest = { incrementMinutes: 15, mode: "nearest" } as const;
    expect([7, 8, 22, 23].map((m) => roundMinutes(m, nearest))).toEqual([0, 15, 15, 30]);
    expect(roundMinutes(5, { incrementMinutes: 0, mode: "up", minimumMinutes: 15 })).toBe(15);
    expect(roundMinutes(0, { incrementMinutes: 0, mode: "up", minimumMinutes: 15 })).toBe(0);
    expect(roundMinutes(17)).toBe(17);
    const perGroup = planTimeInvoice([entry("a", "2026-09-01", 7), entry("b", "2026-09-02", 7)], {
      grouping: "per_product_rate",
      rounding: { incrementMinutes: 15, mode: "up" },
      perGroup: true,
    });
    expect(perGroup.ok && perGroup.value.lines[0]?.roundedMinutes).toBe(15);
    expect(perGroup.ok && perGroup.value.roundedByEntry).toEqual({});
    expect(roundingLabel({ incrementMinutes: 0, mode: "up" })).toBe("keine Rundung");
    expect(roundingLabel({ incrementMinutes: 15, mode: "up", minimumMinutes: 15 })).toBe(
      "15-Minuten-Takt (aufrunden), mindestens 15 min",
    );
    expect(roundingLabel({ incrementMinutes: 0, mode: "nearest", minimumMinutes: 30 })).toBe(
      "keine Taktung, mindestens 30 min",
    );
    expect(roundingLabel({ incrementMinutes: 6, mode: "nearest" })).toBe("6-Minuten-Takt (kaufmännisch)");
  });
});

describe("PRJ-010/PRJ-011 invoice lines from time entries", () => {
  test("PRJ-010 TST-PRJ-07 three entries grouped per_product_rate → one HUR line of 1.500 h with the entry ids", () => {
    const es = [entry("a", "2026-09-03", 30), entry("b", "2026-09-04", 45), entry("c", "2026-09-05", 15)];
    const plan = planTimeInvoice(es, { grouping: "per_product_rate" });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.lines).toHaveLength(1);
    expect(plan.value.lines[0]).toMatchObject({
      quantityMilli: 1500,
      unitCode: "HUR",
      unitPriceMicros: RATE_90,
      netCents: 13_500,
      timeEntryIds: ["a", "b", "c"],
      linePeriod: { from: "2026-09-03", to: "2026-09-05" },
      name: "Arbeitszeit 03.09.–05.09.2026",
      description: "Konzeption a\nKonzeption b\nKonzeption c",
    });
  });

  test("PRJ-010 groupings per_entry, per_day and summary; product name and id carried", () => {
    const es = [
      entry("a", "2026-09-03", 60, { productId: "p1", productName: "Beratung Webdesign" }),
      entry("b", "2026-09-03", 30, { productId: "p1", productName: "Beratung Webdesign", description: "Konzeption a" }),
      entry("c", "2026-09-04", 30, { productId: "p1", productName: "Beratung Webdesign" }),
    ];
    const perEntry = planTimeInvoice(es, { grouping: "per_entry" });
    expect(perEntry.ok && perEntry.value.lines.map((l) => l.name)).toEqual([
      "03.09.2026: Konzeption a",
      "03.09.2026: Konzeption a",
      "04.09.2026: Konzeption c",
    ]);
    const perDay = planTimeInvoice(es, { grouping: "per_day" });
    expect(perDay.ok && perDay.value.lines.map((l) => [l.name, l.quantityMilli, l.description])).toEqual([
      ["Leistungen am 03.09.2026", 1500, "Konzeption a"],
      ["Leistungen am 04.09.2026", 500, "Konzeption c"],
    ]);
    const byProduct = planTimeInvoice(es, { grouping: "per_product_rate" });
    expect(byProduct.ok && byProduct.value.lines[0]).toMatchObject({ name: "Beratung Webdesign", productId: "p1" });
    const summary = planTimeInvoice([...es, entry("d", "2026-09-28", 60, { productId: "p2" })], {
      grouping: "summary",
    });
    expect(summary.ok && summary.value.lines.map((l) => [l.name, l.quantityMilli, l.productId])).toEqual([
      ["Leistungen lt. Leistungsnachweis 03.09.–28.09.2026", 3000, undefined],
    ]);
  });

  test("PRJ-011 TST-PRJ-08 E-PRJ-17 10 min at 90 €/h: 15,03 € on 0,167 h vs exact 15,00 €; unit MIN yields 15,00 €", () => {
    const hours = planTimeInvoice([entry("a", "2026-09-03", 10)], { grouping: "per_entry" });
    expect(hours.ok && hours.value.lines[0]).toMatchObject({ quantityMilli: 167, netCents: 1503, exactNetCents: 1500 });
    expect(hours.ok && hours.value.notices).toEqual([
      "10 Minuten ergeben 0,167 Stunden (gerundet). Abweichung: 0,03 €. Einheit „Minute“ verwenden?",
    ]);
    const mins = planTimeInvoice([entry("a", "2026-09-03", 10)], { grouping: "per_entry", unit: "MIN" });
    expect(mins.ok && mins.value.lines[0]).toMatchObject({
      unitCode: "MIN",
      quantityMilli: 10_000,
      unitPriceMicros: 15_000,
      netCents: 1500,
    });
    expect(mins.ok && mins.value.notices).toEqual([]);
    expect(timeQuantity(90, RATE_90)).toEqual({ quantityMilli: 1500, unitPriceMicros: RATE_90 });
    expect(exactTimeNetCents(10, RATE_90)).toBe(1500);
  });

  test("PRJ-010 E-PRJ-12/13/23 TST-PRJ-22 blocked selections; locked and incomplete entries are refused", () => {
    expect(checkSelection([])?.code).toBe("time_entries_empty");
    expect(
      checkSelection([entry("a", "2026-09-01", 60), entry("b", "2026-09-01", 60, { contactId: "c2" })])?.message,
    ).toBe("Zeiten verschiedener Kunden können nicht in einer Rechnung abgerechnet werden.");
    expect(checkSelection([entry("a", "2026-09-01", 60)], { contactId: "c2", currency: "EUR" })?.code).toBe(
      "time_entries_contacts",
    );
    expect(
      checkSelection([entry("a", "2026-09-01", 60), entry("b", "2026-09-01", 60, { currency: "USD" })])?.message,
    ).toBe("Die ausgewählten Zeiten haben unterschiedliche Währungen.");
    expect(checkSelection([entry("a", "2026-09-01", 60)], { contactId: "c1", currency: "USD" })?.code).toBe(
      "time_entries_currency",
    );
    expect(checkSelection([entry("a", "2026-09-01", 60, { hourlyRateMicros: 0 })])?.message).toBe(
      rateMissingMessage(1),
    );
    expect(rateMissingMessage(2)).toBe("Für 2 Einträge ist kein Stundensatz hinterlegt.");
    expect(checkSelection([entry("a", "2026-09-01", 60, { status: "in_draft", documentLabel: "Entwurf" })])?.code).toBe(
      "time_entry_locked",
    );
    expect(
      checkSelection([entry("a", "2026-09-01", 60, { status: "invoiced", documentLabel: "RE-2026-0001" })])?.message,
    ).toContain("RE-2026-0001");
    expect(checkSelection([entry("a", "2026-09-01", 60, { incomplete: true })])?.code).toBe("time_entry_incomplete");
    const p = planTimeInvoice([entry("a", "2026-09-01", 60, { contactId: undefined })], { grouping: "summary" });
    expect(p.ok && p.value.contactId).toBeUndefined();
    expect(planTimeInvoice([], { grouping: "summary" }).ok).toBe(false);
  });

  test("PRJ-016 non-billable entries are excluded from the selection by default, included on request", () => {
    const es = [
      entry("a", "2026-09-01", 60),
      entry("b", "2026-09-01", 60, { billable: false }),
      entry("c", "2026-09-01", 5, { status: "invoiced" }),
    ];
    expect(selectableForInvoicing(es).map((e) => e.id)).toEqual(["a"]);
    expect(selectableForInvoicing(es, { includeNonBillable: true }).map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("PRJ-013 supply period of an invoice from entries", () => {
  test("PRJ-013 UST-08 TST-PRJ-12 entries 03.09.–28.09.2026 → period; narrowing → E-PRJ-18; widening ok", () => {
    const es = [entry("a", "2026-09-28", 60), entry("b", "2026-09-03", 60), entry("c", "2026-09-10", 60)];
    const plan = planTimeInvoice(es, { grouping: "per_entry" });
    expect(plan.ok && plan.value.supplyDate).toEqual({ kind: "period", from: "2026-09-03", to: "2026-09-28" });
    const one = planTimeInvoice([entry("a", "2026-09-03", 60)], { grouping: "per_entry" });
    expect(one.ok && one.value.supplyDate).toEqual({ kind: "date", date: "2026-09-03" });
    const dates = es.map((e) => e.date);
    expect(checkSupplyCoversEntries({ kind: "period", from: "2026-09-05", to: "2026-09-28" }, dates)?.message).toBe(
      "Der Leistungszeitraum muss alle abgerechneten Zeiten umfassen (03.09.2026–28.09.2026).",
    );
    expect(checkSupplyCoversEntries({ kind: "month", month: "2026-09" }, dates)).toBeNull();
    expect(checkSupplyCoversEntries({ kind: "period", from: "2026-09-01", to: "2026-09-30" }, dates)).toBeNull();
    expect(checkSupplyCoversEntries({ kind: "date", date: "2026-09-03" }, dates)?.code).toBe(
      "supply_period_too_narrow",
    );
    expect(checkSupplyCoversEntries(undefined, dates)?.code).toBe("supply_period_too_narrow");
    expect(checkSupplyCoversEntries(undefined, [])).toBeNull();
  });

  test("PRJ-013 EC-024 UST-15 TST-PRJ-13 entries spanning a (simulated) rate change on 2027-07-01 split into two lines", () => {
    const overrides: RuleOverride<VatRateValue>[] = [
      { id: "sim", validFrom: d("2027-07-01"), value: { category: "S", rateBp: 2100 }, source: "Simulation" },
    ];
    const vatRowOf = (key: string, date: CalendarDate) => {
      const r = lookupVatRate(key, date, overrides);
      return r.ok ? { rowId: r.value.rowId, validFrom: r.value.validFrom } : null;
    };
    const es = [entry("a", "2027-06-29", 60), entry("b", "2027-06-30", 60), entry("c", "2027-07-02", 120)];
    const plan = planTimeInvoice(es, { grouping: "summary", vatRowOf });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.lines.map((l) => [l.linePeriod, l.quantityMilli, l.timeEntryIds])).toEqual([
      [{ from: "2027-06-29", to: "2027-06-30" }, 2000, ["a", "b"]],
      [{ from: "2027-07-02", to: "2027-07-02" }, 2000, ["c"]],
    ]);
    expect(plan.value.notices[0]).toBe(
      "Wegen Steuersatzänderung am 01.07.2027 wurden die Zeiten auf zwei Positionen aufgeteilt.",
    );
    expect(plan.value.supplyDate).toEqual({ kind: "period", from: "2027-06-29", to: "2027-07-02" });
  });
});
