import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as React from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { renderWithIntl } from "@/i18n/test-utils";
import { AppSidebar } from "./app-sidebar";
import { CommandPalette, isPaletteShortcut } from "./command-palette";
import { MobileTabBar } from "./mobile-tab-bar";
import { findActiveNavItem, NAV_SECTIONS } from "./nav-config";
import { ShellUiProvider } from "./shell-context";
import { GlobalShortcuts } from "./shortcuts";

const nav = vi.hoisted(() => ({
  pathname: "/",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
}));

// jsdom lacks what cmdk uses for list measuring and scrolling.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};

beforeEach(() => {
  nav.pathname = "/";
  nav.router.push.mockReset();
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <ShellUiProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </ShellUiProvider>
    </TooltipProvider>
  );
}

describe("navigation model (04-ui-ux §3.4)", () => {
  test("SMOKE the longest matching route is active", () => {
    expect(findActiveNavItem("/")?.key).toBe("start");
    expect(findActiveNavItem("/rechnungen")?.key).toBe("rechnungen");
    expect(findActiveNavItem("/rechnungen/wiederkehrend")?.key).toBe("wiederkehrend");
    expect(findActiveNavItem("/rechnungen/neu")?.key).toBe("rechnungen");
    expect(findActiveNavItem("/einstellungen/steuern")?.key).toBe("einstellungen");
    expect(findActiveNavItem("/rechnungenxyz")).toBeUndefined();
  });

  test("SMOKE the sidebar shows every section of the route map with German labels", () => {
    nav.pathname = "/rechnungen/wiederkehrend";
    renderWithIntl(
      <Shell>
        <AppSidebar />
      </Shell>,
    );
    const main = screen.getByRole("navigation", { name: "Hauptnavigation" });
    for (const section of ["Verkauf", "Einkauf", "Bank & Kasse", "Buchhaltung", "Steuern", "Auswertungen"]) {
      expect(within(main).getByText(section)).toBeInTheDocument();
    }
    const links = within(main).getAllByRole("link");
    expect(links).toHaveLength(NAV_SECTIONS.flatMap((s) => s.items).length);
    expect(within(main).getByRole("link", { name: "Wiederkehrend" })).toHaveAttribute("aria-current", "page");
    expect(within(main).getByRole("link", { name: "Rechnungen" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("link", { name: "Einstellungen" })).toHaveAttribute("href", "/einstellungen");
  });
});

describe("mobile shell (04-ui-ux §3.3)", () => {
  test("SMOKE the bottom tab bar has Start · Rechnungen · Neu · Beleg · Mehr", () => {
    nav.pathname = "/rechnungen";
    renderWithIntl(
      <Shell>
        <MobileTabBar />
      </Shell>,
    );
    const bar = screen.getByRole("navigation", { name: "Schnellzugriff" });
    expect(within(bar).getByRole("link", { name: "Start" })).toHaveAttribute("href", "/");
    expect(within(bar).getByRole("link", { name: "Rechnungen" })).toHaveAttribute("aria-current", "page");
    expect(within(bar).getByRole("button", { name: "Neu erstellen" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Beleg fotografieren oder hochladen" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Mehr" })).toBeInTheDocument();
    const file = bar.querySelector("input[type=file]");
    expect(file).toHaveAttribute("capture", "environment");
    expect(file).toHaveAttribute("accept", "image/*,application/pdf");
  });
});

describe("command palette and shortcuts (04-ui-ux §5)", () => {
  test("SMOKE ⌘K / Ctrl+K is recognised", () => {
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "k", metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "K", ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(new KeyboardEvent("keydown", { key: "k" }))).toBe(false);
  });

  test("SMOKE Ctrl+K opens the palette and choosing a page navigates", async () => {
    renderWithIntl(
      <Shell>
        <CommandPalette />
      </Shell>,
    );
    act(() => {
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    });
    const input = await screen.findByPlaceholderText("Seite oder Aktion suchen …");
    await userEvent.type(input, "Kontakte");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(nav.router.push).toHaveBeenCalledWith("/kontakte"));
  });

  test("SMOKE n then r opens a new invoice; typing in a field is ignored", async () => {
    renderWithIntl(
      <Shell>
        <input aria-label="Feld" />
        <GlobalShortcuts />
      </Shell>,
    );
    await userEvent.keyboard("nr");
    expect(nav.router.push).toHaveBeenCalledWith("/rechnungen/neu");
    nav.router.push.mockReset();
    await userEvent.click(screen.getByLabelText("Feld"));
    await userEvent.keyboard("nk");
    expect(nav.router.push).not.toHaveBeenCalled();
  });
});
