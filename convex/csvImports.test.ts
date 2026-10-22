/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { genericErrorCsv } from "../src/domain/import/generic/csv-import";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setupInvoicing } from "./invoices.fixtures";
import { makeT, type TestT } from "./test.setup";

/** Windows-1252 bytes (all characters of the fixture are Latin-1). */
const cp1252 = (text: string) => Uint8Array.from([...text].map((ch) => ch.charCodeAt(0)));

const CONTACTS =
  "Kundennummer;Firma;Straße;PLZ;Ort;E-Mail\r\n" +
  "K-100;Bäckerei Müller GmbH;Hauptstraße 1;10115;Berlin;info@baeckerei.example\r\n" +
  "K-101;;;;;\r\n" +
  "K-102;Schulz & Söhne KG;Ring 2;20095;Hamburg;kontakt@schulz.example\r\n";

const PRODUCTS =
  "Artikelnummer;Name;Einheit;Preis (netto);Steuersatz\nCSV-1;Beratung;Std;95,00;19\nCSV-2;Fachbuch;Stk;24,30;7\n";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

async function setup() {
  const t = makeT();
  const { owner } = await setupInvoicing(t);
  return { t, owner };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

async function project(t: TestT, owner: Owner, bytes: Uint8Array, target: "contacts" | "products", name: string) {
  const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
  const storageId = await t.run((ctx) => ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>])));
  const r = await owner.action(api.csvImports.setFile, { importId, storageId, name, target });
  if ("needsEncoding" in r) throw new Error(r.message);
  return { importId, ...r };
}

