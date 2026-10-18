/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import kontakte from "../test/fixtures/sevdesk-export/kontakte.csv?raw";
import pdfGs from "../test/fixtures/sevdesk-export/pdf/GS-0001.pdf?raw";
import pdfOrphan from "../test/fixtures/sevdesk-export/pdf/RE-0999.pdf?raw";
import pdf1001 from "../test/fixtures/sevdesk-export/pdf/RE-1001.pdf?raw";
import pdf1005 from "../test/fixtures/sevdesk-export/pdf/RE-1005_RE-1006.pdf?raw";
import pdf1002 from "../test/fixtures/sevdesk-export/pdf/Rechnung_RE-1002.pdf?raw";
import pdf1003 from "../test/fixtures/sevdesk-export/pdf/re 1003.PDF?raw";
import rechnungen from "../test/fixtures/sevdesk-export/rechnungen.csv?raw";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { assignCounterNumber } from "./model/numberRanges";
import { makeT, type TestT } from "./test.setup";

/** Products CSV in UTF-8 (the Windows-1252 fixture is covered by the domain tests; `?raw` would re-decode it). */
const ARTIKEL =
  "Artikelnummer;Name;Beschreibung;Einheit;Preis (netto);Steuersatz\nART-001;Beratung;Je Stunde;Std;95,00;19\nART-002;Fachbuch;Buch;Stk;24,30;7\n";

const FILES = [
  { name: "kontakte.csv", content: kontakte },
  { name: "artikel.csv", content: ARTIKEL },
  { name: "rechnungen.csv", content: rechnungen },
  { name: "RE-1001.pdf", content: pdf1001 },
  { name: "Rechnung_RE-1002.pdf", content: pdf1002 },
  { name: "re 1003.PDF", content: pdf1003 },
  { name: "GS-0001.pdf", content: pdfGs },
  { name: "RE-1005_RE-1006.pdf", content: pdf1005 },
  { name: "RE-0999.pdf", content: pdfOrphan },
];

const RANGES = [
  { rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never" as const, next: 1008 },
  { rangeKey: "correction", format: "GS-{####}", resetPolicy: "never" as const, next: 2 },
];
const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);

async function setup() {
  const t = makeT();
  const { owner } = await setupInvoicing(t);
  return { t, owner };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

async function upload(t: TestT, owner: Owner, importId: Id<"imports">, files = FILES) {
  const stored = [];
  for (const f of files)
    stored.push({ storageId: await t.run((ctx) => ctx.storage.store(new Blob([f.content]))), name: f.name });
  return owner.action(api.imports.addFiles, { importId, files: stored });
}

/**
 * Upload, preview, resolve the ambiguous PDF (RE-1005 gets it; RE-1006 is excluded, or with `assignAll` gets the
 * otherwise orphaned file), preview again.
 */
async function prepared(t: TestT, owner: Owner, opts: { assignAll?: boolean } = {}) {
  const importId = await owner.mutation(api.imports.create, {});
  await upload(t, owner, importId);
  const first = await owner.action(api.imports.preview, { importId });
  const view = await owner.query(api.imports.get, { importId });
  const combined = view?.files.find((f) => f.name === "RE-1005_RE-1006.pdf")?.id as string;
  const orphan = view?.files.find((f) => f.name === "RE-0999.pdf")?.id as string;
  const re1006 = first.preview.findings.find((f) => f.code === "E-IMP-22" && f.key === "invoice:RE-1006")
    ?.rowRef as string;
  await owner.mutation(api.imports.setResolutions, {
    importId,
    resolutions: opts.assignAll
      ? { pdfAssignments: { "invoice:RE-1005": combined, "invoice:RE-1006": orphan } }
      : { pdfAssignments: { "invoice:RE-1005": combined }, excluded: [re1006] },
  });
  const second = await owner.action(api.imports.preview, { importId });
  return { importId, first, second };
}

const businessCounts = (t: TestT) =>
  t.run(async (ctx) => ({
    documents: (await ctx.db.query("salesDocuments").collect()).length,
    contacts: (await ctx.db.query("contacts").collect()).length,
    products: (await ctx.db.query("products").collect()).length,
    register: (await ctx.db.query("numberRegister").collect()).length,
    importedRecords: (await ctx.db.query("importedRecords").collect()).length,
    snapshots: (await ctx.db.query("documentSnapshots").collect()).length,
  }));

const importedDocs = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("salesDocuments").collect()).filter((d) => d.imported === true));

