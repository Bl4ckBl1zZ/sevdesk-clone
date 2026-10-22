import { PROTOCOL_INPUT } from "@test/factories/import-protocol";
import { describe, expect, test } from "vitest";
import type { CalendarDate } from "../../time/calendar-date";
import { inspectFile } from "./files";
import { autoMap, isMappedCsvKind } from "./mapping";
import {
  buildPlan,
  EXTERNAL_TYPES,
  type ImportResolutions,
  importedKey,
  type LocalImportState,
  parseImportFiles,
  previewHashInput,
  summarizePlan,
} from "./preview";
import { buildImportProtocol } from "./protocol";

/**
 * F09 §5.3 import edge cases on small synthetic invoice lists (no real customer data): E-IMP-19 (paid in a newer
 * export, still open here), E-IMP-30 (open amount not determinable), E-IMP-31 (unresolvable Storno reference) and
 * IMP-022 (open-item reconciliation against the owner-entered sevdesk total).
 */

const TODAY = "2026-10-18" as CalendarDate;
const HEADER = "Rechnungsnummer;Typ;Rechnungsdatum;Fällig am;Kundennummer;Kunde;Netto;Steuer;Brutto;Steuersatz;Status";

function listFiles(rows: string[], header = HEADER) {
  const bytes = new TextEncoder().encode(`${header}\r\n${rows.join("\r\n")}\r\n`);
  const info = inspectFile("rechnungen.csv", bytes);
  if (!isMappedCsvKind(info.kind) || !info.headers || !info.table) throw new Error(`not a list: ${info.kind}`);
  const files = [{ id: "f1", name: "rechnungen.csv", sha256: "sha-list", kind: info.kind, table: info.table }];
  const mappings = { f1: { columns: autoMap(info.kind, info.headers) } };
  return { files, mappings, parsed: parseImportFiles(files, mappings, TODAY) };
}

const local = (over: Partial<LocalImportState> = {}): LocalImportState => ({
  today: TODAY,
  imported: {},
  registerNumbers: {},
  contactsByNumber: {},
  contactsByName: {},
  productsByNumber: {},
  documentsByNumber: {},
  ranges: [],
  opening: { date: "2026-06-01" as CalendarDate, fiscalYear: 2026, receivablesPosted: false, taxedAs: "soll" },
  ...over,
});

const OPEN_ROW = "RE-2001;Rechnung;02.03.2026;16.03.2026;1001;Muster Bau GmbH;100,00;19,00;119,00;19;Offen";

