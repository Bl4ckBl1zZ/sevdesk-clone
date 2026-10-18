import { describe, expect, test } from "vitest";
import { type ImportedDocument, openVatSplit, parseInvoiceRow } from "./invoices";
import { autoMap } from "./mapping";

const HEADERS = [
  "Rechnungsnummer",
  "Typ",
  "Rechnungsdatum",
  "Lieferdatum",
  "Kunde",
  "Netto",
  "Steuer",
  "Brutto",
  "Steuersatz",
  "Steuerregel",
  "Status",
  "Offener Betrag",
  "Bezahlter Betrag",
  "Währung",
];
const ctx = { fileId: "f1", fileName: "rechnungen.csv", numberFormat: "de", dateFormat: "dmy" } as const;

type Row = Partial<Record<(typeof HEADERS)[number], string>>;
function parse(row: Row, headers: readonly string[] = HEADERS) {
  const base: Row = {
    Rechnungsnummer: "RE-1",
    Typ: "Rechnung",
    Rechnungsdatum: "15.01.2026",
    Lieferdatum: "15.01.2026",
    Kunde: "Muster GmbH",
    Währung: "EUR",
  };
  const merged = { ...base, ...row };
  return parseInvoiceRow(
    7,
    headers.map((h) => merged[h] ?? ""),
    headers,
    autoMap("invoices", headers),
    ctx,
  );
}
const doc = (r: ReturnType<typeof parse>): ImportedDocument => {
  if (r.kind !== "row" || !r.doc) throw new Error(JSON.stringify(r.findings));
  return r.doc;
};
const codes = (r: ReturnType<typeof parse>) => r.findings.map((f) => f.code);

describe("F09 IMP-020 document reconstruction from list rows", () => {
  test("IMP-020 IMP-003 header data, amounts in cents and one summary group per rate", () => {
    const d = doc(
      parse({ Netto: "1.000,00", Steuer: "190,00", Brutto: "1.190,00", Steuersatz: "19", "Offener Betrag": "0,00" }),
    );
    expect(d).toMatchObject({
      key: "invoice:RE-1",
      rowRef: "f1:7",
      type: "invoice",
      number: "RE-1",
      documentDate: "2026-01-15",
      supplyDate: "2026-01-15",
      sentOn: "2026-01-15",
      sentOnAssumed: true,
      taxCase: "domestic",
      totals: { netCents: 100000, vatCents: 19000, grossCents: 119000 },
      groups: [{ category: "S", rateBp: 1900, netCents: 100000, vatCents: 19000, grossCents: 119000 }],
      openAmountCents: 0,
      openSource: "open_column",
    });
  });

  test("IMP-020 per-rate columns give one summary group per VAT rate; totals stay authoritative", () => {
    const headers = [
      "Rechnungsnummer",
      "Rechnungsdatum",
      "Kunde",
      "Netto 19 %",
      "USt 19 %",
      "Netto 7 %",
      "USt 7 %",
      "Brutto",
      "Offen",
    ];
    const r = parseInvoiceRow(
      2,
      ["RE-9", "01.03.2026", "A", "100,00", "19,00", "50,00", "3,50", "172,50", "172,50"],
      headers,
      autoMap("invoices", headers),
      ctx,
    );
    const d = doc(r);
    expect(d.groups).toEqual([
      { category: "S", rateBp: 1900, netCents: 10000, vatCents: 1900, grossCents: 11900 },
      { category: "S", rateBp: 700, netCents: 5000, vatCents: 350, grossCents: 5350 },
    ]);
    expect(d.totals).toEqual({ netCents: 15000, vatCents: 2250, grossCents: 17250 });
    expect(openVatSplit(d, 17250)).toEqual([
      { rateBp: 1900, vatCents: 1900 },
      { rateBp: 700, vatCents: 350 },
    ]);
  });

  test("E-IMP-08 inconsistent sums are imported as-is with a warning", () => {
    const r = parse({ Netto: "100,00", Steuer: "19,00", Brutto: "119,01", Steuersatz: "19", Status: "Bezahlt" });
    expect(doc(r).totals).toEqual({ netCents: 10000, vatCents: 1900, grossCents: 11901 });
    expect(r.findings.find((f) => f.code === "E-IMP-08")?.message).toBe(
      "Summen von RE-1 weichen um 0,01 € ab (übernommen wie im sevdesk-Export).",
    );
  });
});

