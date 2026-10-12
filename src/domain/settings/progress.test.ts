import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { completedSteps, type SetupFacts } from "./progress";

const none: SetupFacts = {
  ownerPasskeys: 0,
  accessConfirmed: false,
  authMailDelivered: false,
  checkpointStorageOk: false,
  profile: null,
  bankAccounts: 0,
  layouts: 0,
  numberRanges: 0,
};
const today = calendarDate("2026-10-12");

describe("setup progress (F01 SET-003)", () => {
  test("SET-003 progress is derived from data: nothing done on a fresh instance", () => {
    expect(completedSteps(none, today)).toEqual([]);
  });

  test("SET-003 „Start“ counts as done once the four access steps are; data steps follow their records", () => {
    const facts: SetupFacts = {
      ...none,
      ownerPasskeys: 1,
      accessConfirmed: true,
      authMailDelivered: true,
      checkpointStorageOk: true,
      bankAccounts: 1,
      numberRanges: 13,
      setupCompletedAt: 1,
    };
    expect(completedSteps(facts, today)).toEqual([
      "inhaberkonto",
      "zugriff",
      "email",
      "speicher",
      "start",
      "bank",
      "nummernkreise",
      "fertig",
    ]);
    expect(completedSteps({ ...facts, checkpointStorageOk: false }, today)).not.toContain("start");
  });
});
