import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { StornoDialog } from "./corrections";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  validate: vi.fn(),
  cancel: vi.fn(),
  duplicate: vi.fn(),
  exportFiles: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) =>
    getFunctionName(ref as never) === "invoices:duplicate" ? backend.duplicate : backend.cancel,
  useAction: (ref: unknown) =>
    getFunctionName(ref as never) === "corrections:validateCancel" ? backend.validate : backend.exportFiles,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: backend.push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("./invoice-shared", async (orig) => ({
  ...(await orig<typeof import("./invoice-shared")>()),
  downloadExport: vi.fn().mockResolvedValue(undefined),
}));

const preview = (patch: Record<string, unknown>) => ({
  original: { number: "RE-2026-0042", documentDate: "2026-10-01" },
  guard: null,
  mirror: null,
  notice: "Die Rechnung wurde noch nicht versendet.",
  exportSuggested: false,
  artifactsBlocked: false,
  ...patch,
});

beforeEach(() => {
  vi.clearAllMocks();
  backend.cancel.mockResolvedValue({ id: "s1", number: "RE-2026-0050" });
  backend.duplicate.mockResolvedValue({ id: "d2" });
  backend.exportFiles.mockResolvedValue({ files: [], attachments: [], zipName: null });
  backend.data = { "members:me": { role: "owner" } };
});

describe("Storno dialog fallbacks (EC-DOC-110, EC-DOC-116)", () => {
  test("EC-DOC-110 an invalid Storno XML on blocked files offers „Ohne E-Rechnung stornieren“", async () => {
    backend.data["corrections:cancelPreview"] = preview({ artifactsBlocked: true });
    backend.validate.mockResolvedValue({ status: "failed", message: "BR-CO-15" });
    renderWithIntl(<StornoDialog id={"d1" as never} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Stornorechnung erstellen" }));
    expect(backend.cancel).not.toHaveBeenCalled();
    await userEvent.click(await screen.findByRole("button", { name: "Ohne E-Rechnung stornieren" }));
    expect(backend.cancel).toHaveBeenCalledWith({ id: "d1", einvoiceFallback: true });
    await waitFor(() => expect(backend.push).toHaveBeenCalledWith("/rechnungen/s1"));
  });

  test("EC-DOC-110 no fallback when the original's files are fine (invalid XML stays a blocker)", async () => {
    backend.data["corrections:cancelPreview"] = preview({ artifactsBlocked: false });
    backend.validate.mockResolvedValue({ status: "failed", message: "BR-CO-15" });
    renderWithIntl(<StornoDialog id={"d1" as never} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Stornorechnung erstellen" }));
    await waitFor(() => expect(backend.validate).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Ohne E-Rechnung stornieren" })).toBeNull();
    expect(backend.cancel).not.toHaveBeenCalled();
  });

  test("EC-DOC-110 „Stornieren und neu erstellen“ cancels and opens a copy of the original as a draft", async () => {
    backend.data["corrections:cancelPreview"] = preview({ artifactsBlocked: true });
    backend.validate.mockResolvedValue({ status: "passed", message: null });
    renderWithIntl(<StornoDialog id={"d1" as never} recreate onClose={vi.fn()} />);
    expect(screen.getByRole("heading", { name: /stornieren und neu erstellen/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Stornorechnung erstellen" }));
    await waitFor(() => expect(backend.duplicate).toHaveBeenCalledWith({ id: "d1" }));
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/d2");
  });

  test("EC-DOC-116 an exported but unmarked invoice: warning before, „Exportieren“ of the Storno after", async () => {
    const notice =
      "Die Rechnung wurde exportiert, aber nicht als versendet markiert. Der Kunde könnte sie bereits erhalten haben – bitte die Stornorechnung ebenfalls übermitteln, sonst bleibt die ausgewiesene Steuer nach § 14c UStG geschuldet.";
    backend.data["corrections:cancelPreview"] = preview({ exportSuggested: true, notice });
    backend.validate.mockResolvedValue({ status: "passed", message: null });
    renderWithIntl(<StornoDialog id={"d1" as never} onClose={vi.fn()} />);
    expect(screen.getByTestId("storno-notice")).toHaveTextContent("§ 14c UStG");
    await userEvent.click(screen.getByRole("button", { name: "Stornorechnung erstellen" }));
    await userEvent.click(await screen.findByRole("button", { name: "Exportieren" }));
    expect(backend.exportFiles).toHaveBeenCalledWith({ id: "s1", request: { entry: "default" } });
    await waitFor(() => expect(backend.push).toHaveBeenCalledWith("/rechnungen/s1"));
  });
});
