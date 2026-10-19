import { describe, expect, test } from "vitest";
import { lookupRule } from "../rules/rule-table";
import { KLEINUNTERNEHMER_LIMITS } from "../rules/thresholds";
import { type CalendarDate, calendarDate } from "../time/calendar-date";
import {
  bankSummary,
  greetingName,
  kuProgress,
  MATCHED_SHARE_LEVELS,
  matchedShare,
  monthlyResult,
  monthWindow,
  receivablesSummary,
  staleUnassigned,
  subtractMonths,
  topCustomers,
} from "./dashboard";

const d = (s: string): CalendarDate => calendarDate(s);
const TODAY = d("2026-10-18");

describe("DASH-001 greeting", () => {
  test("DASH-001 uses the first word of the member name", () => {
    expect(greetingName({ name: "Erika Musterfrau", email: "erika@example.test" })).toBe("Erika");
  });
  test("DASH-001 falls back to the e-mail local part when the name is empty or the e-mail itself", () => {
    expect(greetingName({ name: "  ", email: "buero@example.test" })).toBe("buero");
    expect(greetingName({ name: "buero@example.test", email: "buero@example.test" })).toBe("buero");
    expect(greetingName({ email: "info@example.test" })).toBe("info");
  });
  test("DASH-001 no name and no e-mail → no name (plain „Herzlich Willkommen“)", () => {
    expect(greetingName({})).toBeNull();
    expect(greetingName({ name: "", email: "" })).toBeNull();
  });
});

describe("DASH-003 month window and monthly result from the journal", () => {
  test("DASH-003 the window is 12 months ending with the current month, across the year boundary", () => {
    const w = monthWindow(TODAY);
    expect(w).toHaveLength(12);
    expect(w[0]).toEqual({ period: "2025-11", label: "Nov 25" });
    expect(w.at(-1)).toEqual({ period: "2026-10", label: "Okt 26" });
    expect(w.map((m) => m.label)).toContain("Mär 26");
    expect(monthWindow(d("2026-01-31"), 3).map((m) => m.period)).toEqual(["2025-11", "2025-12", "2026-01"]);
  });

  test("DASH-003 subtractMonths clamps to the end of a shorter month", () => {
    expect(subtractMonths(d("2026-05-31"), 3)).toBe("2026-02-28");
    expect(subtractMonths(d("2026-10-18"), 3)).toBe("2026-07-18");
    expect(subtractMonths(d("2026-01-15"), 1)).toBe("2025-12-15");
  });

  const types = new Map([
    ["8200", "revenue"],
    ["8195", "revenue"],
    ["4930", "expense"],
    ["4970", "expense"],
    ["1200", "asset"],
    ["1400", "asset"],
  ] as const);

  test("DASH-003 income = credit − debit on revenue accounts, expenses = debit − credit on expense accounts", () => {
    const r = monthlyResult(
      [
        // invoice 2026-10: 1400 S / 8195 H 1.000,00 (KU revenue)
        { date: "2026-10-02", account: "1400", debitCents: 100_000, creditCents: 0 },
        { date: "2026-10-02", account: "8195", debitCents: 0, creditCents: 100_000 },
        // bank fee 2026-10: 4970 S / 1200 H 12,50
        { date: "2026-10-05", account: "4970", debitCents: 1_250, creditCents: 0 },
        { date: "2026-10-05", account: "1200", debitCents: 0, creditCents: 1_250 },
        // office supplies 2026-09
        { date: "2026-09-30", account: "4930", debitCents: 5_000, creditCents: 0 },
        // payment (no P&L effect)
        { date: "2026-10-10", account: "1200", debitCents: 100_000, creditCents: 0 },
        { date: "2026-10-10", account: "1400", debitCents: 0, creditCents: 100_000 },
        // outside the window
        { date: "2025-10-31", account: "8200", debitCents: 0, creditCents: 999_999 },
        { date: "2026-10-19", account: "8200", debitCents: 0, creditCents: 999_999 },
      ],
      types,
      TODAY,
    );
    expect(r.from).toBe("2025-11-01");
    expect(r.to).toBe("2026-10-18");
    expect(r.incomeCents).toBe(100_000);
    expect(r.expenseCents).toBe(6_250);
    expect(r.profitCents).toBe(93_750);
    expect(r.months.at(-1)).toEqual({
      period: "2026-10",
      label: "Okt 26",
      incomeCents: 100_000,
      expenseCents: 1_250,
      profitCents: 98_750,
    });
    expect(r.months.at(-2)).toMatchObject({ period: "2026-09", incomeCents: 0, expenseCents: 5_000 });
    expect(r.months[0]).toMatchObject({ incomeCents: 0, expenseCents: 0, profitCents: 0 });
  });

  test("DASH-003 a Storno nets the month; a month can turn negative (value kept, the UI clamps the bar)", () => {
    const r = monthlyResult(
      [
        { date: "2026-08-03", account: "8195", debitCents: 0, creditCents: 50_000 },
        // Storno in September of an August invoice
        { date: "2026-09-02", account: "8195", debitCents: 50_000, creditCents: 0 },
      ],
      types,
      TODAY,
    );
    expect(r.months.find((m) => m.period === "2026-08")?.incomeCents).toBe(50_000);
    expect(r.months.find((m) => m.period === "2026-09")?.incomeCents).toBe(-50_000);
    expect(r.incomeCents).toBe(0);
  });

  test("DASH-003 lines on unknown accounts are ignored", () => {
    const r = monthlyResult([{ date: "2026-10-01", account: "9999", debitCents: 0, creditCents: 1 }], types, TODAY);
    expect(r.incomeCents).toBe(0);
  });
});

