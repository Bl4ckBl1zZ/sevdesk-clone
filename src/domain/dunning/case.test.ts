import { describe, expect, test } from "vitest";
import { renderTemplate, validatePlaceholders } from "../templates/placeholders";
import type { CalendarDate } from "../time/calendar-date";
import { transitionCase } from "./case";
import { defaultReminderTexts, reminderPlaceholderValues } from "./templates";

const d = (s: string) => s as CalendarDate;

describe("DUN-034 DUN-035 DUN-042 dunning case state machine (§4.4)", () => {
  test("DUN-034 EC-125 a partial payment pauses for pauseOnPartialPaymentDays", () => {
    const r = transitionCase("active", { kind: "partial_payment", today: d("2026-10-16"), days: 14 });
    expect(r.ok && r.value).toEqual({ status: "paused", pausedUntil: "2026-10-30" });
  });

  test("DUN-034 dispute pauses without a date; resume reactivates", () => {
    expect(transitionCase("active", { kind: "dispute" })).toEqual({ ok: true, value: { status: "paused" } });
    expect(transitionCase("paused", { kind: "resume" })).toEqual({ ok: true, value: { status: "active" } });
  });

  test("DUN-035 EC-077 EC-129 paid → closed; a reversal reopens with a grace period", () => {
    expect(transitionCase("active", { kind: "settled" })).toEqual({ ok: true, value: { status: "closed" } });
    const r = transitionCase("closed", { kind: "reopen", today: d("2026-10-16"), graceDays: 7 });
    expect(r.ok && r.value).toEqual({ status: "active", graceUntil: "2026-10-23" });
  });

  test("DUN-042 hand over stops automation; a closed case cannot be handed over or paused", () => {
    expect(transitionCase("paused", { kind: "hand_over" })).toEqual({ ok: true, value: { status: "handed_over" } });
    const r = transitionCase("closed", { kind: "pause" });
    expect(!r.ok && r.error.message).toBe("Der Mahnfall ist abgeschlossen – Pausieren ist nicht möglich.");
  });
});

describe("DUN-050 reminder texts", () => {
  const claim = {
    level: 2,
    title: "1. Mahnung",
    inDefault: true,
    feeCents: 0,
    interestCents: 1234,
    interestSegments: [],
    flatFee40Cents: 4000,
    flatFeeAlreadyClaimed: false,
    openAmountCents: 119_000,
    newDueDate: d("2026-10-23"),
    totalCents: 124_234,
    defaultStartDate: d("2026-09-27"),
  };

  test("DUN-050 T05-150 every default text uses only known placeholders (de and en, levels 1–3)", () => {
    for (const lang of ["de", "en"] as const) {
      for (const level of [1, 2, 3]) {
        const t = defaultReminderTexts(level, lang);
        for (const body of [t.subject, t.headText, t.footText]) {
          const r = validatePlaceholders(body, { kind: "document_head", docTypes: ["reminder"] });
          expect(r.ok, `${lang} ${level}: ${body}`).toBe(true);
        }
      }
    }
    const bad = validatePlaceholders("{{reminder.unbekannt}}", { kind: "document_head", docTypes: ["reminder"] });
    expect(bad.ok).toBe(false);
  });

  test("DUN-050 level 2 renders the default start and the total claim", () => {
    const v = reminderPlaceholderValues({
      claim,
      invoiceNumber: "RE-2026-0042",
      invoiceDate: "2026-08-12",
      invoiceDueDate: "2026-08-26",
    });
    const t = defaultReminderTexts(2, "de");
    const head = renderTemplate(t.headText, v);
    expect(head).toContain("Sie befinden sich seit dem 27.09.2026 in Verzug.");
    expect(renderTemplate(t.footText, v)).toContain("bis zum 23.10.2026");
    const notInDefault = reminderPlaceholderValues({
      claim: { ...claim, inDefault: false },
      invoiceNumber: "RE-2026-0042",
      invoiceDate: "2026-08-12",
      invoiceDueDate: "2026-08-26",
    });
    expect(renderTemplate(t.headText, notInDefault)).not.toContain("Verzug");
  });

  test("MAHN-03 the default texts never mention the 40 € flat fee (consumer-safe)", () => {
    for (const level of [1, 2, 3]) {
      const t = defaultReminderTexts(level, "de");
      expect(`${t.headText}${t.footText}`).not.toMatch(/Pauschale|40/);
    }
  });
});
