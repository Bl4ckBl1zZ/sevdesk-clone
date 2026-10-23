import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api, internal } from "./_generated/api";
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

describe("SET-124 rules.freshness cron", () => {
  test("SET-124 notifies duplicate overrides and contradicted overrides (listing the documents that used them); skips under IS_TEST", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t, { seller: "ku" });
    // duplicate of the shipped Basiszinssatz row 2026-07-01 (1,52 %)
    const { id: dup } = await owner.mutation(api.settings.addRuleOverride, {
      values: {
        ruleSet: "basiszinssatz",
        tableId: "basiszinssatz",
        rate: "1,52",
        validFrom: "2026-07-01",
        validTo: "2026-12-31",
        source: "https://www.bundesbank.de/basiszinssatz",
      },
    });
    // own KU note text 2026 — differs from the shipped text, used by a finalised invoice
    const { id: own } = await owner.mutation(api.settings.addRuleOverride, {
      values: {
        ruleSet: "noteText",
        tableId: "ku_note_19",
        de: "Gemäß § 19 Abs. 1 UStG wird keine Umsatzsteuer berechnet.",
        en: "No VAT is charged under Section 19 (1) UStG.",
        validFrom: "2026-01-01",
        validTo: "2026-12-31",
        source: "Eigene Formulierung (SET-036)",
      },
    });
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const { number } = await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);

    expect(await t.mutation(internal.settings.rulesFreshnessCron, {})).toBeNull();
    const findings = await t.mutation(internal.settings.rulesFreshnessCron, { force: true });
    expect(findings?.map((f) => [f.code, f.overrideId])).toEqual(
      expect.arrayContaining([
        ["override_duplicates_shipped", dup],
        ["override_differs_from_shipped", own],
      ]),
    );
    const stale = () =>
      t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.kind === "rules.stale"));
    const notes = await stale();
    expect(notes.find((n) => n.entity?.id === dup)?.body).toContain(
      "Ihre Überschreibung entspricht der ausgelieferten Regel — entfernen?",
    );
    expect(notes.find((n) => n.entity?.id === own)?.body).toContain(
      `Mit der Überschreibung fertiggestellt: ${number}.`,
    );
    expect(notes.every((n) => n.link === "/einstellungen/regeln")).toBe(true);
    // weekly re-run while open: the same notifications are counted up (NTF-006), not duplicated
    await t.mutation(internal.settings.rulesFreshnessCron, { force: true });
    expect(await stale()).toHaveLength(notes.length);
  });
});

describe("SET-133 integrity.runNow", () => {
  test("SET-133 the owner runs integrity.verify on demand (recorded as a full run), at most once per 10 minutes", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const runs = () => t.run((ctx) => ctx.db.query("integrityRuns").collect());
    const before = (await runs()).length;

    expect(await owner.action(api.integrity.runNow, {})).toMatchObject({ ok: true, findings: 0 });
    const after = await runs();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ scope: "full", ok: true });

    const second = await owner.action(api.integrity.runNow, {}).then(
      () => null,
      (e: { data?: Record<string, unknown> }) => e.data,
    );
    expect(second).toMatchObject({ code: "conflict", reason: "RATE_LIMITED" });
    expect(String(second?.message)).toContain("Die Integritätsprüfung wurde gerade erst ausgeführt.");
    expect(await runs()).toHaveLength(before + 1);

    vi.setSystemTime(new Date(NOW.getTime() + 10 * 60_000 + 1_000));
    expect(await owner.action(api.integrity.runNow, {})).toMatchObject({ ok: true });
    expect(await runs()).toHaveLength(before + 2);
  });

  test("SET-133 only the owner may trigger it (settings.write)", async () => {
    const t = makeT();
    await setupInvoicing(t);
    const bookkeeper = await t.asUser("bookkeeper");
    await expect(bookkeeper.action(api.integrity.runNow, {})).rejects.toThrow();
  });
});
