import { expect, test } from "vitest";

test("SMOKE domain project runs in plain node (no DOM)", () => {
  expect(typeof window).toBe("undefined");
  expect(process.env.TZ).toBe("UTC");
});
