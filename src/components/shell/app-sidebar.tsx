"use client";

import { SearchIcon } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { findActiveNavItem, NAV_GROUPS, type NavItem } from "./nav-config";
import { useShellUi } from "./shell-context";

const DESKTOP_QUERY = "(min-width: 1280px)";

/**
 * 04-ui-ux §3.1: full sidebar on desktop (≥ 1280 px), icons only on tablets (768–1279 px). ⌘B still toggles.
 */
export function SidebarAutoCollapse() {
  const { setOpen } = useSidebar();
  // setOpen changes identity with every toggle; only breakpoint changes should re-apply the default.
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;
  useEffect(() => {
    const mql = window.matchMedia(DESKTOP_QUERY);
    const apply = () => setOpenRef.current(mql.matches);
    apply();
    mql.addEventListener("change", apply);
    return () => mql.removeEventListener("change", apply);
  }, []);
  return null;
}

function useCloseOnMobile() {
  const { isMobile, setOpenMobile } = useSidebar();
  return () => {
    if (isMobile) setOpenMobile(false);
  };
}

/**
 * One sidebar area (NAV-002). Its sub-items are rendered only while the area is active, like in sevdesk; the area
 * link carries `aria-expanded`, the current page `aria-current`.
 */
function NavArea({ item, activeKey }: { item: NavItem; activeKey: NavItem["key"] | undefined }) {
  const t = useTranslations("nav.items");
  const close = useCloseOnMobile();
  const label = t(item.key);
  const Icon = item.icon;
  const children = item.children ?? [];
  const current = activeKey === item.key;
  const open = current || children.some((c) => c.key === activeKey);
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={current || (open && children.length > 0)}
        tooltip={label}
        className="max-md:h-11"
        render={
          <Link
            href={item.href}
            aria-current={current ? "page" : undefined}
            aria-expanded={children.length > 0 ? open : undefined}
            onClick={close}
          />
        }
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </SidebarMenuButton>
      {open && children.length > 0 && (
        <SidebarMenuSub className="fade-in slide-in-from-top-1 animate-in duration-200">
          {children.map((child) => {
            const active = activeKey === child.key;
            return (
              <SidebarMenuSubItem key={child.key}>
                <SidebarMenuSubButton
                  isActive={active}
                  className="max-md:h-10"
                  render={<Link href={child.href} aria-current={active ? "page" : undefined} onClick={close} />}
                >
                  <span>{t(child.key)}</span>
                </SidebarMenuSubButton>
              </SidebarMenuSubItem>
            );
          })}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  );
}

/** NAV-003: search at the top of the sidebar, like sevdesk; opens the command palette (⌘K). */
function SidebarSearch() {
  const t = useTranslations("shell");
  const { setPaletteOpen } = useShellUi();
  const close = useCloseOnMobile();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={t("search")}
        className="bg-sidebar-accent/60 text-muted-foreground max-md:h-11"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => {
          close();
          setPaletteOpen(true);
        }}
      >
        <SearchIcon aria-hidden="true" />
        <span className="flex-1">{t("search")}</span>
        <kbd className="rounded border bg-background px-1.5 font-mono text-[10px] group-data-[collapsible=icon]:hidden">
          ⌘K
        </kbd>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Desktop sidebar; on phones the same content is the "Mehr" sheet (04-ui-ux §3.2, §3.3). */
export function AppSidebar() {
  const t = useTranslations();
  const pathname = usePathname();
  const activeKey = findActiveNavItem(pathname)?.key;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" render={<Link href="/" />}>
              <Image src="/icon.svg" alt="" width={32} height={32} className="size-8 rounded-md" unoptimized />
              <span className="font-semibold">{t("app.name")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarSearch />
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("nav.label")}>
          {NAV_GROUPS.map((group) => (
            <SidebarGroup key={group.key} className="py-1">
              {group.key !== "main" && <SidebarGroupLabel>{t(`nav.groups.${group.key}`)}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <NavArea key={item.key} item={item} activeKey={activeKey} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
