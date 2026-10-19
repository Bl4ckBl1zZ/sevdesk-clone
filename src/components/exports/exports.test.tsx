import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { ExportMenu } from "./export-menu";
import { JobsPage } from "./jobs-page";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  mutations: {} as Record<string, ReturnType<typeof vi.fn>>,
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    backend.mutations[name] ??= vi.fn().mockResolvedValue(null);
    return backend.mutations[name];
  },
  useConvex: () => ({ query: vi.fn().mockResolvedValue({ url: "https://files/x", name: "x.csv", sha256: "ab" }) }),
}));
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const NOW = Date.UTC(2026, 9, 12, 10);

beforeEach(() => {
  backend.mutations = {};
  toast.success.mockReset();
  toast.info.mockReset();
  backend.data = {
    "members:me": { role: "owner" },
    "jobs:list": [
      {
        id: "j1",
        kind: "csv_export",
        label: "CSV-Export dokumente-2026-10-12.csv",
        status: "running",
        progress: { done: 3000, total: 6000 },
        resultName: null,
        resultSha256: null,
        resultBytes: null,
        hasResult: false,
        skipped: [],
        error: null,
        actor: "user:u",
        createdAt: NOW,
        finishedAt: null,
        expiresAt: null,
      },
      {
        id: "j2",
        kind: "bulk_export",
        label: "Sammel-Export (3 Dokumente)",
        status: "done",
        progress: { done: 3, total: 3 },
        resultName: "sammel-export-2026-10-12.zip",
        resultSha256: "abc123",
        resultBytes: 100,
        hasResult: true,
        skipped: [{ id: "d9", label: "RE-1009", reason: "Archivdateien noch nicht bereit" }],
        error: null,
        actor: "user:u",
        createdAt: NOW,
        finishedAt: NOW,
        expiresAt: NOW + 30 * 86_400_000,
      },
    ],
  };
});

describe("export menu and jobs (EXP-021, EXP-026)", () => {
  test("EXP-021 „Export ▾“ offers „CSV (Excel)“ and „CSV (technisch)“; a large export starts a job", async () => {
    const createObjectURL = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    backend.mutations["exports:csv"] = vi
      .fn()
      .mockResolvedValueOnce({ kind: "file", name: "dokumente.csv", content: "a;b", rows: 1, sha256: "x" })
      .mockResolvedValueOnce({ kind: "job", jobId: "j1", rows: 6000 });
    renderWithIntl(<ExportMenu list="documents" params={{ type: "invoice" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Export als CSV" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "CSV (Excel)" }));
    expect(backend.mutations["exports:csv"]).toHaveBeenCalledWith({
      list: "documents",
      variant: "excel",
      type: "invoice",
    });
    expect(createObjectURL).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("1 Zeilen exportiert.");
    await userEvent.click(screen.getByRole("button", { name: "Export als CSV" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "CSV (technisch)" }));
    expect(toast.info).toHaveBeenCalledWith("6000 Zeilen – der Export läuft im Hintergrund.", expect.anything());
  });

  test("EXP-026 jobs show progress, cancel while running, skipped documents and the download with hash", async () => {
    renderWithIntl(<JobsPage />);
    expect(screen.getByRole("progressbar", { name: "CSV-Export dokumente-2026-10-12.csv: 50 %" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(backend.mutations["jobs:cancel"]).toHaveBeenCalledWith({ id: "j1" });
    expect(screen.getByText("1 übersprungen")).toBeInTheDocument();
    expect(screen.getByText("SHA-256 abc123")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "sammel-export-2026-10-12.zip herunterladen" })).toBeInTheDocument();
  });
});
