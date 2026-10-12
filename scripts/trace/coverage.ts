import { isAdHocId, isAnnotationId } from "./ids";
import type { Requirement } from "./parse-spec";
import type { TestRef } from "./scan-tests";

export interface Coverage {
  /** Spec ID → tests. A test naming a test case (T-SET-005) also covers the IDs in that row's "Covers" column. */
  testsById: Map<string, TestRef[]>;
  /** IDs named by tests that appear in no spec table (typos, invented IDs). */
  unknown: string[];
}

export function buildCoverage(registry: Map<string, Requirement>, refs: TestRef[]): Coverage {
  const testsById = new Map<string, TestRef[]>();
  const add = (id: string, ref: TestRef) => {
    const list = testsById.get(id) ?? [];
    if (!list.includes(ref)) list.push(ref);
    testsById.set(id, list);
  };
  const unknown = new Set<string>();
  for (const ref of refs) {
    if (isAnnotationId(ref.id)) continue;
    const entry = registry.get(ref.id);
    if (!entry) {
      if (!isAdHocId(ref.id)) unknown.add(ref.id);
      continue;
    }
    if (ref.todo) continue;
    add(ref.id, ref);
    if (entry.kind === "test-case") for (const id of entry.covers) if (registry.has(id)) add(id, ref);
  }
  return { testsById, unknown: [...unknown] };
}
