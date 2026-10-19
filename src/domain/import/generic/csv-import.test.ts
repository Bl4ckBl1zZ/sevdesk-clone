import { describe, expect, test } from "vitest";
import { readCsvRecords } from "../../csv/csv";
import {
  buildGenericPlan,
  checkGenericMapping,
  type GenericLocalState,
  genericErrorCsv,
  genericKeys,
  idempotencyKey,
  parseGenericRows,
  presetLabel,
  summarizeGenericPlan,
  withIdempotencyKeys,
} from "./csv-import";

const enc1252 = (text: string) => Uint8Array.from([...text].map((ch) => (ch === "ü" ? 0xfc : ch.charCodeAt(0))));

const CONTACTS =
  "Kundennummer;Firma;Straße;PLZ;Ort;E-Mail;USt-IdNr\r\n" +
  "K-1;Müller GmbH;Hauptstr. 1;10115;Berlin;info@mueller.example;DE123456788\r\n" +
  "K-2;;;;;;\r\n" +
  "K-3;Schulz KG;Ring 2;20095;Hamburg;kontakt@schulz.example;\r\n";

const PRODUCTS =
  "Artikelnummer;Name;Einheit;Preis (netto);Steuersatz\nA-1;Beratung;Std;95,00;19\n;Ohne Nummer;Stk;1,00;19\n";

const EMPTY: GenericLocalState = {
  imported: {},
  contactsByNumber: {},
  contactsByEmail: {},
  contactsByVatId: {},
  productsByNumber: {},
};

