import { internal } from "../convex/_generated/api";

/**
 * Runtime invariants (docs/spec/10-edge-cases.md, RI-*), checked after every Convex and integration test
 * (07-testing §5a). The checks themselves run server-side in the paged action `internal.invariants.run`
 * (convex/invariants.ts, convex/model/invariants.ts) so convex-test, the real backend and the nightly job share one
 * implementation and the check keeps working on a backend that has accumulated a lot of data.
 *
 * Tests register the backend under test with `useInvariantTarget(target)` (`makeT()` does it automatically);
 * the afterEach hook in test/setup-invariants.ts asserts. A test that tampers with data on purpose calls
 * `clearInvariantTarget()` when done.
 *
 * Implemented (P0): RI-14 (audit chain complete, head contains the latest checkpoint), RI-15 (every state change
 * audited: replaying audit diffs reproduces every record — also catches changes to frozen records).
 * P1: RI-11 (cash never negative in (date, seq) order), RI-12 (journal gapless, balanced, sourced, mirrored lines).
 */
export type InvariantSeverity = "ERROR" | "WARN";

export interface InvariantViolation {
  id: `RI-${string}`;
  severity: InvariantSeverity;
  message: string;
}

/** Anything that can run an internal action: a convex-test instance or an admin `ConvexHttpClient`. */
export interface InvariantTarget {
  action: (ref: typeof internal.invariants.run, args: Record<string, never>) => Promise<InvariantViolation[]>;
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
  return target.action(internal.invariants.run, {});
}

export async function assertInvariants(target: InvariantTarget | undefined = current): Promise<void> {
  if (target === undefined) return;
  const errors = (await checkInvariants(target)).filter((v) => v.severity === "ERROR");
  if (errors.length > 0) {
    throw new Error(`Invariant violations:\n${errors.map((v) => `  ${v.id}: ${v.message}`).join("\n")}`);
  }
}
