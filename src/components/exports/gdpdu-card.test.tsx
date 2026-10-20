import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { GdpduCard } from "./gdpdu-card";

const backend = vi.hoisted(() => ({
  calls: [] as { name: string; args: unknown }[],
  can: new Set<string>(),
  list: [] as unknown[],
}));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: unknown) => {
    const name = getFunctionName(ref as never);
    backend.calls.push({ name, args });
    return name === "gdpdu:download" ? { url: null, name: "x" } : { jobId: "j1" };
  },
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (_ref: unknown, _args: unknown, enabled = true) => (enabled ? backend.list : undefined),
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/catalog/shared")>()),
  useCan: (p: string) => backend.can.has(p),
}));

const pkg = {
  id: "g1",
  year: 2025,
  encoding: "utf8",
  includeFiles: true,
  name: "gdpdu-2025.zip",
  sha256: "ab".repeat(32),
  bytes: 2_500_000,
  createdAt: Date.UTC(2026, 9, 1),
};

beforeEach(() => {
  backend.calls = [];
  backend.can = new Set(["exports.gdpdu", "exports.gdpdu.read"]);
  backend.list = [pkg];
});

describe("GdpduCard (EXP-017, AUD-023)", () => {
  test("EXP-017 EXP-018 the owner picks year, encoding and originals and starts the job", async () => {
    renderWithIntl(<GdpduCard />);
    expect(screen.getByRole("heading", { name: "GDPdU / Z3 (Datenträgerüberlassung)" })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Zeichensatz"), "ansi");
    await user.click(screen.getByRole("checkbox", { name: "Originalbelege beifügen" }));
    await user.click(screen.getByRole("button", { name: "GDPdU-Export erstellen" }));
    expect(backend.calls[0]).toMatchObject({ name: "gdpdu:start", args: { encoding: "ansi", includeFiles: false } });
  });

  test("AUD-023 the auditor only sees the package list and downloads (audited via the download mutation)", async () => {
    backend.can = new Set(["exports.gdpdu.read"]);
    renderWithIntl(<GdpduCard />);
    expect(screen.queryByRole("button", { name: "GDPdU-Export erstellen" })).toBeNull();
    const item = within(screen.getByRole("list", { name: "GDPdU-Exporte" })).getByRole("listitem");
    expect(item).toHaveTextContent("Wirtschaftsjahr 2025");
    await userEvent.setup().click(within(item).getByRole("button", { name: "gdpdu-2025.zip herunterladen" }));
    expect(backend.calls).toEqual([{ name: "gdpdu:download", args: { id: "g1" } }]);
  });

  test("AUD-023 roles without access see nothing", () => {
    backend.can = new Set();
    renderWithIntl(<GdpduCard />);
    expect(screen.queryByRole("heading")).toBeNull();
  });
});
