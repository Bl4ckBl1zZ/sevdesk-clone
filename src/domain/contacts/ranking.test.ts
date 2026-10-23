import { describe, expect, test } from "vitest";
import { calendarDate } from "../time/calendar-date";
import { contactRanking, type RankedDocument, sortRanking } from "./ranking";

const today = calendarDate("2026-10-12");
const doc = (contactId: string, over: Partial<RankedDocument>): RankedDocument => ({
  contactId,
  docType: "invoice",
  documentDate: calendarDate("2026-03-01"),
  netCents: 100_000,
  grossCents: 119_000,
  paymentStatus: "paid",
  currency: "EUR",
  ...over,
});

describe("CON-153 sortable Offen / Umsatz (Jahr) and the top-customers query", () => {
  test("CON-153 aggregates per contact with persons and merged aliases folded into their root (CON-150 definitions)", () => {
    const rootOf = (id: string) => ({ person: "org", loser: "org" })[id] ?? id;
    const rows = contactRanking(
      [
        doc("org", { netCents: 200_000, grossCents: 238_000, paymentStatus: "open", openAmountCents: 238_000 }),
        doc("person", { netCents: 50_000, grossCents: 59_500 }),
        doc("loser", { netCents: 10_000, grossCents: 11_900, documentDate: calendarDate("2025-12-31") }), // last year
        doc("other", { netCents: 300_000, grossCents: 357_000 }),
        doc("other", { docType: "cancellation", netCents: -300_000, grossCents: -357_000 }),
        doc("third", { docType: "quote", netCents: 999_999, grossCents: 999_999 }), // quotes are no revenue
      ],
      rootOf,
      today,
    );
    expect(rows).toEqual(
      new Map([
        ["org", { contactId: "org", revenueYearCents: 250_000, openCents: 238_000 }],
        ["other", { contactId: "other", revenueYearCents: 0, openCents: 0 }],
        ["third", { contactId: "third", revenueYearCents: 0, openCents: 0 }],
      ]),
    );
  });

  test("CON-153 sorts by open amount or year revenue, both directions, ties by name", () => {
    const rows = [
      { contactId: "a", displayName: "Alpha", openCents: 500, revenueYearCents: 10 },
      { contactId: "b", displayName: "Beta", openCents: 0, revenueYearCents: 900 },
      { contactId: "c", displayName: "Gamma", openCents: 500, revenueYearCents: 300 },
    ];
    expect(sortRanking(rows, "open", "desc").map((r) => r.contactId)).toEqual(["a", "c", "b"]);
    expect(sortRanking(rows, "open", "asc").map((r) => r.contactId)).toEqual(["b", "a", "c"]);
    expect(sortRanking(rows, "revenueYear", "desc").map((r) => r.contactId)).toEqual(["b", "c", "a"]);
    expect(sortRanking(rows, "revenueYear", "desc", 2).map((r) => r.contactId)).toEqual(["b", "c"]);
  });
});
