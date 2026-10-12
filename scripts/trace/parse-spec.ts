import { ID_RE } from "./ids";

export type Priority = "MUST" | "SHOULD" | "COULD" | "WONT" | "CASE";

export interface Requirement {
  id: string;
  file: string;
  /** MUST for compliance rules, edge cases and invariants (no priority column); CASE for test vectors. */
  priority: Priority;
  /** Lowest phase number named in the Phase column (P0/P1 → 0); null if the table has no phase. */
  phase: number | null;
  title: string;
}

function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((c) => c.trim());
}

function clean(cell: string): string {
  return cell
    .replace(/[*`]/g, "")
    .replace(/~~.*?~~/g, "")
    .trim();
}

function parsePhase(cell: string | undefined): number | null {
  if (!cell) return null;
  const phases = [...cell.matchAll(/\bP(\d)\b/g)].map((m) => Number(m[1]));
  return phases.length ? Math.min(...phases) : null;
}

function parsePriority(cell: string | undefined, header: string[]): Priority {
  if (cell) {
    const m = /\b(MUST|SHOULD|COULD|WONT)\b/.exec(cell);
    if (m) return m[1] as Priority;
  }
  return header.includes("expected") ? "CASE" : "MUST";
}

/**
 * Extracts requirements from every markdown table whose first header cell is "ID".
 * User-story tables (US-…) are skipped. The first definition of an ID wins.
 */
export function parseSpec(file: string, markdown: string): Requirement[] {
  const out: Requirement[] = [];
  let header: string[] | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      header = null;
      continue;
    }
    const row = cells(line);
    if (/^:?-{2,}/.test(row[0] ?? "")) continue; // separator
    if (clean(row[0] ?? "").toLowerCase() === "id") {
      header = row.map((c) => clean(c).toLowerCase());
      continue;
    }
    if (!header || header.some((h) => h.startsWith("as "))) continue;
    const id = clean(row[0] ?? "");
    if (!ID_RE.test(id)) continue;
    const at = (name: string) => {
      const i = header?.indexOf(name) ?? -1;
      return i >= 0 ? row[i] : undefined;
    };
    out.push({
      id,
      file,
      priority: parsePriority(at("priority"), header),
      phase: parsePhase(at("phase")),
      title: clean(row[1] ?? "").slice(0, 80),
    });
  }
  return out;
}

export function mergeRegistry(lists: Requirement[][]): Map<string, Requirement> {
  const map = new Map<string, Requirement>();
  for (const list of lists) for (const r of list) if (!map.has(r.id)) map.set(r.id, r);
  return map;
}
