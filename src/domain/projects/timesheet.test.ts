import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { buildTimesheet, type TimesheetEntry } from "./timesheet";

const d = calendarDate;
const e = (date: string, minutes: number, description: string, roundedMinutes?: number): TimesheetEntry => ({
  date: d(date),
  description,
  durationMinutes: minutes,
  ...(roundedMinutes !== undefined ? { roundedMinutes } : {}),
  hourlyRateMicros: 900_000,
});

describe("PRJ-014 timesheet (Leistungsnachweis)", () => {
  test("PRJ-014 TST-PRJ-14 the table lists the frozen entries (date, description, duration, rounded, rate, amount) with invoice number and period", () => {
    const m = buildTimesheet({
      invoiceNumber: "RE-2026-0042",
      documentDate: d("2026-10-12"),
      sellerName: "Muster GmbH",
      customerName: "Beispiel AG",
      projectLabel: "PRJ-00001 Website",
      entries: [e("2026-10-02", 50, "Abstimmung", 60), e("2026-10-01", 120, "Workshop", 120)],
      createdAt: Date.UTC(2026, 9, 12, 10),
    });
    expect(m.title).toBe("Leistungsnachweis zur Rechnung RE-2026-0042");
    expect(m.subtitle).toBe("Muster GmbH · Kunde: Beispiel AG · Leistungszeitraum 01.10.–02.10.2026");
    expect(m.fileName).toBe("Leistungsnachweis_RE-2026-0042.pdf");
    expect(m.sections[0]?.paragraphs).toEqual([
      "Rechnung RE-2026-0042 vom 12.10.2026",
      "Leistungszeitraum: 01.10.–02.10.2026",
      "Projekt: PRJ-00001 Website",
      "2 Zeiteinträge",
    ]);
    const table = m.sections[1]?.table;
    expect(table?.headers).toEqual(["Datum", "Tätigkeit", "Dauer", "Abgerechnet", "Satz", "Betrag"]);
    expect(table?.rows.map((r) => r.join(" | ").replace(/\s/g, " "))).toEqual([
      "01.10.2026 | Workshop | 2:00 h | 2:00 h | 90,00 €/h | 180,00 €",
      "02.10.2026 | Abstimmung | 0:50 h | 1:00 h | 90,00 €/h | 90,00 €",
      " | Summe | 2:50 h | 3:00 h |  | 270,00 €",
    ]);
    expect(m.totals).toEqual({ minutes: 170, roundedMinutes: 180, amountCents: 27_000 });
    expect(table?.widths.reduce((s, w) => s + w, 0)).toBe(100);
  });

  test("PRJ-014 without rates: date, description and durations only; per-group rounding falls back to the raw duration", () => {
    const m = buildTimesheet({
      invoiceNumber: "RE/2026/7",
      documentDate: d("2026-10-12"),
      sellerName: "Muster GmbH",
      customerName: "Beispiel AG",
      entries: [e("2026-10-05", 45, "Support")],
      showRates: false,
      createdAt: 0,
    });
    expect(m.fileName).toBe("Leistungsnachweis_RE_2026_7.pdf");
    expect(m.sections[1]?.table?.headers).toEqual(["Datum", "Tätigkeit", "Dauer", "Abgerechnet"]);
    expect(m.sections[1]?.table?.rows[0]).toEqual(["05.10.2026", "Support", "0:45 h", "0:45 h"]);
    expect(m.subtitle).toContain("Leistungszeitraum 05.10.2026");
  });
});
