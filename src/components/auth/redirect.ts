import type { Route } from "next";

/**
 * `?weiter=<path>` target after sign-in (04-ui-ux §3.4). Only same-origin absolute paths are accepted
 * (no `//host`, no scheme, no backslashes) to prevent open redirects; auth pages never loop back to themselves.
 */
export function safeRedirect(target: string | null | undefined, fallback: Route = "/"): Route {
  if (!target || typeof target !== "string") return fallback;
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) return fallback;
  if ([...target].some((c) => c.charCodeAt(0) < 0x20)) return fallback;
  if (target === "/anmelden" || target.startsWith("/anmelden/") || target.startsWith("/anmelden?")) return fallback;
  return target as Route;
}

/** Appends `?weiter=` to an auth route when there is a non-default target. */
export function withRedirect(path: string, target: string | null | undefined): Route {
  const safe = safeRedirect(target);
  return (safe === "/" ? path : `${path}?weiter=${encodeURIComponent(safe)}`) as Route;
}
