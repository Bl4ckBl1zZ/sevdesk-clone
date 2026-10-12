import { describe, expect, test } from "vitest";
import { footerDelta } from "../company/legal-forms";
import { checkFormat, previewNumbers } from "../numbering/format";
import { accessSchema, bankSchema, companyDefaults, companySchema, taxDefaults, taxSchema } from "./settings";

const messagesOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));

describe("Adressen & Zugriff", () => {
  const base = {
    countryCode: "DE",
    provider: "Eigener Server",
    nonEuConfirmed: false,
    tailnetName: "",
    tailnetOnlyConfirmed: true,
  };

  test("SET-046 a server outside the EU requires the Finanzamt confirmation", () => {
    expect(accessSchema.safeParse(base).success).toBe(true);
    const us = accessSchema.safeParse({ ...base, countryCode: "US" });
    expect(messagesOf(us).nonEuConfirmed).toMatch(/§ 146 Abs\. 2b AO/);
    expect(accessSchema.safeParse({ ...base, countryCode: "US", nonEuConfirmed: true }).success).toBe(true);
  });

  test("SET-007 the tailnet-only confirmation is mandatory", () => {
    const r = accessSchema.safeParse({ ...base, tailnetOnlyConfirmed: false });
    expect(messagesOf(r).tailnetOnlyConfirmed).toMatch(/nur im Tailnet/);
  });
});

describe("Unternehmen (F01 §5.1)", () => {
  const valid = {
    ...companyDefaults,
    name: "Max Mustermann",
    street: "Hauptstr. 1",
    postalCode: "10115",
    city: "Berlin",
    contactName: "Max Mustermann",
    phone: "+49 30 123456",
    email: "info@muster.de",
  };

  test("SET-015 a complete Einzelunternehmen passes", () => {
    expect(companySchema.safeParse(valid).success).toBe(true);
  });

  test("SET-016 contact name, phone and e-mail are required (XRechnung BT-41/42/43)", () => {
    const r = companySchema.safeParse({ ...valid, contactName: "", phone: "12", email: "x" });
    expect(messagesOf(r)).toMatchObject({
      contactName: expect.stringMatching(/Ansprechpartner/),
      phone: "Die Telefonnummer ist ungültig.",
      email: "Die E-Mail-Adresse ist ungültig.",
    });
  });

  test("SET-015 street or P.O. box, German postal codes have five digits, websites need https://", () => {
    const r = companySchema.safeParse({ ...valid, street: "", postalCode: "1011", website: "muster.de" });
    expect(messagesOf(r)).toMatchObject({
      street: "Straße oder Postfach fehlt.",
      postalCode: "Die Postleitzahl ist ungültig.",
      website: "Bitte eine vollständige Adresse mit https:// angeben.",
    });
    expect(companySchema.safeParse({ ...valid, street: "", poBox: "12 34 56" }).success).toBe(true);
    expect(companySchema.safeParse({ ...valid, countryCode: "AT", postalCode: "1010" }).success).toBe(true);
  });

  test("SET-012 representatives need a written-out first and last name", () => {
    const r = companySchema.safeParse({ ...valid, legalForm: "gmbh", representatives: [{ name: "M. Mustermann" }] });
    expect(messagesOf(r)["representatives.0.name"]).toBe(
      "Bitte Vor- und Nachnamen ausschreiben (z. B. „Max Mustermann“).",
    );
    expect(
      companySchema.safeParse({ ...valid, legalForm: "gmbh", representatives: [{ name: "Max Mustermann" }] }).success,
    ).toBe(true);
  });

  test("SET-011 register numbers follow the register type", () => {
    const gmbh = { ...valid, legalForm: "gmbh" as const, registerCourt: "Amtsgericht Charlottenburg" };
    expect(companySchema.safeParse({ ...gmbh, registerNumber: "123456 B" }).success).toBe(true);
    expect(messagesOf(companySchema.safeParse({ ...gmbh, registerNumber: "HRB-12" })).registerNumber).toBe(
      "Die Registernummer ist ungültig.",
    );
  });

  test("SET-011 switching to GmbH lists the added footer items", () => {
    expect(footerDelta("einzelunternehmen", "gmbh")).toEqual(["Sitz", "Registergericht", "HRB", "Geschäftsführer"]);
    expect(footerDelta("gmbh", "einzelunternehmen")).toEqual([]);
  });
});

