import { describe, expect, test } from "vitest";
import { pdfText } from "../../test/golden/pdf-text";
import { mahnbescheidData, mahnbescheidSheet } from "../domain/dunning/mahnbescheid";
import type { LetterCompany } from "../domain/receivables/letter";
import { accountStatementLetter, buildAccountStatement } from "../domain/receivables/statement";
import type { CalendarDate } from "../domain/time/calendar-date";
import { renderLetter } from "./letter";

const COMPANY: LetterCompany = {
  legalForm: "gmbh",
  name: "Muster Webdesign GmbH",
  address: { street: "Musterstraße 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
  seat: "Berlin",
  contact: { name: "Max Muster", phone: "030 123456", email: "info@muster.de" },
  register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
  representatives: [{ name: "Max Muster" }],
  accounts: [{ accountHolder: "Muster Webdesign GmbH", iban: "DE02120300000000202051", bic: "BYLADEM1001" }],
};

const statement = (n: number) =>
  accountStatementLetter({
    statement: buildAccountStatement({
      from: "2026-01-01",
      to: "2026-12-31",
      documents: Array.from({ length: n }, (_, i) => ({
        id: `d${i}`,
        kind: "invoice" as const,
        number: `RE-2026-${String(i + 1).padStart(4, "0")}`,
        date: `2026-${String((i % 12) + 1).padStart(2, "0")}-15`,
        payableCents: 11_900,
      })),
      payments: [],
    }),
    company: COMPANY,
    recipient: { name: "Beispiel AG", customerNumber: "K-10001", address: ["Hauptstraße 5", "80331 München"] },
    date: "2027-01-05",
  });

describe("receivables letter PDF (PAY-005, DUN-044, MAIL-03)", () => {
  test("PAY-005 MAIL-03 the statement renders the address, the table and the Geschäftsbrief footer; deterministic", async () => {
    const bytes = await renderLetter(statement(3));
    const again = await renderLetter(statement(3));
    expect(Buffer.from(bytes).equals(Buffer.from(again))).toBe(true);
    const text = await pdfText(bytes);
    expect(text).toContain("Muster Webdesign GmbH · Musterstraße 1 · 10115 Berlin");
    expect(text).toContain("Beispiel AG");
    expect(text).toContain("Kontoauszug vom 01.01.2026 bis 31.12.2026");
    expect(text).toMatch(/Anfangssaldo/);
    expect(text).toMatch(/Endsaldo/);
    expect(text).toContain("357,00 €");
    expect(text).toContain("HRB 123456 B");
  });

  test("PAY-005 a long statement continues on further pages with the table header and the footer on each page", async () => {
    const bytes = await renderLetter(statement(120));
    const text = await pdfText(bytes);
    const pages = text.split(/--- page \d+ ---/).filter((p) => p.trim() !== "");
    expect(pages.length).toBeGreaterThan(2);
    for (const p of pages) expect(p).toContain("HRB 123456 B");
    expect(pages.filter((p) => p.includes("Saldo")).length).toBe(pages.length);
  });

  test("DUN-044 the Mahnbescheid data sheet renders its facts", async () => {
    const data = mahnbescheidData({
      date: "2026-11-20" as CalendarDate,
      company: COMPANY,
      debtor: {
        name: "Beispiel Handel GmbH",
        kind: "organisation",
        isConsumer: false,
        legalForm: "GmbH",
        representative: "Hans Beispiel",
        address: { street: "Hauptstraße 5", postalCode: "80331", city: "München", countryCode: "DE" },
      },
      invoice: {
        number: "RE-2026-0042",
        documentDate: "2026-09-01",
        dueDate: "2026-10-01",
        currency: "EUR",
        payableCents: 119_000,
        openAmountCents: 119_000,
      },
      defaultStart: { date: "2026-11-01" as CalendarDate, route: "30_days", label: "" },
      reminderFeesCents: 0,
      feesReceivedCents: 0,
    });
    if (!data.ok) throw new Error(data.error.message);
    const text = await pdfText(await renderLetter(mahnbescheidSheet(data.value, COMPANY, "2026-11-20")));
    expect(text).toContain("Rechnung Nr. RE-2026-0042 vom 01.09.2026");
    expect(text).toContain("9 Prozentpunkte über dem jeweiligen Basiszinssatz seit 01.11.2026");
  });
});
