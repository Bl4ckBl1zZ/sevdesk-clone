import { describe, expect, test } from "vitest";
import { recurringTemplateSchema } from "../schemas/recurring";
import { calendarDate } from "../time/calendar-date";
import {
  fillRecurringPlaceholders,
  kuChangeIn,
  occurrenceDraft,
  rateChangeDates,
  rateHints,
  splitAtRateChanges,
  type TemplateDraft,
} from "./generate";

const d = (s: string) => calendarDate(s);

const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  type: "invoice",
  contactId: "c1",
  currency: "EUR",
  priceMode: "net",
  paymentTerms: { dueDays: 14 },
  showEpcQr: true,
  language: "de",
  lines: [
    {
      kind: "item",
      productType: "service",
      name: "Wartungspauschale",
      quantityMilli: 1000,
      unitCode: "C62",
      unitPriceMicros: 5_000_000,
      vatRateKey: "standard",
    },
  ],
  ...over,
});

const NOV = { from: d("2026-11-01"), to: d("2026-11-30") };

describe("REC-04/09 occurrence draft", () => {
  test("REC-04 REC-09 T-REC-001 supply period = billing period, BT-12 = template name, period line in the head text", () => {
    const r = occurrenceDraft({
      draft: draft({ headText: "Vielen Dank für Ihren Auftrag." }),
      templateName: "Wartungsvertrag Müller",
      period: NOV,
      periodTextEnabled: true,
      kleinunternehmer: [{ validFrom: "2020-01-01", isKU: false }],
    });
    expect(r.values.supplyDate).toEqual({ kind: "period", from: "2026-11-01", to: "2026-11-30" });
    expect(r.values.supplyDateMode).toBe("explicit");
    expect(r.values.contractReference).toBe("Wartungsvertrag Müller");
    expect(r.values.headText).toBe(
      "Berechnung für den Zeitraum vom 01.11.2026 bis 30.11.2026\n\nVielen Dank für Ihren Auftrag.",
    );
    expect(r.values.documentDate).toBeUndefined();
    expect(r.needsReview).toBe(false);
  });

  test("REC-09 the template contract reference wins over the name; placeholders are filled, no duplicate line", () => {
    const r = occurrenceDraft({
      draft: draft({
        headText: "{{recurring.periodText}}.",
        subject: "Wartung {{recurring.periodFrom}}–{{recurring.periodTo}}",
      }),
      templateName: "Wartung",
      contractReference: "V-2026-17",
      period: NOV,
      periodTextEnabled: true,
      kleinunternehmer: [],
    });
    expect(r.values.contractReference).toBe("V-2026-17");
    expect(r.values.headText).toBe("Berechnung für den Zeitraum vom 01.11.2026 bis 30.11.2026.");
    expect(r.values.subject).toBe("Wartung 01.11.2026–30.11.2026");
  });

  test("REC-04 without the period switch the head text stays as entered", () => {
    const r = occurrenceDraft({
      draft: draft(),
      templateName: "X",
      period: NOV,
      periodTextEnabled: false,
      kleinunternehmer: [],
    });
    expect(r.values.headText).toBeUndefined();
    expect(fillRecurringPlaceholders("{{ recurring.periodTo }}", NOV, "de")).toBe("30.11.2026");
  });
});

describe("REC-15 rate-change and KU boundaries", () => {
  // restaurant_food: 19 % until 31.12.2025, 7 % from 01.01.2026 (StÄndG 2025)
  const crossing = { from: d("2025-12-15"), to: d("2026-01-14") };

  test("REC-15 EC-094 T-EC-094 a period across a rate change splits the line pro rata by days (17 + 14 days)", () => {
    expect(rateChangeDates("restaurant_food", crossing)).toEqual(["2026-01-01"]);
    expect(rateChangeDates("standard", crossing)).toEqual([]);
    const lines = draft({
      lines: [
        { kind: "heading", name: "Catering" },
        {
          kind: "item",
          name: "Kantinenverpflegung",
          quantityMilli: 31_000,
          unitCode: "DAY",
          unitPriceMicros: 200_000,
          vatRateKey: "restaurant_food",
        },
        { kind: "item", name: "Getränke", quantityMilli: 1000, unitPriceMicros: 100_000, vatRateKey: "standard" },
      ],
    }).lines;
    const r = splitAtRateChanges(lines, crossing);
    expect(r.boundaries).toEqual(["2026-01-01"]);
    expect(r.lines).toHaveLength(4);
    expect(r.lines[1]).toMatchObject({ quantityMilli: 17_000, linePeriod: { from: "2025-12-15", to: "2025-12-31" } });
    expect(r.lines[2]).toMatchObject({ quantityMilli: 14_000, linePeriod: { from: "2026-01-01", to: "2026-01-14" } });
    expect(r.lines[3]).toEqual(lines[2]);
  });

  test("REC-15 pro-rata quantities always sum to the original (residual to the longest segment)", () => {
    const r = splitAtRateChanges(
      [{ kind: "item", name: "Pauschale", quantityMilli: 1000, vatRateKey: "restaurant_food" }],
      crossing,
    );
    expect(r.lines.map((l) => l.quantityMilli)).toEqual([549, 451]);
    expect(r.lines.reduce((a, l) => a + (l.quantityMilli ?? 0), 0)).toBe(1000);
  });

  test("REC-15 KU-01 a Kleinunternehmer change inside the period is reported (no line split possible)", () => {
    const history = [
      { validFrom: "2020-01-01", isKU: true },
      { validFrom: "2026-11-15", isKU: false },
    ];
    expect(kuChangeIn(history, NOV)).toBe("2026-11-15");
    expect(kuChangeIn(history, { from: d("2026-12-01"), to: d("2026-12-31") })).toBeNull();
    const r = occurrenceDraft({
      draft: draft(),
      templateName: "X",
      period: NOV,
      periodTextEnabled: false,
      kleinunternehmer: history,
    });
    expect(r.kuChange).toBe("2026-11-15");
    expect(r.needsReview).toBe(true);
  });

  test("REC-13 rate hint for a preview period across a change", () => {
    expect(rateHints(draft({ lines: [{ kind: "item", vatRateKey: "restaurant_food" }] }), crossing)).toEqual([
      "Steuersatzänderung am 01.01.2026 – Positionen werden aufgeteilt, Entwurf zur Prüfung",
    ]);
    expect(rateHints(draft(), NOV)).toEqual([]);
  });
});

describe("REC-16 template schema", () => {
  const body = {
    name: "Wartung",
    draft: draft(),
    schedule: { interval: "P1M", firstDate: "2026-11-01", billing: "in_advance", periodTextEnabled: true },
    automation: { finalize: true },
  };

  test("REC-16 T-REC-011 automation is { finalize } only: a send field is rejected", () => {
    expect(recurringTemplateSchema.safeParse(body).success).toBe(true);
    const r = recurringTemplateSchema.safeParse({ ...body, automation: { finalize: true, send: true } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.code).toBe("unrecognized_keys");
  });

  test("REC-03 an end date before the first invoice is rejected", () => {
    const r = recurringTemplateSchema.safeParse({ ...body, schedule: { ...body.schedule, endDate: "2026-10-01" } });
    expect(r.success).toBe(false);
  });
});
