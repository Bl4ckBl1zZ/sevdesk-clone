import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConvexClientProvider, useConvexAvailable } from "@/components/convex/convex-provider";
import { getConvexClient, requireConvexClient } from "./convex-client";

/**
 * Server rendering must produce the same provider tree as the browser (otherwise every `useId` below the
 * provider differs and React reports hydration mismatches: label `for` ≠ input `id`, MISC-10), but must never
 * open a Convex connection (02 §4.1: Server Components read through fetchAuthQuery).
 */
const sockets: string[] = [];

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "http://127.0.0.1:3210");
  vi.stubGlobal(
    "WebSocket",
    class {
      constructor(url: string) {
        sockets.push(url);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  sockets.length = 0;
});

test("MISC-10 server rendering gets a Convex client (same provider tree as the browser) without a WebSocket", () => {
  expect(typeof window).toBe("undefined");
  const a = getConvexClient();
  const b = getConvexClient();
  expect(a).not.toBeNull();
  expect(a).not.toBe(b); // one per render: nothing is shared between requests

  function Probe() {
    return createElement("span", null, useConvexAvailable() ? "verbunden" : "ohne Convex");
  }
  const html = renderToString(createElement(ConvexClientProvider, null, createElement(Probe)));
  expect(html).toContain("verbunden");
  expect(sockets).toEqual([]);
});

test("MISC-10 imperative Convex calls stay browser-only", () => {
  expect(() => requireConvexClient()).toThrow("Keine Verbindung zum Server");
});

test("SMOKE without NEXT_PUBLIC_CONVEX_URL there is no client", () => {
  vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "");
  expect(getConvexClient()).toBeNull();
});
