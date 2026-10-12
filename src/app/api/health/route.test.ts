import { expect, test } from "vitest";
import { GET } from "./route";

test("SMOKE GET /api/health answers with a minimal status body", async () => {
  const res = GET();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ status: "ok", version: expect.any(String) });
});
