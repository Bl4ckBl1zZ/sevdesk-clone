/**
 * Runtime invariants (docs/spec/10-edge-cases.md, RI-*). P0 stub.
 *
 * `assertInvariants()` must run after every Convex, integration and E2E test and fail the test on any
 * ERROR-level violation (07-testing §5a). Tests register the backend under test with
 * `useInvariantTarget(t)`; the afterEach hook in test/setup-invariants.ts checks it.
 *
 * TODO(P0, RI-*): implement the checks (gapless numbering, journal balance, cash never negative, audit
 * hash chain, …) as queries against the target. Until then this is a no-op.
 */
export type InvariantSeverity = "ERROR" | "WARN";

export interface InvariantViolation {
  id: `RI-${string}`;
  severity: InvariantSeverity;
  message: string;
}

/** Anything the checks can query: a convex-test instance or a real-backend client. */
export type InvariantTarget = unknown;

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

export async function checkInvariants(_target: InvariantTarget): Promise<InvariantViolation[]> {
  return [];
}

export async function assertInvariants(target: InvariantTarget = current): Promise<void> {
  if (target === undefined) return;
  const errors = (await checkInvariants(target)).filter((v) => v.severity === "ERROR");
  if (errors.length > 0) {
    throw new Error(`Invariant violations:\n${errors.map((v) => `  ${v.id}: ${v.message}`).join("\n")}`);
  }
}
