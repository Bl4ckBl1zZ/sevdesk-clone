import { describe, expect, test } from "vitest";
import {
  agingBucket,
  agingBuckets,
  computeOpenItems,
  isOverdue,
  type OpenItemDocument,
  openItemsCsv,
  type SettlementRow,
} from "./open-items";
import { planRefund, planReversal } from "./reversal";

const doc = (id: string, documentDate: string, dueDate: string, payableCents = 119000): OpenItemDocument => ({
  id,
  kind: "salesDocument",
  number: `RE-${id}`,
  contactId: "c1",
  contactName: "Müller GmbH",
  documentDate,
  dueDate,
  payableCents,
  currency: "EUR",
});
const row = (targetId: string, date: string, settlesCents: number): SettlementRow => ({
  targetKind: "salesDocument",
  targetId,
  date,
  settlesCents,
  amountCents: settlesCents,
});

describe("open items and aging (PAY-001…PAY-003)", () => {
  test("T05-001 PAY-001 PAY-002 three open invoices, one 45 days overdue → totals, days overdue, bucket 31–60", () => {
    const r = computeOpenItems({
      documents: [
        doc("1", "2026-08-01", "2026-08-29"),
        doc("2", "2026-10-01", "2026-10-31"),
        doc("3", "2026-10-05", "2026-10-15", 50000),
      ],
      rows: [row("2", "2026-10-10", 19000)],
      asOf: "2026-10-13",
    });
    expect(r.items.map((i) => [i.id, i.daysOverdue, i.bucket, i.openCents])).toEqual([
      ["1", 45, "31-60", 119000],
      ["3", 0, "not_due", 50000],
      ["2", 0, "not_due", 100000],
    ]);
    expect(r.totals).toMatchObject({ openCents: 269000, overdueCents: 119000, dueWithin7Cents: 50000 });
    expect(r.totals.buckets.map((b) => [b.label, b.openCents])).toEqual([
      ["nicht fällig", 150000],
      ["1–30", 0],
      ["31–60", 119000],
      ["61–90", 0],
      ["> 90", 0],
    ]);
  });

  test("T05-002 PAY-003 GOBD-01 as of 30.09.: a payment reversed on 05.10. still counts", () => {
    const rows = [row("1", "2026-09-20", 119000), row("1", "2026-10-05", -119000)];
    const documents = [doc("1", "2026-09-01", "2026-09-15"), doc("9", "2026-10-02", "2026-10-30")];
    expect(computeOpenItems({ documents, rows, asOf: "2026-09-30" }).items).toEqual([]);
    expect(computeOpenItems({ documents, rows, asOf: "2026-10-13" }).items.map((i) => i.id)).toEqual(["1", "9"]);
  });

  test("PAY-001 PAY-031 credit balances per contact; PAY-002 configurable edges", () => {
    const r = computeOpenItems({
      documents: [],
      rows: [
        { targetKind: "contactCredit", targetId: "c1", date: "2026-10-01", settlesCents: 4500, amountCents: 4500 },
      ],
      asOf: "2026-10-13",
      contactNames: new Map([["c1", "Müller GmbH"]]),
    });
    expect(r.credits).toEqual([{ contactId: "c1", contactName: "Müller GmbH", balanceCents: 4500 }]);
    expect(agingBucket(91)).toBe("gt90");
    expect(agingBucket(14, [14, 28])).toBe("1-14");
    expect(agingBuckets([14]).map((b) => b.label)).toEqual(["nicht fällig", "1–14", "> 14"]);
  });

  test("PAY-043 overdue is derived from status and due date", () => {
    expect(isOverdue({ paymentStatus: "open", dueDate: "2026-10-12" }, "2026-10-13")).toBe(true);
    expect(isOverdue({ paymentStatus: "partially_paid", dueDate: "2026-10-13" }, "2026-10-13")).toBe(false);
    expect(isOverdue({ paymentStatus: "paid", dueDate: "2026-01-01" }, "2026-10-13")).toBe(false);
  });

  test("T05-004 PAY-006 OPOS CSV with ';', decimal comma and BOM", () => {
    const csv = openItemsCsv(
      computeOpenItems({ documents: [doc("1", "2026-08-01", "2026-08-29")], rows: [], asOf: "2026-10-13" }),
    );
    expect(csv.startsWith("﻿Nr.;Kunde;")).toBe(true);
    expect(csv).toContain("RE-1;Müller GmbH;01.08.2026;29.08.2026;45;1190,00;0,00;1190,00;überfällig");
  });
});

