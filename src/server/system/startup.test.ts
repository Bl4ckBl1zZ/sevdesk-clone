import { describe, expect, test, vi } from "vitest";
import { enforceStartupSecrets } from "./startup";

describe("web start in production (AUD-021, SEC-01)", () => {
  test("E-AUD-20 production without APP_ENCRYPTION_KEY / JWT_PRIVATE_KEY_PEM logs each variable and exits", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(enforceStartupSecrets({ NODE_ENV: "production", JWT_PRIVATE_KEY_PEM: "pem" }, { exit, log })).toBe(false);
    expect(log).toHaveBeenCalledWith("APP_ENCRYPTION_KEY fehlt – Start im Produktivmodus verweigert (SEC-01).");
    expect(log).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  test("E-AUD-20 a complete production env, the build phase and development starts pass", () => {
    const exit = vi.fn();
    const log = vi.fn();
    expect(
      enforceStartupSecrets(
        { NODE_ENV: "production", JWT_PRIVATE_KEY_PEM: "pem", APP_ENCRYPTION_KEY: "k" },
        { exit, log },
      ),
    ).toBe(true);
    expect(enforceStartupSecrets({ NODE_ENV: "production", NEXT_PHASE: "phase-production-build" }, { exit, log })).toBe(
      true,
    );
    expect(enforceStartupSecrets({ NODE_ENV: "development" }, { exit, log })).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
