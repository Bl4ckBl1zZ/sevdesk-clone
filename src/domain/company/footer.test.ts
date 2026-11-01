import { describe, expect, test } from "vitest";
import { type FooterCompany, footerDeltaMessage, geschaeftsbriefFooter, labelledGeschaeftsbriefFooter } from "./footer";

const GMBH: FooterCompany = {
  legalForm: "gmbh",
  name: "Muster Design GmbH",
  address: { street: "Hauptstr. 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
  seat: "Berlin",
  contact: { name: "Erika Musterfrau", phone: "+49 30 123456", email: "info@muster.de", website: "https://muster.de" },
  register: { court: "Amtsgericht Charlottenburg", type: "HRB", number: "123456 B" },
  representatives: [{ name: "Max Mustermann" }],
  taxNumber: "1127081508155",
  taxNumberState: "BE",
  vatId: "DE123456788",
};
const ACCOUNT = { iban: "DE89370400440532013000", bic: "COBADEFFXXX", accountHolder: "Muster Design GmbH" };

describe("SET-013 Geschäftsbrief footer (MAIL-03)", () => {
  test("SET-013 T-SET-005 GmbH: company/contact · register, Geschäftsführer, tax IDs · bank account", () => {
    expect(geschaeftsbriefFooter(GMBH, [ACCOUNT])).toEqual({
      columns: [
        [
          "Muster Design GmbH",
          "Hauptstr. 1",
          "10115 Berlin",
          "Tel. +49 30 123456",
          "info@muster.de",
          "https://muster.de",
        ],
        [
          "Sitz: Berlin",
          "Registergericht: Amtsgericht Charlottenburg",
          "HRB 123456 B",
          "Geschäftsführer: Max Mustermann",
          "Steuernummer: 27/815/08155",
          "USt-IdNr.: DE123456788",
        ],
        ["IBAN: DE89 3704 0044 0532 0130 00", "BIC: COBADEFFXXX"],
      ],
    });
  });

  test("SET-013 T-SET-009 GmbH & Co. KG prints the Komplementär block", () => {
    const footer = geschaeftsbriefFooter(
      {
        ...GMBH,
        legalForm: "gmbh_co_kg",
        name: "Muster GmbH & Co. KG",
        register: { court: "Amtsgericht Hamburg", type: "HRA", number: "4711" },
        representatives: [],
        generalPartner: {
          name: "Muster Verwaltungs GmbH",
          seat: "Hamburg",
          registerCourt: "Amtsgericht Hamburg",
          registerNumber: "HRB 99",
          managingDirectors: ["Max Mustermann", "Erika Musterfrau"],
        },
      },
      [],
    );
    expect(footer.columns[1]).toEqual([
      "Sitz: Berlin",
      "Registergericht: Amtsgericht Hamburg",
      "HRA 4711",
      "Persönlich haftende Gesellschafterin: Muster Verwaltungs GmbH, Sitz Hamburg, Amtsgericht Hamburg HRB 99",
      "Geschäftsführer der Komplementärin: Max Mustermann, Erika Musterfrau",
      "Steuernummer: 27/815/08155",
      "USt-IdNr.: DE123456788",
    ]);
    expect(footer.columns[2]).toEqual([]);
  });

  test("SET-013 AG: Vorstand with Vorsitz, Aufsichtsratsvorsitz and share capital with outstanding contributions", () => {
    const footer = geschaeftsbriefFooter(
      {
        ...GMBH,
        legalForm: "ag",
        name: "Muster AG",
        representatives: [{ name: "Anna Alpha", role: "chair" }, { name: "Bernd Beta" }],
        supervisoryBoardChair: "Clara Gamma",
        shareCapital: { amountCents: 5_000_000, outstandingCents: 1_000_000 },
      },
      [],
    );
    expect(footer.columns[1]).toEqual([
      "Sitz: Berlin",
      "Registergericht: Amtsgericht Charlottenburg",
      "HRB 123456 B",
      "Vorstand: Anna Alpha (Vorsitz), Bernd Beta",
      "Vorsitz des Aufsichtsrats: Clara Gamma",
      "Grundkapital: 50.000,00\u00a0€ (ausstehende Einlagen: 10.000,00\u00a0€)",
      "Steuernummer: 27/815/08155",
      "USt-IdNr.: DE123456788",
    ]);
  });

  test("SET-013 Einzelunternehmen: name, trade name, address, tax ID; no register block; holder printed if different", () => {
    const footer = geschaeftsbriefFooter(
      {
        legalForm: "einzelunternehmen",
        name: "Max Mustermann",
        tradeName: "Muster Design",
        address: { street: "", poBox: "Postfach 12 34", postalCode: "80331", city: "München", countryCode: "DE" },
        contact: { name: "Max Mustermann", phone: "089 123456", email: "max@muster.de" },
        representatives: [],
        vatId: "DE123456788",
      },
      [{ iban: "DE89370400440532013000", accountHolder: "Max Mustermann e. K." }],
    );
    expect(footer.columns).toEqual([
      ["Max Mustermann", "Muster Design", "Postfach 12 34", "80331 München", "Tel. 089 123456", "max@muster.de"],
      ["USt-IdNr.: DE123456788"],
      ["IBAN: DE89 3704 0044 0532 0130 00", "Kontoinhaber: Max Mustermann e. K."],
    ]);
  });

  test("SET-013 a foreign address prints the country; all invoice accounts are listed when the layout says so", () => {
    const footer = geschaeftsbriefFooter(
      { ...GMBH, address: { ...GMBH.address, countryCode: "AT", postalCode: "1010", city: "Wien" } },
      [ACCOUNT, { iban: "DE02120300000000202051", accountHolder: "Muster Design GmbH", name: "Rücklagen" }],
      { allInvoiceAccounts: true },
    );
    expect(footer.columns[0]).toContain("Österreich");
    expect(footer.columns[2]).toEqual([
      "IBAN: DE89 3704 0044 0532 0130 00",
      "BIC: COBADEFFXXX",
      "Rücklagen: IBAN DE02 1203 0000 0000 2020 51",
    ]);
  });

  test("SET-013 the legal-form change shows the delta message", () => {
    expect(footerDeltaMessage("einzelunternehmen", "gmbh")).toBe(
      "Pflichtangaben im Fußtext: + Sitz, + Registergericht, + HRB, + Geschäftsführer",
    );
    expect(footerDeltaMessage("gmbh", "einzelunternehmen")).toBeNull();
  });
});

describe("SET-071 labelled footer of the layout sevdesk (MAIL-03)", () => {
  const SOLE: FooterCompany = {
    ...GMBH,
    legalForm: "einzelunternehmen",
    name: "Lena Kleinert",
    seat: "",
    register: undefined,
    representatives: [],
    contact: { name: "Lena", phone: "0341 555", email: "hallo@example.org" },
  };

  test("SET-071 sole trader: address · contact · tax IDs and owner · bank, like the sevdesk footer", () => {
    expect(
      labelledGeschaeftsbriefFooter(SOLE, [
        { ...ACCOUNT, bankName: "Revolut Bank UAB", accountHolder: "Lena Kleinert" },
      ]),
    ).toEqual([
      [{ value: "Lena Kleinert" }, { value: "Hauptstr. 1" }, { value: "10115 Berlin" }, { value: "Deutschland" }],
      [
        { label: "Tel.", value: "0341 555" },
        { label: "E-Mail", value: "hallo@example.org" },
      ],
      [
        { label: "USt.-ID", value: "DE123456788" },
        { label: "Steuer-Nr.", value: expect.any(String) },
        { label: "Inhaber/-in", value: "Lena Kleinert", stacked: true },
      ],
      [
        { label: "Bank", value: "Revolut Bank UAB" },
        { label: "IBAN", value: "DE89370400440532013000" },
        { label: "BIC", value: "COBADEFFXXX" },
      ],
    ]);
  });

  test("MAIL-03 GmbH: every item of the legal column survives the labelling", () => {
    const flat = labelledGeschaeftsbriefFooter(GMBH, [ACCOUNT])
      .flat()
      .map((f) => f.value);
    const legal = geschaeftsbriefFooter(GMBH, [ACCOUNT]).columns[1];
    expect(legal.length).toBeGreaterThan(3);
    for (const line of legal) expect(flat.some((v) => line.endsWith(v))).toBe(true);
  });

  test("SET-051 the option „alle Rechnungskonten“ lists the further accounts", () => {
    const [, , , bank] = labelledGeschaeftsbriefFooter(
      GMBH,
      [ACCOUNT, { name: "Zweitkonto", iban: "DE02120300000000202051", accountHolder: "Muster Design GmbH" }],
      { allInvoiceAccounts: true },
    );
    expect(bank).toContainEqual({ label: "Zweitkonto", value: "DE02120300000000202051" });
  });
});
