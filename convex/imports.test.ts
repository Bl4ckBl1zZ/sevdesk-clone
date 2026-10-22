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
import vPart from "../test/fixtures/sevdesk-export-verified/18-10-2026_part.csv?raw";
import vContacts from "../test/fixtures/sevdesk-export-verified/contacts.csv?raw";
import vInvoices from "../test/fixtures/sevdesk-export-verified/invoices.csv?raw";
import vPdf1000 from "../test/fixtures/sevdesk-export-verified/pdf/2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf?raw";
import vPdf1001 from "../test/fixtures/sevdesk-export-verified/pdf/2026-06-26_Rechnung_RE-5001_0123456789abcdef0123456789abcd01.pdf?raw";
import vPdf1002 from "../test/fixtures/sevdesk-export-verified/pdf/2026-07-29_Rechnung_RE-5002_0123456789abcdef0123456789abcd02.pdf?raw";
import vPdf1003 from "../test/fixtures/sevdesk-export-verified/pdf/2026-08-12_Stornorechnung_RE-5003_0123456789abcdef0123456789abcd03.pdf?raw";
import vPdf1004 from "../test/fixtures/sevdesk-export-verified/pdf/2026-09-15_Rechnung_RE-5004_0123456789abcdef0123456789abcd04.pdf?raw";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { assignCounterNumber } from "./model/numberRanges";
import { openItemsAsOf } from "./model/payments";
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

/** Buchungsbeginn after the last fixture document: the sevdesk history predates our bookkeeping (IMP-007). */
const BOOKKEEPING_START = "2026-06-01";

