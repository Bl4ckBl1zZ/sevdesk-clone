/**
 * 10 EC-001 „OCC retry“: every audited write appends to the single hash-chained audit log (and the journal), so
 * concurrent finalisations conflict on its head. Convex retries a conflicting mutation itself but gives up under
 * sustained contention; the action then retries the whole commit with jittered backoff. Safe: a failed mutation
 * committed nothing (no number consumed), and the commit is idempotent for an already finalised version.
 */
const OCC = /OptimisticConcurrencyControlFailure|changed while this mutation was being run/;

export function isOccConflict(e: unknown): boolean {
  if ((e as { data?: { code?: string } } | null)?.data?.code) return false; // domain errors never heal by retrying
  return OCC.test(e instanceof Error ? e.message : String(e));
}

export async function withOccRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 12;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= attempts || !isOccConflict(e)) throw e;
      await sleep(Math.round(Math.min(50 * 2 ** attempt, 2_000) * (0.5 + Math.random())));
    }
  }
}
