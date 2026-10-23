import { describe, expect, test } from "vitest";
import type { LetterCompany } from "../receivables/letter";
import type { CalendarDate } from "../time/calendar-date";
import { computeInterestClaim, type InterestClaimInput, interestClaimLetter } from "./interest-claim";

const d = (s: string) => s as CalendarDate;

const COMPANY: LetterCompany = {
  legalForm: "gmbh",
  name: "Muster Webdesign GmbH",
  address: { street: "Musterstraße 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
  seat: "Berlin",
  contact: { name: "Max Muster", phone: "030 123456", email: "info@muster.de" },
  register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
  representatives: [{ name: "Max Muster" }],
};

// 10.000,00 € in default since 2026-06-01, paid in full on 2026-08-01 (golden G1: 06-01 … 07-31 → 173,76 €)
const base: InterestClaimInput = {
  date: d("2026-08-10"),
  currency: "EUR",
  isConsumer: false,
  defaultStart: { date: d("2026-06-01"), route: "calendar", label: "" },
  openAmountCents: 0,
  paidOn: d("2026-08-01"),
  history: { principalCents: 1_000_000, changes: [{ date: d("2026-08-01"), deltaCents: -1_000_000 }] },
  reminderFeesCents: 0,
  feesReceivedCents: 0,
  interestReceivedCents: 0,
};

describe("„Zinsforderung stellen“ (DUN-028)", () => {
  test("DUN-028 MAHN-02 MAHN-03 after a late full payment: interest until the payment + 40 € (B2B), less what was received", () => {
    const r = computeInterestClaim(base);
    expect(r.ok && r.value).toMatchObject({
      defaultStartDate: "2026-06-01",
      paidOn: "2026-08-01",
      marginBp: 900,
      interestCents: 17_376,
      flatFee40Cents: 4_000,
      totalCents: 21_376,
      newDueDate: "2026-08-24",
    });
    expect(r.ok && r.value.interestSegments.map((s) => [s.from, s.to, s.rateBp])).toEqual([
      ["2026-06-01", "2026-06-30", 1027],
      ["2026-07-01", "2026-07-31", 1052],
    ]);
    // fees of the reminders, part of it already received with the payment (PAY-024)
    const less = computeInterestClaim({
      ...base,
      reminderFeesCents: 500,
      feesReceivedCents: 4_500,
      interestReceivedCents: 7_376,
    });
    expect(less.ok && less.value.totalCents).toBe(10_000);
    // a consumer: 5 points, no flat fee
    const b2c = computeInterestClaim({ ...base, isConsumer: true });
    expect(b2c.ok && [b2c.value.marginBp, b2c.value.flatFee40Cents]).toEqual([500, 0]);
  });

  test("DUN-028 only after full payment, only if paid late, only while something is still owed", () => {
    expect(computeInterestClaim({ ...base, openAmountCents: 100, paidOn: null })).toMatchObject({
      ok: false,
      error: { code: "not_paid" },
    });
    const early = computeInterestClaim({
      ...base,
      defaultStart: { date: d("2026-08-02"), route: "30_days", label: "" },
    });
    expect(early.ok ? null : early.error.message).toBe(
      "Die Rechnung wurde vor Verzugsbeginn bezahlt – es sind keine Verzugszinsen entstanden.",
    );
    expect(computeInterestClaim({ ...base, defaultStart: null }).ok).toBe(false);
    const settled = computeInterestClaim({ ...base, feesReceivedCents: 4_000, interestReceivedCents: 17_376 });
    expect(settled.ok ? null : settled.error.code).toBe("nothing_open");
    expect(computeInterestClaim({ ...base, currency: "USD" }).ok).toBe(false);
  });

  test("DUN-028 the letter lists the interest segments, the costs and the total with a new deadline", () => {
    const r = computeInterestClaim({ ...base, reminderFeesCents: 500 });
    if (!r.ok) throw new Error(r.error.message);
    const l = interestClaimLetter({
      claim: r.value,
      invoice: { number: "RE-2026-0042", documentDate: "2026-05-01", payableCents: 1_000_000 },
      defaultRoute: "calendar",
      isConsumer: false,
      salutation: "Sehr geehrte Damen und Herren",
      company: COMPANY,
      recipient: { name: "Beispiel AG", address: ["Hauptstraße 5", "80331 München"] },
      date: "2026-08-10",
    });
    expect(l.kind).toBe("interest_claim");
    expect(l.subject).toBe("Verzugszinsen und Kosten zur Rechnung RE-2026-0042");
    expect(l.paragraphs[2]).toContain("9 Prozentpunkten über dem jeweiligen Basiszinssatz (§ 288 Abs. 2 BGB)");
    expect(l.table?.rows.map((x) => [x[0], x[4]])).toEqual([
      ["01.06.2026 – 30.06.2026", "84,41 €"],
      ["01.07.2026 – 31.07.2026", "89,35 €"],
      ["Verzugszinsen gesamt", "173,76 €"],
      ["Mahngebühren", "5,00 €"],
      ["Pauschale nach § 288 Abs. 5 BGB", "40,00 €"],
      ["Zu zahlen", "218,76 €"],
    ]);
    expect(l.closing[0]).toBe("Bitte überweisen Sie den Betrag von 218,76 € bis zum 24.08.2026.");
  });
});
