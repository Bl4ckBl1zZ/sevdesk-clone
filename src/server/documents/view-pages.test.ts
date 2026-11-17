import { makeSnapshot } from "@test/factories/snapshot";
import { describe, expect, test, vi } from "vitest";
import { PREVIEW_NUMBER } from "@/domain/documents/snapshot";
import { renderDraftPdf } from "@/pdf/draft-preview";
import type { DraftRenderInput } from "./draft-pdf";
import { type DocumentViewInput, documentPages, VIEW_MAX_PAGES } from "./view-pages";

/** F04 §6.4 / DOC-62: the pages of the „Vorschau“ section on the Beleg page. */

const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

const finalised = (over: Partial<DocumentViewInput> = {}): DocumentViewInput => ({
  status: "finalized",
  version: 2,
  artifactStatus: "ready",
  number: "RE-1013",
  kind: "pdf",
  variant: "original",
  url: "https://convex.example/api/storage/abc",
  ...over,
});

describe("documentPages (DOC-62)", { timeout: 60_000 }, () => {
  test("DOC-62 a finalised document shows the pages of its archived PDF as PNG images", async () => {
    const pdf = await renderDraftPdf({ snapshot: makeSnapshot(), layoutConfig: null, logo: null, letterhead: null });
    const fetchPdf = vi.fn(async () => pdf);
    const draftInput = vi.fn();
    const r = await documentPages(finalised(), { fetchPdf, draftInput });
    expect(fetchPdf).toHaveBeenCalledWith("https://convex.example/api/storage/abc");
    expect(draftInput).not.toHaveBeenCalled();
    if (r.state !== "pages") throw new Error(`expected pages, got ${JSON.stringify(r)}`);
    expect(r.pageCount).toBeGreaterThanOrEqual(1);
    expect(r.pages.length).toBe(Math.min(r.pageCount, VIEW_MAX_PAGES));
    for (const p of r.pages) expect(p).toMatch(PNG_DATA_URL);
  });

  test("DOC-62 while the files are being produced (or blocked) there are no pages but a German reason", async () => {
    const deps = { fetchPdf: vi.fn(), draftInput: vi.fn() };
    const pending = await documentPages(finalised({ artifactStatus: "pending", url: null }), deps);
    expect(pending).toMatchObject({ state: "unavailable", reason: "pending" });
    const blocked = await documentPages(finalised({ artifactStatus: "blocked", url: null }), deps);
    expect(blocked).toMatchObject({ state: "unavailable", reason: "blocked" });
    expect(deps.fetchPdf).not.toHaveBeenCalled();
  });

  test("DOC-62 a finalised document without archived files (sevdesk import without PDF) says so instead of waiting", async () => {
    const deps = { fetchPdf: vi.fn(), draftInput: vi.fn() };
    const r = await documentPages(finalised({ artifactStatus: null, url: null }), deps);
    expect(r).toMatchObject({ state: "unavailable", reason: "none" });
    expect(deps.fetchPdf).not.toHaveBeenCalled();
  });

  test("DOC-62 an unreadable archive file is reported, not thrown", async () => {
    const r = await documentPages(finalised(), { fetchPdf: async () => null, draftInput: vi.fn() });
    expect(r).toMatchObject({ state: "unavailable", reason: "missing" });
  });

  test("DOC-62 DOC-42 a draft shows the ENTWURF render of the stored draft", async () => {
    const input = {
      status: "draft",
      type: "invoice",
      version: 3,
      findings: [],
      snapshot: makeSnapshot({ number: PREVIEW_NUMBER }),
      layoutConfig: null,
      logoUrl: null,
      letterheadUrl: null,
      letterheadFollowUrl: null,
    } as unknown as DraftRenderInput;
    const fetchPdf = vi.fn();
    const r = await documentPages(finalised({ status: "draft", artifactStatus: null, url: null, number: null }), {
      fetchPdf,
      draftInput: async () => input,
    });
    expect(fetchPdf).not.toHaveBeenCalled();
    if (r.state !== "pages") throw new Error(`expected pages, got ${JSON.stringify(r)}`);
    expect(r.pages[0]).toMatch(PNG_DATA_URL);
  });

  test("DOC-62 a draft with blocking errors explains why there is no preview yet", async () => {
    const input = {
      status: "draft",
      type: "invoice",
      version: 1,
      findings: [
        { code: "contact_missing", severity: "E", rule: "UST-03", group: "pflichtangaben", message: "Kunde fehlt." },
        { code: "x", severity: "W", rule: "UST-03", group: "hinweise", message: "Nur ein Hinweis." },
      ],
      snapshot: null,
    } as unknown as DraftRenderInput;
    const r = await documentPages(finalised({ status: "draft", artifactStatus: null, url: null }), {
      fetchPdf: vi.fn(),
      draftInput: async () => input,
    });
    expect(r).toMatchObject({ state: "unavailable", reason: "invalid", errors: ["Kunde fehlt."] });
  });
});
