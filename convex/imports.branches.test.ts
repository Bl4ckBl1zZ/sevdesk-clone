/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { emptyAddress, emptyContactForm } from "../src/domain/schemas/contacts";
import { emptyProductForm } from "../src/domain/schemas/products";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { setArchived } from "./model/contacts";
import type { ImportedDocumentPayload, ImportedVoucherPayload } from "./model/imports";
import { makeT, type TestT } from "./test.setup";

/**
 * F09 sevdesk export import (IMP-003…026): the guards and optional paths of convex/model/imports.ts and
 * convex/imports.ts that the end-to-end import tests do not reach — workspace edits after discard, file and mapping
 * refusals, resolution validation, the read-only local snapshot, and the authoritative re-checks inside the commit
 * batches (number collisions, missing contacts/PDFs, Storno without original, archive-only vouchers in the booked
 * period, DATEV account conflicts). All fixtures are synthetic.
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

const CONTACTS = "Kundennummer;Name;Ort\nK-700;Synthetik GmbH;Berlin\n";
const enc = new TextEncoder();
const pdf = (seed: string) => enc.encode(`%PDF-1.4\n% ${seed}\n1 0 obj <</Type /Page>> endobj\n%%EOF\n`);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

async function setup(opts: { bookkeepingStart?: string | null } = {}) {
  const t = makeT();
  const { owner } = await setupInvoicing(t);
  const start = opts.bookkeepingStart === undefined ? "2026-06-01" : opts.bookkeepingStart;
  if (start) await owner.mutation(api.accounting.setBookkeepingStartDate, { date: start });
  return { t, owner };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

const actorOf = (owner: Owner) => ({ actor: owner.actor, role: "owner" as const, channel: "import" as const });

async function upload(
  t: TestT,
  owner: Owner,
  importId: Id<"imports">,
  files: readonly { name: string; content: string | Uint8Array }[],
) {
  const stored = [];
  for (const f of files)
    stored.push({
      storageId: await t.run((ctx) =>
        ctx.storage.store(
          new Blob([typeof f.content === "string" ? f.content : (f.content as Uint8Array<ArrayBuffer>)]),
        ),
      ),
      name: f.name,
    });
  return owner.action(api.imports.addFiles, { importId, files: stored });
}

const row = (t: TestT, id: Id<"imports">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"imports">>;
const fileId = async (t: TestT, id: Id<"imports">, name: string) =>
  (await row(t, id)).files.find((f) => f.name === name)?.id as string;
const auditOf = (t: TestT, id: Id<"imports">) =>
  t.run((ctx) =>
    ctx.db
      .query("auditLog")
      .withIndex("by_entity", (q) => q.eq("entity.table", "imports").eq("entity.id", id))
      .collect(),
  );

/** An import in `running` (preview stored, commit begun) with a contacts CSV, two PDFs and a JPEG. */
async function running(t: TestT, owner: Owner) {
  const importId = await owner.mutation(api.imports.create, {});
  await upload(t, owner, importId, [
    { name: "kontakte.csv", content: CONTACTS },
    { name: "RE-7001.pdf", content: pdf("re-7001") },
    { name: "Beleg_ER-1.pdf", content: pdf("er-1") },
    { name: "ER-2.jpg", content: JPEG },
  ]);
  const p = await owner.action(api.imports.preview, { importId });
  const r = await row(t, importId);
  await t.mutation(internal.imports.beginCommitInternal, {
    actorContext: actorOf(owner),
    importId,
    previewHash: p.previewHash,
    revision: r.revision,
    decisions: { numberRanges: [] },
  });
  return { importId, previewHash: p.previewHash };
}

/** A minimal imported contact (E-IMP-25 path) inside a running import; returns its local id. */
async function minimalContact(t: TestT, owner: Owner, importId: Id<"imports">, key: string, name: string) {
  await t.mutation(internal.imports.commitContactsInternal, {
    actorContext: actorOf(owner),
    importId,
    contacts: [],
    minimal: [{ key, name }],
  });
  const rec = await t.run((ctx) =>
    ctx.db
      .query("importedRecords")
      .withIndex("by_external", (q) => q.eq("externalType", "sevdesk.contact").eq("externalId", key))
      .first(),
  );
  return rec?.localId as Id<"contacts">;
}

const docPayload = (over: Partial<ImportedDocumentPayload> = {}): ImportedDocumentPayload => ({
  key: "invoice:RE-7001",
  type: "invoice",
  number: "RE-7001",
  documentDate: "2026-03-10",
  sentOn: "2026-03-10",
  sentOnAssumed: false,
  customerName: "",
  currency: "EUR",
  taxCase: "domestic",
  groups: [{ category: "S", rateBp: 1900, netCents: 10_000, vatCents: 1900, grossCents: 11_900 }],
  totals: { netCents: 10_000, vatCents: 1900, grossCents: 11_900 },
  finalStatus: "sent",
  contact: { kind: "import", key: "contact:K-700" },
  deviations: [],
  ...over,
});

const voucherPayload = (fileId: string, over: Partial<ImportedVoucherPayload> = {}): ImportedVoucherPayload => ({
  key: "voucher:lieferant|ER-1",
  number: "ER-1",
  supplierName: "Lieferant AG",
  documentDate: "2026-02-01",
  statusText: "",
  cancelled: false,
  taxRule: "input_vat_deductible",
  lines: [
    {
      position: 1,
      description: "Material",
      account: "",
      rateBp: 1900,
      netCents: 1000,
      vatCents: 190,
      grossCents: 1190,
    },
  ],
  totals: {
    netCents: 1000,
    vatCents: 190,
    grossCents: 1190,
    byRate: [{ rateBp: 1900, netCents: 1000, vatCents: 190 }],
  },
  statedGrossCents: 1190,
  deviations: [],
  fileId,
  ...over,
});