describe("Steuern (F01 §5.3)", () => {
  test("SET-041 SET-037 SKR03 is preselected and regular taxation (Soll) is the default", () => {
    const d = taxDefaults("einzelunternehmen");
    expect(d.chartOfAccounts).toBe("SKR03");
    expect(d.taxationMethod).toBe("soll");
    expect(d.isKleinunternehmer).toBe("no");
  });

  test("SET-030 Steuernummer or USt-IdNr is required", () => {
    const r = taxSchema.safeParse(taxDefaults("einzelunternehmen"));
    expect(messagesOf(r).taxNumber).toBe("Steuernummer oder USt-IdNr fehlt (Pflichtangabe auf Rechnungen).");
    expect(taxSchema.safeParse({ ...taxDefaults("einzelunternehmen"), vatId: "de 123456788" }).success).toBe(true);
  });

  test("SET-037 SET-033 Ist-Versteuerung needs the Finanzamt confirmation; Kleinunternehmer needs a start date", () => {
    const base = { ...taxDefaults("einzelunternehmen"), vatId: "DE123456788" };
    const r = taxSchema.safeParse({ ...base, taxationMethod: "ist", isKleinunternehmer: "yes" });
    expect(Object.keys(messagesOf(r)).sort()).toEqual(["istConfirmed", "kuValidFrom"]);
    expect(
      taxSchema.safeParse({
        ...base,
        taxationMethod: "ist",
        istConfirmed: true,
        isKleinunternehmer: "yes",
        kuValidFrom: "2026-01-01",
      }).success,
    ).toBe(true);
  });

  test("SET-039 EÜR is refused for a GmbH and needs the §241a confirmation for an e.K.", () => {
    const gmbh = { ...taxDefaults("gmbh"), vatId: "DE123456788", profitMethod: "euer" as const };
    expect(messagesOf(taxSchema.safeParse(gmbh)).profitMethod).toMatch(/Bilanzierung Pflicht/);
    const ek = { ...taxDefaults("ek"), vatId: "DE123456788", profitMethod: "euer" as const };
    expect(messagesOf(taxSchema.safeParse(ek)).euerConfirmed).toMatch(/§ 241a HGB/);
  });

  test("SET-042 an abweichendes Wirtschaftsjahr only for registered companies with Bilanz", () => {
    const eu = { ...taxDefaults("einzelunternehmen"), vatId: "DE123456788", fiscalYearStartMonth: 7 };
    expect(messagesOf(taxSchema.safeParse(eu)).fiscalYearStartMonth).toMatch(/abweichendes Wirtschaftsjahr/);
    const gmbh = { ...taxDefaults("gmbh"), vatId: "DE123456788", fiscalYearStartMonth: 7 };
    expect(taxSchema.safeParse(gmbh).success).toBe(true);
  });
});

describe("Bank (F01 §5.4)", () => {
  test("SET-050 IBAN checksum, BIC format and the 70-character account holder limit", () => {
    const ok = bankSchema.safeParse({
      iban: "DE89 3704 0044 0532 0130 00",
      bic: "",
      accountHolder: "Max Mustermann",
      currency: "EUR",
    });
    expect(ok.success && ok.data.iban).toBe("DE89370400440532013000");
    const r = bankSchema.safeParse({
      iban: "DE89 3704 0044 0532 0130 01",
      bic: "XYZ",
      accountHolder: "x".repeat(71),
      currency: "EUR",
    });
    expect(messagesOf(r)).toEqual({
      iban: "Die IBAN ist ungültig.",
      bic: "Die BIC ist ungültig.",
      accountHolder: "Kontoinhaber fehlt oder ist länger als 70 Zeichen.",
    });
  });
});

describe("Nummernkreise preview (F01 §5.5)", () => {
  test("SET-055 preview shows the next three numbers", () => {
    expect(previewNumbers("RE-{YYYY}-{####}", { year: 2026, month: 10 }, 42)).toEqual([
      "RE-2026-0042",
      "RE-2026-0043",
      "RE-2026-0044",
    ]);
  });

  test("SET-056 format errors use the F01 texts", () => {
    expect(checkFormat("RE {YYYY}-{####}", "yearly").message).toMatch(/Das Zeichen „ “ ist nicht erlaubt/);
    expect(checkFormat("RE-{YYYY}", "yearly").message).toBe("Das Format muss genau einen Zähler wie {####} enthalten.");
    expect(checkFormat("RE-{####}", "yearly").message).toMatch(/jährlicher Neustart/);
    expect(checkFormat("RE-{MM}-{####}", "monthly").message).toMatch(/monatlicher Neustart/);
    expect(checkFormat(`${"A".repeat(30)}{##########}`, "never").message).toMatch(/höchstens 36/);
    expect(checkFormat("RE-{YYYY}-{####}", "yearly").ok).toBe(true);
  });
});