describe("IMP-012 generic CSV import (imports.source = generic_csv)", () => {
  test("IMP-012 TST-IMP-12 Windows-1252 `;` contacts with 1 invalid row: preview lists it, commit creates the rest, re-import skips", async () => {
    const { t, owner } = await setup();
    const before = (await t.run((ctx) => ctx.db.query("contacts").collect())).length;
    const { importId, encoding, rows } = await project(t, owner, cp1252(CONTACTS), "contacts", "kontakte.csv");
    expect(encoding).toBe("windows-1252");
    expect(rows).toBe(3);
    const view = await owner.query(api.csvImports.get, { importId });
    expect(view?.file?.delimiter).toBe(";");
    expect(view?.file?.headers).toContain("Straße");
    // The automatic mapping (same mapper as the contacts CSV import) found the columns.
    expect(view?.columns).toMatchObject({ number: "Kundennummer", organizationName: "Firma", email: "E-Mail" });

    // Map explicitly and save the mapping as a preset (reused by later imports).
    await owner.mutation(api.csvImports.setMapping, {
      importId,
      columns: {
        number: "Kundennummer",
        organizationName: "Firma",
        street: "Straße",
        postalCode: "PLZ",
        city: "Ort",
        email: "E-Mail",
      },
      preset: "Kontakte alt",
      savePreset: true,
    });
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ rows: 3, new: 2, errors: 1 });
    expect(p.preview.problems).toHaveLength(1);
    expect(p.preview.problems[0]).toMatchObject({ line: 3, status: "error" });
    const csv = genericErrorCsv(view?.file?.headers ?? [], p.preview.problems);
    expect(csv).toContain("K-101");

    const r = await owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash });
    expect(r).toMatchObject({ status: "done", created: 2 });
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts).toHaveLength(before + 2);
    expect(contacts.map((c) => c.displayName)).toEqual(
      expect.arrayContaining(["Bäckerei Müller GmbH", "Schulz & Söhne KG"]),
    );
    const records = await t.run((ctx) =>
      ctx.db
        .query("importedRecords")
        .withIndex("by_import", (q) => q.eq("importId", importId))
        .collect(),
    );
    expect(records).toHaveLength(2);
    expect(records[0]?.externalType).toBe("generic_csv:contact");
    expect(records[0]?.externalId).toMatch(/^[0-9a-f]{64}$/);
    const done = await owner.query(api.csvImports.get, { importId });
    expect(done?.status).toBe("done");
    // IMP-014: the commit is audited with the user as actor on channel `import`.
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const created = audit.filter((a) => a.action === "import.record");
    expect(created.length).toBe(2);
    expect(created[0]?.actor).toMatch(/^user:/);

    // Re-import of the same file: the saved preset applies, every row is skipped, nothing is created.
    const again = await project(t, owner, cp1252(CONTACTS), "contacts", "kontakte-nochmal.csv");
    const view2 = await owner.query(api.csvImports.get, { importId: again.importId });
    expect(view2?.preset).toBe("Kontakte alt");
    const p2 = await owner.action(api.csvImports.preview, { importId: again.importId });
    expect(p2.preview.counts).toMatchObject({ new: 0, skipped: 2, errors: 1 });
    const r2 = await owner.action(api.csvImports.commit, { importId: again.importId, previewHash: p2.previewHash });
    expect(r2.created).toBe(0);
    expect(await t.run((ctx) => ctx.db.query("contacts").collect())).toHaveLength(before + 2);
  });

  test("IMP-012 products CSV: dedupe by article number; a stale preview cannot be committed; discard removes the file", async () => {
    const { t, owner } = await setup();
    const { importId } = await project(t, owner, new TextEncoder().encode(PRODUCTS), "products", "artikel.csv");
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ rows: 2, new: 2 });
    // Changing the mapping invalidates the preview (IMP-023, E-IMP-27).
    await owner.mutation(api.csvImports.setMapping, {
      importId,
      columns: { number: "Artikelnummer", name: "Name", unit: "Einheit", netPrice: "Preis (netto)", vat: "Steuersatz" },
    });
    const stale = await owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash }).catch((e) => e);
    expect(reasonOf(stale)).toBe("PREVIEW_STALE");
    const p2 = await owner.action(api.csvImports.preview, { importId });
    const r = await owner.action(api.csvImports.commit, { importId, previewHash: p2.previewHash });
    expect(r.created).toBe(2);
    const products = await t.run((ctx) => ctx.db.query("products").collect());
    expect(products.map((x) => x.number)).toEqual(expect.arrayContaining(["CSV-1", "CSV-2"]));

    // A second project with a different preset name: the articles exist already (dedupe by number).
    const other = await project(t, owner, new TextEncoder().encode(PRODUCTS), "products", "artikel2.csv");
    await owner.mutation(api.csvImports.setMapping, {
      importId: other.importId,
      columns: { number: "Artikelnummer", name: "Name", unit: "Einheit", netPrice: "Preis (netto)", vat: "Steuersatz" },
      preset: "Andere Vorlage",
    });
    const p3 = await owner.action(api.csvImports.preview, { importId: other.importId });
    expect(p3.preview.counts).toMatchObject({ new: 0, existing: 2 });
    await owner.mutation(api.imports.discard, { importId: other.importId });
    const discarded = await owner.query(api.csvImports.get, { importId: other.importId });
    expect(discarded?.status).toBe("discarded");
    expect(discarded?.file).toBeNull();
  });

  test("IMP-012 an unreadable file is rejected and deleted; a missing required column blocks the preview", async () => {
    const { t, owner } = await setup();
    const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob([""])));
    const e = await owner
      .action(api.csvImports.setFile, { importId, storageId, name: "leer.csv", target: "contacts" })
      .catch((x) => x);
    expect(reasonOf(e)).toBe("IMPORT_EMPTY");
    expect(await t.run((ctx) => ctx.storage.get(storageId))).toBeNull();
    const ok = await project(t, owner, new TextEncoder().encode("Name;Preis\nX;1\n"), "products", "p.csv");
    await owner.mutation(api.csvImports.setMapping, { importId: ok.importId, columns: { name: "Name" } });
    const blocked = await owner.action(api.csvImports.preview, { importId: ok.importId }).catch((x) => x);
    expect(reasonOf(blocked)).toBe("E_IMP_21");
  });
});

