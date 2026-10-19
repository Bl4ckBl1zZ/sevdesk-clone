import { describe, expect, test } from "vitest";
import { INVOICING_DEADLINE } from "../rules/thresholds";
import { addDays, type CalendarDate } from "../time/calendar-date";
import {
  invoicingDeadlineLevel,
  mustInvoiceWithinSixMonths,
  type UninvoicedSupplyRow,
  uninvoicedSupplyDeadlines,
} from "./uninvoiced-supplies";

const TODAY = "2026-10-19" as CalendarDate;
const daysAgo = (n: number) => addDays(TODAY, -n);
const B2B = { isConsumer: false, kind: "organization" as const };
const CONSUMER = { isConsumer: true, kind: "person" as const };

const note = (over: Partial<UninvoicedSupplyRow> = {}): UninvoicedSupplyRow => ({
  id: "n1",
  status: "finalized",
  supplyDate: { kind: "date", date: daysAgo(151) },
  customer: B2B,
  ...over,
});

describe("UST-01 / QUO-14 uninvoiced delivery notes", () => {
  test("QUO-14 T-QUO-009 a B2B delivery note 151 days old and not invoiced is a warning; 181 days an escalation", () => {
    expect(invoicingDeadlineLevel(note(), TODAY)).toMatchObject({
      level: "warning",
      deliveredOn: daysAgo(151),
      daysSince: 151,
      escalatesOn: addDays(daysAgo(151), 180),
    });
    expect(invoicingDeadlineLevel(note({ supplyDate: { kind: "date", date: daysAgo(181) } }), TODAY)).toMatchObject({
      level: "escalation",
      daysSince: 181,
    });
  });

  test("QUO-14 boundaries: day 149 nothing, day 150 warning, day 179 warning, day 180 escalation", () => {
    const at = (n: number) => invoicingDeadlineLevel(note({ supplyDate: { kind: "date", date: daysAgo(n) } }), TODAY);
    expect(at(149)).toBeNull();
    expect(at(150)?.level).toBe("warning");
    expect(at(179)?.level).toBe("warning");
    expect(at(180)?.level).toBe("escalation");
  });

  test("UST-01 the obligation applies to B2B, legal persons and property-related supplies — not to consumers", () => {
    expect(mustInvoiceWithinSixMonths(B2B, false)).toBe(true);
    // An organisation (legal person) counts even when flagged as a consumer (e.g. a non-business association).
    expect(mustInvoiceWithinSixMonths({ isConsumer: true, kind: "organization" }, false)).toBe(true);
    expect(mustInvoiceWithinSixMonths({ isConsumer: false, kind: "person" }, false)).toBe(true);
    expect(mustInvoiceWithinSixMonths(CONSUMER, false)).toBe(false);
    // § 14 Abs. 2 S. 1 Nr. 1 UStG: property-related supplies to anyone, including private persons.
    expect(mustInvoiceWithinSixMonths(CONSUMER, true)).toBe(true);
    // Unknown customer: conservative reading — warn rather than miss a deadline.
    expect(mustInvoiceWithinSixMonths(null, false)).toBe(true);
  });

  test("UST-01 consumer customers get no to-do; a property-related supply to a consumer does", () => {
    expect(invoicingDeadlineLevel(note({ customer: CONSUMER }), TODAY)).toBeNull();
    expect(invoicingDeadlineLevel(note({ customer: CONSUMER, propertyRelated: true }), TODAY)?.level).toBe("warning");
  });

  test("QUO-14 invoiced, cancelled and draft delivery notes are never flagged", () => {
    for (const status of ["invoiced", "cancelled", "draft"] as const) {
      expect(
        invoicingDeadlineLevel(note({ status, supplyDate: { kind: "date", date: daysAgo(400) } }), TODAY),
      ).toBeNull();
    }
    for (const status of ["finalized", "sent", "accepted"] as const) {
      expect(invoicingDeadlineLevel(note({ status }), TODAY)?.level).toBe("warning");
    }
  });

  test("QUO-14 the reference date is the end of the supply (period end, last day of the month); none without a date", () => {
    expect(
      invoicingDeadlineLevel(note({ supplyDate: { kind: "period", from: daysAgo(200), to: daysAgo(160) } }), TODAY),
    ).toMatchObject({ level: "warning", deliveredOn: daysAgo(160) });
    expect(invoicingDeadlineLevel(note({ supplyDate: { kind: "month", month: "2026-03" } }), TODAY)).toMatchObject({
      level: "escalation",
      deliveredOn: "2026-03-31",
    });
    expect(invoicingDeadlineLevel(note({ supplyDate: undefined }), TODAY)).toBeNull();
  });

  test("EC-026 UST-01 the thresholds are date-effective rule data (§ 14 Abs. 2 UStG), overridable without code changes", () => {
    expect(INVOICING_DEADLINE.entries[0]?.value).toEqual({ warnAfterDays: 150, escalateAfterDays: 180 });
    const override = [
      {
        id: "ovr-1",
        validFrom: "2026-01-01" as CalendarDate,
        value: { warnAfterDays: 100, escalateAfterDays: 120 },
        source: "test",
      },
    ];
    expect(
      invoicingDeadlineLevel(note({ supplyDate: { kind: "date", date: daysAgo(121) } }), TODAY, override)?.level,
    ).toBe("escalation");
  });

  test("QUO-14 uninvoicedSupplyDeadlines splits the rows into warnings and escalations", () => {
    const r = uninvoicedSupplyDeadlines(
      [
        note({ id: "w" }),
        note({ id: "e", supplyDate: { kind: "date", date: daysAgo(190) } }),
        note({ id: "fresh", supplyDate: { kind: "date", date: daysAgo(10) } }),
        note({ id: "c", customer: CONSUMER }),
      ],
      TODAY,
    );
    expect(r.warn.map((x) => x.id)).toEqual(["w"]);
    expect(r.escalate.map((x) => x.id)).toEqual(["e"]);
  });
});
