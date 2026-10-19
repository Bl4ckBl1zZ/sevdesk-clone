import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { DuplicateButton } from "./duplicate-button";

const backend = vi.hoisted(() => ({
  data: {} as Record<string, unknown>,
  duplicate: vi.fn(),
  push: vi.fn(),
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => backend.data[getFunctionName(ref as never)],
}));
vi.mock("convex/react", () => ({ useMutation: () => backend.duplicate }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: backend.push }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  backend.data = { "members:me": { role: "owner" } };
  backend.duplicate = vi.fn().mockResolvedValue({ id: "new1" });
  backend.push.mockReset();
});

describe("DuplicateButton (DOC-35)", () => {
  test("DOC-35 duplicates an advance invoice and opens the new invoice draft", async () => {
    renderWithIntl(<DuplicateButton doc={{ _id: "d1" as never, type: "advance_invoice" }} />);
    await userEvent.click(screen.getByRole("button", { name: "Duplizieren" }));
    expect(backend.duplicate).toHaveBeenCalledWith({ id: "d1" });
    expect(backend.push).toHaveBeenCalledWith("/rechnungen/new1");
  });

  test("DOC-35 hidden for a Storno and for read-only roles", () => {
    const { unmount } = renderWithIntl(<DuplicateButton doc={{ _id: "d1" as never, type: "cancellation" }} />);
    expect(screen.queryByRole("button", { name: "Duplizieren" })).toBeNull();
    unmount();
    backend.data["members:me"] = { role: "viewer" };
    renderWithIntl(<DuplicateButton doc={{ _id: "d1" as never, type: "quote" }} />);
    expect(screen.queryByRole("button", { name: "Duplizieren" })).toBeNull();
  });
});
