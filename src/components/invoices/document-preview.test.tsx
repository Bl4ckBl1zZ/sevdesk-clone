import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DocumentPreview } from "./document-preview";

/** F04 §6.4 / DOC-62: the „Vorschau“ section of the Beleg page (above „Verlauf“). */

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const respond = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(() => respond({ state: "pages", pageCount: 2, pages: [PNG, PNG] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("DocumentPreview (DOC-62)", () => {
  test("DOC-62 shows every page of the document as an image under the heading „Vorschau“", async () => {
    renderWithIntl(<DocumentPreview id="doc1" refreshKey="finalized:ready" draft={false} />);
    expect(screen.getByRole("heading", { name: "Vorschau" })).toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "Seite 1 von 2" })).toHaveAttribute("src", PNG);
    expect(screen.getByRole("img", { name: "Seite 2 von 2" })).toBeInTheDocument();
    expect(screen.getByText(/Archiviertes Original/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/dokumente/doc1/ansicht", expect.objectContaining({ cache: "no-store" }));
  });

  test("DOC-62 a draft preview refreshes when the draft is saved (new version) and keeps the old pages meanwhile", async () => {
    const { rerender } = renderWithIntl(<DocumentPreview id="doc1" refreshKey="draft:1" draft />);
    await screen.findByRole("img", { name: "Seite 1 von 2" });
    expect(screen.getByText(/zuletzt gespeicherten Stand/)).toBeInTheDocument();
    let resolve: (r: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (resolve = r)));
    rerender(<DocumentPreview id="doc1" refreshKey="draft:2" draft />);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("img", { name: "Seite 1 von 2" })).toBeInTheDocument();
    expect(screen.getByText("Wird aktualisiert …")).toBeInTheDocument();
    resolve(
      new Response(JSON.stringify({ state: "pages", pageCount: 1, pages: [PNG] }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await screen.findByRole("img", { name: "Seite 1 von 1" })).toBeInTheDocument();
    expect(screen.queryByText("Wird aktualisiert …")).not.toBeInTheDocument();
  });

  test("DOC-62 a draft with blocking errors lists what is missing instead of pages", async () => {
    fetchMock.mockImplementation(() => respond({ state: "unavailable", reason: "invalid", errors: ["Kunde fehlt."] }));
    renderWithIntl(<DocumentPreview id="doc1" refreshKey="draft:1" draft />);
    expect(await screen.findByText(/sobald diese Angaben ergänzt sind/)).toBeInTheDocument();
    expect(screen.getByText("Kunde fehlt.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  test("DOC-62 files still being produced show a notice", async () => {
    fetchMock.mockImplementation(() => respond({ state: "unavailable", reason: "pending" }));
    renderWithIntl(<DocumentPreview id="doc1" refreshKey="finalized:pending" draft={false} />);
    expect(await screen.findByText(/werden gerade erzeugt/)).toBeInTheDocument();
  });

  test("DOC-62 a document without archived files says so", async () => {
    fetchMock.mockImplementation(() => respond({ state: "unavailable", reason: "none" }));
    renderWithIntl(<DocumentPreview id="doc1" refreshKey="finalized:" draft={false} />);
    expect(await screen.findByText(/keine PDF-Datei archiviert/)).toBeInTheDocument();
  });

  test("DOC-62 long documents show the first pages with a hint", async () => {
    fetchMock.mockImplementation(() => respond({ state: "pages", pageCount: 12, pages: [PNG, PNG] }));
    renderWithIntl(<DocumentPreview id="doc1" refreshKey="finalized:ready" draft={false} />);
    expect(await screen.findByText(/Die ersten 2 von 12 Seiten/)).toBeInTheDocument();
  });

  test("DOC-62 a failed request can be retried", async () => {
    fetchMock.mockImplementationOnce(() => respond({ error: "x" }, 500));
    renderWithIntl(<DocumentPreview id="doc1" refreshKey="finalized:ready" draft={false} />);
    await userEvent.click(await screen.findByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));
  });
});
