"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { findActiveNavItem, NAV_SECTIONS, type NavItem, SECONDARY_NAV } from "./nav-config";

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

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const t = useTranslations("nav.items");
  const { isMobile, setOpenMobile } = useSidebar();
  const label = t(item.key);
  const Icon = item.icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={label}
        className="max-md:h-11"
        render={
          <Link
            href={item.href}
            aria-current={active ? "page" : undefined}
            onClick={() => {
              if (isMobile) setOpenMobile(false);
            }}
          />
        }
      >
        <Icon aria-hidden="true" />
        <span>{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Desktop sidebar; on phones the same content is the "Mehr" sheet (04-ui-ux §3.2, §3.3). */
export function AppSidebar() {
  const t = useTranslations();
  const pathname = usePathname();
  const active = findActiveNavItem(pathname);
  const settings = SECONDARY_NAV.find((i) => i.key === "einstellungen");

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
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label={t("nav.label")}>
          {NAV_SECTIONS.map((section) => (
            <SidebarGroup key={section.key} className="py-1">
              {section.key !== "main" && <SidebarGroupLabel>{t(`nav.sections.${section.key}`)}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => (
                    <NavLink key={item.key} item={item} active={active?.key === item.key} />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      {settings && (
        <SidebarFooter>
          <SidebarMenu>
            <NavLink item={settings} active={active?.key === "einstellungen"} />
          </SidebarMenu>
        </SidebarFooter>
      )}
      <SidebarRail />
    </Sidebar>
  );
}
