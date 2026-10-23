import { describe, expect, test } from "vitest";
import { QUOTE_FOLLOW_UP_POLICY, type QuoteFollowUpRow, quoteFollowUps } from "./quote-follow-up";

const row = (patch: Partial<QuoteFollowUpRow> = {}): QuoteFollowUpRow => ({
  id: "q1",
  status: "sent",
  sentOn: "2026-10-12",
  validUntil: "2026-11-30",
  level: 0,
  ...patch,
});

describe("QUO-16 quote follow-up reminders", () => {
  test("QUO-16 the steps are +5 and +12 days after sending, on the dunning policy step model", () => {
    expect(QUOTE_FOLLOW_UP_POLICY.steps.map((s) => [s.level, s.daysAfter])).toEqual([
      [1, 5],
      [2, 12],
    ]);
    expect(QUOTE_FOLLOW_UP_POLICY.steps.every((s) => s.feeCents === 0 && !s.addInterest && !s.addFlatFee40)).toBe(true);
  });

  test("QUO-16 a sent quote without reaction: level 1 on day +5, level 2 on day +12, then nothing", () => {
    expect(quoteFollowUps([row()], "2026-10-16")).toEqual([]);
    expect(quoteFollowUps([row()], "2026-10-17")).toEqual([
      { id: "q1", level: 1, daysSinceSent: 5, title: "Angebot nachfassen" },
    ]);
    expect(quoteFollowUps([row({ level: 1 })], "2026-10-23")).toEqual([]);
    expect(quoteFollowUps([row({ level: 1 })], "2026-10-24")).toEqual([
      { id: "q1", level: 2, daysSinceSent: 12, title: "Angebot erneut nachfassen" },
    ]);
    expect(quoteFollowUps([row({ level: 2 })], "2026-12-01")).toEqual([]);
  });

  test("QUO-16 like dunning, one level per run: a missed day +5 still raises level 1 first", () => {
    expect(quoteFollowUps([row()], "2026-10-26").map((f) => f.level)).toEqual([1]);
  });

  test("QUO-16 any reaction stops the follow-up; unsent or expired quotes are not followed up", () => {
    for (const status of ["accepted", "rejected", "cancelled", "expired", "finalized", "invoiced"] as const) {
      expect(quoteFollowUps([row({ status })], "2026-10-20")).toEqual([]);
    }
    expect(quoteFollowUps([row({ sentOn: undefined })], "2026-10-20")).toEqual([]);
    expect(quoteFollowUps([row({ validUntil: "2026-10-16" })], "2026-10-17")).toEqual([]);
  });
});
