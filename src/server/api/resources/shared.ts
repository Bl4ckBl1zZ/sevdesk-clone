import "server-only";
import { z } from "zod";
import { decodeId, type IdTable } from "@/domain/api/ids";
import { parseExpand, parseInstant, prefixedId } from "@/domain/schemas/api/common";
import { ApiProblem } from "../http";

/** Path parameter `{id}` with the table's prefix; a wrong prefix answers 404 (never another table's record). */
export const idParams = (table: IdTable) => z.object({ id: prefixedId(table) });

export function rawId(table: IdTable, id: string): string {
  const raw = decodeId(table, id);
  if (!raw) throw new ApiProblem("not_found");
  return raw;
}

export function paginationOpts(q: { limit: number; cursor?: string | undefined }) {
  return { numItems: q.limit, cursor: q.cursor ?? null };
}

export function updatedSince(q: { updated_since?: string | undefined }): number | undefined {
  return q.updated_since ? (parseInstant(q.updated_since) ?? undefined) : undefined;
}

export function nextCursor(page: { isDone: boolean; continueCursor: string }): string | null {
  return page.isDone || !page.continueCursor ? null : page.continueCursor;
}

export function expandOf(value: string | undefined, allowed: readonly string[]): Set<string> {
  const r = parseExpand(value, allowed);
  if (!r.ok) {
    throw new ApiProblem("invalid_expand", {
      detail: `Unbekannter Wert „${r.unknown}". Erlaubt: ${allowed.join(", ")}.`,
      errors: [{ code: "invalid_expand", field: "expand", message: `Erlaubt: ${allowed.join(", ")}` }],
    });
  }
  return r.expand;
}

/** 05 §3 Concurrency: `If-Match: <version>` or a `version` field; missing → 422 with field `version`. */
export function requireVersion(ifMatch: string | null, bodyVersion: number | undefined): number {
  const fromHeader = ifMatch !== null && /^\d+$/.test(ifMatch) ? Number(ifMatch) : undefined;
  const v = fromHeader ?? bodyVersion;
  if (v === undefined) {
    throw new ApiProblem("validation_failed", {
      errors: [
        { code: "version_required", field: "version", message: "Bitte die Version (If-Match oder version) angeben." },
      ],
    });
  }
  return v;
}

export const versionField = z
  .number()
  .int()
  .min(1)
  .optional()
  .meta({ description: "Erwartete Version (alternativ Header If-Match)" });

export const expandQueryParam = (allowed: readonly string[]) =>
  z
    .string()
    .optional()
    .meta({ description: `Kommagetrennt: ${allowed.join(", ")}` });
