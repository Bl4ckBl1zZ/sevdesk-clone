import { describe, expect, test } from "vitest";
import { looksLikeMojibake, readCsvRecords } from "../../csv/csv";
import { contactFormFromRecord, emptyContactForm } from "../../schemas/contacts";
import { applyPreset, checkMapping } from "../sevdesk/mapping";
import {
  buildGenericPlan,
  type GenericLocalState,
  genericPreviewHashInput,
  mergeImportedContact,
  parseGenericRows,
  summarizeGenericPlan,
  withIdempotencyKeys,
} from "./csv-import";
import { shippedPresetsFor } from "./presets";

/**
 * F09 §5.3 generic CSV import edge cases on synthetic files: E-IMP-15 (unclear encoding), E-IMP-17 (existing contact:
 * update or skip), E-IMP-18 (DSGVO Art. 14 notice) and the IMP-013 lexoffice presets.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const rate = (key: string) => (key === "standard" ? 1900 : key === "reduced" ? 700 : undefined);

function table(bytes: Uint8Array, encoding?: "utf-8" | "windows-1252") {
  const r = readCsvRecords(bytes, encoding);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const EMPTY: GenericLocalState = {
  imported: {},
  contactsByNumber: {},
  contactsByEmail: {},
  contactsByVatId: {},
  productsByNumber: {},
};

const CONTACTS =
  "Kundennummer;Firma;Ort;E-Mail;USt-IdNr;Notiz\r\n" +
  "K-9;Beispiel Werkstatt GmbH;Köln;post@werkstatt.example;;Neue Notiz\r\n" +
  "K-10;Neu AG;Bonn;neu@neu.example;;\r\n";
const contactMapping = {
  number: "Kundennummer",
  organizationName: "Firma",
  city: "Ort",
  email: "E-Mail",
  vatId: "USt-IdNr",
  notes: "Notiz",
};

async function contactRows() {
  return withIdempotencyKeys(parseGenericRows("contacts", table(utf8(CONTACTS)), contactMapping, rate), "x");
}

describe("generic CSV import edge cases (F09 §5.3)", () => {
  test("E-IMP-15 a mixed file (UTF-8 umlauts plus a stray Windows-1252 byte) is recognised as unclear; the chosen encoding decodes it", () => {
    const mixed = Uint8Array.from([...utf8("Name;Ort\nMüller GmbH;Köln\nMaier;"), 0xe4, ...utf8("hausen\n")]);
    const detected = table(mixed);
    expect(detected.encoding).toBe("windows-1252");
    const text = detected.records.map((r) => r.cells.join(";")).join("\n");
    expect(text).toContain("MÃ¼ller");
    expect(looksLikeMojibake(text)).toBe(true);
    // the owner chooses UTF-8: the umlauts are right, the stray byte becomes the replacement character
    const chosen = table(mixed, "utf-8");
    expect(chosen.encoding).toBe("utf-8");
    expect(chosen.records[0]?.cells).toEqual(["Müller GmbH", "Köln"]);
    expect(chosen.records[1]?.cells[1]).toBe("�hausen");
    // clean files are not asked about
    const clean1252 = Uint8Array.from([...utf8("Name;Ort\nM"), 0xfc, ...utf8("ller;K"), 0xf6, ...utf8("ln\n")]);
    const t1252 = table(clean1252);
    expect(t1252.records[0]?.cells).toEqual(["Müller", "Köln"]);
    expect(looksLikeMojibake(t1252.records[0]?.cells.join(";") ?? "")).toBe(false);
    expect(looksLikeMojibake("Müller GmbH; Straße 1; „Zitat“ 5 € – 20 °C")).toBe(false);
    // double-encoded UTF-8 („Ã¶“ stored as UTF-8) is unclear as well
    expect(looksLikeMojibake(table(utf8("Name\nKÃ¶ln\n")).records[0]?.cells[0] ?? "")).toBe(true);
  });

  test("E-IMP-16 a contact row with the company's own USt-IdNr is an error row in the preview, not a new contact", async () => {
    const [first, second] = await contactRows();
    if (!first || !second) throw new Error("fixture rows missing");
    const own = { ...second, keys: { ...second.keys, vatId: "DE123456788" } };
    const plan = buildGenericPlan("contacts", [first, own], { ...EMPTY, ownVatId: "de 123 456 788" });
    expect(plan.rows[1]).toMatchObject({ status: "error", message: "Zeile 3: Das ist Ihre eigene USt-IdNr." });
    expect(plan.counts).toMatchObject({ new: 1, errors: 1 });
    // without a company USt-IdNr the row is new
    expect(buildGenericPlan("contacts", [first, own], EMPTY).counts).toMatchObject({ new: 2, errors: 0 });
  });

  test("E-IMP-17 an existing contact is listed as „Zeile n: Kontakt existiert bereits (nr).“ and skipped by default", async () => {
    const rows = await contactRows();
    const local: GenericLocalState = {
      ...EMPTY,
      contactsByEmail: { "post@werkstatt.example": "c1" },
      contactNumbers: { c1: "K-1001" },
    };
    const plan = buildGenericPlan("contacts", rows, local);
    expect(plan.rows[0]).toMatchObject({
      status: "existing",
      localId: "c1",
      message: "Zeile 2: Kontakt existiert bereits (K-1001).",
    });
    expect(plan.counts).toMatchObject({ new: 1, existing: 1, updates: 0 });
  });

  test("E-IMP-17 with „Vorhandene Kontakte aktualisieren“ the row updates the existing contact; the option is part of the preview hash", async () => {
    const rows = await contactRows();
    const local: GenericLocalState = {
      ...EMPTY,
      contactsByNumber: { "K-9": "c1" },
      contactNumbers: { c1: "K-9" },
    };
    const skip = buildGenericPlan("contacts", rows, local);
    const upd = buildGenericPlan("contacts", rows, local, { onExisting: "update" });
    expect(upd.rows[0]).toMatchObject({
      status: "update",
      localId: "c1",
      message: "Zeile 2: Kontakt existiert bereits (K-9). Die Stammdaten werden aktualisiert.",
    });
    expect(upd.counts).toMatchObject({ new: 1, existing: 0, updates: 1 });
    // products never update
    expect(buildGenericPlan("products", [], EMPTY, { onExisting: "update" }).counts.updates).toBe(0);
    const base = { fileSha256: "f", target: "contacts" as const, columns: contactMapping, preset: "x" };
    expect(genericPreviewHashInput({ ...base, plan: skip })).not.toBe(
      genericPreviewHashInput({ ...base, plan: upd, onExisting: "update" }),
    );
    expect(genericPreviewHashInput({ ...base, plan: skip, onExisting: "skip" })).toBe(
      genericPreviewHashInput({ ...base, plan: skip }),
    );
  });

  test("E-IMP-17 the update merges only mapped, non-empty Stammdaten; the number never changes and empty cells never clear", async () => {
    const [row] = await contactRows();
    const existing = {
      ...emptyContactForm(),
      kind: "organization" as const,
      number: "K-1001",
      organizationName: "Beispiel Werkstatt GmbH",
      taxNumber: "21/815/08150",
      notes: "Alte Notiz",
    };
    const merged = mergeImportedContact(existing, row?.values as never, Object.keys(contactMapping));
    expect(merged).toMatchObject({
      number: "K-1001",
      organizationName: "Beispiel Werkstatt GmbH",
      taxNumber: "21/815/08150",
      notes: "Neue Notiz",
    });
    // nothing new → no update
    expect(
      mergeImportedContact({ ...existing, notes: "Neue Notiz" }, row?.values as never, Object.keys(contactMapping)),
    ).toBeNull();
    // unmapped columns are ignored
    expect(mergeImportedContact(existing, row?.values as never, ["number", "organizationName"])).toBeNull();
    expect(typeof contactFormFromRecord).toBe("function");
  });

  test("E-IMP-18 a contact import preview carries the DSGVO Art. 14 notice; a product import does not", async () => {
    const rows = await contactRows();
    const summary = summarizeGenericPlan(buildGenericPlan("contacts", rows, EMPTY));
    expect(summary.notices).toEqual([
      "Sie übernehmen personenbezogene Daten aus einem anderen System (CSV-Datei). Bitte die Herkunft der Daten im Verzeichnis von Verarbeitungstätigkeiten (Einstellungen › Datenschutz) vermerken – Informationspflicht nach Art. 14 DSGVO.",
    ]);
    expect(summarizeGenericPlan(buildGenericPlan("products", [], EMPTY)).notices).toEqual([]);
  });

  test("IMP-013 TST-IMP-13 the lexoffice presets (ungeprüft) map a lexoffice-style sample file; products pass the required-column check", async () => {
    const [contactsPreset] = shippedPresetsFor("contacts");
    const [productsPreset] = shippedPresetsFor("products");
    expect(contactsPreset).toMatchObject({ name: "lexoffice Kontakte (ungeprüft)", unsure: true });
    expect(productsPreset).toMatchObject({ name: "lexoffice Artikel (ungeprüft)", unsure: true });

    const contacts = table(
      utf8(
        "Kundennummer;Firmenname;Vorname;Nachname;Straße;PLZ;Ort;E-Mail;USt-IdNr.\n" +
          "10001;Beispiel Bau GmbH;;;Musterweg 1;50667;Köln;info@bau.example;DE123456788\n",
      ),
    );
    const cMap = applyPreset(contacts.headers, contactsPreset?.columns ?? {});
    expect(cMap).toMatchObject({ number: "Kundennummer", organizationName: "Firmenname", vatId: "USt-IdNr." });
    expect(checkMapping("contacts", contacts.headers, cMap).missing).toEqual([]);
    const [c] = parseGenericRows("contacts", contacts, cMap, rate);
    expect(c?.error).toBeUndefined();
    expect(c?.display).toBe("Beispiel Bau GmbH");
    expect(c?.keys).toEqual({ number: "10001", email: "info@bau.example", vatId: "DE123456788" });

    const products = table(
      utf8("artikelnummer;bezeichnung;einheit;nettopreis;steuersatz\nA-100;Wartung;Std;80,00;19\n"),
    );
    const pMap = applyPreset(products.headers, productsPreset?.columns ?? {});
    expect(checkMapping("products", products.headers, pMap).missing).toEqual([]);
    const [p] = parseGenericRows("products", products, pMap, rate);
    expect(p?.error).toBeUndefined();
    expect(p?.display).toBe("Wartung");
    expect(p?.keyValue).toBe("number:A-100");
  });
});
