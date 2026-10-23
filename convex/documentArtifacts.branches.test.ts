import { PDFDocument, rgb } from "@cantoo/pdf-lib";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { b2bBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * Branch coverage of convex/documentArtifacts.ts — step 3 of the pipeline (DOC-28, INV-20/21, ER-12), the logo of
 * the rendered PDF (SET-070) and the export (SND-16, SND-20).
 */

const NOW = new Date("2026-10-12T10:00:00Z");
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const KOSIT_OK = { acceptable: true, validatorVersion: "1.6.3", configVersion: "3.0.2" };
const MUSTANG_OK = { valid: true, pdfaValid: true, xmlPresent: true, mustangVersion: "2.16.0" };
const JPG_1PX =
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==";
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });
const artifactsOf = (t: TestT, id: Id<"salesDocuments">) =>
  t.run((ctx) =>
    ctx.db
      .query("documentArtifacts")
      .withIndex("by_document", (q) => q.eq("documentId", id))
      .collect(),
  );

const realFetch = globalThis.fetch;
const isSidecar = (url: unknown) => String(url).startsWith("http://einvoice-tools.test");

/** Sidecar stub: `xml(n)` answers the n-th XML validation (1 = preview, 2 = final XML), `pdf` the Mustang check. */
function sidecar(xml: (n: number) => Response | Promise<Response>, pdf: () => Response | Promise<Response>) {
  let n = 0;
  vi.stubEnv("EINVOICE_TOOLS_URL", "http://einvoice-tools.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!isSidecar(url)) return realFetch(url, init);
      return String(url).endsWith("/validate/xml") ? xml(++n) : pdf();
    }),
  );
}

async function draft(t: TestT) {
  const { owner } = await setupInvoicing(t);
  const { personId } = await b2bBuyer(owner);
  const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
  return { owner, id, personId };
}

describe("render: final validation (ER-12, INV-20)", () => {
  test("ER-12 INV-20 KoSIT and Mustang pass: both reports are archived with the tool versions", async () => {
    const t = makeT();
    const { owner, id } = await draft(t);
    sidecar(
      () => new Response(JSON.stringify(KOSIT_OK)),
      () => new Response(JSON.stringify(MUSTANG_OK)),
    );
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await doc(t, id)).artifactStatus).toBe("ready");
    const arts = await artifactsOf(t, id);
    expect(arts.find((a) => a.kind === "validation_report_kosit")?.tool).toEqual({
      name: "kosit",
      version: "1.6.3 / 3.0.2",
    });
    expect(arts.find((a) => a.kind === "validation_report_mustang")?.tool).toEqual({
      name: "mustang",
      version: "2.16.0",
    });
  });

  test("ER-12 a Mustang rejection after the commit is a failed attempt with the rule", async () => {
    const t = makeT();
    const { owner, id } = await draft(t);
    sidecar(
      () => new Response(JSON.stringify(KOSIT_OK)),
      () => new Response(JSON.stringify({ pdfaValid: false, errors: [{ ruleId: "6.2.11.4", text: "Schrift fehlt" }] })),
    );
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect(await doc(t, id)).toMatchObject({ artifactStatus: "pending", artifactAttempts: 1 });
    expect((await doc(t, id)).artifactError).toBe("Mustang: 6.2.11.4 Schrift fehlt");
    // without a rule list the message names „?“
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!isSidecar(url)) return realFetch(url, init);
        return String(url).endsWith("/validate/xml")
          ? new Response(JSON.stringify(KOSIT_OK))
          : new Response(JSON.stringify({ pdfaValid: false }));
      }),
    );
    await t.action(internal.documentArtifacts.render, { id });
    expect((await doc(t, id)).artifactError).toBe("Mustang: ? ");
  });

  test("EC-006 KoSIT unreachable or rejecting without details after the commit → failed attempt with the reason", async () => {
    const t = makeT();
    const { owner, id } = await draft(t);
    sidecar(
      (n) => {
        if (n === 1) return new Response(JSON.stringify(KOSIT_OK));
        throw new TypeError("fetch failed: ECONNREFUSED");
      },
      () => new Response(JSON.stringify(MUSTANG_OK)),
    );
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await doc(t, id)).artifactError).toBe("KoSIT nicht erreichbar: fetch failed: ECONNREFUSED");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        isSidecar(url) ? new Response(JSON.stringify({ acceptable: false }), { status: 422 }) : realFetch(url, init),
      ),
    );
    await t.action(internal.documentArtifacts.render, { id });
    expect(await doc(t, id)).toMatchObject({ artifactAttempts: 2, artifactError: "KoSIT: ? " });
  });

  test("DOC-28 render does nothing for a draft or for a document whose files are ready", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const before = (await artifactsOf(t, id)).length;
    await t.action(internal.documentArtifacts.render, { id });
    expect((await artifactsOf(t, id)).length).toBe(before);
    const { id: d } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await t.action(internal.documentArtifacts.render, { id: d });
    expect(await artifactsOf(t, d)).toEqual([]);
    expect((await doc(t, d)).artifactStatus).toBeUndefined();
  });
});

