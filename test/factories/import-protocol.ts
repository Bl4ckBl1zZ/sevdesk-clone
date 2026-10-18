/** Synthetic input of the F09 IMP-024 import protocol (domain content test and PDF render test). */
import type { ImportProtocolInput } from "@/domain/import/sevdesk/protocol";

export const SHA = (c: string) => c.repeat(64);
const T0 = Date.UTC(2026, 9, 18, 8, 0, 0); // 10:00 Berlin (CEST)

export const PROTOCOL_INPUT: ImportProtocolInput = {
  importId: "imp123",
  importerVersion: "sevdesk-export-import@1",
  createdBy: "user:u1",
  startedAt: T0,
  commit: {
    actor: "user:u1",
    label: "inhaber@example.test",
    role: "owner",
    startedAt: T0 + 60 * 60_000,
    finishedAt: T0 + 61 * 60_000 + 5_000,
  },
  retentionUntil: "2036-12-31",
  files: [
    {
      id: "f1",
      name: "contacts.csv",
      kind: "contacts",
      detectedKind: "contacts",
      bytes: 1234,
      sha256: SHA("a"),
      rows: 2,
      encoding: "utf-8-bom",
      delimiter: ";",
    },
    {
      id: "f2",
      name: "Rechnungen_18.10.26.zip",
      kind: "zip",
      detectedKind: "zip",
      bytes: 50_000,
      sha256: SHA("b"),
      unpacked: { files: 1, ignored: ["__MACOSX/._x.pdf"] },
    },
    {
      id: "f3",
      name: "2026-06-10_Rechnung_RE-5000_0123.pdf",
      kind: "pdf",
      detectedKind: "pdf",
      bytes: 999,
      sha256: SHA("c"),
      container: "f2",
    },
    {
      id: "f4",
      name: "notizen.txt",
      kind: "unknown",
      detectedKind: "unknown",
      bytes: 5,
      sha256: SHA("d"),
      ignored: true,
    },
  ],
  mapping: { f1: { columns: { number: "Kunden-Nr.", lastName: "Nachname" } } },
  resolutions: {
    excluded: ["f5:7"],
    pdfAssignments: { "invoice:RE-5001": "f3" },
    openAmounts: { "invoice:RE-5002": 1250 },
  },
  decisions: {
    numberRanges: [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never", next: 5005 }],
    missingPdfReason: "PDF in sevdesk gelöscht",
  },
  preview: {
    findingsTotal: 3,
    findings: [
      {
        code: "E-IMP-37",
        severity: "warning",
        message: "invoices.csv enthält keine Steuer- und Positionsangaben.",
        fileName: "invoices.csv",
      },
      { code: "E-IMP-32", severity: "info", message: "Lücken in den importierten Nummern: RE-5003." },
      {
        code: "EC-190",
        severity: "warning",
        message: "RE-5000: Lieferdatum fehlt.",
        fileName: "invoices.csv",
        line: 2,
      },
    ],
    openItems: { count: 1, totalCents: 1250 },
    pdf: { orphans: ["RE-0999.pdf"], missing: ["invoice:RE-5004"] },
  },
  stats: {
    contactsNew: 2,
    invoices: 4,
    contactsCreated: 2,
    documentsCreated: 4,
    openingItemsCreated: 1,
    skipped: 0,
    custom: 7,
  },
  log: ["Eröffnungsbilanz: 1 offene Posten übernommen", "Nummernkreis invoice: RE-{####}, nächste 5005"],
};