describe("F09 IMP-016 IMP-017 IMP-023 workspace guards (model/imports.ts)", () => {
  test("IMP-023 E-IMP-28 after a discard every workspace edit is refused with „Dieser Import wurde verworfen.“", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const f1 = await fileId(t, importId, "kontakte.csv");
    await owner.mutation(api.imports.discard, { importId });
    for (const p of [
      owner.mutation(api.imports.updateFile, { importId, fileId: f1, ignored: true }),
      owner.mutation(api.imports.removeFile, { importId, fileId: f1 }),
      owner.mutation(api.imports.setResolutions, { importId, resolutions: {} }),
      owner.mutation(api.imports.discard, { importId }),
    ]) {
      const e = await failure(p);
      expect(e).toMatchObject({
        code: "conflict",
        reason: "IMPORT_DISCARDED",
        message: "Dieser Import wurde verworfen.",
      });
    }
    // The commit of a discarded import names the discard (not a stale preview).
    const c = await failure(
      owner.action(api.imports.commit, { importId, previewHash: "x".repeat(64), numberRanges: [] }),
    );
    expect(c).toMatchObject({ reason: "IMPORT_COMMITTED", message: "Dieser Import wurde verworfen." });
    // A preview of a discarded import is refused too.
    const p = await failure(owner.action(api.imports.preview, { importId }));
    expect(p.reason).toBe("IMPORT_COMMITTED");
  });

  test("IMP-016 E-IMP-20 an unknown file id is refused; correcting the kind re-maps the file, ignoring keeps the kind", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const f1 = await fileId(t, importId, "kontakte.csv");
    for (const p of [
      owner.mutation(api.imports.updateFile, { importId, fileId: "f99", kind: "products" }),
      owner.mutation(api.imports.removeFile, { importId, fileId: "f99" }),
      owner.mutation(api.imports.setMapping, { importId, fileId: "f99", mapping: { columns: {} } }),
    ]) {
      expect(await failure(p)).toMatchObject({
        code: "not_found",
        message: "Die Datei gehört nicht zu diesem Import.",
      });
    }
    const before = await row(t, importId);
    expect(before.mapping?.[f1]?.columns).toMatchObject({ number: "Kundennummer" });
    await owner.mutation(api.imports.updateFile, { importId, fileId: f1, kind: "products" });
    const after = await row(t, importId);
    expect(after.files[0]).toMatchObject({ kind: "products", detectedKind: "contacts" });
    expect(after.mapping?.[f1]?.columns).not.toHaveProperty("organizationName");
    // A kind without a mapping grid drops the mapping; `ignored` alone keeps the kind (E-IMP-20).
    await owner.mutation(api.imports.updateFile, { importId, fileId: f1, kind: "unknown" });
    expect((await row(t, importId)).mapping?.[f1]).toBeUndefined();
    await owner.mutation(api.imports.updateFile, { importId, fileId: f1, ignored: true });
    expect((await row(t, importId)).files[0]).toMatchObject({ kind: "unknown", ignored: true });
    // Every change invalidated the preview and bumped the revision (audited as import.files).
    expect((await row(t, importId)).revision).toBe(before.revision + 3);
    expect((await auditOf(t, importId)).filter((a) => a.action === "import.files")).toHaveLength(4);
  });

  test("IMP-017 E-IMP-21 a mapping to a header the file does not have is refused; empty choices are dropped; a saved preset maps the next upload", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const f1 = await fileId(t, importId, "kontakte.csv");
    const e = await failure(
      owner.mutation(api.imports.setMapping, {
        importId,
        fileId: f1,
        mapping: { columns: { number: "Kundennr." } },
      }),
    );
    expect(e).toMatchObject({
      code: "invalid_input",
      message: "Die Spalte „Kundennr.“ gibt es in kontakte.csv nicht.",
    });
    // The owner maps `city` to the Name column (unusual on purpose) and saves the mapping as a preset.
    await owner.mutation(api.imports.setMapping, {
      importId,
      fileId: f1,
      mapping: { columns: { number: "Kundennummer", organizationName: "Name", city: "Name", street: "" } },
      savePresetAs: "  Meine Kontakte  ",
    });
    const mapped = await row(t, importId);
    expect(mapped.mapping?.[f1]?.columns).toEqual({ number: "Kundennummer", organizationName: "Name", city: "Name" });
    const presets = await t.run((ctx) => ctx.db.query("importMappingPresets").collect());
    expect(presets.map((p) => [p.name, p.fileKind, p.shipped])).toEqual([["Meine Kontakte", "contacts", false]]);
    // IMP-017: the latest saved preset that maps every required field wins for the next import project.
    const next = await owner.mutation(api.imports.create, {});
    await upload(t, owner, next, [{ name: "kontakte2.csv", content: CONTACTS }]);
    const f2 = await fileId(t, next, "kontakte2.csv");
    expect((await row(t, next)).mapping?.[f2]?.columns).toMatchObject({ city: "Name" });
    const view = await owner.query(api.imports.get, { importId: next });
    expect(view?.presets.map((p) => p.name)).toEqual(["Meine Kontakte"]);
  });

  test("IMP-016 a single file is removed with its storage; files are numbered after the highest id", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [
      { name: "kontakte.csv", content: CONTACTS },
      { name: "RE-1.pdf", content: pdf("rm-1") },
    ]);
    const pdfFile = (await row(t, importId)).files.find((f) => f.name === "RE-1.pdf");
    await owner.mutation(api.imports.removeFile, { importId, fileId: pdfFile?.id as string });
    expect(await t.run((ctx) => ctx.storage.get(pdfFile?.storageId as Id<"_storage">))).toBeNull();
    const audit = await auditOf(t, importId);
    expect(audit.at(-1)).toMatchObject({ action: "import.files" });
    expect(audit.at(-1)?.entity.label).toBe("RE-1.pdf");
    await upload(t, owner, importId, [{ name: "RE-2.pdf", content: pdf("rm-2") }]);
    expect((await row(t, importId)).files.map((f) => f.id)).toEqual(["f1", "f2"]);
  });

  test("IMP-016 the files of one import may total at most 2 GB", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    const e = await failure(
      t.mutation(internal.imports.addFilesInternal, {
        actorContext: actorOf(owner),
        importId,
        files: [
          {
            storageId,
            sha256: "a".repeat(64),
            bytes: 2 * 1024 ** 3 + 1,
            mime: "text/csv",
            name: "riesig.csv",
            kind: "unknown",
            readError: "zu groß",
          },
        ],
      }),
    );
    expect(e).toMatchObject({
      code: "invalid_input",
      message: "Die Dateien eines Imports dürfen zusammen höchstens 2 GB groß sein.",
    });
    expect((await row(t, importId)).files).toEqual([]);
  });

  test("IMP-016 a missing upload is reported and nothing of the call is kept", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const kept = await t.run((ctx) => ctx.storage.store(new Blob([CONTACTS])));
    const gone = await t.run((ctx) => ctx.storage.store(new Blob(["weg"])));
    await t.run((ctx) => ctx.storage.delete(gone));
    const e = await failure(
      owner.action(api.imports.addFiles, {
        importId,
        files: [
          { storageId: kept, name: "kontakte.csv" },
          { storageId: gone, name: "fehlt.csv" },
        ],
      }),
    );
    expect(e).toMatchObject({ code: "not_found", message: "Die Datei fehlt.csv wurde nicht gefunden." });
    expect(await t.run((ctx) => ctx.storage.get(kept))).toBeNull();
    expect((await row(t, importId)).files).toEqual([]);
  });

  test("E-IMP-37 IMP-022 E-IMP-07 resolutions are validated: cents, totals, reasons and PDF assignments", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const f1 = await fileId(t, importId, "kontakte.csv");
    const cases: [Record<string, unknown>, string][] = [
      [{ openAmounts: { "invoice:RE-1": -1 } }, "Offene Beträge in ganzen Cent ≥ 0."],
      [{ openAmounts: { "invoice:RE-1": 1.5 } }, "Offene Beträge in ganzen Cent ≥ 0."],
      [{ expectedOpenTotalCents: -5 }, "Die Summe der offenen Posten in ganzen Cent ≥ 0 angeben."],
      [
        { correctedTotals: { "invoice:RE-1": { grossCents: 0, reason: "PDF" } } },
        "Korrigierte Beträge in ganzen Cent ≠ 0.",
      ],
      [
        { correctedTotals: { "invoice:RE-1": { grossCents: 100, reason: "x".repeat(501) } } },
        "Der Grund darf höchstens 500 Zeichen lang sein.",
      ],
      [{ pdfAssignments: { "invoice:RE-1": f1 } }, "Bitte eine hochgeladene PDF-Datei zuordnen."],
    ];
    for (const [resolutions, message] of cases) {
      const e = await failure(owner.mutation(api.imports.setResolutions, { importId, resolutions }));
      expect(e).toMatchObject({ code: "invalid_input", message });
    }
    await owner.mutation(api.imports.setResolutions, {
      importId,
      resolutions: { openAmounts: { "invoice:RE-1": 0 }, expectedOpenTotalCents: 0 },
    });
    expect((await owner.query(api.imports.get, { importId }))?.resolutions).toEqual({
      openAmounts: { "invoice:RE-1": 0 },
      expectedOpenTotalCents: 0,
    });
  });

  test("IMP-009 E-IMP-27 a preview computed for an older revision is stale on arrival", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const r = await row(t, importId);
    const e = await failure(
      t.mutation(internal.imports.savePreviewInternal, {
        actorContext: actorOf(owner),
        importId,
        revision: r.revision - 1,
        previewHash: "b".repeat(64),
        preview: {},
      }),
    );
    expect(e).toMatchObject({
      code: "conflict",
      reason: "PREVIEW_STALE",
      message: "Die Vorschau ist veraltet. Bitte Vorschau neu erstellen.",
    });
    expect((await row(t, importId)).status).toBe("uploaded");
  });

  test("IMP-024 an unknown import: get answers null, the protocol and the workspace refuse it", async () => {
    const { t, owner } = await setup();
    // A real id of the imports table whose row no longer exists.
    const importId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("imports", {
        source: "sevdesk_export",
        files: [],
        status: "uploaded",
        revision: 0,
        stats: {},
        log: [],
        importerVersion: "test",
        startedAt: 0,
        actor: "system:test",
      });
      await ctx.db.delete(id);
      return id;
    });
    expect(await owner.query(api.imports.get, { importId })).toBeNull();
    expect(await failure(owner.action(api.imports.generateProtocol, { importId }))).toMatchObject({
      code: "not_found",
      message: "Der Import existiert nicht.",
    });
    expect(await failure(owner.mutation(api.imports.setResolutions, { importId, resolutions: {} }))).toMatchObject({
      code: "not_found",
      message: "Der Import existiert nicht.",
    });
  });
});

