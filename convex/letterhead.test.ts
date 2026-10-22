import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFStream, rgb } from "@cantoo/pdf-lib";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

const LAYOUT = { template: "classic", accentColor: "#1F6FEB" };

async function letterhead(size: [number, number] = [595.28, 841.89]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const p = doc.addPage(size);
  p.drawRectangle({ x: 0, y: size[1] - 60, width: size[0], height: 60, color: rgb(0.1, 0.4, 0.2) });
  return doc.save();
}

const storePdf = (t: TestT, bytes: Uint8Array) =>
  t.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" })));

const currentConfig = (t: TestT, layoutId: Id<"layouts">) =>
  t.run(async (ctx) => {
    const l = (await ctx.db.get(layoutId)) as Doc<"layouts">;
    return ((await ctx.db.get(l.currentVersionId as Id<"layoutVersions">)) as Doc<"layoutVersions">).config;
  });

/** Form XObjects of A4 size on page 1 (an embedded letterhead page). */
async function letterheadXObjects(pdf: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(pdf);
  const page = doc.getPage(0);
  const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
  if (!(xobjects instanceof PDFDict)) return 0;
  let n = 0;
  for (const [, ref] of xobjects.entries()) {
    const stream = doc.context.lookup(ref);
    if (!(stream instanceof PDFStream)) continue;
    const subtype = stream.dict.get(PDFName.of("Subtype"));
    const bbox = stream.dict.lookup(PDFName.of("BBox"));
    const height = bbox && "get" in bbox ? (bbox as { get(i: number): unknown }).get(3) : undefined;
    if (subtype === PDFName.of("Form") && height instanceof PDFNumber && Math.round(height.asNumber()) === 842) n++;
  }
  return n;
}

describe("letterhead upload and rendering (F01 SET-071/072)", { timeout: 60_000 }, () => {
  test("SET-072 an invalid PDF is refused with the German reason and creates no layout version", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    const [layout] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const layoutId = layout?.layoutId as Id<"layouts">;
    const storageId = await storePdf(t, await letterhead([612, 792]));
    const e = await owner
      .action(api.documentArtifacts.uploadLetterhead, { layoutId, storageId, slot: "first" })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("invalid_input");
    expect((e as { data?: { reason?: string; message?: string } }).data).toMatchObject({
      reason: "letterhead_not_a4_portrait",
      message: "Das Briefpapier muss im Format A4 hochkant (210 × 297 mm) angelegt sein.",
    });
    expect((await currentConfig(t, layoutId)).letterheadStorageId).toBeUndefined();
  });

  test("SET-072 SET-070 a valid letterhead is a new layout version and the background of finalised documents", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    const [layout] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const layoutId = layout?.layoutId as Id<"layouts">;
    const storageId = await storePdf(t, await letterhead());
    expect(await owner.action(api.documentArtifacts.uploadLetterhead, { layoutId, storageId, slot: "first" })).toEqual({
      pages: 1,
    });
    const [after] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    expect(after).toMatchObject({ version: (layout?.version ?? 0) + 1, letterhead: true, letterheadFollow: false });
    expect((await currentConfig(t, layoutId)).letterheadStorageId).toBe(storageId);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "settings.letterhead.update")).toBe(true);

    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const pdf = await t.run(async (ctx) => {
      const [a] = (await ctx.db.query("documentArtifacts").collect()).filter((x) => x.kind === "zugferd_pdf");
      const blob = a ? await ctx.storage.get(a.storageId) : null;
      return blob ? await blob.arrayBuffer() : null;
    });
    expect(pdf).not.toBeNull();
    expect(await letterheadXObjects(new Uint8Array(pdf as ArrayBuffer))).toBe(1);

    // removing it is a further version; the finalised document keeps its version and file (SET-023)
    await owner.mutation(api.settings.removeLetterhead, { layoutId, slot: "first" });
    expect((await currentConfig(t, layoutId)).letterheadStorageId).toBeUndefined();
    expect(await t.run(async (ctx) => (await ctx.storage.get(storageId)) !== null)).toBe(true);
  });

  test("SET-072 a follow-page file needs a first-page letterhead; viewers cannot upload", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveLayout, { values: LAYOUT });
    const [layout] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const layoutId = layout?.layoutId as Id<"layouts">;
    const storageId = await storePdf(t, await letterhead());
    const e = await owner
      .action(api.documentArtifacts.uploadLetterhead, { layoutId, storageId, slot: "follow" })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("invalid_input");
    const viewer = await t.asUser("viewer");
    const denied = await viewer
      .action(api.documentArtifacts.uploadLetterhead, { layoutId, storageId, slot: "first" })
      .catch((x: unknown) => x);
    expect(errorCode(denied)).toBe("forbidden_role");
  });
});
