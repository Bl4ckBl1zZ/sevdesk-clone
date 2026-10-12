"use client";

import { ConvexReactClient } from "convex/react";

/**
 * The browser's Convex client (02 §4.1: `NEXT_PUBLIC_CONVEX_URL` = `https://convex.<BASE_DOMAIN>`, WebSocket).
 * Created only in the browser: server rendering never opens a Convex connection (Server Components use
 * `fetchAuthQuery` from src/lib/auth-server.ts instead). `null` when the URL is not configured (e.g. `next build`
 * in CI without a backend); callers then show "keine Verbindung".
 */
let client: ConvexReactClient | null | undefined;

export function getConvexClient(): ConvexReactClient | null {
  if (client !== undefined) return client;
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (typeof window === "undefined" || !url) return null;
  client = new ConvexReactClient(url, { unsavedChangesWarning: false });
  return client;
}

/** For imperative calls (adapters): throws a German error when no backend is configured. */
export function requireConvexClient(): ConvexReactClient {
  const c = getConvexClient();
  if (!c) throw new Error("Keine Verbindung zum Server (NEXT_PUBLIC_CONVEX_URL fehlt).");
  return c;
}
