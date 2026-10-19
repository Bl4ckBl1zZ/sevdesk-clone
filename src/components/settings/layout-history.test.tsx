import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { HistoryDialog } from "./layouts-admin";

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown>, restore: vi.fn() }));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({ useMutation: () => backend.restore }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  backend.restore = vi.fn().mockResolvedValue({ version: 3 });
  backend.data = {
    "settings:layoutHistory": {
      name: "Standard",
      versions: [
        {
          versionId: "v2",
          version: 2,
          createdAt: Date.UTC(2026, 9, 12, 10),
          current: true,
          summary: ["Vorlage: Klassisch → Modern"],
          usedBy: 0,
        },
        {
          versionId: "v1",
          version: 1,
          createdAt: Date.UTC(2026, 9, 1, 10),
          current: false,
          summary: ["Erste Version"],
          usedBy: 4,
        },
      ],
    },
  };
});

describe("layout version history dialog (SET-076)", () => {
  test("SET-076 shows date, diff summary and usage, and restores an old version", async () => {
    renderWithIntl(
      <HistoryDialog
        layout={
          {
            layoutId: "l1",
            name: "Standard",
            isDefaultFor: ["invoice"],
            version: 2,
            template: "modern",
            accentColor: "#000",
          } as never
        }
        onClose={() => {}}
      />,
    );
    const list = screen.getByTestId("layout-history");
    expect(list.textContent).toContain("Vorlage: Klassisch → Modern");
    expect(list.textContent).toContain("in 4 Belegen verwendet");
    expect(screen.getAllByRole("button", { name: /Diese Version wiederherstellen/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: /Diese Version wiederherstellen/ }));
    expect(backend.restore).toHaveBeenCalledWith({ layoutId: "l1", versionId: "v1" });
  });
});
