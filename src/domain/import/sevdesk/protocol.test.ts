import { PROTOCOL_INPUT, SHA } from "@test/factories/import-protocol";
import { describe, expect, test } from "vitest";
import { buildImportProtocol } from "./protocol";

const text = (p: ReturnType<typeof buildImportProtocol>) =>
  p.sections
    .flatMap((s) => [
      s.title,
      ...(s.paragraphs ?? []),
      ...(s.table ? [s.table.headers, ...s.table.rows].map((r) => r.join(" | ")) : []),
    ])
    .join("\n");

describe("IMP-024 import protocol content", () => {
  test("IMP-024 header: import id, importer version, actor with role, start/end times in Berlin time, retention", () => {
    const p = buildImportProtocol(PROTOCOL_INPUT);
    expect(p.title).toBe("Importprotokoll sevdesk-Export");
    expect(p.fileName).toBe("Importprotokoll_2026-10-18_imp123.pdf");
    const head = p.sections[0];
    expect(head?.title).toBe("Import");
    expect(head?.table?.rows).toEqual([
      ["Import-ID", "imp123"],
      ["Quelle", "sevdesk-Export (Dateiexporte, keine API)"],
      ["Importer-Version", "sevdesk-export-import@1"],
      ["Projekt angelegt", "18.10.2026, 10:00:00 (Europe/Berlin) von user:u1"],
      ["Übernahme gestartet", "18.10.2026, 11:00:00 (Europe/Berlin)"],
      ["Übernahme abgeschlossen", "18.10.2026, 11:01:05 (Europe/Berlin)"],
      ["Übernommen von", "inhaber@example.test (user:u1, Inhaber)"],
      ["Aufbewahrung bis", "31.12.2036 (Quelldateien und dieses Protokoll)"],
    ]);
  });

  test("IMP-024 every source file with full SHA-256, kind, size and its ZIP; skipped ZIP entries are listed", () => {
    const p = buildImportProtocol(PROTOCOL_INPUT);
    const files = p.sections.find((s) => s.title === "Quelldateien");
    expect(files?.table?.headers).toEqual(["Nr.", "Datei", "Dateiart", "Bytes", "SHA-256"]);
    expect(files?.table?.rows).toEqual([
      ["f1", "contacts.csv", "Kontakte (CSV)", "1.234", SHA("a")],
      ["f2", "Rechnungen_18.10.26.zip", "ZIP-Archiv (entpackt: 1 Datei)", "50.000", SHA("b")],
      ["f3", "2026-06-10_Rechnung_RE-5000_0123.pdf (aus f2)", "Beleg-PDF", "999", SHA("c")],
      ["f4", "notizen.txt", "Unbekannt (ignoriert)", "5", SHA("d")],
    ]);
    expect(files?.paragraphs).toContain(
      "Beim Entpacken von f2 übersprungen (Betriebssystem-Dateien): __MACOSX/._x.pdf",
    );
  });

  test("IMP-024 mapping per CSV file with German field labels, encoding and delimiter", () => {
    const p = buildImportProtocol(PROTOCOL_INPUT);
    const m = p.sections.find((s) => s.title === "Spaltenzuordnung");
    expect(m?.paragraphs?.[0]).toBe(
      "f1 contacts.csv – Kontakte (CSV), Kodierung utf-8-bom, Trennzeichen „;“, 2 Zeilen",
    );
    expect(m?.table?.headers).toEqual(["Datei", "Feld", "Spalte in der Datei"]);
    expect(m?.table?.rows.map((r) => r[0])).toEqual(["f1", "f1"]);
    expect(m?.table?.rows.map((r) => r[2])).toEqual(["Kunden-Nr.", "Nachname"]);
  });

  test("IMP-024 counts, number-range decisions, owner resolutions and the missing-PDF reason", () => {
    const t = text(buildImportProtocol(PROTOCOL_INPUT));
    expect(t).toContain("Neue Kontakte | 2");
    expect(t).toContain("Angelegte Belege | 4");
    expect(t).toContain("custom | 7");
    expect(t).toContain("Summe offene Posten | 1 · 12,50 €");
    expect(t).toContain("Rechnungen | RE-{####} | nie | 5005");
    expect(t).toContain("Ohne Original-PDF übernommen, Begründung: PDF in sevdesk gelöscht");
    expect(t).toContain("Ausgeschlossene Zeilen (1): f5:7");
    expect(t).toContain("Manuelle PDF-Zuordnungen (1): invoice:RE-5001 → f3");
    expect(t).toContain("Eingetragene offene Beträge (1): invoice:RE-5002 = 12,50 €");
  });

  test("IMP-024 E-IMP-32 EC-190 findings summary per code plus every stored finding; open points; run log", () => {
    const p = buildImportProtocol(PROTOCOL_INPUT);
    const f = p.sections.find((s) => s.title === "Befunde und Abweichungen");
    expect(f?.table?.rows).toEqual([
      ["E-IMP-37", "Warnung", "invoices.csv", "invoices.csv enthält keine Steuer- und Positionsangaben."],
      ["EC-190", "Warnung", "invoices.csv:2", "RE-5000: Lieferdatum fehlt."],
      ["E-IMP-32", "Hinweis", "", "Lücken in den importierten Nummern: RE-5003."],
    ]);
    expect(f?.paragraphs?.[0]).toBe("3 Befunde: 0 Fehler, 2 Warnungen, 1 Hinweis.");
    const t = text(p);
    expect(t).toContain("PDFs ohne Beleg in der Liste (nicht übernommen): RE-0999.pdf");
    expect(t).toContain("Belege ohne Original-PDF: invoice:RE-5004");
    expect(t).toContain("Ignorierte Dateien: f4 notizen.txt");
    expect(t).toContain("Eröffnungsbilanz: 1 offene Posten übernommen");
  });

  test("IMP-024 a capped finding list says how many were stored", () => {
    const p = buildImportProtocol({
      ...PROTOCOL_INPUT,
      preview: { ...PROTOCOL_INPUT.preview, findingsTotal: 900 },
    });
    expect(p.sections.find((s) => s.title === "Befunde und Abweichungen")?.paragraphs).toContain(
      "Die Vorschau speichert höchstens 500 Befunde: aufgeführt sind 3 von 900.",
    );
  });

  test("IMP-024 the content is deterministic (same input → same protocol)", () => {
    expect(JSON.stringify(buildImportProtocol(PROTOCOL_INPUT))).toBe(
      JSON.stringify(buildImportProtocol(PROTOCOL_INPUT)),
    );
  });
});
