import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { MembersPanel } from "./members-panel";

/** F12 E-AUD-35: the app has no public host — the invite dialog explains how an auditor reaches it. */

const backend = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown, _args: unknown, enabled = true) =>
    enabled ? backend.data[getFunctionName(ref as never)] : undefined,
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn().mockResolvedValue(null) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  backend.data = { "members:list": [], "invites:list": [] };
});

describe("auditor invite (E-AUD-35)", () => {
  test("E-AUD-35 the invite dialog tells the owner the auditor needs a tailnet device: on site or by tailnet invitation", async () => {
    renderWithIntl(<MembersPanel />);
    await userEvent.click(screen.getByRole("button", { name: "Person einladen" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/Rolle/), "auditor");
    const hint = within(dialog).getByText(/Gerät im Tailnet/);
    expect(hint).toHaveTextContent("vor Ort");
    expect(hint).toHaveTextContent("Tailnet-Einladung");
    expect(hint).toHaveTextContent("Prüferzugang-Anleitung");
  });
});
