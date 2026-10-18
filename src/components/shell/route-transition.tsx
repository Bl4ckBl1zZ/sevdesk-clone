"use client";

import { usePathname } from "next/navigation";
import { type RefObject, useEffect, useRef } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

/**
 * MOT-001: fades the main area in after a page change (not on the first load). Uses the Web Animations API so
 * the page is not remounted; skipped entirely with reduced motion (MOT-007).
 */
export function useRouteEnterAnimation(ref: RefObject<HTMLElement | null>) {
  const pathname = usePathname();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    const el = ref.current;
    if (!el || typeof el.animate !== "function" || window.matchMedia(REDUCED).matches) return;
    el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 220, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
    );
  }, [pathname, ref]);
}
