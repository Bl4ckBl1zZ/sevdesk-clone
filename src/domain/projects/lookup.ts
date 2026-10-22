/**
 * Project lookup for natural-language logging (F11 §7 `time_entry_log`, E-PRJ-21/22). Pure.
 *
 * Order: project ID → exact number → exact name → name/number containing the input. Archived projects are only
 * considered when no active/done project matches (logging to them is then blocked with E-PRJ-21 by the caller).
 * More than one match → structured error with at most five candidates.
 */
import { foldSearch } from "../contacts/core";
import { err, type Issue, issue, ok, type Result } from "../result";

export const MAX_PROJECT_CANDIDATES = 5;

export interface ProjectRefRow {
  readonly id: string;
  readonly number: string;
  readonly name: string;
  readonly status: "active" | "done" | "archived";
}

export interface ProjectCandidate {
  readonly id: string;
  readonly number: string;
  readonly name: string;
}

export type ProjectRefIssue = Issue<"project_ambiguous" | "project_not_found"> & {
  readonly candidates: readonly ProjectCandidate[];
};

const label = (p: ProjectRefRow) => `${p.number} ${p.name}`;
const candidate = (p: ProjectRefRow): ProjectCandidate => ({ id: p.id, number: p.number, name: p.name });

/** E-PRJ-22 texts. */
export const projectAmbiguousText = (input: string, list: readonly ProjectRefRow[]): string =>
  `Projekt „${input}“ ist nicht eindeutig: ${list.slice(0, MAX_PROJECT_CANDIDATES).map(label).join(", ")}. Bitte project_id angeben.`;
export const projectNotFoundText = (input: string): string =>
  `Projekt „${input}“ nicht gefunden. Bitte project_id oder die Projektnummer angeben.`;

export function resolveProjectRef(
  input: string,
  projects: readonly ProjectRefRow[],
): Result<ProjectRefRow, ProjectRefIssue> {
  const raw = input.trim();
  const byId = projects.find((p) => p.id === raw);
  if (byId) return ok(byId);
  const q = foldSearch(raw);
  const pick = (matches: readonly ProjectRefRow[]): Result<ProjectRefRow, ProjectRefIssue> | null => {
    const live = matches.filter((p) => p.status !== "archived");
    const pool = live.length > 0 ? live : matches;
    if (pool.length === 1) return ok(pool[0] as ProjectRefRow);
    if (pool.length > 1) {
      const sorted = [...pool].sort((a, b) => a.number.localeCompare(b.number));
      return err({
        ...issue("project_ambiguous", projectAmbiguousText(raw, sorted)),
        candidates: sorted.slice(0, MAX_PROJECT_CANDIDATES).map(candidate),
      });
    }
    return null;
  };
  if (!q) return err({ ...issue("project_not_found", projectNotFoundText(raw)), candidates: [] });
  return (
    pick(projects.filter((p) => foldSearch(p.number) === q)) ??
    pick(projects.filter((p) => foldSearch(p.name) === q)) ??
    pick(projects.filter((p) => foldSearch(p.name).includes(q) || foldSearch(p.number).includes(q))) ??
    err({ ...issue("project_not_found", projectNotFoundText(raw)), candidates: [] })
  );
}
