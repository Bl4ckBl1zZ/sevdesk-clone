import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../time/calendar-date";
import { type DefaultStartInput, defaultStartOf } from "./default-start";
import { limitationDateOf, limitationStatus } from "./limitation";

const d = (s: string) => s as CalendarDate;

const base: DefaultStartInput = {
  dueDate: d("2026-06-15"),
  isConsumer: false,
  hasB2c286Note: false,
  calendarDueDateAgreed: false,
  reminders: [],
  route: "after_printed_deadline",
};

describe("PAY-053 MAHN-01 default start (Verzugsbeginn)", () => {
  test("MAHN-01 T05-081 B2C invoice with the § 286 note, marked sent 2026-06-01 by e-mail, due 2026-06-15 → 2026-07-16 (30-Tage-Regel)", () => {
    const r = defaultStartOf({ ...base, isConsumer: true, hasB2c286Note: true, invoiceZugang: d("2026-06-01") });
    expect(r).toMatchObject({ date: "2026-07-16", route: "30_days" });
    expect(r?.label).toBe("Verzug seit 16.07.2026 – 30-Tage-Regel");
  });

  test("MAHN-01 EC-DUE-02 EC-128 T05-082 B2C without the note: no 30-day route; default only after a marked reminder", () => {
    const noNote = { ...base, isConsumer: true, invoiceZugang: d("2026-06-01") };
    expect(defaultStartOf(noNote)).toBeNull();
    const unmarked = {
      ...noNote,
      reminders: [{ documentDate: d("2026-06-22"), newDueDate: d("2026-07-02"), status: "finalized" as const }],
    };
    expect(defaultStartOf(unmarked)).toBeNull();
    const marked = {
      ...noNote,
      reminders: [
        {
          documentDate: d("2026-06-22"),
          newDueDate: d("2026-07-02"),
          zugang: d("2026-06-22"),
          status: "sent" as const,
        },
      ],
    };
    expect(defaultStartOf(marked)).toMatchObject({ date: "2026-07-03", route: "reminder" });
  });

  test("MAHN-01 PAY-052 DUN-052 T05-083 reminder marked sent by post 2026-07-01 (Zugang 07-04) → default start 2026-07-05 (zugang_plus_1)", () => {
    const r = defaultStartOf({
      ...base,
      isConsumer: true,
      route: "zugang_plus_1",
      reminders: [
        { documentDate: d("2026-07-01"), newDueDate: d("2026-07-08"), zugang: d("2026-07-04"), status: "sent" },
      ],
    });
    expect(r).toMatchObject({ date: "2026-07-05", route: "reminder" });
  });

  test("MAHN-01 EC-DUE-04 T05-084a dueDays = 0, B2B, marked sent 2026-06-10 → 30-day default start 2026-07-11", () => {
    const r = defaultStartOf({ ...base, dueDate: d("2026-06-10"), invoiceZugang: d("2026-06-10") });
    expect(r).toMatchObject({ date: "2026-07-11", route: "30_days" });
  });

  test("MAHN-01 EC-DUE-06 T05-084b calendar date agreed → due + 1 (needs no Zugang); unset → other routes", () => {
    expect(defaultStartOf({ ...base, calendarDueDateAgreed: true })).toMatchObject({
      date: "2026-06-16",
      route: "calendar",
    });
    expect(defaultStartOf(base)).toBeNull();
  });

  test("MAHN-01 PAY-064 EC-196 no Zugang of the invoice → no 30-day route", () => {
    expect(defaultStartOf({ ...base, invoiceZugang: undefined })).toBeNull();
  });

  test("MAHN-01 T05-175 route (b): after_printed_deadline vs zugang_plus_1; an unmarked reminder never starts default", () => {
    const reminders = [
      { documentDate: d("2026-06-22"), newDueDate: d("2026-06-29"), zugang: d("2026-06-22"), status: "sent" as const },
    ];
    expect(defaultStartOf({ ...base, reminders })?.date).toBe("2026-06-30");
    expect(defaultStartOf({ ...base, reminders, route: "zugang_plus_1" })?.date).toBe("2026-06-23");
    const unmarked = [{ documentDate: d("2026-06-22"), newDueDate: d("2026-06-29"), status: "finalized" as const }];
    expect(defaultStartOf({ ...base, reminders: unmarked })).toBeNull();
  });

  test("MAHN-01 the earliest route wins; a withdrawn reminder or one dated on/before the due date does not count", () => {
    const r = defaultStartOf({
      ...base,
      invoiceZugang: d("2026-06-01"),
      reminders: [
        { documentDate: d("2026-06-15"), newDueDate: d("2026-06-20"), zugang: d("2026-06-15"), status: "sent" },
        { documentDate: d("2026-06-20"), newDueDate: d("2026-06-27"), zugang: d("2026-06-20"), status: "cancelled" },
      ],
    });
    expect(r).toMatchObject({ date: "2026-07-16", route: "30_days" });
  });
});

describe("DUN-040 DUN-041 MAHN-05 limitation (§§ 195, 199 BGB)", () => {
  test("MAHN-05 EC-DUN-16 EC-130 T05-140 due 2023-03-01 → 31.12.2026; warning from 2026-10-01, not on 2026-09-30", () => {
    expect(limitationDateOf(d("2023-03-01"))).toBe("2026-12-31");
    expect(limitationStatus(d("2023-03-01"), d("2026-09-30")).state).toBe("ok");
    const soon = limitationStatus(d("2023-03-01"), d("2026-10-01"));
    expect(soon.state).toBe("soon");
    expect(soon.message).toBe(
      "Verjährt am 31.12.2026 – Mahnbescheid oder Klage hemmen die Verjährung, Mahnungen nicht.",
    );
  });

  test("MAHN-05 EC-DUN-15 after the date the claim is time-barred", () => {
    const s = limitationStatus(d("2023-03-01"), d("2027-01-01"));
    expect(s.state).toBe("expired");
    expect(s.message).toBe(
      "Die Forderung ist seit dem 01.01.2027 verjährt. Der Schuldner kann die Einrede der Verjährung erheben.",
    );
  });
});
