import { afterEach, describe, expect, test } from "vitest";
import { apiTest, call } from "./harness";

/** F07 §7.1 cash over REST: movements and cash payments are immutable (EC-CSH-07, CSH-027, GOBD-06). */

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("REST cash immutability (F07 §7.1)", () => {
  test("EC-CSH-07 CSH-027 PATCH/DELETE of cash payments and cash transfers → 405; only reversals exist", async () => {
    const h = apiTest();
    restore = h.restore;
    const { key } = await h.t.asApiKey(["payments:read", "payments:write", "banking:read", "banking:write"]);
    for (const method of ["PATCH", "DELETE", "PUT"] as const) {
      const pay = await call(method, "/payments/pay_x", { key, body: {} });
      expect(pay.status).toBe(405);
      expect(pay.headers.get("allow")).toBe("GET");
      const transfers = await call(method, "/cash/transfers", { key, body: {} });
      expect(transfers.status).toBe(405);
      expect(transfers.headers.get("allow")).toBe("POST");
      const reverse = await call(method, "/cash/transfers/ctr_x/reverse", { key, body: {} });
      expect(reverse.status).toBe(405);
      expect(reverse.headers.get("allow")).toBe("POST");
    }
  });
});
