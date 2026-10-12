import { expect, test } from "vitest";
import { makeT } from "./test.setup";

test("SMOKE convex-test runs against the schema in the edge-runtime environment", async () => {
  const t = makeT();
  const result = await t.run(async (ctx) => {
    expect(ctx.db).toBeDefined();
    return typeof (globalThis as { EdgeRuntime?: unknown }).EdgeRuntime;
  });
  expect(result).toBe("string");
});
