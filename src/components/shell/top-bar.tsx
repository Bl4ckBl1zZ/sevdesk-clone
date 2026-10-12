"use client";

import { BellIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button, buttonVariants } from "@/components/ui/button";
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { AccountMenu } from "./account-menu";
import { CreateDropdown } from "./create-menu";
import { findActiveNavItem } from "./nav-config";
import { useShellUi } from "./shell-context";

/**
 * Top bar (04-ui-ux §3.2/3.3). Desktop: sidebar toggle, "⌘K Suchen …", "+ Neu ▾", bell, theme, account.
 * Phone: ☰ (navigation sheet), current section title, search icon.
 */
export function TopBar() {
  const t = useTranslations();
  const pathname = usePathname();
  const { isMobile } = useSidebar();
  const { setPaletteOpen } = useShellUi();
  const active = findActiveNavItem(pathname);
  const title = active ? t(`nav.items.${active.key}`) : t("app.name");

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background/95 px-2 backdrop-blur supports-backdrop-filter:bg-background/80 md:px-4">
      <SidebarTrigger
        className="size-11 md:size-8"
        aria-label={isMobile ? t("shell.openNav") : t("shell.toggleSidebar")}
      />
      <span className="truncate font-semibold md:hidden">{title}</span>

      <Button
        variant="outline"
        className="hidden h-9 w-72 justify-start gap-2 text-muted-foreground md:flex"
        onClick={() => setPaletteOpen(true)}
        aria-keyshortcuts="Meta+K Control+K"
      >
        <SearchIcon aria-hidden="true" />
        <span className="flex-1 text-left">{t("shell.search")}</span>
        <kbd className="rounded border bg-muted px-1.5 font-mono text-[10px]">⌘K</kbd>
      </Button>

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-11 md:hidden"
          onClick={() => setPaletteOpen(true)}
          aria-label={t("shell.searchLabel")}
        >
          <SearchIcon aria-hidden="true" />
        </Button>
        <div className="hidden md:block">
          <CreateDropdown />
        </div>
        <Link
          href="/benachrichtigungen"
          aria-label={t("shell.notifications")}
          className={cn(buttonVariants({ variant: "ghost", size: "icon" }), "hidden md:inline-flex")}
        >
          <BellIcon aria-hidden="true" />
        </Link>
        <div className="hidden md:block">
          <ThemeToggle />
        </div>
        <AccountMenu />
      </div>
    </header>
  );
}
