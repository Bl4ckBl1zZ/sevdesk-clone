import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT } from "./test.setup";

/** F01 §4.4/§4.12 settings monitors and system tools (SET-040, SET-124, SET-133, SET-134, SET-136). */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SET-040 settings.thresholdMonitor", () => {
  test("SET-040 turnover from finalised invoices of the year, prior year from the stored figure, profit unknown without an EÜR — warning only", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, {
        supplyDate: { kind: "date", date: "2026-10-09" as CalendarDate },
        lines: [
          {
            kind: "item",
            productType: "service",
            name: "Rahmenvertrag 2026",
            quantityMilli: 1_000,
            unitCode: "C62",
            unitPriceMicros: 6_600_000_000, // 660 000,00 € net
            vatRateKey: "standard",
          },
        ],
      }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);

    const m = await owner.query(api.settings.thresholdMonitor, {});
    expect(m.blocking).toBe(false);
    expect(m.bars).toEqual([
      // setupInvoicing stores 120 000,00 € as the 2025 Gesamtumsatz (SET-043)
      {
        key: "turnover_prior_year",
        year: 2025,
        amountCents: 12_000_000,
        limitCents: 80_000_000,
        bp: 1500,
        level: "ok",
      },
      {
        key: "turnover_current_year",
        year: 2026,
        amountCents: 66_000_000,
        limitCents: 80_000_000,
        bp: 8250,
        level: "warn_80",
      },
      { key: "profit_prior_year", year: 2025, amountCents: null, limitCents: 8_000_000, bp: 0, level: "unknown" },
    ]);

    // a stored prior-year figure above 800 000 € → § 141 AO info notice (never blocking)
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        { priorYearTotalTurnoverCents: [{ year: 2025, amountCents: 85_000_000 }] },
        { action: "settings.tax.update" },
      ),
    );
    const crossed = await owner.query(api.settings.thresholdMonitor, {});
    expect(crossed.bars[0]?.level).toBe("exceeded");
    expect(crossed.notices.map((n) => n.code)).toContain("bookkeeping_duty_info");
    expect(crossed.blocking).toBe(false);
  });

  test("SET-040 viewers may read the monitor; auditors may not (settings.read)", async () => {
    const t = makeT();
    await setupInvoicing(t);
    const viewer = await t.asUser("viewer");
    expect((await viewer.query(api.settings.thresholdMonitor, {})).bars).toHaveLength(3);
    const auditor = await t.asUser("auditor");
    await expect(auditor.query(api.settings.thresholdMonitor, {})).rejects.toThrow();
  });
});
