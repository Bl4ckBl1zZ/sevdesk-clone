import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { LetterheadDialog } from "./letterhead-dialog";

const backend = vi.hoisted(() => ({ calls: {} as Record<string, ReturnType<typeof vi.fn>> }));
const fn = (ref: unknown, value: unknown) => {
  const name = getFunctionName(ref as never);
  backend.calls[name] ??= vi.fn().mockResolvedValue(value);
  return backend.calls[name];
};
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => fn(ref, "https://upload.test/x"),
  useAction: (ref: unknown) => fn(ref, { pages: 1 }),
}));
const upload = vi.hoisted(() => vi.fn().mockResolvedValue("storage1"));
vi.mock("@/components/banking/shared", () => ({ uploadFile: upload }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

beforeEach(() => {
  backend.calls = {};
  upload.mockClear();
  toast.success.mockReset();
});

const pdf = () => new File(["%PDF-1.7"], "briefpapier.pdf", { type: "application/pdf" });

describe("Briefpapier dialog (F01 SET-072)", () => {
  test("SET-072 uploading a PDF runs the server check for page 1 and marks the letterhead as present", async () => {
    renderWithIntl(<LetterheadDialog layout={{ layoutId: "l1", name: "Standard" }} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Briefpapier für „Standard“" })).toHaveTextContent("A4 hochkant");
    // the follow-page file needs a first-page letterhead
    expect(screen.getByLabelText(/PDF hochladen \(Eigene Datei für Folgeseiten/)).toBeDisabled();
    const user = userEvent.setup();
    await user.upload(screen.getByLabelText(/PDF hochladen \(Briefpapier \(Seite 1/), pdf());
    expect(upload).toHaveBeenCalledWith("https://upload.test/x", expect.any(File));
    expect(backend.calls["documentArtifacts:uploadLetterhead"]).toHaveBeenCalledWith({
      layoutId: "l1",
      storageId: "storage1",
      slot: "first",
    });
    expect(toast.success).toHaveBeenCalledWith("Briefpapier gespeichert (neue Layout-Version).");
    expect(screen.getByLabelText(/PDF hochladen \(Eigene Datei für Folgeseiten/)).toBeEnabled();
  });

  test("SET-072 removing the page-1 letterhead is a new version and drops the follow-page file too", async () => {
    renderWithIntl(
      <LetterheadDialog
        layout={{ layoutId: "l1", name: "Standard", letterhead: true, letterheadFollow: true }}
        onClose={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Entfernen.*Seite 1/ }));
    expect(backend.calls["settings:removeLetterhead"]).toHaveBeenCalledWith({ layoutId: "l1", slot: "first" });
    expect(screen.queryByRole("button", { name: /Entfernen/ })).toBeNull();
    expect(screen.getAllByText("nicht hinterlegt")).toHaveLength(2);
  });
});