describe("F09 IMP-009 the read-only local snapshot (importLocalState)", () => {
  test("IMP-009 E-IMP-19 E-IMP-47 E-IMP-10 imported open amounts, register hits, name matches, closed periods and personal accounts", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const contactId = await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    await t.mutation(internal.imports.commitDocumentsInternal, {
      actorContext: actorOf(owner),
      importId,
      docs: [docPayload({ openAmountCents: 5000, paymentStatus: "partially_paid" })],
    });
    // Personal accounts: the imported contact has a debtor account; another contact owns a creditor account.
    await t.mutation(internal.imports.commitDatevInternal, {
      actorContext: actorOf(owner),
      importId,
      accounts: [{ account: "10700", field: "debtorAccount", contact: { kind: "local", id: contactId } }],
      files: [],
    });
    const other = await minimalContact(t, owner, importId, "contact:K-701", "Kreditor KG");
    await t.mutation(internal.imports.commitDatevInternal, {
      actorContext: actorOf(owner),
      importId,
      accounts: [{ account: "70100", field: "creditorAccount", contact: { kind: "local", id: other } }],
      files: [],
    });
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        { period: "2026-07", status: "locked", lockedAt: Date.now(), lockedBy: owner.actor, reason: "ustva_submitted" },
        { action: "period.lock" },
      ),
    );
    const state = await owner.query(api.imports.localState, {
      today: "2026-10-23",
      keys: {
        imported: [
          "sevdesk.document|invoice:RE-7001",
          "sevdesk.document|invoice:RE-0000",
          "sevdesk.contact|contact:K-700",
        ],
        registerNumbers: [],
        contactNumbers: ["K-404"],
        contactNames: ["synthetik gmbh", "kreditor kg"],
        productNumbers: ["ART-404"],
        documentNumbers: ["RE-7001", "RE-0000"],
        personalAccounts: ["10700", "70100", "99999"],
      },
    });
    expect(state.imported).toMatchObject({ "sevdesk.contact|contact:K-700": contactId });
    expect(state.importedOpen).toEqual({ "sevdesk.document|invoice:RE-7001": 5000 });
    expect(Object.keys(state.registerNumbers)).toEqual([]);
    expect(state.documentsByNumber["RE-7001"]).toMatchObject({ type: "invoice" });
    expect(state.contactsByNumber).toEqual({});
    expect(state.contactsByName).toEqual({ "synthetik gmbh": [contactId], "kreditor kg": [other] });
    expect(state.productsByNumber).toEqual({});
    expect(state.closedPeriods).toEqual({ "2026-07": "ustva_submitted" });
    expect(state.contactAccounts).toEqual({
      [contactId]: { debtorAccount: "10700" },
      [other]: { creditorAccount: "70100" },
    });
    expect(state.accountOwners).toEqual({ "10700": contactId, "70100": other });
    expect(state.opening).toMatchObject({ date: "2026-06-01", receivablesPosted: false });
  });
});

