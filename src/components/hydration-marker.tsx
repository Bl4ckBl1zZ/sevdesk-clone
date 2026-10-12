"use client";

import { useEffect } from "react";

/**
 * Sets `<html data-hydrated="true">` once React has hydrated the page (effects run after the whole tree, incl. the
 * shell's keyboard shortcuts, has committed). E2E tests wait for it before pressing keys or running axe
 * (e2e/fixtures.ts `waitForApp`). Renders nothing.
 */
export function HydrationMarker() {
  useEffect(() => {
    document.documentElement.dataset.hydrated = "true";
  }, []);
  return null;
}
