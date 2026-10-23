"use client";

import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, selectClass } from "@/components/catalog/shared";
import { Label } from "@/components/ui/label";
import type { InboxDetail } from "./inbox-item";

/**
 * INB-009 „Aufteilen“ / „Zusammenführen“. The originals stay unchanged on the old item (GOBD-08); the new items get
 * copies of the file entries with the same hashes. Split assigns each file with role `original` to a part; merge
 * appends the chosen items after the current one (e.g. front, then back).
 */

export interface MergeCandidate {
  id: string;
  label: string;
}

export const SPLIT_MERGE_OPEN = ["new", "needs_review", "duplicate"] as const;

export function SplitDialog({
  item,
  onClose,
  onSplit,
}: {
  item: InboxDetail;
  onClose: () => void;
  onSplit: (groups: number[][]) => Promise<void>;
}) {
  const t = useTranslations("inbox.split");
  const id = useId();
  const originals = item.files.filter((f) => f.role === "original");
  const [part, setPart] = useState<Record<number, number>>(() =>
    Object.fromEntries(originals.map((f, i) => [f.index, i])),
  );
  const groups = originals
    .map((_, p) => originals.filter((f) => part[f.index] === p).map((f) => f.index))
    .filter((g) => g.length > 0);
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm", { count: groups.length })}
      confirmDisabled={groups.length < 2}
      onClose={onClose}
      onConfirm={() => onSplit(groups)}
    >
      <ul className="flex flex-col gap-2" data-testid="split-files">
        {originals.map((f) => (
          <li key={f.index} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <Label htmlFor={`${id}-${f.index}`} className="min-w-0 break-all font-normal">
              {f.name}
            </Label>
            <select
              id={`${id}-${f.index}`}
              className={`${selectClass} w-auto`}
              value={part[f.index] ?? 0}
              onChange={(e) => setPart((p) => ({ ...p, [f.index]: Number(e.target.value) }))}
            >
              {originals.map((_, p) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: parts are numbered positions.
                <option key={p} value={p}>
                  {t("part", { n: p + 1 })}
                </option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}

export function MergeDialog({
  candidates,
  onClose,
  onMerge,
}: {
  candidates: readonly MergeCandidate[];
  onClose: () => void;
  onMerge: (ids: string[]) => Promise<void>;
}) {
  const t = useTranslations("inbox.merge");
  const id = useId();
  const [chosen, setChosen] = useState<string[]>([]);
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      confirmDisabled={chosen.length === 0}
      onClose={onClose}
      onConfirm={() => onMerge(candidates.filter((c) => chosen.includes(c.id)).map((c) => c.id))}
    >
      {candidates.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("none")}</p>
      ) : (
        <ul className="flex max-h-72 flex-col gap-2 overflow-auto" data-testid="merge-candidates">
          {candidates.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm">
              <input
                id={`${id}-${c.id}`}
                type="checkbox"
                className="size-5"
                checked={chosen.includes(c.id)}
                onChange={(e) => setChosen((s) => (e.target.checked ? [...s, c.id] : s.filter((x) => x !== c.id)))}
              />
              <Label htmlFor={`${id}-${c.id}`} className="min-w-0 break-words font-normal">
                {c.label}
              </Label>
            </li>
          ))}
        </ul>
      )}
    </ConfirmDialog>
  );
}

/** „Aufgeteilt in …“ / „Entstanden aus …“ links (INB-009). */
export function SplitMergeLinks({ item }: { item: InboxDetail }) {
  const t = useTranslations("inbox.splitMerge");
  const rows: { key: string; ids: readonly string[] }[] = [];
  if (item.supersededBy)
    rows.push({ key: `supersededBy.${item.supersededBy.kind}`, ids: item.supersededBy.inboxItemIds });
  if (item.createdFrom) rows.push({ key: `createdFrom.${item.createdFrom.kind}`, ids: item.createdFrom.inboxItemIds });
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1 text-sm" data-testid="split-merge-links">
      {rows.map((r) => (
        <p key={r.key} className="flex flex-wrap gap-x-2">
          <span className="text-muted-foreground">{t(r.key as never)}</span>
          {r.ids.map((id, i) => (
            <Link key={id} href={`/posteingang?id=${id}` as Route} className="underline">
              {t("item", { n: i + 1 })}
            </Link>
          ))}
        </p>
      ))}
    </div>
  );
}
