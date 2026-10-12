import { ID_RE, ID_SOURCE } from "./ids";

export type Priority = "MUST" | "SHOULD" | "COULD" | "WONT" | "CASE";

/**
 * requirement: feature/compliance requirement rows (`| ID | Requirement | Priority | Phase |`, `| ID | Rule | …`).
 * edge-case:   edge-case and error rows (`| ID | Scenario | …`, `| ID | Situation | …`, `| # | Case | …` with E-… IDs).
 * test-case:   feature test-case rows (`| Test ID | … | Covers req IDs |`) and test vectors (`| ID | Input | Expected |`).
 */
export type Kind = "requirement" | "edge-case" | "test-case";

export interface Requirement {
  id: string;
  file: string;
  kind: Kind;
  /** MUST for compliance rules, edge cases and invariants (no priority column); CASE for test cases and vectors. */
  priority: Priority;
  /** Lowest phase number named in the Phase column (P0/P1 → 0); null if the table has no phase. */
  phase: number | null;
  title: string;
  /** Test cases: the IDs listed in the "Covers" column (resolved against the registry by the caller). */
  covers: string[];
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

function parsePriority(cell: string | undefined): Priority | null {
  const m = cell ? /\b(MUST|SHOULD|COULD|WONT)\b/.exec(cell) : null;
  return m ? (m[1] as Priority) : null;
}

const COVERS_ID_RE = new RegExp(`(?<![A-Za-z0-9-])${ID_SOURCE}(?![A-Za-z0-9-])`, "g");

/** Table kind from the cleaned, lower-cased header; null for tables that define no traceable IDs. */
function tableKind(header: string[]): Kind | null {
  const [first, second = ""] = header;
  if (first === "test id") return "test-case";
  if (first === "id") {
    if (header.some((h) => h.startsWith("as "))) return null; // user stories
    if (header.includes("expected")) return "test-case";
    if (["scenario", "situation", "case"].includes(second)) return "edge-case";
    return "requirement";
  }
  // Feature-local edge-case/error tables: | # | Case | Behaviour | Message (DE) |
  if (first === "#" && second === "case") return "edge-case";
  return null;
}

/**
 * Extracts requirement, edge-case and test-case rows from the spec tables (see `Kind`).
 * User stories, data-model changes (D-…) and open questions (Q-…) are skipped. The first definition of an ID wins.
 */
export function parseSpec(file: string, markdown: string): Requirement[] {
  const out: Requirement[] = [];
  let header: string[] | null = null;
  let kind: Kind | null = null;
  for (const raw of markdown.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) {
      header = null;
      kind = null;
      continue;
    }
    const row = cells(line);
    if (/^:?-{2,}/.test(row[0] ?? "")) continue; // separator
    if (!header) {
      header = row.map((c) => clean(c).toLowerCase());
      kind = tableKind(header);
      continue;
    }
    if (!kind) continue;
    const id = clean(row[0] ?? "");
    if (!ID_RE.test(id)) continue;
    const at = (pred: (h: string) => boolean) => {
      const i = header?.findIndex(pred) ?? -1;
      return i >= 0 ? row[i] : undefined;
    };
    const coversCell = kind === "test-case" ? at((h) => h.startsWith("covers")) : undefined;
    out.push({
      id,
      file,
      kind,
      priority: kind === "test-case" ? "CASE" : (parsePriority(at((h) => h === "priority")) ?? "MUST"),
      phase: kind === "test-case" ? null : parsePhase(at((h) => h === "phase")),
      title: clean(row[1] ?? "").slice(0, 80),
      covers: coversCell ? [...new Set(clean(coversCell).match(COVERS_ID_RE) ?? [])].filter((c) => c !== id) : [],
    });
  }
  return out;
}

export function mergeRegistry(lists: Requirement[][]): Map<string, Requirement> {
  const map = new Map<string, Requirement>();
  for (const list of lists) for (const r of list) if (!map.has(r.id)) map.set(r.id, r);
  return map;
}
