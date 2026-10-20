import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import { invoiceEvent, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { makeT } from "./test.setup";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("tax reserve read model (RPT-010, RPT-011)", () => {
  test("RPT-010 RPT-011 open USt from the VAT accounts, saved assumptions apply, the result is labelled an estimate", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-09-10", 100000));
    const owner = await t.asUser("owner");
    await owner.mutation(api.taxes.saveTaxReserveInputs, {
      year: 2026,
      profitOverrideCents: 6_000_000,
      splitting: false,
      churchTaxBp: 0,
      gewerbesteuerHebesatzBp: 40_000,
    });
    const viewer = await t.asUser("viewer");
    const r = await viewer.query(api.reports.taxReserve, { year: 2026 });
    expect(r).toMatchObject({
      estimate: true,
      disclaimer: "Schätzung – keine Steuerberatung",
      ust: { openCents: 19000 },
      gewst: { gewstCents: 497_000 },
      annualCents: 1_423_300,
      ruleVersion: "tax-reserve-2026.1",
      legalForm: "einzelunternehmen",
    });
    expect(r.notices).toEqual([]);
    // REST/MCP overrides are not saved
    const o = await viewer.query(api.reports.taxReserve, { year: 2026, hebesatzBp: 50_000 });
    expect(o.gewst?.gewstCents).toBe(621_250);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((e) => e.action === "settings.tax_reserve.update")).toHaveLength(1);
  });

  test("RPT-010 without a saved Hebesatz 400 % is assumed with a notice; a viewer cannot save assumptions", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    const viewer = await t.asUser("viewer");
    const r = await viewer.query(api.reports.taxReserve, { year: 2026, profitOverrideCents: 6_000_000 });
    expect(r.notices).toContain(
      "Hebesatz nicht hinterlegt – 400 % angenommen. Bitte den Hebesatz Ihrer Gemeinde eintragen.",
    );
    const err = await viewer
      .mutation(api.taxes.saveTaxReserveInputs, { year: 2026, splitting: true })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("forbidden_role");
  });

  test("RPT-010 partner shares must add up to 100 %", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    const err = await owner
      .mutation(api.taxes.saveTaxReserveInputs, {
        year: 2026,
        splitting: false,
        partners: [
          { name: "A", shareBp: 5000 },
          { name: "B", shareBp: 4000 },
        ],
      })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
  });
});