describe("GOBD-04 unbooked > 10 days", () => {
  test("GOBD-04 unassigned bank transactions older than the rule's 10 days are counted; assigned or recent ones not", () => {
    const today = d("2026-10-19");
    const s = staleUnassigned(
      [
        { status: "open", bookingDate: "2026-10-08" },
        { status: "partially_matched", bookingDate: "2026-10-01" },
        { status: "open", bookingDate: "2026-10-09" },
        { status: "matched", bookingDate: "2026-09-01" },
        { status: "ignored", bookingDate: "2026-09-01" },
      ],
      today,
    );
    expect(s).toEqual({ count: 2, days: 10 });
  });
});

describe("DASH-004 Ausstehende Rechnungen", () => {
  test("DASH-004 disjoint buckets: overdue first, then partially paid, else open; they sum to the total", () => {
    const s = receivablesSummary([
      { openCents: 10_000, paidCents: 0, overdue: true, currency: "EUR" },
      { openCents: 5_000, paidCents: 2_000, overdue: true, currency: "EUR" },
      { openCents: 20_000, paidCents: 0, overdue: false, currency: "EUR" },
      { openCents: 7_000, paidCents: 3_000, overdue: false, currency: "EUR" },
      // open refund (we owe), other currency: not part of the receivables card
      { openCents: -4_000, paidCents: 0, overdue: false, currency: "EUR" },
      { openCents: 9_000, paidCents: 0, overdue: false, currency: "USD" },
    ]);
    expect(s.overdue).toEqual({ count: 2, cents: 15_000 });
    expect(s.open).toEqual({ count: 1, cents: 20_000 });
    expect(s.partiallyPaid).toEqual({ count: 1, cents: 7_000 });
    expect(s.totalCents).toBe(42_000);
    expect(s.overdue.cents + s.open.cents + s.partiallyPaid.cents).toBe(s.totalCents);
  });
  test("DASH-004 no open items → zeros", () => {
    expect(receivablesSummary([])).toEqual({
      totalCents: 0,
      overdue: { count: 0, cents: 0 },
      open: { count: 0, cents: 0 },
      partiallyPaid: { count: 0, cents: 0 },
      dueWithin7: { count: 0, cents: 0 },
      creditCents: 0,
    });
  });
  test("PAY-007 due within 7 days is a subset of the not-overdue rows; credit balances are passed through", () => {
    const today = "2026-10-18" as CalendarDate;
    const s = receivablesSummary(
      [
        { openCents: 10_000, paidCents: 0, overdue: true, currency: "EUR", dueDate: "2026-10-10" },
        { openCents: 20_000, paidCents: 0, overdue: false, currency: "EUR", dueDate: "2026-10-25" },
        { openCents: 7_000, paidCents: 3_000, overdue: false, currency: "EUR", dueDate: "2026-10-18" },
        { openCents: 4_000, paidCents: 0, overdue: false, currency: "EUR", dueDate: "2026-10-26" },
        { openCents: 9_000, paidCents: 0, overdue: false, currency: "USD", dueDate: "2026-10-20" },
      ],
      { today, creditCents: 3_500 },
    );
    expect(s.dueWithin7).toEqual({ count: 2, cents: 27_000 });
    expect(s.creditCents).toBe(3_500);
    expect(s.overdue.cents + s.open.cents + s.partiallyPaid.cents).toBe(s.totalCents);
  });
});

