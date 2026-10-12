"use client";

import { ConvexReactClient } from "convex/react";

/**
 * The Convex client (02 §4.1: `NEXT_PUBLIC_CONVEX_URL` = `https://convex.<BASE_DOMAIN>`, WebSocket). `null` when the
 * URL is not configured (e.g. `next build` in CI without a backend); callers then show "keine Verbindung".
 *
 * Server rendering gets a client too, so the provider tree (and every `useId` below it) is the same as in the
 * browser and hydration matches. `ConvexReactClient` opens its WebSocket lazily on the first subscription or
 * mutation, which only happens in effects and event handlers, so server rendering never connects (Server Components
 * use `fetchAuthQuery` from src/lib/auth-server.ts instead). On the server it is one client per render, never
 * shared between requests; in the browser one for the page.
 */
let client: ConvexReactClient | undefined;

export function getConvexClient(): ConvexReactClient | null {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  if (typeof window === "undefined") return new ConvexReactClient(url, { unsavedChangesWarning: false });
  client ??= new ConvexReactClient(url, { unsavedChangesWarning: false });
  return client;
}

/** For imperative calls (adapters): throws a German error when no backend is configured. */
export function requireConvexClient(): ConvexReactClient {
  const c = typeof window === "undefined" ? null : getConvexClient();
  if (!c) throw new Error("Keine Verbindung zum Server (NEXT_PUBLIC_CONVEX_URL fehlt).");
  return c;
}