describe("F09 sevdesk export import — upload, preview, commit (Convex)", () => {
  test("TST-IMP-16 IMP-016 IMP-017 files are classified and mapped with the shipped presets", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const r = await upload(t, owner, importId);
    expect(r.added).toHaveLength(9);
    const view = await owner.query(api.imports.get, { importId });
    expect(view?.files.map((f) => [f.name, f.kind])).toEqual([
      ["kontakte.csv", "contacts"],
      ["artikel.csv", "products"],
      ["rechnungen.csv", "invoices"],
      ["RE-1001.pdf", "pdf"],
      ["Rechnung_RE-1002.pdf", "pdf"],
      ["re 1003.PDF", "pdf"],
      ["GS-0001.pdf", "pdf"],
      ["RE-1005_RE-1006.pdf", "pdf"],
      ["RE-0999.pdf", "pdf"],
    ]);
    const invoices = view?.files.find((f) => f.kind === "invoices");
    expect(view?.mapping[invoices?.id as string]?.columns).toMatchObject({
      number: "Rechnungsnummer",
      gross: "Brutto",
    });
    expect(invoices?.samples?.[0]?.[0]).toBe("RE-1001");
    // identical bytes uploaded again count once (§4.3.5 step 4)
    const again = await upload(t, owner, importId, [{ name: "RE-1001 Kopie.pdf", content: pdf1001 }]);
    expect(again).toEqual({ added: [], duplicates: ["RE-1001 Kopie.pdf"] });
  });

  test("TST-IMP-09 IMP-009 the preview writes no business data, stores counts and a stable hash", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId);
    const before = await businessCounts(t);
    const p1 = await owner.action(api.imports.preview, { importId });
    const p2 = await owner.action(api.imports.preview, { importId });
    expect(await businessCounts(t)).toEqual(before);
    expect(p1.previewHash).toBe(p2.previewHash);
    expect(p1.preview.counts).toMatchObject({
      contactsNew: 3,
      productsNew: 2,
      invoices: 5,
      corrections: 1,
      cancellations: 1,
    });
    expect(p1.preview.blocking).toBe(2); // RE-1005 / RE-1006 share one PDF (E-IMP-22)
    const view = await owner.query(api.imports.get, { importId });
    expect(view).toMatchObject({ status: "previewed", previewHash: p1.previewHash });
  });

  test("TST-IMP-16 TST-IMP-19 IMP-003 IMP-004 IMP-020 EC-190 commit creates archived documents with original numbers and PDFs", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner);
    expect(second.preview.blocking).toBe(0);
    // E-IMP-07: rows without PDF need the explicit confirmation
    const missing = await owner
      .action(api.imports.commit, { importId, previewHash: second.previewHash, numberRanges: RANGES })
      .catch((e) => e);
    expect(reasonOf(missing)).toBe("E_IMP_07");
    const r = await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: RANGES,
      missingPdfReason: "Storno und RE-1004/RE-1007 ohne PDF im sevdesk-Export",
    });
    expect(r.counts).toMatchObject({ contactsCreated: 4, productsCreated: 2, documentsCreated: 8 });

    const docs = await importedDocs(t);
    const byNumber = new Map(docs.map((d) => [d.number, d]));
    expect([...byNumber.keys()].sort()).toEqual(
      ["GS-0001", "RE-1001", "RE-1002", "RE-1003", "RE-1004", "RE-1005", "RE-1007", "STORNO-1004"].sort(),
    );
    for (const d of docs) {
      expect(d).toMatchObject({ imported: true, channel: "import", origin: { source: "sevdesk_export", importId } });
      expect(d.lockedAt).toBeTypeOf("number");
      expect(d.snapshotId).toBeUndefined();
    }
    expect(byNumber.get("RE-1001")).toMatchObject({
      status: "sent",
      paymentStatus: "paid",
      openAmountCents: 0,
      taxCase: "domestic",
    });
    expect(byNumber.get("RE-1002")).toMatchObject({ paymentStatus: "partially_paid", openAmountCents: 5700 });
    expect(byNumber.get("RE-1002")?.zugang).toEqual({
      date: "2026-02-05",
      basis: "manual",
      reason: "Import-Annahme: Versanddatum + 3 Tage (F09 §4.3.3)",
    });
    expect(byNumber.get("RE-1003")).toMatchObject({ taxCase: "intra_community_supply", paymentStatus: "open" });
    expect(byNumber.get("RE-1003")?.supplyDate).toBeUndefined(); // EC-190: not enforced retroactively
    expect(byNumber.get("RE-1004")?.status).toBe("cancelled");
    expect(byNumber.get("STORNO-1004")).toMatchObject({
      type: "cancellation",
      correctsId: byNumber.get("RE-1004")?._id,
    });
    expect(byNumber.get("GS-0001")).toMatchObject({ type: "correction", correctsId: byNumber.get("RE-1001")?._id });
    expect(byNumber.get("RE-1005")?.taxCase).toBe("unknown_imported");

    await t.run(async (ctx) => {
      const re1001 = byNumber.get("RE-1001") as NonNullable<ReturnType<typeof byNumber.get>>;
      const lines = await ctx.db
        .query("documentLines")
        .withIndex("by_document", (q) => q.eq("documentId", re1001._id))
        .collect();
      expect(lines).toEqual([
        expect.objectContaining({
          fromSummary: true,
          name: "Positionen siehe Original-PDF",
          lineNetCents: 100000,
          vatRateBp: 1900,
        }),
      ]);
      // IMP-003: the original PDF byte-identical (SHA-256 of the uploaded file)
      const artifacts = await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", re1001._id))
        .collect();
      expect(artifacts).toEqual([
        expect.objectContaining({
          kind: "pdf",
          variant: "original",
          name: "RE-1001.pdf",
          sha256: await sha256Hex(new TextEncoder().encode(pdf1001)),
          tool: { name: "sevdesk-import", version: "sevdesk-export-import@1" },
        }),
      ]);
      // IMP-004: imported numbers in the register
      const reg = await ctx.db
        .query("numberRegister")
        .withIndex("by_normalized", (q) => q.eq("normalized", "RE-1004"))
        .first();
      expect(reg).toMatchObject({
        imported: true,
        status: "cancelled_by_storno",
        documentId: byNumber.get("RE-1004")?._id,
      });
      // TST-IMP-19: never re-rendered
      expect((await ctx.db.query("documentSnapshots").collect()).length).toBe(0);
      // IMP-008: retention from the original date
      expect(re1001.retentionUntil).toBe("2034-12-31");
      // IMP-021 / E-IMP-25: the minimal contact for the unknown customer
      const minimal = await ctx.db
        .query("contacts")
        .withIndex("by_number", (q) => q.eq("numberNormalized", "2001"))
        .first();
      expect(minimal?.displayName).toBe("Neukunde KG");
      // IMP-014: audit entries on channel import, actor = the committing user
      const audits = (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "document.import");
      expect(audits.length).toBeGreaterThan(0);
      expect(audits.every((a) => a.channel === "import" && a.actor === owner.actor)).toBe(true);
      // IMP-024: the import row keeps the source files ≥ 10 years
      const row = await ctx.db.get(importId);
      expect(row).toMatchObject({ status: "done", committedBy: owner.actor });
      expect(row?.files).toHaveLength(9);
      expect(Number(row?.retentionUntil?.slice(0, 4))).toBeGreaterThanOrEqual(2036);
    });
  });

  test("TST-IMP-05 EC-014 IMP-005 the confirmed range continues above the imported maximum", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner);
    const invoice = second.preview.numberRanges.find((r) => r.rangeKey === "invoice");
    expect(invoice?.candidates[0]).toMatchObject({ format: "RE-{####}", next: 1008 });
    await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: RANGES,
      missingPdfReason: "ohne PDF",
    });
    const next = await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      assignCounterNumber(ctx, { docType: "invoice", date: { year: 2026, month: 10 }, action: "document.finalize" }),
    );
    expect(next.number).toBe("RE-1008");
    // E-IMP-12: a next value that would re-create an imported number is refused
    const t2 = await setup();
    const p = await prepared(t2.t, t2.owner);
    const e = await t2.owner
      .action(api.imports.commit, {
        importId: p.importId,
        previewHash: p.second.previewHash,
        numberRanges: [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never", next: 1005 }],
        missingPdfReason: "ohne PDF",
      })
      .catch((x) => x);
    expect(messageOf(e)).toBe("Die nächste Nummer RE-1005 wäre nicht eindeutig.");
    expect((await t2.t.run((ctx) => ctx.db.get(p.importId)))?.status).toBe("failed");
  });

  test("TST-IMP-02 IMP-003 GOBD-06 an imported document is immutable", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner);
    await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
    });
    const doc = (await importedDocs(t)).find((d) => d.number === "RE-1001");
    const e = await t
      .model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
        auditedPatch(
          ctx,
          "salesDocuments",
          doc?._id as Id<"salesDocuments">,
          { totals: { ...(doc?.totals as NonNullable<typeof doc>["totals"]), grossCents: 1 } },
          {
            action: "document.update_draft",
          },
        ),
      )
      .catch((x) => x);
    expect(errorCode(e)).toBe("immutable_record");
    // the committed import itself is frozen (migration evidence)
    const discard = await owner.mutation(api.imports.discard, { importId }).catch((x) => x);
    expect(messageOf(discard)).toBe("Der Import wurde bereits übernommen und kann nicht verworfen werden.");
  });

  test("TST-IMP-03 IMP-006 E-IMP-04 the same export imported again creates nothing", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner, { assignAll: true });
    await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
    });
    expect((await importedDocs(t)).length).toBe(9);
    const before = await businessCounts(t);
    const again = await owner.mutation(api.imports.create, {});
    await upload(t, owner, again);
    const p = await owner.action(api.imports.preview, { importId: again });
    expect(p.preview.counts).toMatchObject({
      contactsNew: 0,
      contactsSkipped: 3,
      contactsMinimal: 0,
      productsNew: 0,
      productsSkipped: 2,
      invoices: 0,
      corrections: 0,
      cancellations: 0,
      documentsSkipped: 9,
    });
    expect(p.preview.blocking).toBe(0);
    const r = await owner.action(api.imports.commit, { importId: again, previewHash: p.previewHash, numberRanges: [] });
    expect(r.counts).toMatchObject({ contactsCreated: 0, productsCreated: 0, documentsCreated: 0 });
    expect(await businessCounts(t)).toEqual(before);
  });
});