describe("F09 IMP-023 E-IMP-14 commit lifecycle (beginImportCommit, failImport, finishImport)", () => {
  test("IMP-023 a running import cannot be begun twice; a failed run resumes; a done import is refused as committed", async () => {
    const { t, owner } = await setup();
    const { importId, previewHash } = await running(t, owner);
    const r = await row(t, importId);
    const begin = () =>
      t.mutation(internal.imports.beginCommitInternal, {
        actorContext: actorOf(owner),
        importId,
        previewHash,
        revision: r.revision,
        decisions: { numberRanges: [] },
      });
    expect(await failure(begin())).toMatchObject({ reason: "IMPORT_RUNNING", message: "Der Import läuft bereits." });
    await t.mutation(internal.imports.failInternal, { actorContext: actorOf(owner), importId, message: "Charge 2" });
    expect(await row(t, importId)).toMatchObject({ status: "failed", error: "Charge 2" });
    expect((await row(t, importId)).log.at(-1)).toBe("Fehler: Charge 2");
    await begin(); // resume
    expect((await row(t, importId)).status).toBe("running");
    expect((await auditOf(t, importId)).filter((a) => a.action === "import.commit").map((a) => a.entity.label)).toEqual(
      [previewHash.slice(0, 12), "Fortsetzen"],
    );
    // finish: generic stats (created) are labelled as records; a longer record retention beats the 10 years
    await t.mutation(internal.imports.finishInternal, {
      actorContext: actorOf(owner),
      importId,
      stats: { created: 3 },
      log: ["fertig"],
      today: "2026-10-23",
      maxRetentionUntil: "2040-12-31",
    });
    const done = await row(t, importId);
    expect(done).toMatchObject({ status: "done", retentionUntil: "2040-12-31", committedBy: owner.actor });
    expect((await auditOf(t, importId)).find((a) => a.action === "import.finish")?.entity.label).toBe("3 Datensätze");
    // failImport outside `running` is a no-op; a begin on a done import is E-IMP-28.
    await t.mutation(internal.imports.failInternal, { actorContext: actorOf(owner), importId, message: "spät" });
    expect((await row(t, importId)).status).toBe("done");
    expect(await failure(begin())).toMatchObject({ reason: "IMPORT_COMMITTED" });
    // Batches refuse a non-running import.
    expect(
      await failure(
        t.mutation(internal.imports.commitProductsInternal, { actorContext: actorOf(owner), importId, products: [] }),
      ),
    ).toMatchObject({ reason: "IMPORT_NOT_RUNNING", message: "Der Import läuft nicht." });
  });

  test("IMP-024 the protocol cannot be attached or rendered before the import is done", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4"])));
    const e = await failure(
      t.mutation(internal.imports.attachProtocolInternal, {
        actorContext: actorOf(owner),
        importId,
        file: { storageId, sha256: "c".repeat(64), bytes: 8, mime: "application/pdf", name: "p.pdf" },
      }),
    );
    expect(e).toMatchObject({
      reason: "IMPORT_NOT_DONE",
      message: "Das Importprotokoll entsteht erst mit der Übernahme.",
    });
    const q = await failure(t.query(internal.imports.protocolInput, { importId }));
    expect(q).toMatchObject({ reason: "IMPORT_NOT_DONE" });
  });

  test("IMP-024 the protocol input carries files, mapping, decisions and preview findings of the frozen row", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [
      { name: "kontakte.csv", content: CONTACTS },
      { name: "liesmich.txt", content: "nichts" },
    ]);
    const txt = await fileId(t, importId, "liesmich.txt");
    await owner.mutation(api.imports.updateFile, { importId, fileId: txt, ignored: true });
    const p = await owner.action(api.imports.preview, { importId });
    const r = await row(t, importId);
    await t.mutation(internal.imports.beginCommitInternal, {
      actorContext: actorOf(owner),
      importId,
      previewHash: p.previewHash,
      revision: r.revision,
      decisions: {
        numberRanges: [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never", next: 10 }],
        missingPdfReason: "Archiv unvollständig",
      },
    });
    await t.mutation(internal.imports.finishInternal, {
      actorContext: actorOf(owner),
      importId,
      stats: {},
      log: [],
      today: "2026-10-23",
    });
    const input = await t.query(internal.imports.protocolInput, { importId });
    expect(input.commit).toMatchObject({ actor: owner.actor });
    expect(input.commit.startedAt).toBeTypeOf("number");
    expect(input.retentionUntil).toBe("2036-12-31");
    expect(input.files.find((f) => f.name === "kontakte.csv")).toMatchObject({ rows: 1, delimiter: ";" });
    expect(input.files.find((f) => f.name === "liesmich.txt")).toMatchObject({ ignored: true });
    expect(Object.values(input.mapping)[0]?.columns).toMatchObject({ number: "Kundennummer" });
    expect(input.decisions).toEqual({
      numberRanges: [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never", next: 10 }],
      missingPdfReason: "Archiv unvollständig",
    });
    expect(input.preview?.findingsTotal).toBe(p.preview.findingsTotal);
    expect((await auditOf(t, importId)).find((a) => a.action === "import.finish")?.entity.label).toBe("0 Belege");
    // „Protokoll erzeugen“ creates the missing protocol once; a second call keeps it.
    expect(await owner.action(api.imports.generateProtocol, { importId })).toEqual({ created: true });
    expect((await row(t, importId)).protocolFile?.mime).toBe("application/pdf");
    expect(await owner.action(api.imports.generateProtocol, { importId })).toEqual({ created: false });
  });
});