describe("sevdesk import edge cases (F09 §5.3)", () => {
  test("E-IMP-30 an open invoice without open/paid column blocks its row until the owner enters the open amount", () => {
    const { parsed } = listFiles([OPEN_ROW]);
    const blocked = buildPlan(parsed, local(), {});
    const finding = blocked.findings.find((f) => f.code === "E-IMP-30");
    expect(finding).toMatchObject({
      severity: "error",
      key: "invoice:RE-2001",
      message: "Offener Betrag für RE-2001 nicht ermittelbar. Bitte eintragen.",
    });
    expect(blocked.documents[0]?.status).toBe("error");
    expect(blocked.blocking).toBeGreaterThan(0);
    expect(blocked.opening).toBeNull();

    const entered = buildPlan(parsed, local(), { openAmounts: { "invoice:RE-2001": 11900 } });
    expect(entered.findings.some((f) => f.code === "E-IMP-30")).toBe(false);
    expect(entered.documents[0]).toMatchObject({ status: "new", openAmountCents: 11900, paymentStatus: "open" });
    expect(entered.opening?.items).toEqual([{ key: "invoice:RE-2001", openCents: 11900, notDueVat: [] }]);
    // an impossible amount (above the gross) is refused with the same code
    const wrong = buildPlan(parsed, local(), { openAmounts: { "invoice:RE-2001": 20000 } });
    expect(wrong.findings.find((f) => f.code === "E-IMP-30")?.message).toBe(
      "Der eingetragene offene Betrag für RE-2001 ist ungültig.",
    );
  });

  test("E-IMP-31 a Storno whose referenced invoice is neither in the import nor local is archived standalone with a warning", () => {
    const header = `${HEADER};Bezug`;
    const { parsed } = listFiles(
      [
        "RE-2002;Rechnung;02.03.2026;16.03.2026;1001;Muster Bau GmbH;100,00;19,00;119,00;19;Bezahlt;",
        "ST-2003;Stornorechnung;05.03.2026;;1001;Muster Bau GmbH;-50,00;-9,50;-59,50;19;Bezahlt;RE-1999",
      ],
      header,
    );
    const p = buildPlan(parsed, local(), {});
    const storno = p.documents.find((d) => d.doc.number === "ST-2003");
    expect(storno).toMatchObject({ status: "new" });
    expect(storno?.correctsKey).toBeUndefined();
    expect(storno?.correctsLocalId).toBeUndefined();
    expect(p.findings.find((f) => f.code === "E-IMP-31")).toMatchObject({
      severity: "warning",
      message: "ST-2003: Bezug zur ursprünglichen Rechnung nicht gefunden – als eigenständiger Beleg archiviert.",
    });
    // the unrelated invoice in the list is not changed automatically
    expect(p.documents.find((d) => d.doc.number === "RE-2002")).toMatchObject({ finalStatus: "sent" });
    // a local original resolves the reference: no warning
    const resolved = buildPlan(
      parsed,
      local({ documentsByNumber: { "RE-1999": { id: "doc1", type: "invoice" } } }),
      {},
    );
    expect(resolved.findings.some((f) => f.code === "E-IMP-31")).toBe(false);
    expect(resolved.documents.find((d) => d.doc.number === "ST-2003")?.correctsLocalId).toBe("doc1");
  });

  test("E-IMP-19 a re-run with a newer export lists invoices paid in sevdesk that are still open here", () => {
    const paidRow = "RE-2001;Rechnung;02.03.2026;16.03.2026;1001;Muster Bau GmbH;100,00;19,00;119,00;19;Bezahlt";
    const { parsed } = listFiles([paidRow]);
    const key = importedKey(EXTERNAL_TYPES.document, "invoice:RE-2001");
    const p = buildPlan(parsed, local({ imported: { [key]: "doc1" }, importedOpen: { [key]: 11900 } }), {});
    expect(p.documents[0]?.status).toBe("skip");
    expect(p.findings.find((f) => f.code === "E-IMP-19")).toMatchObject({
      severity: "warning",
      key: "invoice:RE-2001",
      message: "RE-2001 ist laut neuem sevdesk-Export bezahlt, hier noch offen.",
    });
    expect(p.blocking).toBe(0);
    // settled locally (or still open in sevdesk) → no discrepancy
    const settled = buildPlan(parsed, local({ imported: { [key]: "doc1" }, importedOpen: { [key]: 0 } }), {});
    expect(settled.findings.some((f) => f.code === "E-IMP-19")).toBe(false);
    const { parsed: stillOpen } = listFiles([OPEN_ROW]);
    const open = buildPlan(stillOpen, local({ imported: { [key]: "doc1" }, importedOpen: { [key]: 11900 } }), {});
    expect(open.findings.some((f) => f.code === "E-IMP-19")).toBe(false);
  });

  test("IMP-022 the open-item total is reconciled with the owner-entered sevdesk total; a difference is a warning in the preview and hash", () => {
    const { files, mappings, parsed } = listFiles([OPEN_ROW]);
    const base: ImportResolutions = { openAmounts: { "invoice:RE-2001": 11900 } };
    const same = buildPlan(parsed, local(), { ...base, expectedOpenTotalCents: 11900 });
    expect(same.openItemDifference).toBeNull();
    expect(same.findings.some((f) => f.code === "IMP-022")).toBe(false);

    const diff = buildPlan(parsed, local(), { ...base, expectedOpenTotalCents: 15900 });
    expect(diff.openItemDifference).toEqual({ expectedCents: 15900, importedCents: 11900, differenceCents: -4000 });
    expect(diff.findings.find((f) => f.code === "IMP-022")).toMatchObject({
      severity: "warning",
      message:
        "Summe der offenen Posten im Import (119,00 €) weicht von der Summe laut sevdesk (159,00 €) um 40,00 € ab. Bitte prüfen und die Abweichung vor der Übernahme bestätigen.",
    });
    expect(diff.blocking).toBe(0);
    expect(summarizePlan(diff).openItemDifference).toEqual(diff.openItemDifference);
    // without an entered total nothing is compared; the entered total is part of the preview hash
    expect(buildPlan(parsed, local(), base).openItemDifference).toBeNull();
    const h1 = previewHashInput(files, mappings, base, buildPlan(parsed, local(), base));
    const h2 = previewHashInput(files, mappings, { ...base, expectedOpenTotalCents: 15900 }, diff);
    expect(h1).not.toBe(h2);
    expect(h1).not.toContain("expectedOpenTotalCents");
  });

  test("IMP-022 IMP-024 the acknowledged open-item difference is recorded among the decisions of the import protocol", () => {
    const p = buildImportProtocol({
      ...PROTOCOL_INPUT,
      decisions: { ...PROTOCOL_INPUT.decisions, openItemDifference: { expectedCents: 15900, importedCents: 11900 } },
    });
    expect(p.sections.find((s) => s.title === "Entscheidungen")?.paragraphs).toContain(
      "Abweichung der offenen Posten bestätigt (IMP-022): Import 119,00 €, laut sevdesk 159,00 €.",
    );
  });
});
