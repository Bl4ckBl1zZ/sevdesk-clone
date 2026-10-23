/**
 * F04 DOC-36 „Letztes Dokument übernehmen“: on a new, empty draft with a chosen contact the editor offers to copy
 * the lines and texts of that contact's last document of the same type. Only content is copied (lines, subject,
 * head/foot text, delivery terms) — dates, references, chain links and line periods are dropped like on „Duplizieren“
 * (DOC-35). Pure.
 */
import type { DraftValues } from "../schemas/documents";
import { type DuplicateSource, duplicateValues } from "./duplicate";

export interface LastDocumentContent {
  readonly lines: DraftValues["lines"];
  readonly subject?: string;
  readonly headText?: string;
  readonly footText?: string;
  readonly deliveryTerms?: string;
}

/** Content to copy; null for documents that cannot be a source (Storno, corrections, reminders). */
export function lastDocumentContent(src: DuplicateSource): LastDocumentContent | null {
  const r = duplicateValues(src);
  if (!r.ok) return null;
  const v = r.values;
  return {
    lines: v.lines,
    ...(v.subject ? { subject: v.subject } : {}),
    ...(v.headText ? { headText: v.headText } : {}),
    ...(v.footText ? { footText: v.footText } : {}),
    ...(v.deliveryTerms ? { deliveryTerms: v.deliveryTerms } : {}),
  };
}

const SKIPPED: ReadonlySet<string> = new Set(["draft", "cancelled", "withdrawn"]);

/** Newest issued document (document date, then creation); drafts and cancelled/withdrawn documents are skipped. */
export function pickLastDocument<T extends { status: string; documentDate?: string | undefined; createdAt: number }>(
  docs: readonly T[],
): T | null {
  let best: T | null = null;
  for (const d of docs) {
    if (SKIPPED.has(d.status)) continue;
    if (
      !best ||
      (d.documentDate ?? "") > (best.documentDate ?? "") ||
      ((d.documentDate ?? "") === (best.documentDate ?? "") && d.createdAt > best.createdAt)
    )
      best = d;
  }
  return best;
}
