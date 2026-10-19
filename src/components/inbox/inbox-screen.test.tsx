import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { renderWithIntl } from "@/i18n/test-utils";
import { InboxScreen } from "./inbox-screen";

const nav = vi.hoisted(() => ({
  search: "",
  listeners: new Set<() => void>(),
  replace: vi.fn((href: string) => {
    // The URL updates after the next render, as with the App Router.
    setTimeout(() => {
      nav.search = href.split("?")[1] ?? "";
      for (const l of nav.listeners) l();
    }, 0);
  }),
}));

vi.mock("next/navigation", async () => {
  const React = await import("react");
  return {
    usePathname: () => "/posteingang",
    useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
    useSearchParams: () => {
      const [, force] = React.useReducer((x: number) => x + 1, 0);
      React.useEffect(() => {
        nav.listeners.add(force);
        return () => {
          nav.listeners.delete(force);
        };
      }, []);
      return new URLSearchParams(nav.search);
    },
  };
});
vi.mock("@/components/convex/convex-provider", () => ({
  ConvexGuard: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/hooks/use-authed-query", () => ({
  useAuthedQuery: (ref: unknown) => {
    const name = getFunctionName(ref as never);
    if (name === "members:me") return { role: "owner" };
    if (name === "inbox:list") return [];
    if (name === "inbox:counts") return {};
    return undefined;
  },
}));
vi.mock("convex/react", () => ({ useMutation: () => vi.fn(), useAction: () => vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));

beforeEach(() => {
  nav.search = "";
  nav.replace.mockClear();
});

describe("Posteingang screen (F06 §6.1)", () => {
  test("INB-003 „📷 Beleg“ (?capture=1) opens the multi-page capture; „Abbrechen“ closes it for good", async () => {
    const user = userEvent.setup();
    nav.search = "capture=1";
    renderWithIntl(<InboxScreen />);
    expect(await screen.findByRole("dialog", { name: "Beleg fotografieren" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Abbrechen" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(nav.replace).toHaveBeenCalledWith("/posteingang", { scroll: false });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  test("INB-001 filter chips with the „> 10 Tage“ chip and a garbage ?id= is ignored", () => {
    nav.search = "id=../../etc";
    renderWithIntl(<InboxScreen />);
    expect(screen.getByRole("link", { name: "> 10 Tage" })).toHaveAttribute(
      "href",
      "/posteingang?filter=older_than_10_days",
    );
    expect(screen.getByText("Der Posteingang ist leer.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ordner hochladen" })).toBeInTheDocument();
  });
});
