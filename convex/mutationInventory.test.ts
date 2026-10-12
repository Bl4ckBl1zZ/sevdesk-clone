/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";

/**
 * Mutation inventory (07-testing §5, GOBD-06). P0 placeholder.
 *
 * 1. Static: no module outside convex/model/** and convex/betterAuth/** calls ctx.db writes
 *    (same rule as scripts/check-boundaries.ts, repeated here so the Convex suite fails on its own).
 * 2. Inventory: every public mutation is enumerated from the modules. Once finalised documents, payments,
 *    journal entries, cash transfers, booked bank transactions, sendLog rows and audit entries exist, each
 *    public mutation is called against them and must throw `immutable_record`.
 */
const sources = import.meta.glob(["./**/*.ts", "!./**/*.test.ts", "!./_generated/**"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const modules = import.meta.glob(["./**/*.ts", "!./**/*.*.ts", "!./_generated/**"], { eager: true }) as Record<
  string,
  Record<string, unknown>
>;

const WRITE_RE = /\bdb\s*\.\s*(insert|patch|replace|delete)\s*\(/;
const ALLOWED = [/^\.\/model\//, /^\.\/betterAuth\//];

type RegisteredFn = { isMutation?: boolean; isPublic?: boolean; isInternal?: boolean };

function publicMutations(): string[] {
  const names: string[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    for (const [exportName, value] of Object.entries(mod)) {
      const fn = value as RegisteredFn | null;
      if (typeof value === "function" && fn?.isMutation && fn.isPublic) {
        names.push(`${path.replace(/^\.\//, "").replace(/\.ts$/, "")}:${exportName}`);
      }
    }
  }
  return names.sort();
}

describe("mutation inventory", () => {
  test("SMOKE no Convex module outside convex/model/** writes to ctx.db", () => {
    const offenders = Object.entries(sources)
      .filter(([path]) => !ALLOWED.some((re) => re.test(path)) && path !== "./test.setup.ts")
      .filter(([, src]) => WRITE_RE.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  test("SMOKE public mutations can be enumerated", () => {
    // Empty in the scaffold; grows with every feature. Keep the list visible in the test output.
    expect(Array.isArray(publicMutations())).toBe(true);
  });

  test.todo("GOBD-06 every public mutation rejects changes to finalised records with immutable_record");
});
