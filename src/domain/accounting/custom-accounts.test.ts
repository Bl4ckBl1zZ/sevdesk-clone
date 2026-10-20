import { describe, expect, test } from "vitest";
import { inAccountRange } from "../rules/accounting/ranges";
import { calendarDate } from "../time/calendar-date";
import { removalOf, validateCustomAccount } from "./custom-accounts";
import { resolveLines } from "./resolve";

describe("ACC-009 custom accounts", () => {
  test("ACC-009 E-ACC-07 the number must lie in the chart's range for the type", () => {
    const r = validateCustomAccount({ chart: "SKR04", number: "1234", name: "Test", type: "expense" }, new Set());
    expect(!r.ok && r.error.message).toBe(
      "Kontonummer 1234 liegt nicht im zulässigen Bereich für Aufwandskonto (SKR04).",
    );
    expect(inAccountRange("SKR04", "expense", "6999")).toBe(true);
    expect(inAccountRange("SKR03", "revenue", "8999")).toBe(true);
    expect(inAccountRange("SKR03", "revenue", "4999")).toBe(false);
    expect(inAccountRange("SKR03", "expense", "12345")).toBe(false);
  });

  test("ACC-009 a taken number is refused; a valid account gets EÜR/BWA defaults", () => {
    expect(
      validateCustomAccount({ chart: "SKR04", number: "6999", name: "X", type: "expense" }, new Set(["6999"])).ok,
    ).toBe(false);
    const r = validateCustomAccount(
      { chart: "SKR04", number: "6999", name: "Software-Abos", type: "expense" },
      new Set(),
    );
    expect(r.ok && r.value).toMatchObject({ number: "6999", euerKey: "BA.SONSTIGE", bwaGroup: "SONSTIGE" });
  });

  test("ACC-009 system accounts are never deleted; accounts with postings only archived; assigned accounts stay", () => {
    expect(removalOf({ number: "6999", isSystem: false, used: false })).toEqual({
      ok: true,
      value: { action: "delete" },
    });
    expect(removalOf({ number: "6999", isSystem: false, used: true })).toEqual({
      ok: true,
      value: { action: "archive" },
    });
    expect(removalOf({ number: "6815", isSystem: true, used: false })).toEqual({
      ok: true,
      value: { action: "archive" },
    });
    expect(removalOf({ number: "1800", isSystem: true, used: true, assignedTo: "dem Bankkonto „Revolut“" }).ok).toBe(
      false,
    );
  });

  test("ACC-009 E-ACC-06 custom accounts are postable; archived accounts are refused", () => {
    const base = { chart: "SKR04" as const, date: calendarDate("2026-05-01"), overrides: [], bankAccounts: [] };
    const custom = {
      number: "6999",
      name: "Software-Abos",
      type: "expense" as const,
      euerKey: "BA.SONSTIGE" as const,
      bwaGroup: "SONSTIGE" as const,
      verified: true,
    };
    const lines = [
      { account: "6999", debitCents: 100, creditCents: 0 },
      { account: "1800", debitCents: 0, creditCents: 100 },
    ];
    expect(resolveLines(lines, base).ok).toBe(false);
    expect(resolveLines(lines, { ...base, customAccounts: [custom] }).ok).toBe(true);
    const archived = resolveLines(lines, { ...base, customAccounts: [custom], archivedAccounts: new Set(["6999"]) });
    expect(!archived.ok && archived.error.message).toBe("Konto 6999 ist archiviert und kann nicht bebucht werden.");
  });
});
