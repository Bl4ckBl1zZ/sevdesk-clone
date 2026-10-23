import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { getCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * F09 IMP-012 generic CSV import (convex/csvImports.ts): the list/get views without a file, the upload refusals,
 * a workspace whose stored file went missing or changed, commits of done/discarded imports, and the optional row
 * keys (USt-IdNr, e-mail, category path). All CSV content is synthetic.
 */

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), reason: reasonOf(e), message: messageOf(e) };
  }
  throw new Error("expected an error");
}

const enc = new TextEncoder();
const PRODUCTS =
  "Artikelnummer;Name;Einheit;Preis (netto);Steuersatz;Kategorie\nGEN-1;Beratung;Std;95,00;19;Leistungen > Beratung\n";
const PRODUCT_COLUMNS = {
  number: "Artikelnummer",
  name: "Name",
  unit: "Einheit",
  netPrice: "Preis (netto)",
  vat: "Steuersatz",
  category: "Kategorie",
};
const CONTACTS =
  "Firma;USt-IdNr;E-Mail;PLZ\nOhne Nummer GmbH;DE136695976;;10115\nNur Mail KG;;mail@nur-mail.example;20095\n";

async function setup() {
  const t = makeT();
  const { owner } = await setupInvoicing(t);
  return { t, owner };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

const store = (t: TestT, bytes: Uint8Array) =>
  t.run((ctx) => ctx.storage.store(new Blob([bytes as Uint8Array<ArrayBuffer>])));
const row = (t: TestT, id: Id<"imports">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"imports">>;

async function project(t: TestT, owner: Owner, text: string, target: "contacts" | "products", name = "daten.csv") {
  const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
  const storageId = await store(t, enc.encode(text));
  const r = await owner.action(api.csvImports.setFile, { importId, storageId, name, target });
  if ("needsEncoding" in r) throw new Error(r.message);
  return importId;
}

describe("F09 IMP-012 generic CSV import — views and upload refusals", () => {
  test("IMP-012 a fresh project has no file: list, get and source show the empty workspace; the preview asks for the upload", async () => {
    const { owner } = await setup();
    const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
    const [listed] = await owner.query(api.csvImports.list, {});
    expect(listed).toMatchObject({ id: importId, status: "uploaded", fileName: null, committedAt: null });
    const view = await owner.query(api.csvImports.get, { importId });
    expect(view).toMatchObject({
      file: null,
      columns: {},
      preset: null,
      onExisting: "skip",
      previewHash: null,
      preview: null,
    });
    const src = await owner.query(api.csvImports.source, { importId });
    expect(src).toMatchObject({ file: null, columns: {}, preset: null, onExisting: "skip", previewHash: null });
    expect(await failure(owner.action(api.csvImports.preview, { importId }))).toMatchObject({
      code: "invalid_input",
      message: "Bitte zuerst eine CSV-Datei hochladen.",
    });
  });

  test("IMP-012 IMP-016 a sevdesk import is not shown as a CSV import; the sevdesk list hides CSV imports", async () => {
    const { owner } = await setup();
    const sevdesk = await owner.mutation(api.imports.create, {});
    const csv = await owner.mutation(api.csvImports.create, {});
    expect(await owner.query(api.csvImports.get, { importId: sevdesk })).toBeNull();
    expect((await owner.query(api.csvImports.list, {})).map((i) => i.id)).toEqual([csv]);
    const sev = await owner.query(api.imports.list, {});
    expect(sev.map((i) => i.id)).toEqual([sevdesk]);
    // without a preview the list shows the run statistics
    expect(sev[0]?.counts).toEqual({});
    expect(await failure(owner.query(api.csvImports.source, { importId: sevdesk }))).toMatchObject({
      code: "invalid_input",
      message: "Dieser Import ist kein CSV-Import für Kontakte oder Produkte.",
    });
  });

  test("IMP-012 a missing or oversized upload is refused; an oversized file is deleted again; a blank name becomes import.csv", async () => {
    const { t, owner } = await setup();
    const importId: Id<"imports"> = await owner.mutation(api.csvImports.create, {});
    const gone = await store(t, enc.encode("x"));
    await t.run((ctx) => ctx.storage.delete(gone));
    expect(
      await failure(
        owner.action(api.csvImports.setFile, { importId, storageId: gone, name: "weg.csv", target: "products" }),
      ),
    ).toMatchObject({ code: "not_found", message: "Die Datei weg.csv wurde nicht gefunden." });
    const big = await store(t, new Uint8Array(10 * 1024 * 1024 + 1));
    expect(
      await failure(
        owner.action(api.csvImports.setFile, { importId, storageId: big, name: "gross.csv", target: "products" }),
      ),
    ).toMatchObject({ code: "invalid_input", message: "Die Datei ist zu groß (max. 10 MB bzw. 20.000 Zeilen)." });
    expect(await t.run((ctx) => ctx.storage.get(big))).toBeNull();
    const ok = await store(t, enc.encode(PRODUCTS));
    const r = await owner.action(api.csvImports.setFile, { importId, storageId: ok, name: "   ", target: "products" });
    expect(r).toEqual({ rows: 1, encoding: "utf-8" });
    expect((await owner.query(api.csvImports.get, { importId }))?.file?.name).toBe("import.csv");
  });
});

describe("F09 IMP-012 GOBD-03 the preview parses exactly the stored upload", () => {
  test("IMP-012 a stored file that went missing or was swapped blocks the preview", async () => {
    const { t, owner } = await setup();
    const importId = await project(t, owner, PRODUCTS, "products", "artikel.csv");
    const r = await row(t, importId);
    const file = r.files[0] as Doc<"imports">["files"][number];
    // swapped: the row points at other bytes than the hashed upload
    const other = await store(t, enc.encode(`${PRODUCTS}GEN-2;Anderes;Stk;1,00;19;\n`));
    await t.run((ctx) => ctx.db.patch(importId, { files: [{ ...file, storageId: other }] }));
    expect(await failure(owner.action(api.csvImports.preview, { importId }))).toMatchObject({
      code: "conflict",
      message: "Die Datei artikel.csv wurde verändert.",
    });
    await t.run((ctx) => ctx.storage.delete(other));
    expect(await failure(owner.action(api.csvImports.preview, { importId }))).toMatchObject({
      code: "not_found",
      message: "Die Datei artikel.csv fehlt im Speicher.",
    });
    await t.run((ctx) => ctx.db.patch(importId, { files: [file] }));
  });
});

describe("F09 IMP-012 IMP-023 commit states and optional keys", () => {
  test("IMP-012 products with a category path are created in the category; a done import can neither be previewed nor committed again", async () => {
    const { t, owner } = await setup();
    const importId = await project(t, owner, PRODUCTS, "products");
    await owner.mutation(api.csvImports.setMapping, { importId, columns: PRODUCT_COLUMNS });
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ rows: 1, new: 1 });
    expect(await owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash })).toEqual({
      status: "done",
      created: 1,
      skipped: 0,
      updated: 0,
    });
    const product = await t.run(async (ctx) =>
      (await ctx.db.query("products").collect()).find((x) => x.number === "GEN-1"),
    );
    const category = product?.categoryId
      ? await t.run((ctx) => ctx.db.get(product.categoryId as Id<"productCategories">))
      : null;
    expect(category?.name).toBe("Beratung");
    const done = await owner.query(api.csvImports.get, { importId });
    expect(done?.log[0]).toBe(
      "Produkte: 1 angelegt, 0 aktualisiert, 0 bereits importiert, 0 vorhanden, 0 doppelt, 0 fehlerhaft (Vorlage ohne Vorlage (Produkte))",
    );
    const listed = (await owner.query(api.csvImports.list, {}))[0];
    expect(listed?.committedAt).toBeTypeOf("number");
    expect(await failure(owner.action(api.csvImports.preview, { importId }))).toMatchObject({
      reason: "IMPORT_COMMITTED",
      message: "Der Import wurde bereits übernommen und kann nicht verworfen werden.",
    });
    expect(await failure(owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash }))).toMatchObject({
      reason: "IMPORT_COMMITTED",
      message: "Der Import wurde bereits übernommen und kann nicht verworfen werden.",
    });
  });

  test("IMP-023 a discarded CSV import cannot be committed", async () => {
    const { t, owner } = await setup();
    const importId = await project(t, owner, PRODUCTS, "products");
    await owner.mutation(api.csvImports.setMapping, { importId, columns: PRODUCT_COLUMNS });
    const p = await owner.action(api.csvImports.preview, { importId });
    await owner.mutation(api.imports.discard, { importId });
    const e = await failure(owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash }));
    // the discard removed the stored file; the commit never runs
    expect(e).toMatchObject({ code: "invalid_input", message: "Bitte zuerst eine CSV-Datei hochladen." });
    expect(await t.run((ctx) => ctx.db.query("products").collect())).toHaveLength(0);
  });

  test("IMP-012 contacts without a number are keyed by USt-IdNr or e-mail and created", async () => {
    const { t, owner } = await setup();
    const importId = await project(t, owner, CONTACTS, "contacts", "kontakte.csv");
    await owner.mutation(api.csvImports.setMapping, {
      importId,
      columns: { organizationName: "Firma", vatId: "USt-IdNr", email: "E-Mail", postalCode: "PLZ" },
    });
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ rows: 2, new: 2, errors: 0 });
    const r = await owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash });
    expect(r.created).toBe(2);
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts.find((c) => c.displayName === "Ohne Nummer GmbH")?.vatId).toBe("DE136695976");
    const records = await t.run((ctx) =>
      ctx.db
        .query("importedRecords")
        .withIndex("by_import", (q) => q.eq("importId", importId))
        .collect(),
    );
    expect(records).toHaveLength(2);
  });

  test("E-IMP-16 a contact row with the company's own USt-IdNr is listed as an error in the preview and not imported", async () => {
    const { t, owner } = await setup();
    const own = (await t.run((ctx) => getCompanyProfile(ctx)))?.vatId as string;
    expect(own).toMatch(/^DE\d{9}$/);
    const importId = await project(
      t,
      owner,
      `Firma;USt-IdNr\nEigen GmbH;${own}\nFremd AG;DE136695976\n`,
      "contacts",
      "eigen.csv",
    );
    await owner.mutation(api.csvImports.setMapping, {
      importId,
      columns: { organizationName: "Firma", vatId: "USt-IdNr" },
    });
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ new: 1, errors: 1 });
    expect(p.preview.problems).toContainEqual(
      expect.objectContaining({ line: 2, status: "error", message: "Zeile 2: Das ist Ihre eigene USt-IdNr." }),
    );
    expect(await owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash })).toMatchObject({
      status: "done",
      created: 1,
    });
    const names = (await t.run((ctx) => ctx.db.query("contacts").collect())).map((c) => c.displayName);
    expect(names).toContain("Fremd AG");
    expect(names).not.toContain("Eigen GmbH");
  });

  test("E-IMP-14 IMP-023 a row refused in the writing transaction marks the import failed with the German message", async () => {
    const { t, owner } = await setup();
    const cols = { organizationName: "Firma", debtorAccount: "Debitorenkonto" };
    const first = await project(t, owner, "Firma;Debitorenkonto\nErste GmbH;10001\n", "contacts", "erste.csv");
    await owner.mutation(api.csvImports.setMapping, { importId: first, columns: cols });
    const p1 = await owner.action(api.csvImports.preview, { importId: first });
    await owner.action(api.csvImports.commit, { importId: first, previewHash: p1.previewHash });
    // The personal account is only checked against other contacts in the writing transaction (DATEV_ACCOUNT_TAKEN).
    const importId = await project(t, owner, "Firma;Debitorenkonto\nZweite GmbH;10001\n", "contacts", "zweite.csv");
    await owner.mutation(api.csvImports.setMapping, { importId, columns: cols });
    const p = await owner.action(api.csvImports.preview, { importId });
    expect(p.preview.counts).toMatchObject({ new: 1 });
    const message = "Das Personenkonto 10001 ist bereits Erste GmbH zugeordnet.";
    const e = await failure(owner.action(api.csvImports.commit, { importId, previewHash: p.previewHash }));
    expect(e).toMatchObject({ code: "invalid_input", reason: "DATEV_ACCOUNT_TAKEN" });
    expect(e.message).toContain(message);
    expect((await row(t, importId)).status).toBe("failed");
    expect((await row(t, importId)).error).toContain(message);
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts.some((c) => c.displayName === "Zweite GmbH")).toBe(false);
  });
});
