/** Shared E-IMP-24 deduplication of parsed import records (F09 §5.3). */
import type { ImportFinding } from "./types";

/** E-IMP-24: same key twice — identical content counts once, different content blocks all copies. */
export function dedupe<T extends { key: string; fingerprint: string; rowRef: string; line: number; fileId: string }>(
  items: readonly T[],
  label: (t: T) => string,
  findings: ImportFinding[],
  fileName: (id: string) => string,
): { kept: T[]; conflicted: Set<string>; dropped: number } {
  const byKey = new Map<string, T[]>();
  for (const i of items) byKey.set(i.key, [...(byKey.get(i.key) ?? []), i]);
  const kept: T[] = [];
  const conflicted = new Set<string>();
  let dropped = 0;
  for (const group of byKey.values()) {
    const first = group[0] as T;
    if (group.every((g) => g.fingerprint === first.fingerprint)) {
      kept.push(first);
      dropped += group.length - 1;
      continue;
    }
    const files = [...new Set(group.map((g) => fileName(g.fileId)))].join(", ");
    for (const g of group) {
      conflicted.add(g.rowRef);
      findings.push({
        code: "E-IMP-24",
        severity: "error",
        message: `${label(g)} ist mehrfach mit unterschiedlichen Werten enthalten (${files}).`,
        fileId: g.fileId,
        fileName: fileName(g.fileId),
        line: g.line,
        rowRef: g.rowRef,
        key: g.key,
      });
      kept.push(g);
    }
  }
  return { kept, conflicted, dropped };
}
