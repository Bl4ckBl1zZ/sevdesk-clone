/**
 * F06 INB-009 split / merge of inbox items (GOBD-08). Pure.
 *
 * The originals are never altered or removed: a split or merge creates NEW inbox items whose file entries are copies
 * of the source entries (same storage blob, same SHA-256, same capture metadata) and marks the sources `superseded`
 * (kept, linked both ways, audited). Only `derivedFrom` is re-indexed into the new item's file list.
 *
 * Split unit = a file with role `original` (an upload or an e-mail attachment); its derived files (XML of a hybrid
 * PDF, embedded attachments) follow it, and the archived .eml goes with every part so each keeps its Zugang context.
 */
import { err, type Issue, issue, ok, type Result } from "../result";
import type { InboxStatus } from "./status";

export const SPLIT_MERGE_MESSAGES = {
  state: "Nur offene Posteingangsbelege können aufgeteilt oder zusammengeführt werden.",
  booked: "Der zugehörige Beleg ist bereits gebucht – Aufteilen/Zusammenführen ist nicht mehr möglich.",
  emlPending: "Die E-Mail wird noch verarbeitet. Bitte kurz warten.",
  splitOne: "Zum Aufteilen braucht der Beleg mindestens zwei Dateien.",
  splitGroups: "Bitte jede Datei genau einem von mindestens zwei Teilen zuordnen.",
  mergeTwo: "Bitte mindestens zwei Posteingangsbelege zum Zusammenführen auswählen.",
  mergeMax: "Höchstens 10 Posteingangsbelege auf einmal zusammenführen.",
} as const;

export const MERGE_MAX = 10;

export interface SplittableFile {
  role: string;
  derivedFrom?: number;
}

type SplitIssue = Issue<"split_merge">;
const fail = (message: string) => err(issue("split_merge", message));

/** Statuses from which an item can be split or merged; null = allowed, else the German reason. */
export function canSplitOrMerge(input: {
  status: InboxStatus;
  voucherStatus?: string;
  /** The .eml has not been unpacked yet (attachments not known). */
  emlPending: boolean;
}): string | null {
  if (input.status !== "new" && input.status !== "needs_review" && input.status !== "duplicate") {
    return SPLIT_MERGE_MESSAGES.state;
  }
  if (input.voucherStatus !== undefined && input.voucherStatus !== "draft") return SPLIT_MERGE_MESSAGES.booked;
  if (input.emlPending) return SPLIT_MERGE_MESSAGES.emlPending;
  return null;
}

/** Indexes of the split units (role `original`). */
export function splitParts(files: readonly SplittableFile[]): number[] {
  return files.flatMap((f, i) => (f.role === "original" ? [i] : []));
}

/** The unit a derived file belongs to (follows `derivedFrom` up to an `original`); undefined for the .eml. */
function unitOf(files: readonly SplittableFile[], i: number): number | undefined {
  let cur: number | undefined = i;
  for (let guard = 0; cur !== undefined && guard < files.length; guard++) {
    const file: SplittableFile | undefined = files[cur];
    if (!file) return undefined;
    if (file.role === "original") return cur;
    if (file.role === "eml") return undefined;
    cur = file.derivedFrom;
  }
  return undefined;
}

/** Copies `pick` (indexes into `files`, ascending) and re-indexes `derivedFrom` into the new list. */
function copySubset<F extends SplittableFile>(files: readonly F[], pick: readonly number[]): F[] {
  const map = new Map(pick.map((src, dst) => [src, dst]));
  return pick.map((src) => {
    const file = files[src] as F;
    if (file.derivedFrom === undefined) return { ...file };
    const to = map.get(file.derivedFrom);
    const { derivedFrom: _drop, ...rest } = file;
    return (to === undefined ? rest : { ...rest, derivedFrom: to }) as F;
  });
}

/** INB-009 split: `groups` = unit indexes per new item (≥ 2 groups, every unit exactly once). */
export function splitFiles<F extends SplittableFile>(
  files: readonly F[],
  groups: readonly (readonly number[])[],
): Result<F[][], SplitIssue> {
  const parts = splitParts(files);
  if (parts.length < 2) return fail(SPLIT_MERGE_MESSAGES.splitOne);
  const seen = new Set<number>();
  for (const g of groups) {
    if (g.length === 0) return fail(SPLIT_MERGE_MESSAGES.splitGroups);
    for (const i of g) {
      if (!parts.includes(i) || seen.has(i)) return fail(SPLIT_MERGE_MESSAGES.splitGroups);
      seen.add(i);
    }
  }
  if (groups.length < 2 || seen.size !== parts.length) return fail(SPLIT_MERGE_MESSAGES.splitGroups);
  const eml = files.flatMap((f, i) => (f.role === "eml" ? [i] : []));
  return ok(
    groups.map((g) => {
      const units = new Set(g);
      const pick = files.flatMap((_, i) => {
        if (eml.includes(i)) return [i];
        const u = unitOf(files, i);
        return u !== undefined && units.has(u) ? [i] : [];
      });
      return copySubset(files, pick);
    }),
  );
}

/** INB-009 merge: the files of all items in the given order (e.g. front, then back), `derivedFrom` shifted. */
export function mergeFiles<F extends SplittableFile>(items: readonly (readonly F[])[]): Result<F[], SplitIssue> {
  if (items.length < 2) return fail(SPLIT_MERGE_MESSAGES.mergeTwo);
  if (items.length > MERGE_MAX) return fail(SPLIT_MERGE_MESSAGES.mergeMax);
  const out: F[] = [];
  for (const files of items) {
    const offset = out.length;
    for (const file of files) {
      out.push(file.derivedFrom === undefined ? { ...file } : { ...file, derivedFrom: file.derivedFrom + offset });
    }
  }
  return ok(out);
}
