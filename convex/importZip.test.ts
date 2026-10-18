/// <reference types="vite/client" />
import { zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { sha256Hex } from "../src/domain/audit/chain";
import { craftZip, tinyPdf } from "../test/factories/zip";
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
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * F09 IMP-016 ZIP uploads and IMP-024 import protocol (Convex). Every archive is built in the test from the
 * synthetic verified-layout fixtures (sevdesk's `Rechnungen_<dd.mm.yy>.zip`: flat, one PDF per document).
 */
const enc = new TextEncoder();

const INVOICE_PDFS: Record<string, string> = {
  "2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf": vPdf1000,
  "2026-06-26_Rechnung_RE-5001_0123456789abcdef0123456789abcd01.pdf": vPdf1001,
  "2026-07-29_Rechnung_RE-5002_0123456789abcdef0123456789abcd02.pdf": vPdf1002,
  "2026-08-12_Stornorechnung_RE-5003_0123456789abcdef0123456789abcd03.pdf": vPdf1003,
  "2026-09-15_Rechnung_RE-5004_0123456789abcdef0123456789abcd04.pdf": vPdf1004,
};
const invoiceZip = () =>
  zipSync({
    ...Object.fromEntries(Object.entries(INVOICE_PDFS).map(([n, c]) => [n, enc.encode(c)])),
    "__MACOSX/._2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf": new Uint8Array([0, 5, 22, 7]),
  });

async function setup() {
  const t = makeT();
  const { owner } = await setupInvoicing(t);
  await owner.mutation(api.accounting.setBookkeepingStartDate, { date: "2026-10-01" });
  await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
    patchCompanyProfile(
      ctx,
      { kleinunternehmer: [{ validFrom: "2026-01-01", isKU: true }] },
      {
        action: "settings.company.update",
      },
    ),
  );
  return { t, owner };
}
type Owner = Awaited<ReturnType<typeof setup>>["owner"];

async function upload(
  t: TestT,
  owner: Owner,
  importId: Id<"imports">,
  files: { name: string; content: string | Uint8Array }[],
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

const storageCount = (t: TestT) => t.run(async (ctx) => (await ctx.db.system.query("_storage").collect()).length);
const CSVS = [
  { name: "contacts.csv", content: vContacts },
  { name: "18-10-2026_part.csv", content: vPart },
  { name: "invoices.csv", content: vInvoices },
];
const RANGES = [{ rangeKey: "invoice", format: "RE-{####}", resetPolicy: "never" as const, next: 5005 }];

describe("F09 IMP-016 ZIP uploads are unpacked into import files (Convex)", () => {
  test("IMP-016 IMP-024 §4.3.5 the sevdesk invoice ZIP: contained PDFs become files of their own, match and are archived; the ZIP stays as evidence", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const zip = invoiceZip();
    const r = await upload(t, owner, importId, [...CSVS, { name: "Rechnungen_18.10.26.zip", content: zip }]);
    expect(r.rejected).toBeUndefined();
    expect(r.ignoredEntries).toEqual([
      "Rechnungen_18.10.26.zip/__MACOSX/._2026-06-10_Rechnung_RE-5000_0123456789abcdef0123456789abcd00.pdf",
    ]);
    const view = await owner.query(api.imports.get, { importId });
    const zipFile = view?.files.find((f) => f.kind === "zip");
    expect(zipFile).toMatchObject({
      name: "Rechnungen_18.10.26.zip",
      sha256: await sha256Hex(zip),
      bytes: zip.length,
      unpacked: { files: 5, ignored: [expect.stringContaining("__MACOSX/")] },
    });
    const entries = view?.files.filter((f) => f.container === zipFile?.id) ?? [];
    expect(entries.map((f) => [f.name, f.kind])).toEqual(Object.keys(INVOICE_PDFS).map((n) => [n, "pdf"]));
    for (const e of entries) expect(e.sha256).toBe(await sha256Hex(enc.encode(INVOICE_PDFS[e.name] ?? "")));

    const p = await owner.action(api.imports.preview, { importId });
    expect(p.preview.blocking).toBe(0);
    expect(p.preview.counts).toMatchObject({ pdfMatched: 5, pdfOrphans: 0 });
    expect(p.preview.findings.some((f: { message: string }) => /ZIP/.test(f.message))).toBe(false);

    const done = await owner.action(api.imports.commit, { importId, previewHash: p.previewHash, numberRanges: RANGES });
    expect(done.protocol).toBe(true);
    const re5000 = entries.find((e) => e.name.includes("RE-5000"));
    const artifacts = await t.run((ctx) => ctx.db.query("documentArtifacts").collect());
    const art = artifacts.find((a) => a.sha256 === re5000?.sha256);
    expect(art).toMatchObject({ kind: "pdf", variant: "original", name: re5000?.name });
    // The archive and every unpacked file stay stored as migration evidence (IMP-024).
    const row = await t.run((ctx) => ctx.db.get(importId));
    for (const f of row?.files ?? []) {
      expect(await t.run(async (ctx) => (await ctx.storage.get(f.storageId)) !== null)).toBe(true);
    }
    expect(row?.files.find((f) => f.sha256 === re5000?.sha256)?.storageId).toBe(art?.storageId);
  });

  test("IMP-016 §4.3.5 step 4 the same ZIP twice and a contained file already uploaded count once", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const [first, single] = Object.entries(INVOICE_PDFS)[0] as [string, string];
    await upload(t, owner, importId, [{ name: first, content: single }]);
    const before = await storageCount(t);
    const r = await upload(t, owner, importId, [{ name: "Rechnungen.zip", content: invoiceZip() }]);
    expect(r.duplicates).toEqual([first]);
    expect(r.added).toHaveLength(5); // the ZIP + 4 new PDFs
    expect(await storageCount(t)).toBe(before + 5);
    const again = await upload(t, owner, importId, [{ name: "Rechnungen-Kopie.zip", content: invoiceZip() }]);
    expect(again).toMatchObject({ added: [], duplicates: ["Rechnungen-Kopie.zip"] });
    expect(await storageCount(t)).toBe(before + 5);
  });

  test("TST-IMP-23 E-IMP-29 E-IMP-41 an unsafe or encrypted ZIP is rejected with its German message and leaves nothing stored", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const before = await storageCount(t);
    const traversal = craftZip([
      { name: "ok.pdf", data: tinyPdf("ok") },
      { name: "../../boese.pdf", data: tinyPdf("x") },
    ]);
    const encrypted = craftZip([{ name: "geheim.pdf", data: tinyPdf("g"), flags: 0x0001 }]);
    const nested = zipSync({ "innen.zip": zipSync({ "a.pdf": tinyPdf("a") }), "b.pdf": tinyPdf("b") });
    const r = await upload(t, owner, importId, [
      { name: "boese.zip", content: traversal },
      { name: "passwort.zip", content: encrypted },
      { name: "verschachtelt.zip", content: nested },
    ]);
    expect(r.rejected).toEqual([
      {
        name: "boese.zip",
        code: "E-IMP-29",
        message: "Die ZIP-Datei boese.zip ist ungültig oder zu groß: „../../boese.pdf“ zeigt aus dem Archiv heraus.",
      },
      {
        name: "passwort.zip",
        code: "E-IMP-41",
        message:
          "Die ZIP-Datei passwort.zip enthält verschlüsselte Dateien (geheim.pdf). Bitte das Archiv ohne Passwort erstellen und erneut hochladen.",
      },
    ]);
    const view = await owner.query(api.imports.get, { importId });
    // The valid nested archive of the same upload is still added (inner paths name the inner archive).
    expect(view?.files.map((f) => f.name)).toEqual(["verschachtelt.zip", "innen.zip/a.pdf", "b.pdf"]);
    expect(await storageCount(t)).toBe(before + 3);
  });

  test("IMP-016 removing the ZIP removes its unpacked files; its kind cannot be changed", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const before = await storageCount(t);
    await upload(t, owner, importId, [{ name: "Rechnungen.zip", content: invoiceZip() }]);
    const zipId = (await owner.query(api.imports.get, { importId }))?.files[0]?.id as string;
    const e = await owner.mutation(api.imports.updateFile, { importId, fileId: zipId, kind: "pdf" }).catch((x) => x);
    expect(errorCode(e)).toBe("invalid_input");
    await owner.mutation(api.imports.removeFile, { importId, fileId: zipId });
    expect((await owner.query(api.imports.get, { importId }))?.files).toEqual([]);
    expect(await storageCount(t)).toBe(before);
  });
});

