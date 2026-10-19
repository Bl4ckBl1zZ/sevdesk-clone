import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { lookupRule } from "../src/domain/rules/rule-table";
import { KLEINUNTERNEHMER_LIMITS } from "../src/domain/rules/thresholds";
import type { CalendarDate } from "../src/domain/time/calendar-date";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { consumerBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { bookedTransaction } from "./payments.fixtures";
import { makeT } from "./test.setup";

/** 04 §4.7 Übersicht: `dashboard.overview` view model (DASH-001…011). */

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const KU_LINE = {
  kind: "item" as const,
  productType: "service" as const,
  name: "Fotoshooting (halber Tag)",
  quantityMilli: 2_000,
  unitCode: "E48",
  unitPriceMicros: 5_000_000,
  vatRateKey: "standard" as const,
};

describe("DASH-011 dashboard.overview", () => {
  test("DASH-003 DASH-004 DASH-005 DASH-006 DASH-007 DASH-008 DASH-009 a KU company with one partially paid invoice", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t, { seller: "ku" });
    const contactId = await consumerBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(contactId, {
        supplyDate: { kind: "date", date: "2026-10-12" as CalendarDate },
        paymentTerms: { dueDays: 14 },
        lines: [KU_LINE],
      }),
    });
    const fin = await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: bankAccount },
      date: "2026-10-12",
      amountCents: 40_000,
    });
    await bookedTransaction(t, bankAccount, {
      bookingDate: "2026-10-11",
      amountCents: 12_345,
      purpose: "Überweisung",
      counterpartyName: "Muster GmbH",
    });

    const o = await owner.query(api.dashboard.overview, {});
    expect(o.today).toBe("2026-10-12");
    // DASH-003: KU revenue posted at finalisation (journal by entry date)
    expect(o.result?.incomeCents).toBe(100_000);
    expect(o.result?.expenseCents).toBe(0);
    expect(o.result?.profitCents).toBe(100_000);
    expect(o.result?.months).toHaveLength(12);
    expect(o.result?.months.at(-1)).toMatchObject({ label: "Okt 26", incomeCents: 100_000 });
    // DASH-004
    expect(o.receivables).toMatchObject({
      totalCents: 60_000,
      overdue: { count: 0, cents: 0 },
      open: { count: 0, cents: 0 },
      partiallyPaid: { count: 1, cents: 60_000 },
      creditCents: 0,
    });
    // DASH-005: limits from the rule table, never literals
    const limits = lookupRule(KLEINUNTERNEHMER_LIMITS, "2026-10-12" as CalendarDate);
    expect(limits.ok).toBe(true);
    expect(o.ku).toMatchObject({
      year: 2026,
      turnoverCents: 100_000,
      limitCents: limits.ok ? limits.value.value.currentYearLimitCents : -1,
    });
    // DASH-006: no statement yet → balance unknown, the transaction is listed
    expect(o.bank).toMatchObject({ accountCount: 1, totalCents: 0, accountsWithoutBalance: 1 });
    expect(o.bank?.latest).toEqual([
      expect.objectContaining({ bookingDate: "2026-10-11", amountCents: 12_345, label: "Muster GmbH" }),
    ]);
    // DASH-007
    expect(o.matching).toMatchObject({ total: 1, unassigned: 1, percent: 0, level: "low" });
    // DASH-008: invoiced payable amount in the last 3 months
    expect(o.topCustomers).toEqual([{ contactId, name: expect.any(String), amountCents: 100_000 }]);
    // DASH-009
    expect(o.activity?.map((a) => a.text)).toEqual(
      expect.arrayContaining([`${fin.number} fertiggestellt`, `Zahlung zu ${fin.number} erfasst`]),
    );
    expect(o.activity?.length).toBeLessThanOrEqual(5);
    expect(JSON.stringify(o.activity)).not.toContain("@");
  });

  test("DASH-001 DASH-005 greeting from the member name; not KU → no KU card", async () => {
    const t = makeT();
    await setupInvoicing(t, { seller: "gmbh" });
    const named = await t.asUser("bookkeeper", { name: "Erika Musterfrau" });
    const o = await named.query(api.dashboard.overview, {});
    expect(o.greetingName).toBe("Erika");
    expect(o.ku).toBeNull();
    expect(o.matching.percent).toBeNull();
    expect(o.topCustomers).toEqual([]);
    const unnamed = await t.asUser("viewer", { name: "", email: "buero@example.test" });
    expect((await unnamed.query(api.dashboard.overview, {})).greetingName).toBe("buero");
  });

  test("DASH-011 every member role may read the dashboard; API keys may not", async () => {
    const t = makeT();
    for (const role of ["owner", "bookkeeper", "viewer", "auditor"] as const) {
      const u = await t.asUser(role);
      const o = await u.query(api.dashboard.overview, {});
      expect(o.receivables?.totalCents).toBe(0);
      expect(o.bank).toEqual({ accountCount: 0, totalCents: 0, accountsWithoutBalance: 0, latest: [] });
      expect(o.activity).not.toBeNull();
    }
    const key = await t.asApiKey(["documents:read", "banking:read", "audit:read"]);
    await expect(key.query(api.dashboard.overview, {})).rejects.toThrow();
  });
});
