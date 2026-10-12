"use client";

import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef } from "react";

/** Skip link to the main content (04-ui-ux §7). */
export function SkipLink() {
  const t = useTranslations("shell");
  return (
    <a
      href="#main"
      className="sr-only z-100 rounded-md bg-background px-4 py-2 font-medium shadow-lg ring-3 ring-ring focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
    >
      {t("skipLink")}
    </a>
  );
}

/**
 * Focus management on client navigation (04-ui-ux §7): move focus to the new page's heading (or main) so keyboard
 * and screen-reader users start at the content, not at the top of the shell. The initial load is left alone.
 */
export function RouteFocus() {
  const pathname = usePathname();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const target = document.getElementById("page-title") ?? document.getElementById("main");
    target?.focus({ preventScroll: false });
  }, [pathname]);
  return null;
}