describe("F09 IMP-003 IMP-004 IMP-020 document batches re-check in the writing transaction", () => {
  test("IMP-004 E-IMP-06 a number already in the register refuses the batch", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    const commit = (docs: ImportedDocumentPayload[]) =>
      t.mutation(internal.imports.commitDocumentsInternal, { actorContext: actorOf(owner), importId, docs });
    expect(await commit([docPayload()])).toEqual({ created: 1, skipped: 0 });
    // same key: skipped (IMP-006); same number under another key: E-IMP-06
    expect(await commit([docPayload()])).toEqual({ created: 0, skipped: 1 });
    const e = await failure(commit([docPayload({ key: "invoice:RE-7001b" })]));
    expect(e).toMatchObject({
      code: "conflict",
      reason: "E_IMP_06",
      message: "Rechnungsnummer RE-7001 existiert bereits. Bitte Nummernkreise prüfen.",
    });
  });

  test("E-IMP-25 IMP-020 a missing contact or original PDF refuses the batch", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const commit = (docs: ImportedDocumentPayload[]) =>
      t.mutation(internal.imports.commitDocumentsInternal, { actorContext: actorOf(owner), importId, docs });
    expect(await failure(commit([docPayload()]))).toMatchObject({
      reason: "IMPORT_CONTACT_MISSING",
      message: "RE-7001: Kontakt nicht gefunden.",
    });
    expect(await failure(commit([docPayload({ contact: { kind: "local", id: "not-an-id" } })]))).toMatchObject({
      reason: "IMPORT_CONTACT_MISSING",
    });
    const contactId = await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    const csv = await fileId(t, importId, "kontakte.csv");
    expect(
      await failure(commit([docPayload({ contact: { kind: "local", id: contactId }, pdfFileId: csv })])),
    ).toMatchObject({ code: "conflict", message: "RE-7001: Original-PDF nicht gefunden." });
    expect(await t.run((ctx) => ctx.db.query("salesDocuments").collect())).toEqual([]);
  });

  test("IMP-003 IMP-020 EC-203 a cancelled credit note with PDF, due date, supply date and a corrected total is archived read-only", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const contactId = await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    const pdfId = await fileId(t, importId, "RE-7001.pdf");
    const commit = (docs: ImportedDocumentPayload[]) =>
      t.mutation(internal.imports.commitDocumentsInternal, { actorContext: actorOf(owner), importId, docs });
    await commit([docPayload({ contact: { kind: "local", id: contactId } })]);
    await commit([
      docPayload({
        key: "correction:GS-7001",
        type: "correction",
        number: "GS-7001",
        supplyDate: "2026-03-09",
        dueDate: "2026-03-24",
        sentOnAssumed: true,
        customerName: "Synthetik GmbH (alt)",
        finalStatus: "cancelled",
        groups: [{ category: "S", rateBp: 700, netCents: -1000, vatCents: -70, grossCents: -1070 }],
        totals: { netCents: -1000, vatCents: -70, grossCents: -1070 },
        correctsKey: "invoice:RE-7001",
        pdfFileId: pdfId,
        deviations: ["Original-PDF fehlt.", "Betrag weicht ab."],
        correctedTotal: { exportedGrossCents: -1000, grossCents: -1070, reason: "Betrag laut PDF" },
      }),
    ]);
    const docs = await t.run((ctx) => ctx.db.query("salesDocuments").collect());
    const original = docs.find((d) => d.number === "RE-7001") as Doc<"salesDocuments">;
    const gs = docs.find((d) => d.number === "GS-7001");
    expect(original.contactName).toBe("Synthetik GmbH");
    expect(original.internalNote).toBe("Importiert aus sevdesk-Export · archiviert. Original-PDF fehlt.");
    expect(gs).toMatchObject({
      status: "cancelled",
      correctsId: original._id,
      correctionKind: "credit",
      contactName: "Synthetik GmbH (alt)",
      dueDate: "2026-03-24",
      supplyDate: { kind: "date", date: "2026-03-09" },
      paymentTerms: { dueDays: 14 },
      artifactStatus: "ready",
      cancellation: { reason: "Storniert (laut sevdesk-Export)" },
      imported: true,
    });
    expect(gs?.internalNote).toBe(
      "Importiert aus sevdesk-Export · archiviert. Versanddatum = Rechnungsdatum (Import-Annahme). Betrag weicht ab.",
    );
    const register = await t.run((ctx) => ctx.db.query("numberRegister").collect());
    expect(register.find((r) => r.number === "GS-7001")?.status).toBe("cancelled_by_storno");
    const artifacts = await t.run((ctx) => ctx.db.query("documentArtifacts").collect());
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({ documentId: gs?._id, variant: "original", tool: { name: "sevdesk-import" } });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "import.corrected_total")).toMatchObject({
      reason: "Betrag laut PDF",
      entity: { table: "salesDocuments", id: gs?._id },
    });
    // the correction may also point at a local document id
    await commit([
      docPayload({
        key: "correction:GS-7003",
        type: "correction",
        number: "GS-7003",
        correctsLocalId: original._id,
        contact: { kind: "local", id: contactId },
      }),
    ]);
    const gs3 = await t.run(async (ctx) =>
      (await ctx.db.query("salesDocuments").collect()).find((d) => d.number === "GS-7003"),
    );
    expect(gs3?.correctsId).toBe(original._id);
  });

  test("E-IMP-10 EC-204 posting at import: Storno without original, other types and periods without a posting refuse", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    const commit = (docs: ImportedDocumentPayload[]) =>
      t.mutation(internal.imports.commitDocumentsInternal, { actorContext: actorOf(owner), importId, docs });
    expect(
      await failure(
        commit([docPayload({ key: "cancellation:ST-1", type: "cancellation", number: "ST-1", post: true })]),
      ),
    ).toMatchObject({
      reason: "IMPORT_STORNO_UNRESOLVED",
      message: "ST-1: Die stornierte Rechnung fehlt – die Stornorechnung kann nicht gebucht werden.",
    });
    // E-IMP-31: a reference that resolves to nothing cannot be posted either.
    expect(
      await failure(
        commit([
          docPayload({
            key: "cancellation:ST-2",
            type: "cancellation",
            number: "ST-2",
            correctsKey: "invoice:RE-404",
            post: true,
          }),
        ]),
      ),
    ).toMatchObject({ reason: "IMPORT_STORNO_UNRESOLVED" });
    expect(
      await failure(commit([docPayload({ key: "advance:AR-1", type: "advance_invoice", number: "AR-1", post: true })])),
    ).toMatchObject({
      reason: "IMPORT_POST_TYPE",
      message: "AR-1: Diese Belegart kann beim Import nicht gebucht werden.",
    });
    // Dated before the Buchungsbeginn: F08 skips the entry, so the import refuses instead of archiving unposted.
    const before = await failure(commit([docPayload({ post: true })]));
    expect(before).toMatchObject({ reason: "IMPORT_NOT_POSTED" });
    expect(before.message).toMatch(/^RE-7001 konnte nicht gebucht werden \(/);
    // A posted invoice after the Buchungsbeginn (cancelled per the export) and its posted Storno.
    const entriesBefore = (await t.run((ctx) => ctx.db.query("journalEntries").collect())).length;
    await commit([
      docPayload({
        key: "invoice:RE-7100",
        number: "RE-7100",
        documentDate: "2026-07-01",
        sentOn: "2026-07-01",
        finalStatus: "cancelled",
        post: true,
      }),
    ]);
    await commit([
      docPayload({
        key: "cancellation:ST-7100",
        type: "cancellation",
        number: "ST-7100",
        documentDate: "2026-07-02",
        sentOn: "2026-07-02",
        correctsKey: "invoice:RE-7100",
        groups: [{ category: "S", rateBp: 1900, netCents: -10_000, vatCents: -1900, grossCents: -11_900 }],
        totals: { netCents: -10_000, vatCents: -1900, grossCents: -11_900 },
        post: true,
      }),
    ]);
    const docs = await t.run((ctx) => ctx.db.query("salesDocuments").collect());
    const posted = docs.find((d) => d.number === "RE-7100");
    expect(posted?.origin).toMatchObject({ posted: true });
    expect(posted?.internalNote).toContain("beim Import gebucht");
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    expect(entries.length).toBe(entriesBefore + 2);
  });
});

