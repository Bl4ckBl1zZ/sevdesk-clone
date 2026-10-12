import { afterEach } from "vitest";
import { assertInvariants, clearInvariantTarget } from "./invariants";

// 07-testing §5a: assertInvariants() after every Convex and integration test.
afterEach(async () => {
  try {
    await assertInvariants();
  } finally {
    clearInvariantTarget();
  }
});
