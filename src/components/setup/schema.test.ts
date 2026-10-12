import { describe, expect, test } from "vitest";
import { footerDelta } from "./legal-forms";
import { checkFormat, previewNumbers } from "./number-format";
import { accessSchema, bankSchema, companyDefaults, companySchema, taxDefaults, taxSchema } from "./schema";
import { resumeStep, WIZARD_STEPS } from "./steps";

const messagesOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((r.error?.issues ?? []).map((i) => [i.path.join("."), i.message]));

describe("setup wizard steps (F01 §3.1)", () => {
  test("SET-002 the wizard has the eleven steps in F01 order; only Bank and Layout can be skipped", () => {
    expect(WIZARD_STEPS.map((s) => s.key)).toEqual([
      "inhaberkonto",
      "zugriff",
      "email",
      "speicher",
      "start",
      "unternehmen",
      "steuern",
      "bank",
      "layout",
      "nummernkreise",
      "fertig",
    ]);
    expect(WIZARD_STEPS.filter((s) => s.skippable).map((s) => s.key)).toEqual(["bank", "layout"]);
    expect(WIZARD_STEPS.map((s) => s.slug).join(" ")).not.toMatch(/smtp|imap|zahlung/i);
  });

  test("SET-003 the wizard resumes at the first incomplete step", () => {
    expect(resumeStep([]).key).toBe("inhaberkonto");
    expect(resumeStep(["inhaberkonto", "zugriff"]).key).toBe("email");
    expect(resumeStep(WIZARD_STEPS.map((s) => s.key)).key).toBe("fertig");
  });
});

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

  test("SMOKE the tailnet-only confirmation is mandatory", () => {
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

  test("SMOKE a complete Einzelunternehmen passes", () => {
    expect(companySchema.safeParse(valid).success).toBe(true);
  });

  test("SMOKE contact name, phone and e-mail are required (XRechnung BT-41/42/43)", () => {
    const r = companySchema.safeParse({ ...valid, contactName: "", phone: "12", email: "x" });
    expect(messagesOf(r)).toMatchObject({
      contactName: expect.stringMatching(/Ansprechpartner/),
      phone: "Die Telefonnummer ist ungültig.",
      email: "Die E-Mail-Adresse ist ungültig.",
    });
  });

  test("SMOKE street or P.O. box, German postal codes have five digits, websites need https://", () => {
    const r = companySchema.safeParse({ ...valid, street: "", postalCode: "1011", website: "muster.de" });
    expect(messagesOf(r)).toMatchObject({
      street: "Straße oder Postfach fehlt.",
      postalCode: "Die Postleitzahl ist ungültig.",
      website: "Bitte eine vollständige Adresse mit https:// angeben.",
    });
    expect(companySchema.safeParse({ ...valid, street: "", poBox: "12 34 56" }).success).toBe(true);
    expect(companySchema.safeParse({ ...valid, countryCode: "AT", postalCode: "1010" }).success).toBe(true);
  });

  test("SMOKE representatives need a written-out first and last name", () => {
    const r = companySchema.safeParse({ ...valid, legalForm: "gmbh", representatives: [{ name: "M. Mustermann" }] });
    expect(messagesOf(r)["representatives.0.name"]).toBe(
      "Bitte Vor- und Nachnamen ausschreiben (z. B. „Max Mustermann“).",
    );
    expect(
      companySchema.safeParse({ ...valid, legalForm: "gmbh", representatives: [{ name: "Max Mustermann" }] }).success,
    ).toBe(true);
  });

  test("SMOKE register numbers follow the register type", () => {
    const gmbh = { ...valid, legalForm: "gmbh" as const, registerCourt: "Amtsgericht Charlottenburg" };
    expect(companySchema.safeParse({ ...gmbh, registerNumber: "123456 B" }).success).toBe(true);
    expect(messagesOf(companySchema.safeParse({ ...gmbh, registerNumber: "HRB-12" })).registerNumber).toBe(
      "Die Registernummer ist ungültig.",
    );
  });

  test("SMOKE switching to GmbH lists the added footer items", () => {
    expect(footerDelta("einzelunternehmen", "gmbh")).toEqual(["Sitz", "Registergericht", "HRB", "Geschäftsführer"]);
    expect(footerDelta("gmbh", "einzelunternehmen")).toEqual([]);
  });
});

