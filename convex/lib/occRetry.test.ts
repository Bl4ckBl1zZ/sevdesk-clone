import { describe, expect, test } from "vitest";
import { isOccConflict, withOccRetry } from "./occRetry";

const occ = () =>
  new Error(
    'Documents read from or written to the "auditLog" table changed while this mutation was being run and on every subsequent retry.',
  );

describe("OCC retry around the finalisation commit (10 EC-001)", () => {
  test("EC-001 a commit that exhausted Convex's own OCC retries is retried until it goes through", async () => {
    let calls = 0;
    const r = await withOccRetry(
      async () => {
        calls++;
        if (calls < 3) throw occ();
        return "RE-2026-0001";
      },
      { sleep: async () => {} },
    );
    expect(r).toBe("RE-2026-0001");
    expect(calls).toBe(3);
  });

  test("EC-001 domain errors are not retried; a lasting conflict surfaces after the last attempt", async () => {
    let calls = 0;
    const domain = Object.assign(new Error("x"), { data: { code: "version_conflict" } });
    await expect(
      withOccRetry(
        async () => {
          calls++;
          throw domain;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBe(domain);
    expect(calls).toBe(1);
    calls = 0;
    await expect(
      withOccRetry(
        async () => {
          calls++;
          throw occ();
        },
        { attempts: 4, sleep: async () => {} },
      ),
    ).rejects.toThrow(/changed while this mutation was being run/);
    expect(calls).toBe(4);
  });

  test("EC-001 recognises the conflict by code or message", () => {
    expect(isOccConflict(occ())).toBe(true);
    expect(isOccConflict(new Error('{"code":"OptimisticConcurrencyControlFailure","message":"…"}'))).toBe(true);
    expect(isOccConflict(new Error("Der Entwurf wurde zwischenzeitlich geändert."))).toBe(false);
  });
});