describe("F09 IMP-007 opening receivables from the imported open items", () => {
  test("IMP-007 E-IMP-34 E-IMP-35 the opening batch re-checks the Buchungsbeginn and an existing receivables posting", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    await t.mutation(internal.imports.commitDocumentsInternal, {
      actorContext: actorOf(owner),
      importId,
      docs: [docPayload({ openAmountCents: 11_900, paymentStatus: "open" })],
    });
    // The Buchungsbeginn was removed after the preview.
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(ctx, { bookkeepingStartDate: undefined }, { action: "settings.company.update" }),
    );
    const opening = () =>
      t.mutation(internal.imports.commitOpeningInternal, { actorContext: actorOf(owner), importId });
    expect(await failure(opening())).toMatchObject({
      reason: "E_IMP_34",
      message: "Offene Posten werden in die Eröffnungsbilanz übernommen – bitte zuerst den Buchungsbeginn festlegen.",
    });
    await owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-06-01" });
    expect(await opening()).toEqual({ created: 1 });
    // once per import (marker)
    expect(await opening()).toEqual({ created: 0 });
    // A second import with an open item while the year's receivables are already posted: E-IMP-35.
    const second = await running(t, owner);
    await t.mutation(internal.imports.commitDocumentsInternal, {
      actorContext: actorOf(owner),
      importId: second.importId,
      docs: [
        docPayload({
          key: "invoice:RE-7200",
          number: "RE-7200",
          openAmountCents: 100,
          contact: { kind: "minimal", key: "contact:K-700" },
        }),
      ],
    });
    expect(
      await failure(
        t.mutation(internal.imports.commitOpeningInternal, { actorContext: actorOf(owner), importId: second.importId }),
      ),
    ).toMatchObject({
      reason: "E_IMP_35",
      message:
        "Für 2026 sind bereits offene Forderungen in der Eröffnungsbilanz erfasst. Bitte dort stornieren oder die offenen Rechnungen vom Import ausschließen.",
    });
  });

  test("IMP-007 UVA-06 under Ist taxation the open item carries its not-due VAT; without open items nothing is posted", async () => {
    const { t, owner } = await setup();
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] },
        { action: "settings.company.update" },
      ),
    );
    const { importId } = await running(t, owner);
    expect(
      await t.mutation(internal.imports.commitOpeningInternal, { actorContext: actorOf(owner), importId }),
    ).toEqual({
      created: 0,
    });
    const second = await running(t, owner);
    await minimalContact(t, owner, second.importId, "contact:K-700", "Synthetik GmbH");
    await t.mutation(internal.imports.commitDocumentsInternal, {
      actorContext: actorOf(owner),
      importId: second.importId,
      docs: [docPayload({ dueDate: "2026-04-10", openAmountCents: 11_900, paymentStatus: "open" })],
    });
    expect(
      await t.mutation(internal.imports.commitOpeningInternal, {
        actorContext: actorOf(owner),
        importId: second.importId,
      }),
    ).toEqual({ created: 1 });
    const items = await t.run((ctx) => ctx.db.query("openingItems").collect());
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ openCents: 11_900, dueDate: "2026-04-10" });
  });
});

describe("F09 IMP-025 archived vouchers (commitImportVouchers)", () => {
  test("IMP-025 E-IMP-44 E-IMP-42 no archive-only voucher in the booked period or without its file", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const pdfId = await fileId(t, importId, "Beleg_ER-1.pdf");
    const csvId = await fileId(t, importId, "kontakte.csv");
    const commit = (vouchers: ImportedVoucherPayload[]) =>
      t.mutation(internal.imports.commitVouchersInternal, { actorContext: actorOf(owner), importId, vouchers });
    expect(await failure(commit([voucherPayload(pdfId, { documentDate: "2026-06-01" })]))).toMatchObject({
      reason: "E_IMP_44",
      message: "ER-1: Belege ab dem Buchungsbeginn werden nicht archiviert. Bitte Vorschau neu erstellen.",
    });
    expect(await failure(commit([voucherPayload(csvId)]))).toMatchObject({
      reason: "E_IMP_42",
      message: "ER-1: Belegdatei nicht gefunden.",
    });
    expect(await t.run((ctx) => ctx.db.query("vouchers").collect())).toEqual([]);
  });

  test("IMP-025 a cancelled voucher with due date, payment date and cost centre; a second voucher on the same file records the file once", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const jpgId = await fileId(t, importId, "ER-2.jpg");
    const commit = (vouchers: ImportedVoucherPayload[]) =>
      t.mutation(internal.imports.commitVouchersInternal, { actorContext: actorOf(owner), importId, vouchers });
    expect(
      await commit([
        voucherPayload(jpgId, {
          cancelled: true,
          statusText: "Storniert",
          dueDate: "2026-02-15",
          paidOn: "2026-02-10",
          costCenter: "KST-1",
          deviations: ["Summe weicht ab."],
        }),
        voucherPayload(jpgId, { key: "voucher:lieferant|ER-2", number: "ER-2", taxRule: "no_input_vat" }),
      ]),
    ).toEqual({ created: 2, skipped: 0 });
    expect(await commit([voucherPayload(jpgId)])).toEqual({ created: 0, skipped: 1 });
    const vouchers = await t.run((ctx) => ctx.db.query("vouchers").collect());
    const v1 = vouchers.find((v) => v.documentNumber === "ER-1");
    expect(v1).toMatchObject({
      status: "cancelled",
      dueDate: "2026-02-15",
      cancelReason: "Storniert (laut sevdesk-Export)",
      retentionUntil: "2034-12-31",
    });
    expect(v1?.internalNote).toBe(
      "Importiert aus sevdesk-Export · archiviert · ohne Buchung (vor dem Buchungsbeginn). Status laut sevdesk: Storniert. Bezahlt am laut sevdesk: 2026-02-10. Kostenstelle laut sevdesk: KST-1. Summe weicht ab.",
    );
    expect(v1?.originalFiles[0]).toMatchObject({ name: "ER-2.jpg", mime: "image/jpeg", capturedVia: "upload" });
    const fileRecords = await t.run(async (ctx) =>
      (await ctx.db.query("importedRecords").collect()).filter((r) => r.externalType === "sevdesk.file"),
    );
    expect(fileRecords).toHaveLength(1);
    expect(fileRecords[0]?.externalId).toBe(await sha256Hex(JPEG));
  });

  test("IMP-025 E-IMP-44 without a Buchungsbeginn every archived voucher is refused", async () => {
    const { t, owner } = await setup({ bookkeepingStart: null });
    const { importId } = await running(t, owner);
    const pdfId = await fileId(t, importId, "Beleg_ER-1.pdf");
    const e = await failure(
      t.mutation(internal.imports.commitVouchersInternal, {
        actorContext: actorOf(owner),
        importId,
        vouchers: [voucherPayload(pdfId)],
      }),
    );
    expect(e.reason).toBe("E_IMP_44");
  });
});

