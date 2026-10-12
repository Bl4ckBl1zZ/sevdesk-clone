import { expect, test } from "vitest";

/**
 * Integration tests run against a real self-hosted Convex backend (07-testing §2):
 * `scripts/convex-local-backend.sh` (no Docker) or `deploy/compose.dev.yml`.
 * They are skipped unless CONVEX_SELF_HOSTED_URL is set.
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;

test("SMOKE integration project is wired (runs serially in node)", () => {
  expect(typeof window).toBe("undefined");
});

test.skipIf(!url)("SMOKE self-hosted Convex backend is reachable", async () => {
  const res = await fetch(`${url}/version`);
  expect(res.ok).toBe(true);
});