describe("generic CSV import edge cases (F09 §5.3)", () => {
  test("E-IMP-15 an unclear encoding is asked with samples in both encodings; the chosen one is stored and used by the preview", async () => {
    const { t, owner } = await setup();
    const enc = new TextEncoder();
    const mixed = Uint8Array.from([
      ...enc.encode("Kundennummer;Firma;Ort\nK-300;Müller Bau GmbH;Köln\nK-301;Maier"),
      0xe4, // a stray Windows-1252 „ä“ in an otherwise UTF-8 file
      ...enc.encode(" KG;Bonn\n"),
    ]);
    const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
    const store = () => t.run((ctx) => ctx.storage.store(new Blob([mixed as Uint8Array<ArrayBuffer>])));
    const first = await store();
    const asked = await owner.action(api.csvImports.setFile, {
      importId,
      storageId: first,
      name: "kontakte.csv",
      target: "contacts",
    });
    expect(asked).toMatchObject({
      needsEncoding: true,
      message: "Zeichenkodierung unklar – bitte Windows-1252 oder UTF-8 wählen.",
    });
    if (!("needsEncoding" in asked)) throw new Error("expected the encoding question");
    expect(asked.samples["utf-8"][0]).toEqual(["K-300", "Müller Bau GmbH", "Köln"]);
    expect(asked.samples["windows-1252"][0]?.[1]).toBe("MÃ¼ller Bau GmbH");
    expect(await t.run((ctx) => ctx.storage.get(first))).toBeNull();
    expect((await owner.query(api.csvImports.get, { importId }))?.file).toBeNull();

    const chosen = await owner.action(api.csvImports.setFile, {
      importId,
      storageId: await store(),
      name: "kontakte.csv",
      target: "contacts",
      encoding: "utf-8",
    });
    expect(chosen).toEqual({ rows: 2, encoding: "utf-8" });
    expect((await owner.query(api.csvImports.get, { importId }))?.file?.encoding).toBe("utf-8");
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.samples.map((s) => s.display)).toEqual(["Müller Bau GmbH", "Maier� KG"]);
  });

  test("E-IMP-17 E-IMP-18 an existing contact is skipped with „Kontakt existiert bereits (nr)“ or, with the option, updated (Stammdaten only); the preview carries the Art. 14 notice", async () => {
    const { t, owner } = await setup();
    const enc = new TextEncoder();
    const first = await project(
      t,
      owner,
      enc.encode("Kundennummer;Firma;Ort;Notiz\nK-400;Beispiel Werkstatt GmbH;Köln;Alte Notiz\n"),
      "contacts",
      "kontakte.csv",
    );
    const columns = { number: "Kundennummer", organizationName: "Firma", city: "Ort", notes: "Notiz" };
    await owner.mutation(api.csvImports.setMapping, { importId: first.importId, columns });
    const p1 = await owner.action(api.csvImports.preview, { importId: first.importId });
    expect(p1.preview.notices[0]).toMatch(/Art\. 14 DSGVO/);
    await owner.action(api.csvImports.commit, { importId: first.importId, previewHash: p1.previewHash });

    const file2 = enc.encode("Kundennummer;Firma;Ort;Notiz\nK-400;Beispiel Werkstatt GmbH;;Neue Notiz\n");
    const second = await project(t, owner, file2, "contacts", "kontakte-neu.csv");
    await owner.mutation(api.csvImports.setMapping, { importId: second.importId, columns, preset: "Neu" });
    const skip = await owner.action(api.csvImports.preview, { importId: second.importId });
    expect(skip.preview.problems[0]).toMatchObject({
      status: "existing",
      message: "Zeile 2: Kontakt existiert bereits (K-400).",
    });
    await owner.mutation(api.csvImports.setMapping, {
      importId: second.importId,
      columns,
      preset: "Neu",
      onExisting: "update",
    });
    const upd = await owner.action(api.csvImports.preview, { importId: second.importId });
    expect(upd.previewHash).not.toBe(skip.previewHash);
    expect(upd.preview.counts).toMatchObject({ new: 0, updates: 1, existing: 0 });
    const r = await owner.action(api.csvImports.commit, { importId: second.importId, previewHash: upd.previewHash });
    expect(r).toMatchObject({ created: 0, updated: 1 });
    const contact = await t.run((ctx) =>
      ctx.db
        .query("contacts")
        .withIndex("by_number", (q) => q.eq("numberNormalized", "K-400"))
        .first(),
    );
    // the number stays; the empty city cell (an address field) changes nothing
    expect(contact).toMatchObject({
      number: "K-400",
      organizationName: "Beispiel Werkstatt GmbH",
      notes: "Neue Notiz",
    });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "contact.update"))
        .collect(),
    );
    expect(audit.at(-1)?.reason).toMatch(/^CSV-Import, generic-csv-import@1, Import .+, Vorlage Neu$/);
  });

  test("IMP-013 the shipped lexoffice presets (ungeprüft) are offered next to the saved ones", async () => {
    const { t, owner } = await setup();
    const { importId } = await project(
      t,
      owner,
      new TextEncoder().encode("Artikelnummer;Bezeichnung;Nettopreis;Steuersatz\nL-1;Wartung;80,00;19\n"),
      "products",
      "lexoffice-artikel.csv",
    );
    const view = await owner.query(api.csvImports.get, { importId });
    expect(view?.presets).toContainEqual(
      expect.objectContaining({
        id: "shipped:lexoffice-products",
        name: "lexoffice Artikel (ungeprüft)",
        unsure: true,
      }),
    );
    expect(view?.presets.some((p) => p.id === "shipped:lexoffice-contacts")).toBe(false);
  });
});
