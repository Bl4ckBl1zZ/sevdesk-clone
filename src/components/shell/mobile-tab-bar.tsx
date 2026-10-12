"use client";

import { CameraIcon, EllipsisIcon, PlusIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef } from "react";
import { useSidebar } from "@/components/ui/sidebar";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { cn } from "@/lib/utils";
import { findActiveNavItem, MOBILE_TABS } from "./nav-config";
import { uploadReceipt } from "./receipt-capture";
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
  const fileRef = useRef<HTMLInputElement>(null);
  const showAdapterError = useAdapterErrorToast();

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
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-backdrop-filter:bg-background/80 md:hidden"
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
          <button
            type="button"
            className={tabClass}
            aria-label={t("shell.receiptCapture")}
            onClick={() => fileRef.current?.click()}
          >
            <CameraIcon className="size-5" aria-hidden="true" />
            <span aria-hidden="true">{t("shell.receipt")}</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*,application/pdf"
            capture="environment"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                await uploadReceipt(file);
              } catch (err) {
                showAdapterError(err);
              }
            }}
          />
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