describe("render: logo (SET-070)", () => {
  test("SET-070 a PNG logo renders; an SVG or a missing logo file renders without logo", async () => {
    const t = makeT();
    const { owner, id, personId } = await draft(t);
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    const png = await t.run((ctx) =>
      ctx.storage.store(new Blob([Buffer.from(PNG_1PX, "base64")], { type: "image/png" })),
    );
    await t.model(actor, (ctx) => patchCompanyProfile(ctx, { logoStorageId: png }, { action: "settings.logo.update" }));
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await doc(t, id)).artifactStatus).toBe("ready");

    const svg = await t.run((ctx) =>
      ctx.storage.store(new Blob(["<svg xmlns='http://www.w3.org/2000/svg'/>"], { type: "image/svg+xml" })),
    );
    await t.model(actor, (ctx) => patchCompanyProfile(ctx, { logoStorageId: svg }, { action: "settings.logo.update" }));
    const { id: second } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: second, version: 1 });
    await settle(t);
    expect((await doc(t, second)).artifactStatus).toBe("ready");

    const gone = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    await t.run((ctx) => ctx.storage.delete(gone));
    await t.model(actor, (ctx) =>
      patchCompanyProfile(ctx, { logoStorageId: gone }, { action: "settings.logo.update" }),
    );
    const { id: third } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: third, version: 1 });
    await settle(t);
    expect((await doc(t, third)).artifactStatus).toBe("ready");
  });
});

async function letterheadPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const p = d.addPage([595.28, 841.89]);
  p.drawRectangle({ x: 0, y: 780, width: 595.28, height: 60, color: rgb(0.1, 0.4, 0.2) });
  return d.save();
}

describe("render: JPEG logo (SET-070)", () => {
  test("SET-070 a JPEG logo renders", async () => {
    const t = makeT();
    const { owner, id } = await draft(t);
    const jpg = await t.run((ctx) =>
      ctx.storage.store(new Blob([Buffer.from(JPG_1PX, "base64")], { type: "image/jpeg" })),
    );
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      patchCompanyProfile(ctx, { logoStorageId: jpg }, { action: "settings.logo.update" }),
    );
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await doc(t, id)).artifactStatus).toBe("ready");
  });
});

describe("letterhead upload (SET-072)", () => {
  test("SET-072 a follow-page letterhead is rendered; a letterhead file missing from storage fails the attempt", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveLayout, { values: { template: "classic", accentColor: "#1F6FEB" } });
    const [layout] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const layoutId = layout?.layoutId as Id<"layouts">;
    const store = async () => {
      const bytes = await letterheadPdf();
      return t.run((ctx) => ctx.storage.store(new Blob([bytes as BlobPart], { type: "application/pdf" })));
    };
    const first = await store();
    const follow = await store();
    await owner.action(api.documentArtifacts.uploadLetterhead, { layoutId, storageId: first, slot: "first" });
    expect(
      await owner.action(api.documentArtifacts.uploadLetterhead, { layoutId, storageId: follow, slot: "follow" }),
    ).toEqual({ pages: 1 });
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    expect((await doc(t, id)).artifactStatus).toBe("ready");
    // the stored follow page disappears → the next render cannot load it
    await t.run((ctx) => ctx.storage.delete(follow));
    const { id: second } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: second, version: 1 });
    await settle(t);
    expect(await doc(t, second)).toMatchObject({
      artifactStatus: "pending",
      artifactError: "Briefpapier fehlt im Speicher",
    });
  });

  test("SET-072 an upload whose file is gone is refused", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveLayout, { values: { template: "classic", accentColor: "#1F6FEB" } });
    const [layout] = await owner.query(api.settings.listLayoutsWithDefaults, {});
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF"])));
    await t.run((ctx) => ctx.storage.delete(storageId));
    const e = await owner
      .action(api.documentArtifacts.uploadLetterhead, {
        layoutId: layout?.layoutId as Id<"layouts">,
        storageId,
        slot: "first",
      })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("invalid_input");
    expect((e as { data?: { message?: string } }).data?.message).toBe("Die hochgeladene Datei wurde nicht gefunden.");
  });
});

describe("export (SND-16, DOC-32, SND-20)", () => {
  test("SND-16 files still being rendered cannot be exported (artifacts_not_ready)", async () => {
    const t = makeT();
    const { owner, id } = await draft(t);
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const e = await owner
      .action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("artifacts_not_ready");
    await settle(t);
  });

  test("SND-16 a draft cannot be exported; the ZIP entry names the archive, single-format entries carry no attachments", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const { id: d } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const e = await owner
      .action(api.documentArtifacts.exportFiles, { id: d, request: { entry: "default" } })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("document_not_draft");
    expect((e as { data?: { message?: string } }).data?.message).toBe("Entwürfe können nicht exportiert werden.");
    const zip = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "zip" } });
    expect(zip.zipName).toMatch(/\.zip$/);
    expect(zip.files.length).toBeGreaterThan(0);
    const pdfOnly = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "pdf" } });
    expect(pdfOnly.zipName).toBeNull();
    expect(pdfOnly.attachments).toEqual([]);
  });
});
