"use client";

import type * as React from "react";
import { useRef } from "react";
import { useSessionState } from "@/components/auth/session-provider";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar, SidebarAutoCollapse } from "./app-sidebar";
import { CommandPalette } from "./command-palette";
import { CreateSheet } from "./create-menu";
import { IntegrityBanner } from "./integrity-banner";
import { MobileTabBar } from "./mobile-tab-bar";
import { RouteFocus, SkipLink } from "./route-focus";
import { useRouteEnterAnimation } from "./route-transition";
import { ShellUiProvider } from "./shell-context";
import { GlobalShortcuts, ShortcutHelpDialog } from "./shortcuts";
import { TopBar } from "./top-bar";

/**
 * Signed-in app shell (04-ui-ux §3): sidebar (full ≥ 1280 px, icons 768–1279 px, sheet on phones), top bar,
 * bottom tab bar on phones, command palette and shortcuts. The main area is a container-query context
 * (`@container/main`) because the sidebar changes the available width.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { expired } = useSessionState();
  const mainRef = useRef<HTMLElement>(null);
  useRouteEnterAnimation(mainRef);
  return (
    <ShellUiProvider>
      <SidebarProvider>
        <SkipLink />
        <SidebarAutoCollapse />
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col" aria-hidden={expired || undefined}>
          <TopBar />
          <IntegrityBanner />
          <main
            id="main"
            ref={mainRef}
            tabIndex={-1}
            className="@container/main flex-1 pb-[calc(4.5rem+env(safe-area-inset-bottom))] outline-none has-data-[slot=page-actions]:pb-[calc(9rem+env(safe-area-inset-bottom))] md:pb-0 md:has-data-[slot=page-actions]:pb-0"
          >
            {children}
          </main>
        </div>
        <MobileTabBar />
        <CreateSheet />
        <CommandPalette />
        <ShortcutHelpDialog />
        <GlobalShortcuts />
        <RouteFocus />
      </SidebarProvider>
    </ShellUiProvider>
  );
}