describe("F09 IMP-010 tax information → tax case (§4.3.2, conservative)", () => {
  test("TST-IMP-10 OSS label, unknown label and 0 % without label → unknown_imported + E-IMP-09; 19 % without label → domestic", () => {
    const oss = parse({
      Netto: "100,00",
      Steuer: "19,00",
      Brutto: "119,00",
      Steuerregel: "Fernverkäufe (OSS)",
      Status: "Bezahlt",
    });
    const unknown = parse({
      Netto: "100,00",
      Steuer: "0,00",
      Brutto: "100,00",
      Steuerregel: "Sonderregel XY",
      Status: "Bezahlt",
    });
    const zero = parse({ Netto: "100,00", Steuer: "0,00", Brutto: "100,00", Status: "Bezahlt" });
    for (const r of [oss, unknown, zero]) {
      expect(doc(r).taxCase).toBe("unknown_imported");
      expect(codes(r)).toContain("E-IMP-09");
    }
    expect(oss.findings.find((f) => f.code === "E-IMP-09")?.message).toBe(
      "RE-1: Steuerangabe nicht eindeutig zuordenbar – nur archiviert, nicht steuerlich ausgewertet.",
    );
    const plain = parse({ Netto: "100,00", Steuer: "19,00", Brutto: "119,00", Status: "Bezahlt" });
    expect(doc(plain).taxCase).toBe("domestic");
    expect(doc(plain).groups[0]).toMatchObject({ category: "S", rateBp: 1900 });
    expect(codes(plain)).not.toContain("E-IMP-09");
  });

  test("IMP-010 the rate must be valid on the document date (date-effective table): 16 % in 2020-H2 yes, in 2026 no", () => {
    const h2 = parse({
      Rechnungsdatum: "15.09.2020",
      Netto: "100,00",
      Steuer: "16,00",
      Brutto: "116,00",
      Status: "Bezahlt",
    });
    expect(doc(h2)).toMatchObject({ taxCase: "domestic", groups: [{ rateBp: 1600 }] });
    const now = parse({ Netto: "100,00", Steuer: "16,00", Brutto: "116,00", Status: "Bezahlt" });
    expect(doc(now)).toMatchObject({ taxCase: "unknown_imported", groups: [{ category: "S", rateBp: 1600 }] });
  });

  test("IMP-010 labels map to their case; a non-domestic label with VAT is not trusted", () => {
    const igl = parse({
      Netto: "2.000,00",
      Steuer: "0,00",
      Brutto: "2.000,00",
      Steuerregel: "Innergemeinschaftliche Lieferungen",
      Status: "Bezahlt",
    });
    expect(doc(igl)).toMatchObject({ taxCase: "intra_community_supply", groups: [{ category: "K", rateBp: 0 }] });
    const ku = parse({
      Netto: "50,00",
      Steuer: "",
      Brutto: "50,00",
      Steuerregel: "Kleinunternehmer (keine USt)",
      Status: "Bezahlt",
    });
    expect(doc(ku)).toMatchObject({ taxCase: "kleinunternehmer", groups: [{ category: "KU" }] });
    const bad = parse({
      Netto: "100,00",
      Steuer: "19,00",
      Brutto: "119,00",
      Steuerregel: "Ausfuhren",
      Status: "Bezahlt",
    });
    expect(doc(bad).taxCase).toBe("unknown_imported");
  });
});

describe("F09 §4.3.3 status mapping and IMP-007 open amounts", () => {
  const amounts = { Netto: "100,00", Steuer: "19,00", Brutto: "119,00" };

  test("IMP-007 precedence: open column → gross − paid column → status „Bezahlt“ → E-IMP-30 (not determinable)", () => {
    expect(doc(parse({ ...amounts, "Offener Betrag": "19,00", "Bezahlter Betrag": "0,00" })).openAmountCents).toBe(
      1900,
    );
    expect(doc(parse({ ...amounts, "Bezahlter Betrag": "100,00" }))).toMatchObject({
      openAmountCents: 1900,
      openSource: "paid_column",
    });
    expect(doc(parse({ ...amounts, Status: "Bezahlt" }))).toMatchObject({
      openAmountCents: 0,
      openSource: "status_paid",
    });
    expect(doc(parse({ ...amounts, Status: "Offen" })).openAmountCents).toBeUndefined();
  });

  test("§4.3.3 drafts and reminders are skipped; „Storniert“ marks the original; amounts beat the status text", () => {
    expect(parse({ ...amounts, Status: "Entwurf", Rechnungsnummer: "" })).toMatchObject({
      kind: "skipped",
      reason: "draft",
    });
    expect(parse({ ...amounts, Typ: "Mahnung" })).toMatchObject({ kind: "skipped", reason: "reminder" });
    const cancelled = doc(parse({ ...amounts, Status: "Storniert" }));
    expect(cancelled).toMatchObject({ cancelledByStatus: true });
    expect(cancelled.openAmountCents).toBeUndefined();
    const contradiction = parse({ ...amounts, Status: "Bezahlt", "Offener Betrag": "119,00" });
    expect(doc(contradiction).openAmountCents).toBe(11900);
    expect(codes(contradiction)).toContain("E-IMP-08");
  });

  test("§4.3.1 type texts: Gutschrift → correction, Stornorechnung → cancellation (with reference), unknown type → row error", () => {
    expect(doc(parse({ ...amounts, Typ: "Gutschrift" })).type).toBe("correction");
    expect(doc(parse({ ...amounts, Typ: "SR" })).type).toBe("cancellation");
    const unknown = parse({ ...amounts, Typ: "Lieferschein" });
    expect(unknown.kind === "row" && unknown.doc).toBe(undefined);
    expect(unknown.findings[0]).toMatchObject({ code: "E-IMP-16", severity: "error", line: 7, rowRef: "f1:7" });
    expect(unknown.findings[0]?.message).toBe("Zeile 7: Belegart „Lieferschein“ ist unbekannt.");
  });

  test("E-IMP-16 invalid values are row errors with the file line; E-IMP-33 foreign currency is flagged", () => {
    const bad = parse({ ...amounts, Rechnungsdatum: "31.02.2026" });
    expect(bad.findings[0]?.message).toBe("Zeile 7: Rechnungsdatum: Datum „31.02.2026“ ist ungültig.");
    const usd = parse({ ...amounts, Währung: "usd", Status: "Bezahlt" });
    expect(doc(usd).currency).toBe("USD");
    expect(usd.findings.find((f) => f.code === "E-IMP-33")?.message).toBe(
      "RE-1 ist in USD – bitte EUR-Betrag des offenen Postens prüfen.",
    );
  });

  test("EC-190 deviations from current rules are listed, never enforced", () => {
    const d = doc(parse({ ...amounts, Lieferdatum: "", Status: "Bezahlt" }));
    expect(d.deviations).toContain("Kein Leistungsdatum angegeben (§ 14 Abs. 4 Nr. 6 UStG).");
  });
});