describe("F09 IMP-023 discard, stale previews, collisions, resume, roles", () => {
  test("TST-IMP-20 IMP-023 E-IMP-28 discard removes files and preview, writes no business data, is audited", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId);
    await owner.action(api.imports.preview, { importId });
    const storageIds = await t.run(async (ctx) => (await ctx.db.get(importId))?.files.map((f) => f.storageId) ?? []);
    const before = await businessCounts(t);
    await owner.mutation(api.imports.discard, { importId });
    expect(await businessCounts(t)).toEqual(before);
    await t.run(async (ctx) => {
      const row = await ctx.db.get(importId);
      expect(row).toMatchObject({ status: "discarded", files: [] });
      expect(row?.preview).toBeUndefined();
      for (const id of storageIds) expect(await ctx.storage.get(id)).toBeNull();
      const audit = (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "import.discard");
      expect(audit).toHaveLength(1);
    });
    const e = await owner.action(api.imports.preview, { importId }).catch((x) => x);
    expect(errorCode(e)).toBe("conflict");
  });

  test("TST-IMP-21 IMP-023 E-IMP-27 a mapping change or a new local number makes the preview stale; nothing is written", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner);
    const view = await owner.query(api.imports.get, { importId });
    const inv = view?.files.find((f) => f.kind === "invoices");
    await owner.mutation(api.imports.setMapping, {
      importId,
      fileId: inv?.id as string,
      mapping: { columns: { ...(view?.mapping[inv?.id as string]?.columns ?? {}), dueDate: "" } },
    });
    const before = await businessCounts(t);
    const stale = await owner
      .action(api.imports.commit, {
        importId,
        previewHash: second.previewHash,
        numberRanges: RANGES,
        missingPdfReason: "x",
      })
      .catch((x) => x);
    expect(reasonOf(stale)).toBe("PREVIEW_STALE");
    expect(messageOf(stale)).toBe("Die Vorschau ist veraltet. Bitte Vorschau neu erstellen.");
    // a new preview, then a local number consumes RE-1007 behind the importer's back
    const fresh = await owner.action(api.imports.preview, { importId });
    await t.run((ctx) =>
      ctx.db.insert("numberRegister", {
        number: "RE-1007",
        normalized: "RE-1007",
        docType: "invoice",
        assignedAt: Date.now(),
        status: "issued",
        imported: true,
      }),
    );
    const stale2 = await owner
      .action(api.imports.commit, {
        importId,
        previewHash: fresh.previewHash,
        numberRanges: RANGES,
        missingPdfReason: "x",
      })
      .catch((x) => x);
    expect(reasonOf(stale2)).toBe("PREVIEW_STALE");
    expect({ ...(await businessCounts(t)), register: before.register }).toEqual(before);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("numberRegister")
        .withIndex("by_normalized", (q) => q.eq("normalized", "RE-1007"))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
  });

  test("TST-IMP-06 IMP-004 E-IMP-06 a local invoice number blocks the colliding row in the preview", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId);
    await t.run((ctx) =>
      ctx.db.insert("numberRegister", {
        number: "RE-1007",
        normalized: "RE-1007",
        docType: "invoice",
        assignedAt: Date.now(),
        status: "issued",
        imported: true,
      }),
    );
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.findings.find((f) => f.code === "E-IMP-06")?.message).toBe(
      "Rechnungsnummer RE-1007 existiert bereits. Bitte Nummernkreise prüfen.",
    );
    expect(p.preview.blocking).toBe(3);
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("numberRegister")
        .withIndex("by_normalized", (q) => q.eq("normalized", "RE-1007"))
        .first();
      if (row) await ctx.db.delete(row._id);
    });
  });

  test("TST-IMP-11 E-IMP-14 an interrupted commit resumes without duplicates", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner);
    const actorContext = { actor: owner.actor, role: "owner" as const, channel: "import" as const };
    const view = await owner.query(api.imports.get, { importId });
    // the run starts and writes the contacts, then fails before the documents
    await t.mutation(internal.imports.beginCommitInternal, {
      actorContext,
      importId,
      previewHash: second.previewHash,
      revision: view?.revision as number,
      decisions: { numberRanges: [] },
    });
    const c = await t.mutation(internal.imports.commitContactsInternal, {
      actorContext,
      importId,
      contacts: [],
      minimal: [{ key: "m:neukunde kg", name: "Neukunde KG", customerNumber: "2001" }],
    });
    expect(c.created).toBe(1);
    await t.mutation(internal.imports.failInternal, { actorContext, importId, message: "Simulierter Abbruch" });
    expect((await t.run((ctx) => ctx.db.get(importId)))?.status).toBe("failed");
    // resume: the same action continues; the minimal contact is skipped, everything else is written once
    const r = await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
    });
    expect(r.counts).toMatchObject({ documentsCreated: 8, contactsCreated: 3 });
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts.filter((x) => x.displayName === "Neukunde KG")).toHaveLength(1);
    expect((await importedDocs(t)).length).toBe(8);
  });

  test("IMP-023 02 §4.3 the bookkeeper previews, only the owner commits", async () => {
    const { t, owner } = await setup();
    const bookkeeper = await t.asUser("bookkeeper");
    const importId = await bookkeeper.mutation(api.imports.create, {});
    await upload(t, bookkeeper as unknown as Owner, importId, FILES.slice(0, 3));
    const p = await bookkeeper.action(api.imports.preview, { importId });
    const e = await bookkeeper
      .action(api.imports.commit, { importId, previewHash: p.previewHash, numberRanges: [] })
      .catch((x) => x);
    expect(errorCode(e)).toBe("forbidden_role");
    const viewer = await t.asUser("viewer");
    expect(errorCode(await viewer.query(api.imports.list, {}).catch((x) => x))).toBe("forbidden_role");
    expect((await owner.query(api.imports.list, {})).map((i) => i.id)).toEqual([importId]);
  });

  test("IMP-007 UVA-06 a payment on an imported open invoice is refused until its opening item exists (LEGAL-OPEN)", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner);
    await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
    });
    const doc = (await importedDocs(t)).find((d) => d.number === "RE-1007");
    const bank = await t.run(async (ctx) => (await ctx.db.query("bankAccounts").first())?._id);
    const e = await owner
      .mutation(api.payments.recordForInvoice, {
        documentId: doc?._id as Id<"salesDocuments">,
        source: { kind: "clearing", accountId: bank as Id<"bankAccounts"> },
        date: "2026-10-12",
        amountCents: 23_800,
      })
      .catch((x) => x);
    expect(reasonOf(e)).toBe("IMPORTED_DOCUMENT_PAYMENT");
    expect((await importedDocs(t)).find((d) => d.number === "RE-1007")?.openAmountCents).toBe(23_800);
  });

  test("E-IMP-26 IMP-017 an ambiguous number format blocks the file until the owner chooses it", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const csv =
      "Rechnungsnummer;Rechnungsdatum;Kunde;Brutto;Status\nRE-1;01.02.2026;A GmbH;1.190;Bezahlt\nRE-2;02.02.2026;A GmbH;2.380;Bezahlt\n";
    await upload(t, owner, importId, [{ name: "liste.csv", content: csv }]);
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.findings[0]?.message).toBe(
      "Zahlen-/Datumsformat in liste.csv ist nicht eindeutig. Bitte Format wählen.",
    );
    const view = await owner.query(api.imports.get, { importId });
    const file = view?.files[0];
    await owner.mutation(api.imports.setMapping, {
      importId,
      fileId: file?.id as string,
      mapping: { columns: view?.mapping[file?.id as string]?.columns ?? {}, numberFormat: "de" },
      savePresetAs: "Meine Rechnungsliste",
    });
    const p2 = await owner.action(api.imports.preview, { importId });
    expect(p2.preview.files[0]).toMatchObject({ numberFormat: "de", blocked: false });
    expect(p2.preview.samples.documents[0]).toMatchObject({ number: "RE-1", grossCents: 119000 });
    // IMP-017: the saved preset is listed for later imports
    expect((await owner.query(api.imports.get, { importId }))?.presets.map((x) => x.name)).toEqual([
      "Meine Rechnungsliste",
    ]);
  });
});
