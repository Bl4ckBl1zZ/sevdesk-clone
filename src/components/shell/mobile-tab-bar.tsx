"use client";

import { CameraIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { findActiveNavItem, MOBILE_TABS } from "./nav-config";
import { useShellUi } from "./shell-context";

const tabClass =
  "flex min-h-14 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current=page]:text-foreground";

/**
 * Bottom tab bar on phones (04-ui-ux §3.3): Start · Rechnungen · (+) Neu · Beleg (camera) · Mehr (full nav sheet).
 * Respects env(safe-area-inset-bottom).
 */
export function MobileTabBar() {
  const t = useTranslations();
  const pathname = usePathname();
  const active = findActiveNavItem(pathname);
  const { setOpenMobile } = useSidebar();
  const { setCreateOpen } = useShellUi();

  const [first, second] = MOBILE_TABS;

  const renderTab = (item: typeof first) => {
    if (!item) return null;
    const Icon = item.icon;
    return (
      <li className="flex flex-1">
        <Link href={item.href} aria-current={active?.key === item.key ? "page" : undefined} className={tabClass}>
          <Icon className="size-5" aria-hidden="true" />
          {t(`nav.items.${item.key}`)}
        </Link>
      </li>
    );
  };

  return (
    <nav
      aria-label={t("shell.mobileNav")}
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="flex items-stretch px-1">
        {renderTab(first)}
        {renderTab(second)}
        <li className="flex flex-1 items-center justify-center">
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            aria-label={t("shell.newMenuLabel")}
            className="-mt-5 flex size-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <PlusIcon className="size-6" aria-hidden="true" />
          </button>
        </li>
        <li className="flex flex-1">
          {/* INB-003: the camera capture (several pages → one item) lives in the Posteingang. */}
          <Link href="/posteingang?capture=1" aria-label={t("shell.receiptCapture")} className={tabClass}>
            <CameraIcon className="size-5" aria-hidden="true" />
            <span aria-hidden="true">{t("shell.receipt")}</span>
          </Link>
        </li>
        <li className="flex flex-1">
          <button type="button" className={cn(tabClass)} onClick={() => setOpenMobile(true)}>
            <EllipsisIcon className="size-5" aria-hidden="true" />
            {t("shell.more")}
          </button>
        </li>
      </ul>
    </nav>
  );
}