describe("DASH-005 Kleinunternehmergrenze (KU-01, TAX-012)", () => {
  const limits = (() => {
    const r = lookupRule(KLEINUNTERNEHMER_LIMITS, TODAY);
    if (!r.ok) throw new Error("rule missing");
    return r.value.value;
  })();
  const inv = (documentDate: string, grossCents: number, over: Partial<{ status: string; type: string }> = {}) => ({
    documentDate,
    grossCents,
    status: "sent",
    type: "invoice",
    ...over,
  });

  test("DASH-005 not KU on today → null (card hidden)", () => {
    expect(
      kuProgress({ today: TODAY, kleinunternehmer: [{ validFrom: "2020-01-01", isKU: false }], invoices: [] }),
    ).toBe(null);
    expect(
      kuProgress({
        today: TODAY,
        kleinunternehmer: [
          { validFrom: "2020-01-01", isKU: true },
          { validFrom: "2026-01-01", isKU: false },
        ],
        invoices: [],
      }),
    ).toBe(null);
    expect(kuProgress({ today: TODAY, kleinunternehmer: [], invoices: [] })).toBe(null);
  });

  test("DASH-005 this year's turnover (finalised invoices, gross) against the current-year limit from the rule table", () => {
    const p = kuProgress({
      today: TODAY,
      kleinunternehmer: [{ validFrom: "2020-01-01", isKU: true }],
      invoices: [
        inv("2026-02-01", 2_000_000),
        inv("2026-09-30", 500_000, { status: "finalized" }),
        inv("2026-10-01", 100_000, { status: "draft" }),
        inv("2026-10-01", 100_000, { status: "cancelled" }),
        inv("2026-10-01", 100_000, { type: "quote" }),
        inv("2025-12-31", 900_000),
      ],
    });
    expect(p).toMatchObject({
      year: 2026,
      turnoverCents: 2_500_000,
      limitCents: limits.currentYearLimitCents,
      priorYearLimitCents: limits.priorYearLimitCents,
      foundingYear: false,
    });
    expect(p?.shareBp).toBe(Math.floor((2_500_000 * 10_000) / limits.currentYearLimitCents));
    expect(p?.level).toBe("ok");
  });

  test("DASH-005 founding year uses the founding-year limit; warn levels come from warnAtBp", () => {
    const [warn, critical] = limits.warnAtBp;
    const limit = limits.foundingYearLimitCents;
    const at = (bp: number) =>
      kuProgress({
        today: TODAY,
        foundedOn: "2026-03-01",
        kleinunternehmer: [{ validFrom: "2026-03-01", isKU: true }],
        invoices: [inv("2026-04-01", Math.ceil((limit * bp) / 10_000))],
      });
    expect(at(1000)).toMatchObject({ foundingYear: true, limitCents: limit, level: "ok" });
    expect(at(warn ?? 0)?.level).toBe("warn");
    expect(at(critical ?? 0)?.level).toBe("critical");
    expect(at(10_100)?.level).toBe("exceeded");
    expect(at(10_100)?.shareBp).toBe(10_000);
  });

  test("DASH-005 rule missing for the date → limit null instead of a guessed number", () => {
    const p = kuProgress({
      today: d("2024-06-01"),
      kleinunternehmer: [{ validFrom: "2020-01-01", isKU: true }],
      invoices: [inv("2024-02-01", 1_000)],
    });
    expect(p).toMatchObject({ year: 2024, turnoverCents: 1_000, limitCents: null, level: "ok", shareBp: 0 });
  });
});

describe("DASH-006 Bank", () => {
  test("DASH-006 total = Σ statement closing balances of EUR bank accounts; latest 4 rows without ignored ones", () => {
    const s = bankSummary(
      [
        { kind: "bank", currency: "EUR", closingBalanceCents: 120_000 },
        { kind: "bank", currency: "EUR", closingBalanceCents: -2_000 },
        { kind: "bank", currency: "EUR", closingBalanceCents: null },
        { kind: "bank", currency: "USD", closingBalanceCents: 50_000 },
        { kind: "clearing", currency: "EUR", closingBalanceCents: 9_999 },
      ],
      [
        {
          id: "a",
          bookingDate: "2026-10-01",
          amountCents: 100,
          status: "open",
          counterpartyName: "Muster GmbH",
          purpose: "",
        },
        {
          id: "b",
          bookingDate: "2026-10-15",
          amountCents: -200,
          status: "booked",
          counterpartyName: null,
          purpose: "Gebühr",
        },
        {
          id: "c",
          bookingDate: "2026-10-16",
          amountCents: 300,
          status: "ignored",
          counterpartyName: null,
          purpose: "x",
        },
        {
          id: "d",
          bookingDate: "2026-10-12",
          amountCents: 400,
          status: "matched",
          counterpartyName: "Beispiel AG",
          purpose: "",
        },
        { id: "e", bookingDate: "2026-10-14", amountCents: 500, status: "open", counterpartyName: "", purpose: "Bar" },
        { id: "f", bookingDate: "2026-09-01", amountCents: 600, status: "open", counterpartyName: null, purpose: "" },
      ],
    );
    expect(s.totalCents).toBe(118_000);
    expect(s.accountCount).toBe(3);
    expect(s.accountsWithoutBalance).toBe(1);
    expect(s.latest.map((t) => t.id)).toEqual(["b", "e", "d", "a"]);
    expect(s.latest.map((t) => t.label)).toEqual(["Gebühr", "Bar", "Beispiel AG", "Muster GmbH"]);
  });
  test("DASH-006 no account → accountCount 0", () => {
    expect(bankSummary([], [])).toEqual({ accountCount: 0, totalCents: 0, accountsWithoutBalance: 0, latest: [] });
  });
});