describe("F09 IMP-026 E-IMP-47 DATEV personal accounts are never overwritten", () => {
  test("IMP-026 E-IMP-47 unknown contacts, set accounts and accounts of another contact are skipped; files are recorded once", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const a = await minimalContact(t, owner, importId, "contact:K-700", "Synthetik GmbH");
    const b = await minimalContact(t, owner, importId, "contact:K-701", "Zweite GmbH");
    const commit = (
      accounts: {
        account: string;
        field: "debtorAccount" | "creditorAccount";
        contact: { kind: "import"; key: string } | { kind: "local"; id: string };
      }[],
      files: { id: string; sha256: string }[] = [],
    ) => t.mutation(internal.imports.commitDatevInternal, { actorContext: actorOf(owner), importId, accounts, files });
    expect(
      await commit(
        [
          { account: "10700", field: "debtorAccount", contact: { kind: "import", key: "contact:K-700" } },
          { account: "10999", field: "debtorAccount", contact: { kind: "import", key: "contact:K-404" } },
          { account: "10998", field: "debtorAccount", contact: { kind: "local", id: "kaputt" } },
        ],
        [{ id: "f9", sha256: "d".repeat(64) }],
      ),
    ).toEqual({ assigned: 1, skipped: 2 });
    expect(
      await commit(
        [
          // a already has a debtor account → kept
          { account: "10701", field: "debtorAccount", contact: { kind: "local", id: a } },
          // 10700 belongs to a → not given to b
          { account: "10700", field: "debtorAccount", contact: { kind: "local", id: b } },
          // b gets a creditor account
          { account: "70701", field: "creditorAccount", contact: { kind: "local", id: b } },
        ],
        [{ id: "f9", sha256: "d".repeat(64) }],
      ),
    ).toEqual({ assigned: 1, skipped: 2 });
    const [ca, cb] = await t.run(async (ctx) => [await ctx.db.get(a), await ctx.db.get(b)]);
    expect(ca).toMatchObject({ debtorAccount: "10700" });
    expect(cb?.debtorAccount).toBeUndefined();
    expect(cb).toMatchObject({ creditorAccount: "70701" });
    const datev = await t.run(async (ctx) =>
      (await ctx.db.query("importedRecords").collect()).filter((r) => r.externalType === "sevdesk.datev"),
    );
    expect(datev).toHaveLength(1);
  });

  test("E-IMP-25 minimal contacts: a free customer number is kept, a taken one is dropped; re-runs skip", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const commit = (minimal: { key: string; name: string; customerNumber?: string }[]) =>
      t.mutation(internal.imports.commitContactsInternal, {
        actorContext: actorOf(owner),
        importId,
        contacts: [],
        minimal,
      });
    expect(await commit([{ key: "contact:K-800", name: "Frei GmbH", customerNumber: "K-800" }])).toEqual({
      created: 1,
      skipped: 0,
    });
    expect(
      await commit([
        { key: "contact:K-800", name: "Frei GmbH", customerNumber: "K-800" },
        { key: "contact:name:belegt", name: "Belegt GmbH", customerNumber: "K-800" },
      ]),
    ).toEqual({ created: 1, skipped: 1 });
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts.find((c) => c.displayName === "Frei GmbH")?.number).toBe("K-800");
    const belegt = contacts.find((c) => c.displayName === "Belegt GmbH");
    expect(belegt?.number).not.toBe("K-800");
    expect(belegt?.notes).toBe("Aus sevdesk-Import – unvollständig (Kontakt fehlte im Kontakte-Export).");
    // products: an already imported key is skipped (IMP-006), the category path is created
    const products = () =>
      t.mutation(internal.imports.commitProductsInternal, {
        actorContext: actorOf(owner),
        importId,
        products: [
          {
            key: "product:ART-800",
            categoryPath: "Dienstleistungen",
            form: { ...emptyProductForm(), number: "ART-800", name: "Beratung", price: "95,00" },
          },
        ],
      });
    expect(await products()).toEqual({ created: 1, skipped: 0 });
    expect(await products()).toEqual({ created: 0, skipped: 1 });
    const product = await t.run(async (ctx) =>
      (await ctx.db.query("products").collect()).find((p) => p.number === "ART-800"),
    );
    expect(product?.categoryId).toBeDefined();
  });
});

