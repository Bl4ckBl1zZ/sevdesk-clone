import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, INVOICE_RANGE, invoiceValues, settle } from "./invoices.fixtures";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("DOC-39 SET-063 number register", { timeout: 30_000 }, () => {
  test("DOC-39 T-DOC-043 the detail shows the register row; SET-063 the register lists it and reports a documented gap", async () => {
    const t = makeT();
    const { owner, id, number, personId } = await finalizedInvoice(t);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.register).toMatchObject({
      number,
      status: "issued",
      rangeName: "Rechnungen",
      periodKey: "2026",
      imported: false,
    });
    const rangeId = detail?.register?.rangeId as Id<"numberRanges">;

    // SET-059: raising 2 → 5 with a reason documents the gap 2–4.
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [{ ...INVOICE_RANGE, next: 5 }], reason: "Abstimmung mit dem Altsystem" },
    });
    const second = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const r2 = await owner.action(api.invoices.finalize, { id: second.id, version: 1 });
    await settle(t);
    expect(r2.number).toBe("RE-2026-0005");

    const view = await owner.query(api.settings.numberRegister, { rangeId, periodKey: "2026" });
    expect(view.rows.map((r) => r.number)).toEqual(["RE-2026-0005", number]);
    expect(view.rows[1]).toMatchObject({ status: "issued", link: `/rechnungen/${id}` });
    expect(view.periods).toEqual(["2026"]);
    expect(view.gaps).toEqual([{ periodKey: "2026", from: 2, to: 4, reason: "Abstimmung mit dem Altsystem" }]);

    // Storno flips the original's register status.
    await owner.mutation(api.corrections.cancel, { id });
    const cancelled = await owner.query(api.settings.numberRegister, { rangeId, status: "cancelled_by_storno" });
    expect(cancelled.rows.map((r) => r.number)).toEqual([number]);
  });
});