function table(bytes: Uint8Array) {
  const r = readCsvRecords(bytes);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const contactMapping = {
  number: "Kundennummer",
  organizationName: "Firma",
  street: "Straße",
  postalCode: "PLZ",
  city: "Ort",
  email: "E-Mail",
  vatId: "USt-IdNr",
};

const rate = (key: string) => (key === "standard" ? 1900 : key === "reduced" ? 700 : undefined);

describe("IMP-012 generic CSV import (contacts and products)", () => {
  test("IMP-012 TST-IMP-12 Windows-1252 `;` contacts: encoding and delimiter detected, the invalid row is listed", async () => {
    const t = table(enc1252(CONTACTS));
    expect(t.encoding).toBe("windows-1252");
    expect(t.separator).toBe(";");
    const rows = await withIdempotencyKeys(
      parseGenericRows("contacts", t, contactMapping, rate),
      presetLabel("contacts"),
    );
    const plan = buildGenericPlan("contacts", rows, EMPTY);
    expect(plan.counts).toEqual({ rows: 3, new: 2, existing: 0, skipped: 0, duplicates: 0, errors: 1 });
    const error = plan.rows.find((r) => r.status === "error");
    expect(error?.line).toBe(3);
    expect(error?.message).toMatch(/^Zeile 3:/);
    const mueller = plan.rows.find((r) => r.line === 2);
    expect(mueller?.display).toBe("Müller GmbH");
    expect(mueller?.keyValue).toBe("number:K-1");
  });

  test("IMP-012 the idempotency key is SHA-256 of (preset, key column value)", async () => {
    const a = await idempotencyKey("Vorlage A", "number:K-1");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await idempotencyKey("Vorlage A", "number:K-1")).toBe(a);
    expect(await idempotencyKey("Vorlage B", "number:K-1")).not.toBe(a);
  });

  test("IMP-012 dedupe by number, e-mail and USt-IdNr against existing data and inside the file", async () => {
    const t = table(
      new TextEncoder().encode(
        "Kundennummer;Firma;E-Mail;USt-IdNr\n" +
          ";Alpha GmbH;alpha@example.test;\n" +
          ";Beta GmbH;;de 811 907 980\n" +
          "K-9;Gamma GmbH;;\n" +
          ";Alpha Kopie;ALPHA@example.test;\n" +
          ";Delta GmbH;;\n",
      ),
    );
    const rows = await withIdempotencyKeys(
      parseGenericRows(
        "contacts",
        t,
        { number: "Kundennummer", organizationName: "Firma", email: "E-Mail", vatId: "USt-IdNr" },
        rate,
      ),
      presetLabel("contacts"),
    );
    const keys = genericKeys(rows);
    expect(keys.emails).toEqual(["alpha@example.test"]);
    expect(keys.vatIds).toEqual(["DE811907980"]);
    expect(keys.numbers).toEqual(["K-9"]);
    const plan = buildGenericPlan("contacts", rows, {
      ...EMPTY,
      contactsByVatId: { DE811907980: "c1" },
      contactsByNumber: { "K-9": "c2" },
    });
    const status = Object.fromEntries(plan.rows.map((r) => [r.line, r.status]));
    expect(status).toEqual({ 2: "new", 3: "existing", 4: "existing", 5: "duplicate", 6: "new" });
    expect(plan.rows.find((r) => r.line === 5)?.message).toBe("Zeile 5 hat dieselbe E-Mail-Adresse wie Zeile 2.");
    expect(plan.rows.find((r) => r.line === 3)?.message).toContain("USt-IdNr");
    // Without number, e-mail or USt-IdNr the normalised name + postcode is the key.
    expect(plan.rows.find((r) => r.line === 6)?.keyValue).toBe("name:delta gmbh|");
  });

  test("IMP-012 a re-import skips rows whose idempotency key is already in importedRecords", async () => {
    const t = table(enc1252(CONTACTS));
    const rows = await withIdempotencyKeys(parseGenericRows("contacts", t, contactMapping, rate), "Meine Vorlage");
    const first = rows.find((r) => r.line === 2);
    const plan = buildGenericPlan("contacts", rows, { ...EMPTY, imported: { [first?.idempotencyKey ?? ""]: "c1" } });
    expect(plan.rows.find((r) => r.line === 2)?.status).toBe("skip");
    expect(plan.counts.skipped).toBe(1);
  });

  test("IMP-012 products: same row parser and schema as the API; the article number is the key", async () => {
    const t = table(new TextEncoder().encode(PRODUCTS));
    const mapping = {
      number: "Artikelnummer",
      name: "Name",
      unit: "Einheit",
      netPrice: "Preis (netto)",
      vat: "Steuersatz",
    };
    expect(checkGenericMapping("products", t.headers, mapping).missing).toEqual([]);
    const rows = await withIdempotencyKeys(parseGenericRows("products", t, mapping, rate), presetLabel("products"));
    const plan = buildGenericPlan("products", rows, { ...EMPTY, productsByNumber: {} });
    expect(plan.rows.map((r) => r.status)).toEqual(["new", "error"]);
    expect(plan.rows[0]?.keyValue).toBe("number:A-1");
    expect(plan.rows[1]?.message).toContain("Artikelnummer fehlt");
    const existing = buildGenericPlan("products", rows, { ...EMPTY, productsByNumber: { "A-1": "p1" } });
    expect(existing.rows[0]?.status).toBe("existing");
  });

  test("IMP-012 a missing required column blocks the file", () => {
    expect(checkGenericMapping("products", ["Name"], { name: "Name" }).missing).toEqual(["number"]);
    expect(checkGenericMapping("contacts", ["E-Mail"], { email: "E-Mail" }).missing).toEqual(["organizationName"]);
  });

  test("IMP-012 the preview summary carries counts, samples and the error rows; the error CSV lists them", async () => {
    const t = table(enc1252(CONTACTS));
    const rows = await withIdempotencyKeys(parseGenericRows("contacts", t, contactMapping, rate), "x");
    const summary = summarizeGenericPlan(buildGenericPlan("contacts", rows, EMPTY));
    expect(summary.counts.errors).toBe(1);
    expect(summary.samples.map((s) => s.display)).toEqual(["Müller GmbH", "Schulz KG"]);
    expect(summary.problems).toHaveLength(1);
    const csv = genericErrorCsv(t.headers, summary.problems);
    expect(csv.startsWith("﻿Zeile;Status;Meldung;Kundennummer;Firma")).toBe(true);
    expect(csv).toContain("3;Fehler;");
    expect(csv).toContain("K-2");
  });
});
