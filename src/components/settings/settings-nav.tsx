"use client";

import { ChevronLeftIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { findActiveSettingsItem, SETTINGS_NAV } from "@/components/shell/nav-config";
import { cn } from "@/lib/utils";

/** Grouped settings navigation on the left (desktop), 04-ui-ux §4.8. */
export function SettingsNav() {
  const t = useTranslations("settings");
  const pathname = usePathname();
  const active = findActiveSettingsItem(pathname);
  return (
    <nav aria-label={t("navLabel")} className="sticky top-14 flex flex-col gap-4 p-4">
      {SETTINGS_NAV.map((group) => (
        <div key={group.key} className="flex flex-col gap-1">
          <h2 className="px-2 font-medium text-muted-foreground text-xs">{t(`groups.${group.key}`)}</h2>
          <ul className="flex flex-col">
            {group.items.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  aria-current={active?.key === item.key ? "page" : undefined}
                  className={cn(
                    "block rounded-md px-2 py-1.5 text-sm hover:bg-muted",
                    active?.key === item.key && "bg-muted font-medium",
                  )}
                >
                  {t(`items.${item.key}`)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** On narrow containers the settings list is its own page; sub-pages get a back link (04-ui-ux §4.8). */
export function SettingsBackLink() {
  const t = useTranslations("settings");
  const pathname = usePathname();
  if (pathname === "/einstellungen") return null;
  return (
    <Link
      href="/einstellungen"
      className="flex min-h-11 items-center gap-1 px-4 text-muted-foreground text-sm hover:text-foreground @5xl/main:hidden"
    >
      <ChevronLeftIcon className="size-4" aria-hidden="true" />
      {t("navLabel")}
    </Link>
  );
}

/** In-page section navigation for long settings forms ("Tabs" of F01 §6.1 as anchors). */
export function SectionNav({ label, sections }: { label: string; sections: { id: string; label: string }[] }) {
  return (
    <nav aria-label={label} className="-mx-4 overflow-x-auto px-4">
      <ul className="flex w-max gap-2">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="inline-flex min-h-11 items-center rounded-full border px-3 text-sm hover:bg-muted md:min-h-9"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