describe("F09 IMP-009 IMP-023 preview and commit actions (convex/imports.ts)", () => {
  const INVOICES_HEADER = "Rechnungsnummer;Rechnungsdatum;Kundennummer;Kunde;Netto;Steuer;Brutto;Offen\n";

  test("IMP-009 GOBD-20 a stored file that went missing or was swapped blocks the preview", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const file = (await row(t, importId)).files[0] as Doc<"imports">["files"][number];
    const other = await t.run((ctx) => ctx.storage.store(new Blob([`${CONTACTS}K-701;Andere GmbH;Bonn\n`])));
    await t.run((ctx) => ctx.db.patch(importId, { files: [{ ...file, storageId: other }] }));
    expect(await failure(owner.action(api.imports.preview, { importId }))).toMatchObject({
      code: "conflict",
      message: "Die Datei kontakte.csv wurde verändert.",
    });
    await t.run((ctx) => ctx.storage.delete(other));
    expect(await failure(owner.action(api.imports.preview, { importId }))).toMatchObject({
      code: "not_found",
      message: "Die Datei kontakte.csv fehlt im Speicher.",
    });
    await t.run((ctx) => ctx.db.patch(importId, { files: [file] }));
  });

  test("E-IMP-20 E-IMP-21 a PDF classified as contacts has no table and no columns to map", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "RE-1.pdf", content: pdf("as-contacts") }]);
    const f1 = await fileId(t, importId, "RE-1.pdf");
    await owner.mutation(api.imports.updateFile, { importId, fileId: f1, kind: "contacts" });
    expect(
      await failure(
        owner.mutation(api.imports.setMapping, { importId, fileId: f1, mapping: { columns: { number: "Nr" } } }),
      ),
    ).toMatchObject({ code: "invalid_input", message: "Die Spalte „Nr“ gibt es in RE-1.pdf nicht." });
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBeGreaterThan(0);
    expect(p.preview.counts.contacts ?? 0).toBe(0);
  });

  test("IMP-017 a saved preset that misses a required field is not applied; the shipped mapping is used", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [{ name: "kontakte.csv", content: CONTACTS }]);
    const f1 = await fileId(t, importId, "kontakte.csv");
    await owner.mutation(api.imports.setMapping, {
      importId,
      fileId: f1,
      mapping: { columns: { city: "Ort" } },
      savePresetAs: "Nur Ort",
    });
    const next = await owner.mutation(api.imports.create, {});
    await upload(t, owner, next, [{ name: "kontakte2.csv", content: CONTACTS }]);
    const f2 = await fileId(t, next, "kontakte2.csv");
    expect((await row(t, next)).mapping?.[f2]?.columns).toMatchObject({ number: "Kundennummer", city: "Ort" });
  });

  test("IMP-016 a single file over 50 MB is refused and deleted", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const big = await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(50 * 1024 * 1024 + 1)])));
    expect(
      await failure(owner.action(api.imports.addFiles, { importId, files: [{ storageId: big, name: "riesig.zip" }] })),
    ).toMatchObject({ code: "invalid_input", message: "riesig.zip ist größer als 50 MB." });
    expect(await t.run((ctx) => ctx.storage.get(big))).toBeNull();
  });

  test("IMP-007 E-IMP-34 IMP-023 a preview with blocking errors cannot be committed", async () => {
    const { t, owner } = await setup({ bookkeepingStart: null });
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [
      { name: "kontakte.csv", content: CONTACTS },
      {
        name: "rechnungen.csv",
        content: `${INVOICES_HEADER}RE-9101;15.03.2026;K-700;Synthetik GmbH;100,00;19,00;119,00;119,00\n`,
      },
    ]);
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBe(1);
    const e = await failure(
      owner.action(api.imports.commit, {
        importId,
        previewHash: p.previewHash,
        numberRanges: [],
        missingPdfReason: "x",
      }),
    );
    expect(e).toMatchObject({
      code: "invalid_input",
      reason: "IMPORT_BLOCKED",
      message: "Die Vorschau enthält noch 1 Fehler. Bitte beheben oder Zeilen ausschließen.",
    });
    expect((await row(t, importId)).status).toBe("previewed");
  });

  test("E-IMP-25 E-IMP-07 IMP-023 invoices without a contacts export create minimal contacts; a done import is not committed again", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [
      {
        name: "rechnungen.csv",
        content: `${INVOICES_HEADER}RE-9201;15.03.2026;K-920;Unbekannt GmbH;100,00;19,00;119,00;0,00\n`,
      },
    ]);
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBe(0);
    const r = await owner.action(api.imports.commit, {
      importId,
      previewHash: p.previewHash,
      numberRanges: [],
      missingPdfReason: "  PDF-Archiv nicht mehr vorhanden  ",
    });
    expect(r.counts).toMatchObject({ contactsCreated: 1, documentsCreated: 1 });
    const contact = await t.run(async (ctx) =>
      (await ctx.db.query("contacts").collect()).find((c) => c.displayName === "Unbekannt GmbH"),
    );
    expect(contact?.notes).toBe("Aus sevdesk-Import – unvollständig (Kontakt fehlte im Kontakte-Export).");
    const done = await row(t, importId);
    expect(done.log).toContain("Ohne Original-PDF übernommen (1): PDF-Archiv nicht mehr vorhanden");
    expect(done.decisions).toMatchObject({ missingPdfReason: "PDF-Archiv nicht mehr vorhanden" });
    expect(
      await failure(owner.action(api.imports.commit, { importId, previewHash: p.previewHash, numberRanges: [] })),
    ).toMatchObject({
      reason: "IMPORT_COMMITTED",
      message: "Der Import wurde bereits übernommen und kann nicht verworfen werden.",
    });
    // E-IMP-28: a begin on a done import with another hash is refused as committed, not as stale.
    expect(
      await failure(
        t.mutation(internal.imports.beginCommitInternal, {
          actorContext: actorOf(owner),
          importId,
          previewHash: "e".repeat(64),
          revision: done.revision,
          decisions: { numberRanges: [] },
        }),
      ),
    ).toMatchObject({ reason: "IMPORT_COMMITTED" });
  });

  test("IMP-023 a begin on a discarded import is refused as discarded", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await owner.mutation(api.imports.discard, { importId });
    expect(
      await failure(
        t.mutation(internal.imports.beginCommitInternal, {
          actorContext: actorOf(owner),
          importId,
          previewHash: "e".repeat(64),
          revision: 0,
          decisions: { numberRanges: [] },
        }),
      ),
    ).toMatchObject({ reason: "IMPORT_DISCARDED", message: "Dieser Import wurde verworfen." });
  });

  test("IMP-006 a contact from the contacts export is created once; IMP-009 archived contacts and open periods are not matched", async () => {
    const { t, owner } = await setup();
    const { importId } = await running(t, owner);
    const values = {
      contact: { ...emptyContactForm(), kind: "organization", organizationName: "Voll GmbH", roles: ["customer"] },
      billingAddress: { ...emptyAddress(), name: "Voll GmbH" },
      channels: [],
    };
    const commit = () =>
      t.mutation(internal.imports.commitContactsInternal, {
        actorContext: actorOf(owner),
        importId,
        contacts: [{ key: "contact:K-750", values }],
        minimal: [],
      });
    expect(await commit()).toEqual({ created: 1, skipped: 0 });
    expect(await commit()).toEqual({ created: 0, skipped: 1 });
    const id = await t.run(async (ctx) =>
      (await ctx.db.query("contacts").collect()).find((c) => c.displayName === "Voll GmbH"),
    );
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      setArchived(ctx, id?._id as Id<"contacts">, true),
    );
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedInsert(ctx, "periods", { period: "2026-08", status: "open" }, { action: "period.lock" }),
    );
    const state = await owner.query(api.imports.localState, {
      today: "2026-10-23",
      keys: {
        imported: [],
        registerNumbers: [],
        contactNumbers: [],
        contactNames: ["voll gmbh"],
        productNumbers: [],
        documentNumbers: [],
      },
    });
    expect(state.contactsByName).toEqual({});
    expect(state.closedPeriods).toEqual({});
    expect(state.contactAccounts).toEqual({});
  });
});
