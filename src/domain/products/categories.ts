/**
 * Product categories (F03 PRD-060/061/084, §5.3): a tree of at most 3 levels, names 1–60 chars unique among
 * siblings; deleting a category with content moves products and children to the parent (or none), never orphans.
 */
import { type FieldIssue, fieldIssue } from "../contacts/core";

export const MAX_CATEGORY_DEPTH = 3;
export const SEED_CATEGORIES = ["Dienstleistungen", "Waren"] as const;

export interface CategoryNode {
  readonly id: string;
  readonly name: string;
  readonly parentId?: string | undefined;
}

/** Depth of a node (root = 1); cycle-safe. */
export function depthOf(id: string | undefined, all: readonly CategoryNode[]): number {
  const byId = new Map(all.map((c) => [c.id, c]));
  let depth = 0;
  const seen = new Set<string>();
  for (
    let cur = id ? byId.get(id) : undefined;
    cur && !seen.has(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  ) {
    seen.add(cur.id);
    depth++;
  }
  return depth;
}

/** Height of the subtree below `id` (a leaf = 1). */
function subtreeHeight(id: string, all: readonly CategoryNode[]): number {
  const children = all.filter((c) => c.parentId === id);
  return 1 + Math.max(0, ...children.map((c) => subtreeHeight(c.id, all)));
}

/** Full path "Waren > Kabel" of a category. */
export function categoryPath(id: string | undefined, all: readonly CategoryNode[]): string {
  const byId = new Map(all.map((c) => [c.id, c]));
  const names: string[] = [];
  const seen = new Set<string>();
  for (
    let cur = id ? byId.get(id) : undefined;
    cur && !seen.has(cur.id);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  ) {
    seen.add(cur.id);
    names.unshift(cur.name);
  }
  return names.join(" > ");
}

const sameName = (a: string, b: string) => a.trim().toLocaleLowerCase("de") === b.trim().toLocaleLowerCase("de");

/** §5.1/§5.3: name, sibling uniqueness, depth ≤ 3 (incl. the subtree when moving), no cycles. */
export function validateCategory(
  input: { id?: string; name: string; parentId?: string | undefined },
  all: readonly CategoryNode[],
): FieldIssue | null {
  const name = input.name.trim();
  if (name.length === 0 || name.length > 60) {
    return fieldIssue("name", "CATEGORY_NAME_INVALID", "Der Kategoriename muss 1 bis 60 Zeichen lang sein.");
  }
  if (input.parentId && input.id) {
    const byId = new Map(all.map((c) => [c.id, c]));
    for (let cur = byId.get(input.parentId); cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
      if (cur.id === input.id) {
        return fieldIssue(
          "parentId",
          "CATEGORY_CYCLE",
          "Eine Kategorie kann nicht unter sich selbst einsortiert werden.",
        );
      }
    }
  }
  const siblings = all.filter((c) => (c.parentId ?? undefined) === (input.parentId || undefined) && c.id !== input.id);
  if (siblings.some((s) => sameName(s.name, name))) {
    return fieldIssue("name", "CATEGORY_DUPLICATE", "Diese Kategorie existiert auf dieser Ebene bereits.");
  }
  const height = input.id ? subtreeHeight(input.id, all) : 1;
  if (depthOf(input.parentId, all) + height > MAX_CATEGORY_DEPTH) {
    return fieldIssue("parentId", "CATEGORY_DEPTH", "Kategorien können höchstens 3 Ebenen tief sein.");
  }
  return null;
}

/**
 * PRD-061 / T-PRD-043: deleting a category with products or children needs a target ("parent" or "none"); returns the
 * new parent of the moved children and the new category of the moved products.
 */
export function planCategoryDelete(
  id: string,
  all: readonly CategoryNode[],
  productCount: number,
  target: "parent" | "none" | undefined,
): { error: FieldIssue } | { moveTo: string | undefined; children: string[] } {
  const node = all.find((c) => c.id === id);
  const children = all.filter((c) => c.parentId === id).map((c) => c.id);
  if ((children.length > 0 || productCount > 0) && !target) {
    return {
      error: fieldIssue(
        "target",
        "CATEGORY_NOT_EMPTY",
        "Bitte wählen, wohin Produkte und Unterkategorien verschoben werden.",
      ),
    };
  }
  return { moveTo: target === "parent" ? node?.parentId : undefined, children };
}

/**
 * PRD-084 / T-PRD-041: "Waren > Kabel" → path segments, creating missing levels (max depth 3). Returns the segments
 * still to create below the deepest existing match, or the depth error.
 */
export function resolveCategoryPath(
  path: string,
  all: readonly CategoryNode[],
): { error: FieldIssue } | { existingId: string | undefined; toCreate: string[] } {
  const parts = path
    .split(">")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > MAX_CATEGORY_DEPTH) {
    return { error: fieldIssue("category", "CATEGORY_DEPTH", "Kategorien können höchstens 3 Ebenen tief sein.") };
  }
  let parent: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const hit = all.find((c) => (c.parentId ?? undefined) === parent && sameName(c.name, parts[i] as string));
    if (!hit) return { existingId: parent, toCreate: parts.slice(i) };
    parent = hit.id;
  }
  return { existingId: parent, toCreate: [] };
}
