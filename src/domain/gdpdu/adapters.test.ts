import { describe, expect, test } from "vitest";
import {
  addressLine,
  bankRow,
  buchungRow,
  dokumentRow,
  eingangsbelegRow,
  eingangsPositionRow,
  firmaRow,
  fixed,
  kontaktRow,
  kontoRow,
  nummerRow,
  positionRows,
  protokollRow,
  rechnungRow,
  supplyText,
  zahlungRow,
} from "./adapters";

// 2026-03-15T09:30:00Z → 10:30:00 in Berlin (CET).
const T = Date.UTC(2026, 2, 15, 9, 30, 0);

describe("gdpdu-v1 adapters, optional fields present and absent (EXP-019, E-EXP-30)", () => {
  test("EXP-019 addressLine skips empty parts and returns null for an empty address", () => {
    expect(addressLine(null)).toBeNull();
    expect(addressLine(undefined)).toBeNull();
    expect(addressLine({ street: "  ", city: "" })).toBeNull();
    expect(addressLine({ street: "Hauptstr. 5", street2: "Hinterhaus", city: "Köln" })).toBe(
      "Hauptstr. 5, Hinterhaus, Köln",
    );
    expect(addressLine({ countryCode: "AT", zip: "1010" })).toBe("1010, AT");
  });

  test("EXP-019 buchung: reversal references the original seq, unknown original stays null, lock time optional", () => {
    const base = {
      _id: "j2",
      seq: 7,
      date: "2026-03-15",
      period: "2026-03",
      text: "Storno RE-2026-0001",
      source: { kind: "document", id: "d9" },
      recordedAt: T,
      actor: "user:u1",
      lines: [],
    };
    const reversal = buchungRow(
      { ...base, reversalOfId: "j1", originalDate: "2026-03-01", lockedAt: T },
      (id) => (id === "j1" ? 3 : undefined),
    );
    expect(reversal).toMatchObject({
      storno_von: 3,
      belegdatum: "2026-03-01",
      festgeschrieben_am: "2026-03-15T09:30:00.000Z",
      erfasst_am: "2026-03-15T09:30:00.000Z",
    });
    expect(buchungRow({ ...base, reversalOfId: "jX" }, () => undefined).storno_von).toBeNull();
    expect(buchungRow(base, () => 1)).toMatchObject({ storno_von: null, belegdatum: null, festgeschrieben_am: null });
  });

  test("EXP-019 kontakt: person vs organisation, restricted (DSGVO) contacts flagged gesperrt", () => {
    const person = kontaktRow({ _id: "c2", number: "K-2", kind: "person", displayName: "Erika Muster" }, null);
    expect(person).toMatchObject({
      art: "Person",
      anschrift: null,
      ust_idnr: null,
      steuernummer: null,
      debitorenkonto: null,
      kreditorenkonto: null,
      gesperrt: "nein",
    });
    const org = kontaktRow(
      {
        _id: "c1",
        number: "K-1",
        kind: "organization",
        displayName: "Muster GmbH",
        vatId: "DE123456789",
        taxNumber: "201/123/45678",
        debtorAccount: "10001",
        creditorAccount: "70001",
        dsgvo: { restrictedAt: T },
      },
      { street: "Markt 1", postalCode: "52062", city: "Aachen", countryCode: "DE" },
    );
    expect(org).toMatchObject({
      art: "Organisation",
      anschrift: "Markt 1, 52062 Aachen, DE",
      ust_idnr: "DE123456789",
      steuernummer: "201/123/45678",
      debitorenkonto: "10001",
      kreditorenkonto: "70001",
      gesperrt: "ja",
    });
  });

  test("EXP-019 supplyText renders date, period and month; falls back to the document date", () => {
    expect(supplyText({ kind: "date", date: "2026-03-01" }, "2026-03-05")).toBe("2026-03-01");
    expect(supplyText({ kind: "period", from: "2026-02-01", to: "2026-02-28" }, undefined)).toBe(
      "2026-02-01 bis 2026-02-28",
    );
    expect(supplyText({ kind: "month", month: "2026-02" }, undefined)).toBe("2026-02");
    expect(supplyText(undefined, "2026-03-05")).toBe("2026-03-05");
    expect(supplyText(null, undefined)).toBeNull();
  });

  test("EXP-019 rechnung: cancelled and corrected documents show the other document's number (or id)", () => {
    const doc = {
      _id: "d1",
      type: "invoice",
      status: "cancelled",
      number: "RE-2026-0001",
      documentDate: "2026-03-05",
      dueDate: "2026-03-19",
      contactId: "c1",
      contactName: "Muster GmbH (Kontakt)",
      billingAddress: { name: "Muster GmbH (Anschrift)" },
      taxCase: "de_standard",
      currency: "EUR",
      totals: { netCents: 10000, vatCents: 1900, grossCents: 11900 },
      cancellation: { byDocumentId: "d2" },
      correctsId: "d0",
    };
    const numbers: Record<string, string> = { d2: "ST-2026-0001" };
    const row = rechnungRow(doc, null, "abc", (id) => numbers[id]);
    expect(row).toMatchObject({
      nummer: "RE-2026-0001",
      leistungsdatum: "2026-03-05",
      faellig_am: "2026-03-19",
      kontakt_id: "c1",
      empfaenger: "Muster GmbH (Anschrift)",
      storniert_durch: "ST-2026-0001",
      korrigiert: "d0",
      datei_sha256: "abc",
    });
    expect(rechnungRow(doc, "Käufer aus Snapshot", null, () => undefined).empfaenger).toBe("Käufer aus Snapshot");
    // Draft without number/date/contact: every optional column is empty.
    const draft = rechnungRow(
      {
        _id: "d3",
        type: "invoice",
        status: "draft",
        taxCase: "de_standard",
        currency: "EUR",
        totals: { netCents: 0, vatCents: 0, grossCents: 0 },
        contactName: "Nur Kontaktname",
      },
      null,
      null,
      () => undefined,
    );
    expect(draft).toMatchObject({
      nummer: null,
      belegdatum: null,
      leistungsdatum: null,
      faellig_am: null,
      kontakt_id: null,
      empfaenger: "Nur Kontaktname",
      storniert_durch: null,
      korrigiert: null,
    });
    expect(
      rechnungRow(
        { _id: "d4", type: "invoice", status: "draft", taxCase: "de_standard", currency: "EUR", totals: doc.totals },
        null,
        null,
        () => undefined,
      ).empfaenger,
    ).toBeNull();
    expect(
      rechnungRow({ ...doc, cancellation: { byDocumentId: "d2" } }, null, null, () => undefined).storniert_durch,
    ).toBe("d2");
  });

  test("EXP-019 fixed renders exact decimals for negatives, integers and padded fractions", () => {
    expect(fixed(-1500, 3)).toBe("-1,5");
    expect(fixed(2000, 3)).toBe("2");
    expect(fixed(5, 4)).toBe("0,0005");
    expect(fixed(-250, 2)).toBe("-2,5");
  });

  test("EXP-019 positions: an item without quantity, price or rate exports empty columns", () => {
    const [row] = positionRows([{ documentId: "d1", position: 1, kind: "item" }]);
    expect(row).toEqual({
      beleg_id: "d1",
      pos: 1,
      bezeichnung: null,
      menge: null,
      einheit: null,
      einzelpreis: null,
      netto: null,
      ust_kategorie: null,
      ust_satz: null,
    });
  });

  test("EXP-019 eingangsbeleg: the original file's hash wins over other files; no file → null", () => {
    const v = {
      _id: "v1",
      internalNumber: "B-2026-0001",
      documentNumber: "4711",
      supplierName: "Telekom",
      supplierContactId: "c9",
      documentDate: "2026-03-02",
      receivedAt: T,
      taxRule: "vst_19",
      currency: "EUR",
      totals: { netCents: 1000, vatCents: 190, grossCents: 1190 },
      status: "booked",
      originalFiles: [
        { sha256: "thumb", role: "derived" },
        { sha256: "orig", role: "original" },
      ],
    };
    expect(eingangsbelegRow(v)).toMatchObject({
      interne_nummer: "B-2026-0001",
      lieferanten_nummer: "4711",
      lieferant: "Telekom",
      kontakt_id: "c9",
      belegdatum: "2026-03-02",
      eingang: "2026-03-15T09:30:00.000Z",
      vorsteuer: 190,
      datei_sha256: "orig",
    });
    expect(eingangsbelegRow({ ...v, originalFiles: [{ sha256: "only", role: "derived" }] }).datei_sha256).toBe("only");
    const bare = eingangsbelegRow({
      _id: "v2",
      receivedAt: T,
      taxRule: "none",
      currency: "EUR",
      totals: { netCents: 0, vatCents: 0, grossCents: 0 },
      status: "inbox",
      originalFiles: [],
    });
    expect(bare).toMatchObject({
      interne_nummer: null,
      lieferanten_nummer: null,
      lieferant: null,
      kontakt_id: null,
      belegdatum: null,
      datei_sha256: null,
    });
  });

  test("EXP-019 eingangsposition: rates with decimal comma; non-deductible share defaults to 0,00", () => {
    const line = { voucherId: "v1", position: 1, account: "4920", netCents: 1000, vatRateBp: 700, vatCents: 70 };
    expect(eingangsPositionRow(line)).toMatchObject({ ust_satz: "7,00", nicht_abziehbar: "0,00" });
    expect(eingangsPositionRow({ ...line, nonDeductibleShareBp: 3000 }).nicht_abziehbar).toBe("30,00");
  });

  test("EXP-019 zahlung: differences listed with kind/reason/fallback label; reversal links", () => {
    const p = {
      _id: "p1",
      target: { kind: "document", id: "d1" },
      number: "RE-2026-0001",
      date: "2026-03-20",
      amountCents: 11800,
      currency: "EUR",
      source: { kind: "bank" },
      differences: [
        { kind: "skonto", amountCents: 100 },
        { reason: "Bankgebühr", amountCents: -50 },
        { amountCents: 5 },
      ],
      reversedById: "p2",
    };
    expect(zahlungRow(p)).toMatchObject({
      ziel_id: "d1",
      belegnummer: "RE-2026-0001",
      differenzen: "skonto 1; Bankgebühr -0,5; Differenz 0,05",
      storniert_durch: "p2",
      storno_von: null,
    });
    const bare = zahlungRow({
      _id: "p2",
      target: { kind: "unassigned" },
      date: "2026-03-21",
      amountCents: -11800,
      currency: "EUR",
      source: { kind: "manual" },
      differences: [],
      reversalOfId: "p1",
    });
    expect(bare).toMatchObject({ ziel_id: null, belegnummer: null, differenzen: null, storno_von: "p1" });
  });

  test("EXP-019 bank: value date and counterparty are optional", () => {
    const t = {
      _id: "t1",
      bookingDate: "2026-03-20",
      amountCents: 11900,
      currency: "EUR",
      purpose: "RE-2026-0001",
      status: "matched",
      source: { kind: "camt053" },
    };
    expect(bankRow(t, "Revolut EUR")).toMatchObject({
      konto: "Revolut EUR",
      wertstellung: null,
      gegenseite: null,
      gegenseite_iban: null,
    });
    expect(
      bankRow({ ...t, valueDate: "2026-03-21", counterpartyName: "Muster GmbH", counterpartyIban: "DE02" }, "x"),
    ).toMatchObject({ wertstellung: "2026-03-21", gegenseite: "Muster GmbH", gegenseite_iban: "DE02" });
  });

  test("EXP-019 nummernregister: reserved numbers without document/period/counter", () => {
    expect(
      nummerRow({ number: "RE-2026-0002", docType: "invoice", assignedAt: T, status: "void" }),
    ).toMatchObject({ beleg_id: null, periode: null, zaehler: null, vergeben_am: "2026-03-15T09:30:00.000Z" });
    expect(
      nummerRow({
        number: "RE-2026-0001",
        docType: "invoice",
        documentId: "d1",
        periodKey: "2026",
        counter: 1,
        assignedAt: T,
        status: "used",
      }),
    ).toMatchObject({ beleg_id: "d1", periode: "2026", zaehler: 1 });
  });

  test("EXP-019 dokument row carries hash, size and ISO creation time", () => {
    expect(
      dokumentRow({
        id: "f1",
        table: "documents",
        entityId: "d1",
        kind: "pdf",
        fileName: null,
        sha256: "aa",
        bytes: 1234,
        mime: "application/pdf",
        createdAt: T,
      }),
    ).toEqual({
      datei_id: "f1",
      entitaet: "documents",
      entitaet_id: "d1",
      art: "pdf",
      dateiname: null,
      sha256: "aa",
      bytes: 1234,
      mime: "application/pdf",
      erstellt_am: "2026-03-15T09:30:00.000Z",
    });
  });

  test("EXP-019 protokoll: Berlin local time DD.MM.YYYY HH:MM:SS, diff as JSON, optional role/label/reason", () => {
    const e = {
      seq: 1,
      at: T,
      actor: "user:u1",
      channel: "ui",
      action: "document.finalize",
      entity: { table: "documents", id: "d1" },
      hash: "h1",
      prevHash: "h0",
    };
    expect(protokollRow(e)).toMatchObject({
      zeit_utc: "2026-03-15T09:30:00.000Z",
      zeit_berlin: "15.03.2026 10:30:00",
      rolle: null,
      bezeichnung: null,
      grund: null,
      aenderung: null,
    });
    // Summer time: 2026-07-01T22:15:00Z is already 02.07. in Berlin.
    const summer = protokollRow({
      ...e,
      at: Date.UTC(2026, 6, 1, 22, 15, 0),
      actorRole: "owner",
      entity: { table: "documents", id: "d1", label: "RE-2026-0001" },
      reason: "Tippfehler",
      diff: { status: ["draft", "final"] },
    });
    expect(summer).toMatchObject({
      zeit_berlin: "02.07.2026 00:15:00",
      rolle: "owner",
      bezeichnung: "RE-2026-0001",
      grund: "Tippfehler",
      aenderung: '{"status":["draft","final"]}',
    });
  });

  test("EXP-019 firma: date-effective KU/taxation and fiscal-year profit method/chart for the exported year", () => {
    const profile = {
      name: "Muster Einzelunternehmen",
      legalForm: "einzelunternehmen",
      address: { street: "Markt 1", postalCode: "52062", city: "Aachen", countryCode: "DE" },
      taxNumber: "201/123/45678",
      vatId: "DE123456789",
      fiscalYearStartMonth: 1,
      kleinunternehmer: [
        { validFrom: "2024-01-01", isKU: true },
        { validFrom: "2026-01-01", isKU: false },
      ],
      taxationMethod: [
        { validFrom: "2024-01-01", method: "ist" },
        { validFrom: "2026-01-01", method: "soll" },
      ],
      profitMethod: [
        { validFromFiscalYear: 2024, method: "euer" },
        { validFromFiscalYear: 2026, method: "bilanz" },
      ],
      chartOfAccounts: [
        { validFromFiscalYear: 2024, chart: "SKR03" },
        { validFromFiscalYear: 2026, chart: "SKR04" },
      ],
    };
    const v = { version: 2, validFrom: "2024-01-01", supersededOn: null, profile };
    expect(firmaRow(v, 2025, "2025-01-01")).toMatchObject({
      anschrift: "Markt 1, 52062 Aachen, DE",
      kontenrahmen: "SKR03",
      gewinnermittlung: "EÜR",
      versteuerung: "Ist",
      kleinunternehmer: "ja",
      wirtschaftsjahr_beginn: 1,
    });
    expect(firmaRow(v, 2026, "2026-01-01")).toMatchObject({
      kontenrahmen: "SKR04",
      gewinnermittlung: "Bilanz",
      versteuerung: "Soll",
      kleinunternehmer: "nein",
    });
    // Before any effective row / a sparse v1 profile: nothing derivable.
    expect(firmaRow({ version: 1, validFrom: "2023-01-01", supersededOn: "2024-01-01", profile: {} }, 2023, "2023-01-01")).toEqual({
      version: 1,
      gueltig_ab: "2023-01-01",
      gueltig_bis: "2024-01-01",
      name: null,
      rechtsform: null,
      anschrift: null,
      steuernummer: null,
      ust_idnr: null,
      kontenrahmen: null,
      gewinnermittlung: null,
      versteuerung: null,
      kleinunternehmer: null,
      wirtschaftsjahr_beginn: null,
    });
    expect(firmaRow(v, 2023, "2023-01-01")).toMatchObject({ kontenrahmen: null, gewinnermittlung: null, kleinunternehmer: null });
  });

  test("EXP-019 konto: automatic VAT accounts and EÜR line mapping", () => {
    expect(kontoRow({ number: "8400", name: "Erlöse 19 % USt", type: "revenue", euerKey: "112", automaticVatAccount: true })).toEqual({
      kontonummer: "8400",
      bezeichnung: "Erlöse 19 % USt",
      kontoart: "revenue",
      euer_zeile: "112",
      automatikkonto: "ja",
    });
    expect(kontoRow({ number: "1200", name: "Bank", type: "asset" })).toMatchObject({ euer_zeile: null, automatikkonto: "nein" });
  });
});