describe("reversal and refund planning (PAY-040…PAY-042, PAY-033)", () => {
  test("T05-022 PAY-041 reversal dated on the original date when its period is open", () => {
    expect(
      planReversal({
        row: { date: "2026-10-01" },
        reason: "Falsch zugeordnet",
        today: "2026-10-13",
        closedPeriods: new Set(),
      }),
    ).toEqual({
      ok: true,
      value: { date: "2026-10-01", warnings: [] },
    });
  });

  test("T05-024 EC-PAY-29 original period locked → dated today with warning", () => {
    const r = planReversal({
      row: { date: "2026-09-10" },
      reason: "Falsch zugeordnet",
      today: "2026-10-13",
      closedPeriods: new Set(["2026-09"]),
    });
    expect(r.ok && r.value).toEqual({
      date: "2026-10-13",
      warnings: [
        {
          code: "reversal_period_locked",
          message: "Der ursprüngliche Zeitraum ist festgeschrieben. Die Stornobuchung erfolgt mit Datum 13.10.2026.",
          ack: false,
        },
      ],
    });
  });

  test("T05-023 EC-PAY-27 reversing twice or a reversal row is rejected; reason ≥ 5 characters", () => {
    const base = { reason: "Falsch zugeordnet", today: "2026-10-13", closedPeriods: new Set<string>() };
    expect(planReversal({ ...base, row: { date: "2026-10-01", reversedById: "x" } })).toMatchObject({
      ok: false,
      error: { message: "Diese Zahlung wurde bereits storniert." },
    });
    expect(planReversal({ ...base, row: { date: "2026-10-01", reversalOfId: "x" } })).toMatchObject({
      ok: false,
      error: { message: "Eine Stornobuchung kann nicht storniert werden. Bitte die Zahlung neu erfassen." },
    });
    expect(planReversal({ ...base, reason: "x", row: { date: "2026-10-01" } }).ok).toBe(false);
  });

  test("T05-061 EC-PAY-24 bank reversal dated on the counter-entry's booking date if open", () => {
    const r = planReversal({
      row: { date: "2026-10-01" },
      reason: "Rückbuchung durch die Bank",
      today: "2026-10-13",
      closedPeriods: new Set(),
      preferredDate: "2026-10-08",
    });
    expect(r.ok && r.value.date).toBe("2026-10-08");
  });

  test("T05-054 EC-PAY-33 refund larger than the credit balance is rejected; cash dating applies", () => {
    const base = {
      sourceKind: "cash" as const,
      creditBalanceCents: 4500,
      date: "2026-10-13",
      today: "2026-10-13",
      closedPeriods: new Set<string>(),
    };
    expect(planRefund({ ...base, amountCents: 5000 })).toMatchObject({
      ok: false,
      error: { message: "Die Erstattung übersteigt den offenen Erstattungsbetrag (45,00 €)." },
    });
    expect(planRefund({ ...base, amountCents: 4500 }).ok).toBe(true);
    expect(planRefund({ ...base, amountCents: 4500, date: "2026-10-01" })).toMatchObject({
      ok: false,
      error: { code: "cash_reason_required" },
    });
    expect(
      planRefund({
        ...base,
        sourceKind: "bank",
        amountCents: 4500,
        bank: { bookingDate: "2026-10-12", amountCents: -4500, allocatedCents: 0 },
      }),
    ).toEqual({ ok: true, value: { date: "2026-10-12", warnings: [] } });
    expect(
      planRefund({
        ...base,
        sourceKind: "bank",
        amountCents: 4500,
        bank: { bookingDate: "2026-10-12", amountCents: 4500, allocatedCents: 0 },
      }).ok,
    ).toBe(false);
  });
});
