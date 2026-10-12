import { describe, expect, test } from "vitest";
import { readCsv } from "../csv/csv";
import { contactCreateSchema, emptyContactForm } from "../schemas/contacts";
import {
  autoMapHeaders,
  CONTACT_EXPORT_HEADERS,
  checkMapping,
  classifyRow,
  contactExportRow,
  duplicateKeysInFile,
  parseCountry,
  parseDate,
  parseRoles,
  parseTagNames,
  rowToFormValues,
} from "./csv-io";

const latin1 = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));

describe("CON-140 CON-141 contact CSV import mapping", () => {
  test("CON-140 headers incl. sevdesk aliases are mapped automatically; unknown and repeated headers stay unmapped", () => {
    expect(
      autoMapHeaders(["Kunden-Nr.", "Firma", "Straße", "PLZ", "Ort", "Land", "USt-IdNr.", "E-Mail", "Foo", "Name"]),
    ).toEqual([
      "number",
      "organizationName",
      "street",
      "postalCode",
      "city",
      "countryCode",
      "vatId",
      "email",
      null,
      null,
    ]);
    expect(checkMapping(["number", null])).toBe("Bitte mindestens „Firma“ oder „Nachname“ zuordnen.");
    expect(checkMapping(["lastName"])).toBeNull();
  });

  test("T-CON-053 CON-142 Windows-1252 file with ';' and umlauts maps to valid create values; invalid IBAN is a row error", () => {
    const file = latin1(
      "Kundennummer;Firma;Stra\xdfe;PLZ;Ort;Land;IBAN;E-Mail;Kategorie\r\n" +
        "20001;M\xfcller GmbH;Hauptstra\xdfe 1;50667;K\xf6ln;Deutschland;DE89370400440532013000;rechnung@mueller.de;Kunde, Lieferant\r\n" +
        "20002;Schulz AG;Ring 2;10115;Berlin;DE;DE00 1234;;Kunde\r\n",
    );
    const table = readCsv(file);
    if (!table.ok) throw new Error(table.error.code);
    expect(table.value.encoding).toBe("windows-1252");
    const mapping = autoMapHeaders(table.value.headers);
    const base = emptyContactForm();
    const [r1, r2] = table.value.rows.map((r) => rowToFormValues(r, mapping, base));
    const ok = contactCreateSchema.safeParse(r1);
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.contact).toMatchObject({
        number: "20001",
        organizationName: "Müller GmbH",
        roles: ["customer", "supplier"],
      });
      expect(ok.data.billingAddress).toMatchObject({ street: "Hauptstraße 1", city: "Köln", countryCode: "DE" });
      expect(ok.data.channels).toEqual([
        { type: "email", value: "rechnung@mueller.de", label: "", isPrimary: true, isInvoiceEmail: true },
      ]);
    }
    const bad = contactCreateSchema.safeParse(r2);
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toBe("Die IBAN ist ungültig.");
  });

  test("CON-140 persons are detected from first/last name columns; salutation and dates are parsed", () => {
    const mapping = autoMapHeaders(["Anrede", "Vorname", "Nachname", "Geburtstag", "Privatkunde", "Sprache"]);
    const v = rowToFormValues(["Frau", "Anna", "Müller", "03.02.1980", "ja", "English"], mapping, emptyContactForm());
    expect(v.contact).toMatchObject({
      kind: "person",
      salutation: "frau",
      firstName: "Anna",
      lastName: "Müller",
      birthday: "1980-02-03",
      isConsumer: true,
      language: "en",
    });
    expect(v.billingAddress.name).toBe("Anna Müller");
  });

  test("CON-140 helpers: roles, countries, dates, tags", () => {
    expect(parseRoles("Kunde/Interessent; Partner")).toEqual(["customer", "prospect", "partner"]);
    expect(parseRoles("")).toEqual([]);
    expect(parseCountry("Österreich")).toBe("AT");
    expect(parseCountry("fr")).toBe("FR");
    expect(parseCountry("")).toBe("DE");
    expect(parseDate("1.2.2026")).toBe("2026-02-01");
    expect(parseDate("2026-02-01")).toBe("2026-02-01");
    expect(parseTagNames("A, B; C|")).toEqual(["A", "B", "C"]);
  });

  test("T-CON-031 CON-141 CON-E32 row status: new, update, conflict (mode, restricted)", () => {
    expect(classifyRow(null, "create_only", "1")).toEqual({ status: "new" });
    expect(classifyRow({ id: "c", number: "1", restricted: false }, "create_and_update", "1")).toEqual({
      status: "update",
    });
    expect(classifyRow({ id: "c", number: "1", restricted: false }, "create_only", "1")).toEqual({
      status: "conflict",
      message: "Kontaktnummer 1 existiert bereits.",
    });
    expect(classifyRow({ id: "c", number: "1", restricted: true }, "create_and_update", "1")).toEqual({
      status: "conflict",
      message: "Kontakt ist nach DSGVO eingeschränkt",
    });
  });

  test("§5.7 duplicate keys inside the file", () => {
    const m = duplicateKeysInFile([
      { rowNumber: 2, number: "1", vatId: "", email: "a@b.de" },
      { rowNumber: 3, number: "2", vatId: "", email: "A@B.DE" },
      { rowNumber: 4, number: "1", vatId: "", email: "" },
    ]);
    expect(m.get(3)).toBe("Zeile 3 hat dieselbe E-Mail-Adresse wie Zeile 2.");
    expect(m.get(4)).toBe("Zeile 4 hat dieselbe Kontaktnummer wie Zeile 2.");
    expect(m.has(2)).toBe(false);
  });
});

describe("CON-143 contact CSV export", () => {
  test("CON-143 one row per contact in header order with German labels", () => {
    const row = contactExportRow({
      number: "10001",
      kind: "organization",
      displayName: "Müller GmbH",
      organizationName: "Müller GmbH",
      roles: ["customer", "supplier"],
      status: "active",
      billing: { street: "Hauptstr. 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
      primaryEmail: "info@mueller.de",
      invoiceEmails: ["rechnung@mueller.de", "buchhaltung@mueller.de"],
      vatId: "DE123456788",
      vatStatusText: "? nicht geprüft",
      isConsumer: false,
      isPublicAuthority: false,
      dueDays: 14,
      tagNames: ["VIP"],
      customFields: { branche: "IT", leer: "" },
    });
    expect(row).toHaveLength(CONTACT_EXPORT_HEADERS.length);
    const at = (h: (typeof CONTACT_EXPORT_HEADERS)[number]) => row[CONTACT_EXPORT_HEADERS.indexOf(h)];
    expect(at("Rollen")).toBe("Kunde, Lieferant");
    expect(at("Status")).toBe("Aktiv");
    expect(at("Rechnungs-E-Mails")).toBe("rechnung@mueller.de, buchhaltung@mueller.de");
    expect(at("Privatkunde")).toBe("nein");
    expect(at("Zahlungsziel")).toBe("14");
    expect(at("Eigene Felder")).toBe("branche=IT");
  });
});
