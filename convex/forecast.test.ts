import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { invoiceEvent, post } from "./bookkeeping.fixtures";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";
import { header, line, setupCompany, TODAY, upload } from "./vouchers.fixtures";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-12T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Liquiditätsvorschau read model (RPT-012)", () => {
  test("RPT-012 E-RPT-09 an open invoice without customer history arrives on its due date; the threshold day is reported", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    const f = await inv.owner.query(api.reports.forecast, { thresholdCents: 50_000 });
    expect(f.today).toBe("2026-10-12");
    expect(f.days).toHaveLength(90);
    expect(f.openingCents).toBe(0);
    const receivables = f.items.filter((i) => i.source === "receivable");
    expect(receivables).toEqual([
      expect.objectContaining({
        id: inv.id,
        source: "receivable",
        expectedDate: "2026-11-11",
        expectedCents: 119_000,
        cautiousCents: 107_100,
        href: `/rechnungen/${inv.id}`,
      }),
    ]);
    // the October Zahllast (19 % of 1 000 €) is due at the UStVA deadline of its period
    expect(f.items.filter((i) => i.source === "tax")).toEqual([
      expect.objectContaining({ id: "ustva:2026-10", cents: -19_000, label: expect.stringContaining("(geschätzt)") }),
    ]);
    expect(f.notices).toContain("Keine Zahlungshistorie – Fälligkeit angenommen.");
    expect(f.belowThreshold.expected).toBe("2026-10-12");
    expect(f.days.find((d) => d.date === "2026-11-11")?.expectedCents).toBe(119_000 - 19_000);
  });

  test("RPT-012 a period with a recorded UStVA payment voucher is not estimated again", async () => {
    vi.useRealTimers();
    const t = makeT();
    const { supplier } = await setupCompany(t);
    await post(t, invoiceEvent(supplier, "d1", TODAY, 100000));
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({
        kind: "tax_payment",
        supplierName: "Finanzamt Berlin",
        taxRule: "no_input_vat",
        taxPayment: { subtype: "ust_prepayment", period: TODAY.slice(0, 7) },
        lines: [line({ account: "3820", description: "USt-VZ", amountCents: 19_000, vatRateBp: 0 })],
      }),
    });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    const f = await owner.query(api.reports.forecast, {});
    expect(f.items.filter((i) => i.source === "tax").map((i) => [i.id, i.cents])).toEqual([[voucherId, -19_000]]);
  });
});

describe("planned items (RPT-013)", () => {
  test("RPT-013 planned items are added, edited and removed (audited, bookkeeper allowed, viewer not) and enter the forecast with their confidence", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    const owner = inv.owner;
    const id = await owner.mutation(api.reports.savePlannedCashItem, {
      label: "Miete Büro",
      amountCents: -80_000,
      date: "2026-10-31",
      recurrence: "P1M",
      confidence: "high",
    });
    let f = await owner.query(api.reports.forecast, {});
    const planned = f.items.filter((i) => i.source === "planned");
    expect(planned.map((i) => [i.id, i.expectedDate, i.cents, i.confidence])).toEqual([
      [`${id}:2026-10-31`, "2026-10-31", -80_000, "high"],
      [`${id}:2026-11-30`, "2026-11-30", -80_000, "high"],
      [`${id}:2026-12-31`, "2026-12-31", -80_000, "high"],
    ]);
    expect(f.items.find((i) => i.source === "receivable")?.confidence).toBe("low");
    // edit: one-off grant with low confidence
    const bookkeeper = await t.asUser("bookkeeper");
    await bookkeeper.mutation(api.reports.savePlannedCashItem, {
      id,
      label: "Förderung",
      amountCents: 200_000,
      date: "2026-11-15",
      recurrence: "once",
      confidence: "low",
    });
    f = await owner.query(api.reports.forecast, {});
    expect(
      f.items.filter((i) => i.source === "planned").map((i) => [i.label, i.expectedDate, i.cautiousCents]),
    ).toEqual([["Förderung", "2026-11-15", 180_000]]);
    expect(await owner.query(api.reports.plannedCashItems, {})).toEqual([
      expect.objectContaining({ id, label: "Förderung", cents: 200_000, recurrence: "once", confidence: "low" }),
    ]);
    // validation and role check
    const bad = await owner
      .mutation(api.reports.savePlannedCashItem, {
        label: "Nichts",
        amountCents: 0,
        date: "2026-11-15",
        recurrence: "once",
        confidence: "low",
      })
      .catch(errorCode);
    expect(bad).toBe("invalid_input");
    const viewer = await t.asUser("viewer");
    expect(await viewer.mutation(api.reports.removePlannedCashItem, { id }).catch(errorCode)).toBe("forbidden_role");
    await owner.mutation(api.reports.removePlannedCashItem, { id });
    expect(await owner.query(api.reports.plannedCashItems, {})).toEqual([]);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((e) => e.action.startsWith("settings.forecast_planned_item")).map((e) => e.action)).toEqual([
      "settings.forecast_planned_item.update",
      "settings.forecast_planned_item.update",
      "settings.forecast_planned_item.remove",
    ]);
  });
});
