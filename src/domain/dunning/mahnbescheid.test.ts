import { describe, expect, test } from "vitest";
import type { LetterCompany } from "../receivables/letter";
import type { CalendarDate } from "../time/calendar-date";
import { type MahnbescheidInput, mahnbescheidData, mahnbescheidSheet } from "./mahnbescheid";

const d = (s: string) => s as CalendarDate;

const COMPANY: LetterCompany = {
  legalForm: "gmbh",
  name: "Muster Webdesign GmbH",
  address: { street: "Musterstraße 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
  seat: "Berlin",
  contact: { name: "Max Muster", phone: "030 123456", email: "info@muster.de" },
  register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
  representatives: [{ name: "Max Muster" }, { name: "Erika Muster" }],
};

const base: MahnbescheidInput = {
  date: d("2026-11-20"),
  company: COMPANY,
  debtor: {
    name: "Beispiel Handel GmbH",
    kind: "organisation",
    isConsumer: false,
    legalForm: "GmbH",
    representative: "Hans Beispiel (Geschäftsführer)",
    address: { street: "Hauptstraße 5", postalCode: "80331", city: "München", countryCode: "DE" },
    customerNumber: "K-10001",
  },
  invoice: {
    number: "RE-2026-0042",
    documentDate: "2026-09-01",
    dueDate: "2026-10-01",
    currency: "EUR",
    payableCents: 119_000,
    openAmountCents: 119_000,
  },
  defaultStart: { date: d("2026-11-01"), route: "30_days", label: "" },
  reminderFeesCents: 500,
  feesReceivedCents: 0,
};

describe("Mahnbescheid data sheet (DUN-044)", () => {
  test("DUN-044 MAHN-05 Antragsteller, Antragsgegner, Anspruch, Hauptforderung, interest wording and Nebenforderungen", () => {
    const r = mahnbescheidData(base);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.antragsteller).toEqual({
      name: "Muster Webdesign GmbH",
      rechtsform: "GmbH",
      strasse: "Musterstraße 1",
      plz: "10115",
      ort: "Berlin",
      land: "DE",
      gesetzlicheVertreter: ["Max Muster", "Erika Muster"],
      register: "Amtsgericht Charlottenburg, HRB 123456 B",
    });
    expect(r.value.antragsgegner).toMatchObject({
      name: "Beispiel Handel GmbH",
      art: "Firma / juristische Person",
      verbraucher: false,
      rechtsform: "GmbH",
      gesetzlicherVertreter: "Hans Beispiel (Geschäftsführer)",
    });
    expect(r.value.anspruch).toEqual({
      bezeichnung: "Rechnung Nr. RE-2026-0042 vom 01.09.2026",
      rechnungsnummer: "RE-2026-0042",
      rechnungsdatum: "2026-09-01",
      faelligAm: "2026-10-01",
      hauptforderungCents: 119_000,
    });
    expect(r.value.zinsen).toEqual({
      prozentpunkte: 9,
      seit: "2026-11-01",
      text: "9 Prozentpunkte über dem jeweiligen Basiszinssatz seit 01.11.2026 aus 1.190,00 €",
    });
    expect(r.value.nebenforderungen).toEqual({ mahnkostenCents: 500, pauschale288Abs5Cents: 4_000 });
    expect(r.value.verjaehrungAm).toBe("2029-12-31");
    // JSON-serialisable (exported next to the PDF)
    expect(JSON.parse(JSON.stringify(r.value))).toEqual(r.value);
  });

  test("DUN-044 a consumer: 5 points and no flat fee; missing legal form/representative and no default give hints", () => {
    const b2c = mahnbescheidData({
      ...base,
      debtor: { ...base.debtor, name: "Erika Beispiel", kind: "person", isConsumer: true, legalForm: undefined, representative: undefined },
    });
    expect(b2c.ok && [b2c.value.zinsen?.prozentpunkte, b2c.value.nebenforderungen.pauschale288Abs5Cents]).toEqual([5, 0]);
    expect(b2c.ok && b2c.value.zinsen?.text).toMatch(/^5 Prozentpunkte über dem jeweiligen Basiszinssatz seit 01\.11\.2026/);
    const org = mahnbescheidData({
      ...base,
      defaultStart: null,
      debtor: { ...base.debtor, legalForm: undefined, representative: undefined },
    });
    expect(org.ok && org.value.zinsen).toBeNull();
    expect(org.ok && org.value.nebenforderungen.pauschale288Abs5Cents).toBe(0);
    expect(org.ok && org.value.hinweise).toEqual(
      expect.arrayContaining([
        "Kein Verzugsbeginn festgestellt – ohne Verzug keine Zinsen und keine Pauschale.",
        "Rechtsform des Antragsgegners fehlt – bitte im Online-Mahnantrag ergänzen.",
        "Gesetzlicher Vertreter des Antragsgegners fehlt – bitte im Online-Mahnantrag ergänzen.",
      ]),
    );
    expect(mahnbescheidData({ ...base, invoice: { ...base.invoice, openAmountCents: 0 } })).toMatchObject({
      ok: false,
      error: { message: "Für einen Mahnbescheid muss die Forderung offen sein." },
    });
    expect(mahnbescheidData({ ...base, invoice: { ...base.invoice, currency: "USD" } }).ok).toBe(false);
  });

  test("DUN-044 the PDF sheet lists the same facts with the Geschäftsbrief footer", () => {
    const r = mahnbescheidData(base);
    if (!r.ok) throw new Error(r.error.message);
    const sheet = mahnbescheidSheet(r.value, COMPANY, "2026-11-20");
    expect(sheet.kind).toBe("mahnbescheid_sheet");
    expect(sheet.fileName).toBe("Mahnbescheid-Datenblatt-RE-2026-0042-2026-11-20.pdf");
    const facts = Object.fromEntries(sheet.facts ?? []);
    expect(facts.Anspruch).toBe("Rechnung Nr. RE-2026-0042 vom 01.09.2026");
    expect(facts.Hauptforderung).toBe("1.190,00 €");
    expect(facts["Pauschale § 288 Abs. 5 BGB"]).toBe("40,00 €");
    expect(sheet.footer[1].join(" ")).toContain("Amtsgericht Charlottenburg");
  });
});