async function setup(opts: { bookkeepingStart?: string | null; taxation?: "soll" | "ist" } = {}) {
  const t = makeT();
  const { owner } = await setupInvoicing(t);
  if (opts.taxation === "ist") {
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] },
        { action: "settings.company.update" },
      ),
    );
  }
  const start = opts.bookkeepingStart === undefined ? BOOKKEEPING_START : opts.bookkeepingStart;
  if (start) await owner.mutation(api.accounting.setBookkeepingStartDate, { date: start });
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
  const re1006 = first.preview.findings.find((f) => f.key === "invoice:RE-1006" && f.rowRef)?.rowRef as string;
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

  test("TST-IMP-16 TST-IMP-19 TST-IMP-14 SET-065 IMP-003 IMP-004 IMP-008 IMP-014 IMP-020 EC-190 commit creates archived documents with original numbers and PDFs", async () => {
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
      // IMP-008: imported audit entries record source and importer version
      expect(audits.every((a) => a.reason === `sevdesk-Export, sevdesk-export-import@1, Import ${importId}`)).toBe(
        true,
      );
      const records = (await ctx.db.query("auditLog").collect()).filter((a) => a.action === "import.record");
      expect(records.length).toBeGreaterThanOrEqual(4 + 2 + 8); // contacts, products, documents (+ their PDF files)
      expect(records.every((a) => a.reason?.includes("sevdesk-export-import@1"))).toBe(true);
      // IMP-024: the import row keeps the source files ≥ 10 years
      const row = await ctx.db.get(importId);
      expect(row).toMatchObject({ status: "done", committedBy: owner.actor });
      expect(row?.files).toHaveLength(9);
      expect(Number(row?.retentionUntil?.slice(0, 4))).toBeGreaterThanOrEqual(2036);
    });
  });

  test("TST-IMP-05 EC-014 IMP-005 E-IMP-12 the confirmed range continues above the imported maximum; a next number ≤ an imported one is refused", async () => {
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

  test("E-IMP-19 a newer export lists an invoice as paid that is still open here: discrepancy warning, nothing changed", async () => {
    const { t, owner } = await setup();
    const { importId, second } = await prepared(t, owner, { assignAll: true });
    await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
    });
    const re1007 = (await importedDocs(t)).find((d) => d.number === "RE-1007");
    expect(re1007?.openAmountCents).toBe(23_800);
    // the newer export: RE-1007 was paid in sevdesk before the cutover
    const newer = rechnungen.replace(";Offen;238,00;EUR;", ";Bezahlt;0,00;EUR;");
    expect(newer).not.toBe(rechnungen);
    const again = await owner.mutation(api.imports.create, {});
    await upload(
      t,
      owner,
      again,
      FILES.map((f) => (f.name === "rechnungen.csv" ? { ...f, content: newer } : f)),
    );
    const p = await owner.action(api.imports.preview, { importId: again });
    expect(p.preview.findings.filter((f) => f.code === "E-IMP-19")).toEqual([
      expect.objectContaining({
        severity: "warning",
        key: "invoice:RE-1007",
        message: "RE-1007 ist laut neuem sevdesk-Export bezahlt, hier noch offen.",
      }),
    ]);
    expect(p.preview.blocking).toBe(0);
    // the archived document is never updated by the import; the owner records the payment locally
    expect((await t.run((ctx) => ctx.db.get(re1007?._id as Id<"salesDocuments">)))?.openAmountCents).toBe(23_800);
  });

  test("IMP-022 TST-IMP-25 an open-item total differing from the entered sevdesk total must be acknowledged before the commit", async () => {
    const { t, owner } = await setup();
    const { importId } = await prepared(t, owner);
    const view = await owner.query(api.imports.get, { importId });
    await owner.mutation(api.imports.setResolutions, {
      importId,
      resolutions: { ...(view?.resolutions ?? {}), expectedOpenTotalCents: 250_000 },
    });
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.openItemDifference).toEqual({
      expectedCents: 250_000,
      importedCents: p.preview.openItems.totalCents,
      differenceCents: p.preview.openItems.totalCents - 250_000,
    });
    expect(p.preview.findings.find((f) => f.code === "IMP-022")?.severity).toBe("warning");
    const refused = await owner
      .action(api.imports.commit, { importId, previewHash: p.previewHash, numberRanges: [], missingPdfReason: "x" })
      .catch((x) => x);
    expect(reasonOf(refused)).toBe("IMP_022");
    expect((await importedDocs(t)).length).toBe(0);
    await owner.action(api.imports.commit, {
      importId,
      previewHash: p.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
      openItemDifferenceAcknowledged: true,
    });
    const row = await t.run((ctx) => ctx.db.get(importId));
    expect(row?.status).toBe("done");
    expect(row?.decisions).toMatchObject({ openItemDifference: { expectedCents: 250_000 } });
    // negative or fractional totals are refused
    const other = await owner.mutation(api.imports.create, {});
    expect(
      errorCode(
        await owner
          .mutation(api.imports.setResolutions, {
            importId: other,
            resolutions: { expectedOpenTotalCents: -1 },
          })
          .catch((x) => x),
      ),
    ).toBe("invalid_input");
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

  test("TST-IMP-07 IMP-007 EC-201 UVA-06 ACC-013 open invoices become opening receivables; payments on the imported invoice settle them", async () => {
    const { t, owner } = await setup({ taxation: "ist" });
    const { importId, second } = await prepared(t, owner);
    expect(second.preview.blocking).toBe(0);
    const r = await owner.action(api.imports.commit, {
      importId,
      previewHash: second.previewHash,
      numberRanges: [],
      missingPdfReason: "x",
    });
    expect(r.counts.openingItemsCreated).toBe(4);
    const docs = new Map((await importedDocs(t)).map((d) => [d.number, d]));
    const items = await t.run((ctx) => ctx.db.query("openingItems").collect());
    expect(items.map((i) => [i.number, i.openCents, i.taxedAs, i.notDueVat ?? [], i.documentId])).toEqual([
      ["RE-1002", 5700, "ist", [{ rateBp: 700, vatCents: 373 }], docs.get("RE-1002")?._id],
      ["RE-1003", 200000, "ist", [], docs.get("RE-1003")?._id],
      ["RE-1005", 30000, "ist", [], docs.get("RE-1005")?._id],
      ["RE-1007", 23800, "ist", [{ rateBp: 1900, vatCents: 3800 }], docs.get("RE-1007")?._id],
    ]);
    expect(items.every((i) => i.fiscalYear === 2026 && i.contactId !== undefined)).toBe(true);
    // One opening-balance journal entry dated at the Buchungsbeginn: 1400 receivables against 9008
    const opening = await t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").collect()).filter((e) => e.source.kind === "opening_balance"),
    );
    expect(opening).toHaveLength(1);
    expect(opening[0]?.date).toBe(BOOKKEEPING_START);
    // OPOS lists the opening items, never the archived documents as well (no double receivable)
    const opos = await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2026-10-12" }));
    const numbers = opos.items.map((i) => i.number).sort();
    expect(numbers).toEqual(["RE-1002", "RE-1003", "RE-1005", "RE-1007"]);
    expect(opos.items.every((i) => i.kind === "opening_item")).toBe(true);

    // A payment recorded on the imported invoice settles its opening item; the document mirrors it.
    const bank = await t.run(async (ctx) => (await ctx.db.query("bankAccounts").first())?._id as Id<"bankAccounts">);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: docs.get("RE-1007")?._id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: bank },
      date: "2026-10-12",
      amountCents: 23_800,
    });
    const after = await t.run(async (ctx) => {
      const item = items.find((i) => i.number === "RE-1007");
      return {
        item: item ? await ctx.db.get(item._id) : null,
        doc: await ctx.db.get(docs.get("RE-1007")?._id as Id<"salesDocuments">),
        payment: (await ctx.db.query("payments").collect()).at(-1),
      };
    });
    expect(after.item?.openAmountCents).toBe(0);
    expect(after.doc).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    expect(after.payment?.target).toMatchObject({ kind: "opening_item" });
    expect((await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2026-10-12" }))).items.map((i) => i.number)).not.toContain(
      "RE-1007",
    );

    // EC-201: an imported invoice without an opening item (paid in sevdesk) takes no payment.
    const e = await owner
      .mutation(api.payments.recordForInvoice, {
        documentId: docs.get("RE-1001")?._id as Id<"salesDocuments">,
        source: { kind: "clearing", accountId: bank },
        date: "2026-10-12",
        amountCents: 1_000,
      })
      .catch((x) => x);
    expect(reasonOf(e)).toBe("IMPORTED_DOCUMENT_PAYMENT");
  });

  test("IMP-007 E-IMP-34 without a Buchungsbeginn the open invoices block the commit", async () => {
    const { t, owner } = await setup({ bookkeepingStart: null });
    const { second } = await prepared(t, owner);
    const codes = second.preview.findings.filter((f) => f.code === "E-IMP-34").map((f) => f.key);
    expect(codes.sort()).toEqual(["invoice:RE-1002", "invoice:RE-1003", "invoice:RE-1005", "invoice:RE-1007"]);
    expect(second.preview.blocking).toBe(4);
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

describe("F09 sevdesk import in the verified export layout (Kleinunternehmer account, Convex)", () => {
  const VERIFIED = [
    { name: "contacts.csv", content: vContacts },
    { name: "18-10-2026_part.csv", content: vPart },
    { name: "invoices.csv", content: vInvoices },
    { name: "2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf", content: vPdf1000 },
    { name: "2026-06-26_Rechnung_RE-5001_0123456789abcdef0123456789abcd01.pdf", content: vPdf1001 },
    { name: "2026-07-29_Rechnung_RE-5002_0123456789abcdef0123456789abcd02.pdf", content: vPdf1002 },
    { name: "2026-08-12_Stornorechnung_RE-5003_0123456789abcdef0123456789abcd03.pdf", content: vPdf1003 },
    { name: "2026-09-15_Rechnung_RE-5004_0123456789abcdef0123456789abcd04.pdf", content: vPdf1004 },
  ];

  test("TST-IMP-16 EC-202 IMP-007 §4.3.3 Kleinunternehmer export: Storno pairs, § 19 tax case from the company history, open item", async () => {
    const { t, owner } = await setup({ bookkeepingStart: "2026-10-01" });
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        { kleinunternehmer: [{ validFrom: "2026-01-01", isKU: true }] },
        { action: "settings.company.update" },
      ),
    );
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, VERIFIED);
    const view = await owner.query(api.imports.get, { importId });
    expect(view?.files.map((f) => f.kind)).toEqual([
      "contacts",
      "products",
      "invoices",
      "pdf",
      "pdf",
      "pdf",
      "pdf",
      "pdf",
    ]);
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBe(0);
    expect(p.preview.counts).toMatchObject({
      contactsNew: 2,
      productsNew: 2,
      invoices: 4,
      cancellations: 1,
      pdfMatched: 5,
      openItems: 1,
    });
    expect(p.preview.findings.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining(["E-IMP-37", "E-IMP-38"]),
    );
    await owner.action(api.imports.commit, {
      importId,
      previewHash: p.previewHash,
      numberRanges: [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never" as const, next: 5005 }],
    });
    const byNumber = new Map((await importedDocs(t)).map((d) => [d.number, d]));
    expect([...byNumber.keys()].sort()).toEqual(["RE-5000", "RE-5001", "RE-5002", "RE-5003", "RE-5004"]);
    for (const d of byNumber.values()) expect(d.taxCase).toBe("kleinunternehmer");
    expect(byNumber.get("RE-5002")?.status).toBe("cancelled");
    expect(byNumber.get("RE-5003")).toMatchObject({ type: "cancellation", correctsId: byNumber.get("RE-5002")?._id });
    expect(byNumber.get("RE-5000")).toMatchObject({ status: "sent", paymentStatus: "paid", openAmountCents: 0 });
    expect(byNumber.get("RE-5004")).toMatchObject({ paymentStatus: "open", openAmountCents: 55_600 });
    const contacts = await t.run((ctx) => ctx.db.query("contacts").collect());
    expect(contacts.find((c) => c.number === "1001")?.vatId).toBe("FR40303265045");
  });

  /** Kleinunternehmer since 2026, Buchungsbeginn at the start of the business: the whole history is booked period. */
  async function kuSetup() {
    const s = await setup({ bookkeepingStart: "2026-06-01" });
    await s.t.model({ actor: s.owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(
        ctx,
        { kleinunternehmer: [{ validFrom: "2026-01-01", isKU: true }] },
        { action: "settings.company.update" },
      ),
    );
    const importId = await s.owner.mutation(api.imports.create, {});
    await upload(s.t, s.owner, importId, VERIFIED);
    return { ...s, importId };
  }

  test("E-IMP-10 EC-204 EC-201 EC-203 IMP-003 booked-period documents are posted at import and paid through the normal payment flow", async () => {
    const { t, owner, importId } = await kuSetup();
    const blocked = await owner.action(api.imports.preview, { importId });
    expect(blocked.preview.blocking).toBe(5);
    expect(blocked.preview.bookedPeriod).toEqual({ date: "2026-06-01", count: 5, post: false, paidInSevdesk: 0 });
    // The owner posts the booked period and corrects one total from its PDF (EC-203).
    await owner.mutation(api.imports.setResolutions, {
      importId,
      resolutions: {
        postBookedPeriod: true,
        correctedTotals: { "invoice:RE-5001": { grossCents: 154_960, reason: "Gesamtbetrag laut PDF" } },
      },
    });
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBe(0);
    expect(p.preview.counts).toMatchObject({ booked: 5, openItems: 0 });
    expect(p.preview.findings.map((f: { code: string }) => f.code)).toEqual(
      expect.arrayContaining(["E-IMP-10", "E-IMP-39", "E-IMP-37"]),
    );
    await owner.action(api.imports.commit, {
      importId,
      previewHash: p.previewHash,
      numberRanges: [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never" as const, next: 5005 }],
    });
    const docs = new Map((await importedDocs(t)).map((d) => [d.number, d]));
    for (const d of docs.values()) expect(d.origin).toMatchObject({ source: "sevdesk_export", posted: true });
    // Open receivables with their gross even though sevdesk lists RE-5000/RE-5001 as paid (EC-204).
    expect(docs.get("RE-5000")).toMatchObject({ status: "sent", paymentStatus: "open", openAmountCents: 99_830 });
    expect(docs.get("RE-5000")?.internalNote).toContain("Laut sevdesk bezahlt am 11.06.2026");
    expect(docs.get("RE-5001")).toMatchObject({ openAmountCents: 154_960, totals: { grossCents: 154_960 } });
    expect(docs.get("RE-5001")?.internalNote).toContain(
      "Betrag gegenüber sevdesk-Export korrigiert: 1.548,80 € → 1.549,60 € (Gesamtbetrag laut PDF).",
    );
    expect(docs.get("RE-5002")).toMatchObject({ status: "cancelled", openAmountCents: 0 });
    // Journal: one S3 entry per invoice (KU, no VAT) dated on the invoice; the Storno reverses its original (S12).
    const entries = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    const of = (n: string) =>
      entries.filter((e) => e.source.kind === "salesDocument" && e.source.id === docs.get(n)?._id);
    for (const n of ["RE-5000", "RE-5001", "RE-5002", "RE-5004"]) {
      expect(
        of(n).map((e) => [e.explanation, e.date]),
        n,
      ).toEqual([["S3", docs.get(n)?.documentDate]]);
    }
    expect(of("RE-5001")[0]?.lines.find((l) => l.debitCents > 0)?.debitCents).toBe(154_960);
    expect(of("RE-5003")).toHaveLength(1);
    expect(of("RE-5003")[0]?.reversalOfId).toBe(of("RE-5002")[0]?._id);
    expect(entries.some((e) => e.source.kind === "opening_balance")).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("openingItems").collect())).toEqual([]);
    // EC-203: the correction is audited with the owner's reason.
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "import.corrected_total")).toMatchObject({
      reason: "Gesamtbetrag laut PDF",
      entity: { table: "salesDocuments", id: docs.get("RE-5001")?._id },
    });
    // OPOS lists the posted invoices themselves; a payment settles the document directly (no opening item).
    const opos = await t.run((ctx) => openItemsAsOf(ctx, { asOf: "2026-10-12" }));
    expect(opos.items.map((i) => [i.number, i.kind]).sort()).toEqual([
      ["RE-5000", "salesDocument"],
      ["RE-5001", "salesDocument"],
      ["RE-5004", "salesDocument"],
    ]);
    const bank = await t.run(async (ctx) => (await ctx.db.query("bankAccounts").first())?._id as Id<"bankAccounts">);
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: docs.get("RE-5000")?._id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: bank },
      date: "2026-10-12",
      amountCents: 99_830,
    });
    const paid = await t.run(async (ctx) => ({
      doc: await ctx.db.get(docs.get("RE-5000")?._id as Id<"salesDocuments">),
      payment: (await ctx.db.query("payments").collect()).at(-1),
    }));
    expect(paid.doc).toMatchObject({ openAmountCents: 0, paymentStatus: "paid" });
    expect(paid.payment?.target).toMatchObject({ kind: "salesDocument" });
  });

  test("E-IMP-10 ACC-006 a booked-period document in a locked month (UStVA filed) is blocked", async () => {
    const { t, owner, importId } = await kuSetup();
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedInsert(
        ctx,
        "periods",
        { period: "2026-09", status: "locked", lockedAt: Date.now(), lockedBy: owner.actor, reason: "ustva_submitted" },
        { action: "period.lock" },
      ),
    );
    await owner.mutation(api.imports.setResolutions, { importId, resolutions: { postBookedPeriod: true } });
    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBe(1);
    expect(p.preview.findings.find((f: { severity: string }) => f.severity === "error")).toMatchObject({
      code: "E-IMP-10",
      key: "invoice:RE-5004",
      message:
        "RE-5004: Der Zeitraum 09/2026 ist festgeschrieben (UStVA abgegeben) – der Beleg kann nicht mehr gebucht werden. Bitte Zeile ausschließen.",
    });
  });

  test("EC-203 E-IMP-37 a corrected total needs a reason (resolutions are validated)", async () => {
    const { owner, importId } = await kuSetup();
    const e = await owner
      .mutation(api.imports.setResolutions, {
        importId,
        resolutions: { correctedTotals: { "invoice:RE-5001": { grossCents: 154_960, reason: " " } } },
      })
      .catch((x) => x);
    expect(messageOf(e)).toBe("Bitte für jede Betragskorrektur einen Grund angeben.");
  });
});
