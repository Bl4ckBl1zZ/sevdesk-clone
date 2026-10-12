import { describe, expect, test } from "vitest";
import { INVITE_MESSAGES_DE } from "../access/signup";
import { calendarDate } from "../time/calendar-date";
import { inviteArgsFromForm, inviteDefaults, inviteSchema, selectableFiscalYears } from "./members";

const auditor = {
  ...inviteDefaults,
  email: "pruefer@finanzamt.example",
  role: "auditor" as const,
  validUntil: "2026-10-31",
  purpose: "Prüfungsanordnung 123/45",
  organisation: "Finanzamt Musterstadt",
  fiscalYears: [2025, 2024],
};

const messages = (values: unknown) => {
  const r = inviteSchema.safeParse(values);
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("invite form (02 §4.3, 04 §4.10)", () => {
  test("SEC-01 a bookkeeper invite needs only a valid e-mail; the expiry is optional", () => {
    expect(messages({ ...inviteDefaults, email: "buchhaltung@example.de" })).toEqual({});
    expect(messages({ ...inviteDefaults, email: "kein-mail" })).toEqual({ email: INVITE_MESSAGES_DE.invalid_email });
    expect(messages({ ...inviteDefaults, email: "a@b.de", validUntil: "2026-02-30" })).toEqual({
      validUntil: "Bitte ein gültiges Datum angeben.",
    });
  });

  test("AUD-022 an auditor invite needs „Gültig bis“, Aktenzeichen and at least one Wirtschaftsjahr", () => {
    expect(messages(auditor)).toEqual({});
    expect(messages({ ...auditor, validUntil: "", purpose: " ", fiscalYears: [] })).toEqual({
      validUntil: INVITE_MESSAGES_DE.auditor_expiry_required,
      purpose: "Bitte die Prüfungsanordnung bzw. das Aktenzeichen angeben.",
      fiscalYears: "Bitte mindestens ein Wirtschaftsjahr auswählen.",
    });
  });

  test("AUD-022 form → invites.create: expiry at 24:00 Berlin, scope only for auditors, years sorted", () => {
    expect(inviteArgsFromForm(inviteSchema.parse(auditor))).toEqual({
      email: "pruefer@finanzamt.example",
      role: "auditor",
      memberExpiresAt: Date.UTC(2026, 10, 1, 0, 0, 0) - 3_600_000 - 1,
      auditor: {
        purpose: "Prüfungsanordnung 123/45",
        organisation: "Finanzamt Musterstadt",
        fiscalYears: [2024, 2025],
      },
    });
    expect(inviteArgsFromForm({ ...auditor, role: "viewer", validUntil: "" })).toEqual({
      email: "pruefer@finanzamt.example",
      role: "viewer",
    });
  });

  test("AUD-022 the dialog offers the current and the ten previous Wirtschaftsjahre (§ 147 AO)", () => {
    const years = selectableFiscalYears(calendarDate("2026-10-12"));
    expect(years[0]).toBe(2026);
    expect(years.at(-1)).toBe(2016);
    expect(years).toHaveLength(11);
  });
});
