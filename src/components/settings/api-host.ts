"use client";

import { useSyncExternalStore } from "react";

/**
 * The REST API and the MCP endpoint live on the `api.` host next to the `app.` host (02 §4, 05 §6). The settings
 * pages show their absolute URLs derived from the current location: `app.<domain>` → `https://api.<domain><path>`.
 * Any other host (localhost, a bare IP) has no derivable api host → `null`, and the caller shows a fallback.
 */
export function apiHostUrl(host: string | null, path: string): string | null {
  if (!host?.startsWith("app.") || host.length <= 4) return null;
  return `https://api.${host.slice(4)}${path}`;
}

const subscribe = () => () => {};

/** `window.location.host` on the client, `null` during server rendering (no hydration mismatch). */
export function useLocationHost(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => window.location.host,
    () => null,
  );
}
