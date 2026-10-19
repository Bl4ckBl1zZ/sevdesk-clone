import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import {
  canOverrideDuplicate,
  canReject,
  matchesInboxFilter,
  nextRetryDelayMs,
  rejectRetention,
  SIDECAR_GIVE_UP_MS,
} from "./status";

const D = (s: string) => s as CalendarDate;

describe("inbox lifecycle (F06 §4.1)", () => {
  test("INB-010 EC-INB-12 T06-014 rejection reasons set retention: 90 days purge-eligible vs letters6", () => {
    expect(
      rejectRetention({ reason: "no_business_document", receivedOn: D("2026-10-19"), parsedEinvoice: false }),
    ).toEqual({
      retentionUntil: "2027-01-17",
      purgeEligibleFrom: "2027-01-17",
    });
    for (const reason of ["not_addressed_to_us", "faulty_invoice_correction_requested", "other"] as const) {
      expect(rejectRetention({ reason, receivedOn: D("2026-10-19"), parsedEinvoice: false })).toEqual({
        retentionUntil: "2032-12-31",
      });
    }
    // Any parsed E-Rechnung that is rejected → letters6, even as „kein Geschäftsbeleg“.
    expect(
      rejectRetention({ reason: "no_business_document", receivedOn: D("2026-10-19"), parsedEinvoice: true }),
    ).toEqual({
      retentionUntil: "2032-12-31",
    });
  });

  test("INB-010 only open items can be rejected; converted and rejected cannot", () => {
    expect(canReject("needs_review")).toBe(true);
    expect(canReject("duplicate")).toBe(true);
    expect(canReject("converted")).toBe(false);
    expect(canReject("rejected")).toBe(false);
    expect(canOverrideDuplicate("duplicate")).toBe(true);
    expect(canOverrideDuplicate("needs_review")).toBe(false);
  });

  test("INB-024 EC-INB-13 sidecar retry backoff grows and stops after 24 h", () => {
    const t0 = 1_000_000;
    expect(nextRetryDelayMs(1, t0, t0)).toBe(60_000);
    expect(nextRetryDelayMs(2, t0, t0 + 60_000)).toBe(5 * 60_000);
    expect(nextRetryDelayMs(9, t0, t0 + 3_600_000)).toBe(60 * 60_000);
    // Never beyond the 24 h window …
    expect(nextRetryDelayMs(30, t0, t0 + SIDECAR_GIVE_UP_MS - 10_000)).toBe(10_000);
    // … and none after it (the item then gets a draft „nicht geprüft“).
    expect(nextRetryDelayMs(31, t0, t0 + SIDECAR_GIVE_UP_MS)).toBeNull();
  });

  test("VOU-111 EC-INB-22 filter „> 10 Tage“ lists unprocessed items only", () => {
    const now = Date.UTC(2026, 9, 19);
    const old = now - 12 * 24 * 3_600_000;
    expect(matchesInboxFilter({ status: "needs_review", receivedAt: old }, "older_than_10_days", now)).toBe(true);
    expect(matchesInboxFilter({ status: "converted", receivedAt: old }, "older_than_10_days", now)).toBe(false);
    expect(matchesInboxFilter({ status: "needs_review", receivedAt: now }, "older_than_10_days", now)).toBe(false);
    expect(
      matchesInboxFilter(
        { status: "needs_review", receivedAt: now, einvoice: { validation: { acceptable: false } } },
        "faulty",
        now,
      ),
    ).toBe(true);
  });
});
