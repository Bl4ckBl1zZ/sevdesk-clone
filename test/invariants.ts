import { internal } from "../convex/_generated/api";

/**
 * Runtime invariants (docs/spec/10-edge-cases.md, RI-*), checked after every Convex and integration test
 * (07-testing §5a). The checks themselves run server-side in `internal.invariants.check`
 * (convex/model/invariants.ts) so convex-test, the real backend and the nightly job share one implementation.
 *
 * Tests register the backend under test with `useInvariantTarget(target)` (`makeT()` does it automatically);
 * the afterEach hook in test/setup-invariants.ts asserts. A test that tampers with data on purpose calls
 * `clearInvariantTarget()` when done.
 *
 * Implemented (P0): RI-14 (audit chain complete, head contains the latest checkpoint), RI-15 (every state change
 * audited: replaying audit diffs reproduces every record — also catches changes to frozen records).
 */
export type InvariantSeverity = "ERROR" | "WARN";

export interface InvariantViolation {
  id: `RI-${string}`;
  severity: InvariantSeverity;
  message: string;
}

/** Anything that can run an internal query: a convex-test instance or an admin `ConvexHttpClient`. */
export interface InvariantTarget {
  query: (ref: typeof internal.invariants.check, args: Record<string, never>) => Promise<InvariantViolation[]>;
}

let current: InvariantTarget | undefined;

export function useInvariantTarget(target: InvariantTarget): void {
  current = target;
}

export function clearInvariantTarget(): void {
  current = undefined;
}

export function currentInvariantTarget(): InvariantTarget | undefined {
  return current;
}

export async function checkInvariants(target: InvariantTarget): Promise<InvariantViolation[]> {
  return target.query(internal.invariants.check, {});
}

export async function assertInvariants(target: InvariantTarget | undefined = current): Promise<void> {
  if (target === undefined) return;
  const errors = (await checkInvariants(target)).filter((v) => v.severity === "ERROR");
  if (errors.length > 0) {
    throw new Error(`Invariant violations:\n${errors.map((v) => `  ${v.id}: ${v.message}`).join("\n")}`);
  }
}
