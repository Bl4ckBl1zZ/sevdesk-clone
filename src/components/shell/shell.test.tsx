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
import { findActiveNavItem, PALETTE_NAV_ITEMS } from "./nav-config";
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

describe("navigation model (04-ui-ux §3.2, §3.4)", () => {
  test("SMOKE the longest matching route is active; a child wins over its parent with the same href", () => {
    expect(findActiveNavItem("/")?.key).toBe("start");
    expect(findActiveNavItem("/rechnungen")?.key).toBe("rechnungen");
    expect(findActiveNavItem("/rechnungen/wiederkehrend")?.key).toBe("wiederkehrend");
    expect(findActiveNavItem("/rechnungen/neu")?.key).toBe("rechnungen");
    expect(findActiveNavItem("/angebote")?.key).toBe("angebote");
    expect(findActiveNavItem("/bank")?.key).toBe("bank");
    expect(findActiveNavItem("/steuern/ustva")?.key).toBe("ustva");
    expect(findActiveNavItem("/einstellungen/steuern")?.key).toBe("einstellungen");
    expect(findActiveNavItem("/zeiten")?.key).toBe("zeiten");
    expect(findActiveNavItem("/rechnungenxyz")).toBeUndefined();
  });

  test("NAV-001 NAV-002 the sidebar has sevdesk's areas; only the active area shows its sub-items", () => {
    nav.pathname = "/rechnungen/wiederkehrend";
    renderWithIntl(
      <Shell>
        <AppSidebar />
      </Shell>,
    );
    const main = screen.getByRole("navigation", { name: "Hauptnavigation" });
    const names = within(main)
      .getAllByRole("link")
      .map((l) => l.textContent);
    expect(names).toEqual([
      "Übersicht",
      "Aufträge",
      "Rechnungen",
      "Wiederkehrend",
      "Mahnungen",
      "Ausgaben",
      "Bank",
      "Steuern",
      "Auswertungen",
      "Kontakte",
      "Produkte",
      "Einstellungen",
    ]);
    expect(within(main).getByText("Verwalten")).toBeInTheDocument();
    expect(within(main).getByRole("link", { name: "Wiederkehrend" })).toHaveAttribute("aria-current", "page");
    const invoices = within(main).getByRole("link", { name: "Rechnungen" });
    expect(invoices).not.toHaveAttribute("aria-current");
    expect(invoices).toHaveAttribute("aria-expanded", "true");
    expect(within(main).getByRole("link", { name: "Aufträge" })).toHaveAttribute("aria-expanded", "false");
    expect(within(main).getByRole("link", { name: "Einstellungen" })).toHaveAttribute("href", "/einstellungen");
  });

  test("NAV-002 MOT-002 an area's link opens its first page and shows its sub-items there", () => {
    nav.pathname = "/steuern/ustva";
    renderWithIntl(
      <Shell>
        <AppSidebar />
      </Shell>,
    );
    const main = screen.getByRole("navigation", { name: "Hauptnavigation" });
    expect(within(main).getByRole("link", { name: "Steuern" })).toHaveAttribute("href", "/steuern/ustva");
    expect(within(main).getByRole("link", { name: "UStVA" })).toHaveAttribute("aria-current", "page");
    for (const sub of ["EÜR", "ZM", "USt-Jahr", "Rücklage"])
      expect(within(main).getByRole("link", { name: sub })).toBeVisible();
    expect(within(main).queryByRole("link", { name: "Wiederkehrend" })).toBeNull();
    expect(within(main).queryByRole("link", { name: "Zeiten" })).toBeNull();
    // MOT-002: the sub-items slide in when the area opens.
    expect(within(main).getByRole("link", { name: "EÜR" }).closest("ul")?.className).toMatch(/animate-in/);
  });

  test("NAV-003 the search sits at the top of the sidebar and opens the command palette", async () => {
    renderWithIntl(
      <Shell>
        <AppSidebar />
        <CommandPalette />
      </Shell>,
    );
    await userEvent.click(screen.getByRole("button", { name: /Suchen/ }));
    expect(await screen.findByPlaceholderText("Seite oder Aktion suchen …")).toBeInTheDocument();
  });

  test("NAV-004 the command palette still lists pages that left the sidebar, once each", () => {
    expect(PALETTE_NAV_ITEMS.map((i) => i.key)).toEqual(
      expect.arrayContaining(["zeiten", "projekte", "journal", "konto"]),
    );
    const hrefs = PALETTE_NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe("mobile shell (04-ui-ux §3.3)", () => {
  test("NAV-005 the bottom tab bar has Übersicht · Rechnungen · Neu · Beleg · Mehr", () => {
    nav.pathname = "/rechnungen";
    renderWithIntl(
      <Shell>
        <MobileTabBar />
      </Shell>,
    );
    const bar = screen.getByRole("navigation", { name: "Schnellzugriff" });
    expect(within(bar).getByRole("link", { name: "Übersicht" })).toHaveAttribute("href", "/");
    expect(within(bar).getByRole("link", { name: "Rechnungen" })).toHaveAttribute("aria-current", "page");
    expect(within(bar).getByRole("button", { name: "Neu erstellen" })).toBeInTheDocument();
    // INB-003: „Beleg“ opens the multi-page camera capture of the Posteingang.
    expect(within(bar).getByRole("link", { name: "Beleg fotografieren oder hochladen" })).toHaveAttribute(
      "href",
      "/posteingang?capture=1",
    );
    expect(within(bar).getByRole("button", { name: "Mehr" })).toBeInTheDocument();
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