describe("DASH-007 Zuordnungsquote", () => {
  test("DASH-007 share of assigned rows; ignored rows are not counted", () => {
    const s = matchedShare({
      matched: 6,
      booked: 1,
      private: 1,
      transfer: 1,
      open: 1,
      partially_matched: 0,
      ignored: 5,
    });
    expect(s).toEqual({ total: 10, assigned: 9, unassigned: 1, percent: 90, level: "medium" });
  });
  test("DASH-007 zero transactions → percent null (empty state)", () => {
    expect(matchedShare({})).toEqual({ total: 0, assigned: 0, unassigned: 0, percent: null, level: null });
    expect(matchedShare({ ignored: 3 }).percent).toBeNull();
  });
  test("DASH-007 the percentage is floored: 100 only when nothing is unassigned", () => {
    expect(matchedShare({ matched: 999, open: 1 }).percent).toBe(99);
    expect(matchedShare({ matched: 999, partially_matched: 1 }).level).toBe("medium");
    expect(matchedShare({ booked: 4 })).toMatchObject({ percent: 100, level: "complete" });
  });
  test("DASH-007 scale: below 85 low, 85–99 medium, 100 complete", () => {
    expect(MATCHED_SHARE_LEVELS).toEqual({ mediumFrom: 85, completeAt: 100 });
    expect(matchedShare({ matched: 84, open: 16 }).level).toBe("low");
    expect(matchedShare({ matched: 85, open: 15 }).level).toBe("medium");
    expect(matchedShare({ open: 3 })).toMatchObject({ percent: 0, level: "low", unassigned: 3 });
  });
});

describe("DASH-008 Top 5 Kunden (invoiced, last 3 months)", () => {
  const doc = (
    contactId: string,
    contactName: string,
    documentDate: string,
    payableCents: number,
    over: Partial<{ type: string; status: string; currency: string }> = {},
  ) => ({
    contactId,
    contactName,
    documentDate,
    payableCents,
    type: "invoice",
    status: "sent",
    currency: "EUR",
    ...over,
  });

  test("DASH-008 ranks by Σ payable amount; ties by name; window (today − 3 months, today]", () => {
    const top = topCustomers(
      [
        doc("c1", "Muster GmbH", "2026-10-01", 50_000),
        doc("c1", "Muster GmbH", "2026-08-01", 25_000, { status: "finalized" }),
        doc("c2", "Beispiel AG", "2026-09-01", 75_000),
        doc("c3", "Alpha KG", "2026-09-15", 75_000, { type: "final_invoice" }),
        doc("c4", "Delta e.K.", "2026-07-19", 10_000),
        doc("c5", "Epsilon GbR", "2026-07-18", 99_000), // exactly 3 months ago: outside
        doc("c6", "Zeta OHG", "2026-10-19", 99_000), // future
        doc("c7", "Eta UG", "2026-10-02", 5_000, { type: "advance_invoice" }),
        doc("c8", "Theta AG", "2026-10-03", 1_000, { type: "partial_invoice" }),
      ],
      TODAY,
    );
    expect(top.map((c) => [c.name, c.amountCents])).toEqual([
      ["Alpha KG", 75_000],
      ["Beispiel AG", 75_000],
      ["Muster GmbH", 75_000],
      ["Delta e.K.", 10_000],
      ["Eta UG", 5_000],
    ]);
  });

  test("DASH-008 drafts, Storno pairs, quotes and other currencies do not count", () => {
    const top = topCustomers(
      [
        doc("c1", "Muster GmbH", "2026-10-01", 50_000, { status: "cancelled" }),
        doc("c1", "Muster GmbH", "2026-10-02", -50_000, { type: "cancellation" }),
        doc("c2", "Beispiel AG", "2026-10-01", 50_000, { status: "draft" }),
        doc("c3", "Alpha KG", "2026-10-01", 50_000, { type: "quote" }),
        doc("c4", "Delta e.K.", "2026-10-01", 50_000, { currency: "USD" }),
        doc("c5", "Epsilon GbR", "2026-10-01", 0),
      ],
      TODAY,
    );
    expect(top).toEqual([]);
  });
});
