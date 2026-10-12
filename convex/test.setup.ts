/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import schema from "./schema";

/**
 * All Convex modules for convex-test (07-testing §3.1). Excludes multi-dot files (*.test.ts, *.d.ts,
 * test.setup.ts, convex.config.ts). Vite 8's glob does not support the extglob `!(*.*.*)` form from the
 * convex-test docs, hence the negated pattern.
 */
export const modules = import.meta.glob(["./**/*.*s", "!./**/*.*.*s"]);

/**
 * Creates a convex-test instance. P0 stub: later seeds company settings and adds identity helpers
 * `asUser({ role })`, `asApiKey(scopes)`, `asMcp(scopes)`, `asSystem(job)` (07-testing §3.1) and registers
 * the instance for assertInvariants() via `useInvariantTarget`.
 */
export function makeT() {
  return convexTest(schema, modules);
}
