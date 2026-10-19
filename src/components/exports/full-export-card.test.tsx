import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { FullExportCard } from "./full-export-card";

const backend = vi.hoisted(() => ({ calls: [] as string[], can: true }));
vi.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async () => {
    backend.calls.push(getFunctionName(ref as never));
    return { jobId: "j1" };
  },
}));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/catalog/shared", async (orig) => ({
  ...(await orig<typeof import("@/components/catalog/shared")>()),
  useCan: () => backend.can,
}));

beforeEach(() => {
  backend.calls = [];
  backend.can = true;
});

describe("FullExportCard (EXP-023)", () => {
  test("EXP-023 the owner starts the Vollexport job; the card names the daily backup as the restorable snapshot", async () => {
    renderWithIntl(<FullExportCard />);
    expect(screen.getByRole("heading", { name: "Vollexport" })).toBeInTheDocument();
    expect(screen.getByText(/tägliche Datensicherung \(convex-export\)/)).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Vollexport erstellen" }));
    expect(backend.calls).toEqual(["fullExport:start"]);
  });

  test("EXP-023 other roles do not see the card", () => {
    backend.can = false;
    renderWithIntl(<FullExportCard />);
    expect(screen.queryByRole("heading", { name: "Vollexport" })).toBeNull();
  });
});
