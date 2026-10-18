import { describe, expect, test } from "vitest";
import { sevdeskFixtureBytes } from "../../../../test/fixtures/sevdesk-export/load";
import { inspectFile } from "./files";
import { applyPreset, autoMap, checkMapping, classifyFile, missingColumnMessage, perRateTarget } from "./mapping";

const enc = (s: string) => new TextEncoder().encode(s);

describe("F09 IMP-016 file classification", () => {
  test("TST-IMP-16 IMP-016 the synthetic export set is classified by content and header", () => {
    expect(inspectFile("kontakte.csv", sevdeskFixtureBytes("kontakte.csv")).kind).toBe("contacts");
    const articles = inspectFile("artikel.csv", sevdeskFixtureBytes("artikel.csv"));
    expect(articles).toMatchObject({ kind: "products", encoding: "windows-1252", delimiter: ";" });
    expect(articles.table?.records[1]?.cells[1]).toBe("Fachbuch „Steuern“ für Gründer");
    expect(inspectFile("rechnungen.csv", sevdeskFixtureBytes("rechnungen.csv"))).toMatchObject({
      kind: "invoices",
      encoding: "utf-8",
    });
    expect(inspectFile("RE-1001.pdf", sevdeskFixtureBytes("pdf/RE-1001.pdf")).kind).toBe("pdf");
  });

  test("IMP-016 E-IMP-20 magic bytes, DATEV header, XML and unknown files", () => {
    const head = (s: string) => enc(s).subarray(0, 16);
    expect(classifyFile({ name: "x.bin", head: new Uint8Array([0x50, 0x4b, 0x03, 0x04]) })).toBe("zip");
    expect(classifyFile({ name: "rechnung.xml", head: head("<?xml") })).toBe("xml");
    expect(
      classifyFile({ name: "EXTF_Buchungsstapel.csv", head: head('"EXTF";700'), firstLine: '"EXTF";700;21' }),
    ).toBe("datev");
    expect(inspectFile("notizen.txt", enc("Hallo;Welt\n1;2\n")).kind).toBe("unknown");
    expect(
      classifyFile({
        name: "belege.csv",
        head: head("B"),
        headers: ["Belegnummer", "Belegdatum", "Lieferant", "Brutto"],
      }),
    ).toBe("vouchers");
  });
});

describe("F09 IMP-017 header-name column mapping", () => {
  test("IMP-017 shipped presets map the sevdesk headers by normalised name", () => {
    const inv = inspectFile("rechnungen.csv", sevdeskFixtureBytes("rechnungen.csv"));
    const m = autoMap("invoices", inv.headers ?? []);
    expect(m).toMatchObject({
      number: "Rechnungsnummer",
      type: "Typ",
      documentDate: "Rechnungsdatum",
      supplyDate: "Lieferdatum",
      dueDate: "Fällig am",
      customerNumber: "Kundennummer",
      customerName: "Kunde",
      net: "Netto",
      vat: "Steuer",
      gross: "Brutto",
      rate: "Steuersatz",
      taxRule: "Steuerregel",
      status: "Status",
      open: "Offener Betrag",
      currency: "Währung",
      reference: "Bezug",
    });
    expect(checkMapping("invoices", inv.headers ?? [], m)).toEqual({
      missing: [],
      unmapped: [],
      conflicts: [],
      unknownHeaders: [],
    });
    const art = inspectFile("artikel.csv", sevdeskFixtureBytes("artikel.csv"));
    expect(autoMap("products", art.headers ?? [])).toEqual({
      number: "Artikelnummer",
      name: "Name",
      description: "Beschreibung",
      unit: "Einheit",
      netPrice: "Preis (netto)",
      vat: "Steuersatz",
    });
    const con = inspectFile("kontakte.csv", sevdeskFixtureBytes("kontakte.csv"));
    expect(autoMap("contacts", con.headers ?? [])).toMatchObject({ number: "Kundennummer", vatId: "USt-IdNr." });
  });

  test("TST-IMP-17 E-IMP-21 renamed headers leave a required field unmapped; a saved preset maps them again", () => {
    const headers = ["Beleg-Nr", "Ausgestellt", "Gesamt (EUR)", "Kunde", "Name"];
    const auto = autoMap("invoices", headers);
    const check = checkMapping("invoices", headers, auto);
    expect(check.missing).toEqual(["number", "documentDate", "gross"]);
    expect(missingColumnMessage("rechnungen.csv", "invoices", "number")).toBe(
      "In rechnungen.csv fehlt die Spalte für Rechnungsnummer. Bitte Spaltenzuordnung ergänzen.",
    );
    // the ambiguous customer header is shown as a conflict (highest-priority candidate taken)
    expect(check.conflicts).toEqual([{ target: "customerName", headers: ["Kunde", "Name"] }]);
    expect(auto.customerName).toBe("Kunde");
    const saved = { number: "Beleg-Nr", documentDate: "Ausgestellt", gross: "Gesamt (EUR)", customerName: "Kunde" };
    // a later export spells the headers slightly differently — the preset matches by normalised name
    const later = ["BELEG NR", "ausgestellt", "Gesamt (EUR)", "Kunde"];
    const applied = applyPreset(later, saved);
    expect(applied).toEqual({
      number: "BELEG NR",
      documentDate: "ausgestellt",
      gross: "Gesamt (EUR)",
      customerName: "Kunde",
    });
    expect(checkMapping("invoices", later, applied).missing).toEqual([]);
  });

  test("IMP-020 per-rate amount columns are detected and replace the gross column", () => {
    expect(perRateTarget("Netto 19 %")).toBe("net@1900");
    expect(perRateTarget("USt. 7%")).toBe("vat@700");
    expect(perRateTarget("Brutto 19,00 %")).toBe("gross@1900");
    expect(perRateTarget("Netto")).toBeNull();
    const headers = ["Rechnungsnummer", "Datum", "Netto 19 %", "USt 19 %", "Netto 7 %", "USt 7 %"];
    const m = autoMap("invoices", headers);
    expect(m).toMatchObject({ "net@1900": "Netto 19 %", "vat@1900": "USt 19 %", "net@700": "Netto 7 %" });
    expect(checkMapping("invoices", headers, m).missing).toEqual([]);
  });
});