describe("Steuern (F01 §5.3)", () => {
  test("SMOKE SKR03 is preselected and regular taxation (Soll) is the default", () => {
    const d = taxDefaults("einzelunternehmen");
    expect(d.chartOfAccounts).toBe("SKR03");
    expect(d.taxationMethod).toBe("soll");
    expect(d.isKleinunternehmer).toBe("no");
  });

  test("SMOKE Steuernummer or USt-IdNr is required", () => {
    const r = taxSchema.safeParse(taxDefaults("einzelunternehmen"));
    expect(messagesOf(r).taxNumber).toBe("Steuernummer oder USt-IdNr fehlt (Pflichtangabe auf Rechnungen).");
    expect(taxSchema.safeParse({ ...taxDefaults("einzelunternehmen"), vatId: "de 123456788" }).success).toBe(true);
  });

  test("SMOKE Ist-Versteuerung needs the Finanzamt confirmation; Kleinunternehmer needs a start date", () => {
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

  test("SMOKE EÜR is refused for a GmbH and needs the §241a confirmation for an e.K.", () => {
    const gmbh = { ...taxDefaults("gmbh"), vatId: "DE123456788", profitMethod: "euer" as const };
    expect(messagesOf(taxSchema.safeParse(gmbh)).profitMethod).toMatch(/Bilanzierung Pflicht/);
    const ek = { ...taxDefaults("ek"), vatId: "DE123456788", profitMethod: "euer" as const };
    expect(messagesOf(taxSchema.safeParse(ek)).euerConfirmed).toMatch(/§ 241a HGB/);
  });

  test("SMOKE an abweichendes Wirtschaftsjahr only for registered companies with Bilanz", () => {
    const eu = { ...taxDefaults("einzelunternehmen"), vatId: "DE123456788", fiscalYearStartMonth: 7 };
    expect(messagesOf(taxSchema.safeParse(eu)).fiscalYearStartMonth).toMatch(/abweichendes Wirtschaftsjahr/);
    const gmbh = { ...taxDefaults("gmbh"), vatId: "DE123456788", fiscalYearStartMonth: 7 };
    expect(taxSchema.safeParse(gmbh).success).toBe(true);
  });
});

describe("Bank (F01 §5.4)", () => {
  test("SMOKE IBAN checksum, BIC format and the 70-character account holder limit", () => {
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
  test("SMOKE preview shows the next three numbers", () => {
    expect(previewNumbers("RE-{YYYY}-{####}", { year: 2026, month: 10 }, 42)).toEqual([
      "RE-2026-0042",
      "RE-2026-0043",
      "RE-2026-0044",
    ]);
  });

  test("SMOKE format errors use the F01 texts", () => {
    expect(checkFormat("RE {YYYY}-{####}", "yearly").message).toMatch(/Das Zeichen „ “ ist nicht erlaubt/);
    expect(checkFormat("RE-{YYYY}", "yearly").message).toBe("Das Format muss genau einen Zähler wie {####} enthalten.");
    expect(checkFormat("RE-{####}", "yearly").message).toMatch(/jährlicher Neustart/);
    expect(checkFormat("RE-{MM}-{####}", "monthly").message).toMatch(/monatlicher Neustart/);
    expect(checkFormat(`${"A".repeat(30)}{##########}`, "never").message).toMatch(/höchstens 36/);
    expect(checkFormat("RE-{YYYY}-{####}", "yearly").ok).toBe(true);
  });
});