describe("F09 IMP-024 import protocol PDF (Convex)", () => {
  test("TST-IMP-22 IMP-024 the commit archives the protocol once (SHA-256, link on the import); attaching again is refused; regenerating keeps it", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    await upload(t, owner, importId, [...CSVS, { name: "Rechnungen_18.10.26.zip", content: invoiceZip() }]);
    const p = await owner.action(api.imports.preview, { importId });
    await owner.action(api.imports.commit, { importId, previewHash: p.previewHash, numberRanges: RANGES });
    const view = await owner.query(api.imports.get, { importId });
    expect(view?.protocol).toMatchObject({ name: expect.stringMatching(/^Importprotokoll_\d{4}-\d{2}-\d{2}_/) });
    expect(view?.protocol?.url).toBeTruthy();
    const row = await t.run((ctx) => ctx.db.get(importId));
    const file = row?.protocolFile;
    if (!file) throw new Error("protocol missing");
    const bytes = new Uint8Array(
      (await t.run(async (ctx) => (await ctx.storage.get(file.storageId))?.arrayBuffer())) ?? new ArrayBuffer(0),
    );
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe("%PDF-");
    expect(await sha256Hex(bytes)).toBe(file.sha256);
    expect(file).toMatchObject({ bytes: bytes.length, mime: "application/pdf" });
    // Retention of the protocol = the frozen row's retention (≥ 10 years, IMP-024).
    expect(row?.retentionUntil && row.retentionUntil >= "2036-12-31").toBe(true);

    // Same frozen row → same content → same bytes (render twice).
    const r1 = await t.action(internal.importsNode.renderProtocol, { importId });
    const r2 = await t.action(internal.importsNode.renderProtocol, { importId });
    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.sha256).toBe(file.sha256);

    // The frozen row accepts protocolFile exactly once (immutability matrix): another file is refused.
    const actorContext = { actor: owner.actor, role: "owner" as const, channel: "ui" as const };
    const other = await t
      .mutation(internal.imports.attachProtocolInternal, {
        actorContext,
        importId,
        file: { ...r1, sha256: "0".repeat(64) },
      })
      .catch((x) => x);
    expect(errorCode(other)).toBe("immutable_record");
    await t.mutation(internal.imports.attachProtocolInternal, { actorContext, importId, file }); // same file: no-op
    expect((await t.run((ctx) => ctx.db.get(importId)))?.protocolFile).toEqual(file);
    expect(await owner.action(api.imports.generateProtocol, { importId })).toEqual({ created: false });
    await t.run(async (ctx) => {
      await ctx.storage.delete(r1.storageId);
      await ctx.storage.delete(r2.storageId);
    });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "imports").eq("entity.id", importId))
        .collect(),
    );
    expect(audit.filter((a) => a.action === "import.protocol").map((a) => a.actor)).toEqual([owner.actor]);
  });

  test("IMP-024 the protocol exists only for committed imports; bookkeepers cannot create it", async () => {
    const { t, owner } = await setup();
    const importId = await owner.mutation(api.imports.create, {});
    const e = await owner.action(api.imports.generateProtocol, { importId }).catch((x) => x);
    expect(errorCode(e)).toBe("conflict");
    const bookkeeper = await t.asUser("bookkeeper");
    const f = await bookkeeper.action(api.imports.generateProtocol, { importId }).catch((x) => x);
    expect(errorCode(f)).toBe("forbidden_role");
  });
});
