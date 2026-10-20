/**
 * Golden GDPdU (Z3) package for a fixed fixture (F09 TST-EXP-16, EXP-017/018/019, GOBD-11): `index.xml` of the
 * `gdpdu-v1` export schema, the journal CSVs and the README. A change here is a change of the export schema or
 * format — it needs `pnpm golden:update` and a written reason (and, for columns, a new export schema version).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buchungRow, buchungszeilenRows, kontaktRow, kontoRow, protokollRow } from "@/domain/gdpdu/adapters";
import { GDPDU_DTD, GDPDU_DTD_SHA256 } from "@/domain/gdpdu/dtd";
import { buildGdpduPackage, validateIndexXml } from "@/domain/gdpdu/write";

const td = new TextDecoder();

const entries = [
  {
    _id: "j1",
    seq: 1,
    date: "2026-02-01",
    period: "2026-02",
    text: "Rechnung RE-2026-0001 Muster GmbH",
    source: { kind: "salesDocument", id: "d1" },
    recordedAt: Date.UTC(2026, 1, 1, 9, 30),
    actor: "user:u1",
    lines: [
      { account: "1400", debitCents: 119000, creditCents: 0, contactId: "c1" },
      { account: "8400", debitCents: 0, creditCents: 100000, taxKey: "USt19", taxPeriod: "2026-02" },
      { account: "1776", debitCents: 0, creditCents: 19000, taxKey: "USt19", taxPeriod: "2026-02" },
    ],
  },
  {
    _id: "j2",
    seq: 2,
    date: "2026-02-15",
    period: "2026-02",
    text: 'Zahlung RE-2026-0001; "Skonto" 2 %',
    source: { kind: "payment", id: "p1" },
    reversalOfId: undefined,
    recordedAt: Date.UTC(2026, 1, 15, 8),
    lockedAt: Date.UTC(2026, 2, 10),
    actor: "system:bank.match",
    lines: [
      { account: "1200", debitCents: 116620, creditCents: 0 },
      { account: "8736", debitCents: 2000, creditCents: 0, taxKey: "USt19" },
      { account: "1776", debitCents: 380, creditCents: 0, taxKey: "USt19" },
      { account: "1400", debitCents: 0, creditCents: 119000, contactId: "c1" },
    ],
  },
];

function fixture() {
  return buildGdpduPackage({
    supplier: { name: "Muster Handwerk GmbH", location: "Aachen" },
    app: { name: "Rechnungen", version: "1.0.0" },
    year: 2026,
    range: { from: "2026-01-01", to: "2026-12-31" },
    encoding: "utf8",
    createdAt: "2027-01-15T10:00:00.000Z",
    rows: {
      "konten.csv": [
        kontoRow({ number: "1200", name: "Bank", type: "asset", euerKey: "NONE" }),
        kontoRow({
          number: "1400",
          name: "Forderungen aus Lieferungen und Leistungen",
          type: "asset",
          euerKey: "NONE",
        }),
        kontoRow({ number: "1776", name: "Umsatzsteuer 19 %", type: "liability", euerKey: "UST" }),
        kontoRow({
          number: "8400",
          name: "Erlöse 19 % USt",
          type: "revenue",
          euerKey: "BE",
          automaticVatAccount: true,
        }),
        kontoRow({
          number: "8736",
          name: "Gewährte Skonti 19 % USt",
          type: "revenue",
          euerKey: "BE",
          automaticVatAccount: true,
        }),
      ],
      "kontakte.csv": [
        kontaktRow(
          {
            _id: "c1",
            number: "K-0001",
            kind: "organization",
            displayName: "Muster GmbH",
            vatId: "DE123456789",
            debtorAccount: "10001",
          },
          { street: "Markt 1", postalCode: "52062", city: "Aachen", countryCode: "DE" },
        ),
      ],
      "buchungen.csv": entries.map((e) => buchungRow(e, () => undefined)),
      "buchungszeilen.csv": entries.flatMap((e) => buchungszeilenRows(e)),
      "protokoll.csv": [
        protokollRow({
          seq: 41,
          at: Date.UTC(2026, 1, 1, 9, 30),
          actor: "user:u1",
          actorRole: "owner",
          channel: "ui",
          action: "document.finalize",
          entity: { table: "salesDocuments", id: "d1", label: "RE-2026-0001" },
          diff: { after: { status: "open", number: "RE-2026-0001" } },
          hash: "a".repeat(64),
          prevHash: "b".repeat(64),
        }),
      ],
    },
    dbCounts: { "buchungen.csv": 2, "buchungszeilen.csv": 7 },
    internalSchemaVersions: ["2026.10.18"],
    restrictedContacts: 0,
    purges: [],
  });
}

describe("golden GDPdU package (TST-EXP-16)", () => {
  test("EXP-017 the shipped DTD constant equals the official file (reference copy in test/fixtures/gdpdu)", () => {
    const official = readFileSync(join(__dirname, "../fixtures/gdpdu/gdpdu-01-09-2004.dtd"));
    expect(createHash("sha256").update(official).digest("hex")).toBe(GDPDU_DTD_SHA256);
    expect(Buffer.from(GDPDU_DTD, "utf8").equals(official)).toBe(true);
  });

  const r = fixture();
  if (!r.ok) throw new Error(r.errors.join("\n"));
  const files = r.value.files;

  test("TST-EXP-16 EXP-017 GOBD-11 index.xml (gdpdu-v1) is DTD-valid and unchanged", async () => {
    const xml = td.decode(files["index.xml"]);
    expect(validateIndexXml(xml)).toEqual([]);
    await expect(xml).toMatchFileSnapshot("./gdpdu/fixture-2026/index.xml");
  });

  for (const name of [
    "buchungen.csv",
    "buchungszeilen.csv",
    "kontakte.csv",
    "konten.csv",
    "protokoll.csv",
    "README.txt",
  ]) {
    test(`TST-EXP-16 EXP-018 ${name}`, async () => {
      await expect(td.decode(files[name])).toMatchFileSnapshot(`./gdpdu/fixture-2026/${name}`);
    });
  }
});
