"use client";

import { api } from "@convex/_generated/api";
import type { Doc, Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useDeferredValue, useId, useState } from "react";
import { ConfirmDialog, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DUPLICATE_REASON_LABELS } from "@/domain/contacts/duplicates";
import { MERGE_FIELD_LABELS, MERGE_FIELDS, type MergeField } from "@/domain/contacts/merge";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/** CON-131: possible duplicates with „Kein Duplikat“ and the merge dialog (CON-132…135). */
export function DuplicatesPanel() {
  return (
    <ConvexGuard fallback={<div className="h-64" aria-busy="true" />}>
      <DuplicatesInner />
    </ConvexGuard>
  );
}

function DuplicatesInner() {
  const t = useTranslations("contacts.duplicates");
  const pairs = useAuthedQuery(api.contacts.duplicates, {});
  const run = useRun();
  const dismiss = useMutation(api.contacts.dismissDuplicate);
  const canMerge = useCan("contacts.merge");
  const [merging, setMerging] = useState<{
    a: Id<"contacts">;
    b: Id<"contacts">;
    kind: Doc<"contacts">["kind"];
  } | null>(null);
  if (pairs === undefined) return <div className="h-64" aria-busy="true" />;
  if (pairs.length === 0) return <EmptyState title={t("empty")} />;
  return (
    <>
      <ul className="flex flex-col gap-3">
        {pairs.map((p) => (
          <li key={`${p.a._id}-${p.b._id}`} className="flex flex-col gap-2 rounded-xl border p-4 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium">
                <Link href={`/kontakte/${p.a._id}` as Route} className="underline">
                  {p.a.displayName} ({p.a.number})
                </Link>{" "}
                ↔{" "}
                <Link href={`/kontakte/${p.b._id}` as Route} className="underline">
                  {p.b.displayName} ({p.b.number})
                </Link>
              </p>
              <Badge variant="outline">
                {t("score")}: {Math.round(p.score * 100)} %
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {t("reasons")}:{" "}
              {p.reasons.map((r) => DUPLICATE_REASON_LABELS[r as keyof typeof DUPLICATE_REASON_LABELS] ?? r).join(", ")}
            </p>
            <div className="flex flex-wrap gap-2">
              {canMerge && p.a.kind === p.b.kind && (
                <Button className="h-11 md:h-9" onClick={() => setMerging({ a: p.a._id, b: p.b._id, kind: p.a.kind })}>
                  {t("merge")}
                </Button>
              )}
              <Button
                variant="outline"
                className="h-11 md:h-9"
                onClick={() => void run(() => dismiss({ a: p.a._id, b: p.b._id }), t("dismissed"))}
              >
                {t("dismiss")}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {merging && (
        <MergeDialog winnerId={merging.a} loserId={merging.b} kind={merging.kind} onClose={() => setMerging(null)} />
      )}
    </>
  );
}

function show(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "boolean") return v ? "Ja" : "Nein";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if ("dueDays" in o) return `${o.dueDays} Tage`;
    if ("value" in o) return String(o.value);
    return JSON.stringify(v);
  }
  return String(v);
}

/** Merge dialog: pick the second contact (if not given), choose the winner and per-field values, then confirm. */
export function MergeDialog({
  winnerId,
  loserId,
  kind,
  onClose,
}: {
  winnerId: Id<"contacts">;
  loserId?: Id<"contacts">;
  kind: Doc<"contacts">["kind"];
  onClose: () => void;
}) {
  const t = useTranslations("contacts.duplicates");
  const router = useRouter();
  const run = useRun();
  const merge = useMutation(api.contacts.merge);
  const [pair, setPair] = useState<{ winner: Id<"contacts">; loser: Id<"contacts"> | null }>({
    winner: winnerId,
    loser: loserId ?? null,
  });
  const [q, setQ] = useState("");
  const query = useDeferredValue(q);
  const searchId = useId();
  const options = useAuthedQuery(api.contacts.options, { kind, ...(query ? { q: query } : {}) }, !loserId) ?? [];
  const preview = useAuthedQuery(
    api.contacts.mergePreview,
    { winnerId: pair.winner, loserIds: pair.loser ? [pair.loser] : [] },
    pair.loser !== null,
  );
  const [choices, setChoices] = useState<Partial<Record<MergeField, string>>>({});
  const [confirmVat, setConfirmVat] = useState(false);
  const winner = preview?.contacts.find((c) => c._id === pair.winner);
  const loser = preview?.contacts.find((c) => c._id === pair.loser);
  const differing = winner && loser ? MERGE_FIELDS.filter((f) => show(winner[f]) !== show(loser[f])) : [];
  const vatConflict = Boolean(winner?.vatId && loser?.vatId && winner.vatId !== loser.vatId);
  const submit = async () => {
    if (!pair.loser) return;
    const r = await run(
      () =>
        merge({
          values: {
            winnerId: pair.winner,
            loserIds: [pair.loser],
            fieldChoices: choices,
            confirmVatConflict: confirmVat,
          },
        }),
      t("merged"),
    );
    if (r.ok) {
      onClose();
      router.push(`/kontakte/${pair.winner}` as Route);
    }
  };
  return (
    <ConfirmDialog
      title={t("mergeTitle")}
      description={t("undoHint")}
      confirmLabel={t("confirm")}
      destructive
      confirmDisabled={!pair.loser || !preview || (vatConflict && !confirmVat)}
      onClose={onClose}
      onConfirm={submit}
    >
      <div className="flex flex-col gap-4 text-sm">
        {!loserId && (
          <div className="flex flex-col gap-2">
            <label htmlFor={searchId} className="font-medium">
              {t("search")}
            </label>
            <Input
              id={searchId}
              type="search"
              className="h-11 md:h-9"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
              {options
                .filter((o) => o._id !== winnerId)
                .map((o) => (
                  <li key={o._id}>
                    <label className="flex min-h-11 items-center gap-2 md:min-h-8">
                      <input
                        type="radio"
                        name={`${searchId}-pick`}
                        className="size-5 accent-primary md:size-4"
                        checked={pair.loser === o._id}
                        onChange={() => setPair({ winner: winnerId, loser: o._id })}
                      />
                      {o.displayName} ({o.number})
                    </label>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {winner && loser && (
          <>
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium">{t("winner")}</legend>
              {[winner, loser].map((c) => (
                <label key={c._id} className="flex min-h-11 items-center gap-2 md:min-h-8">
                  <input
                    type="radio"
                    name={`${searchId}-winner`}
                    className="size-5 accent-primary md:size-4"
                    checked={pair.winner === c._id}
                    onChange={() => {
                      setChoices({});
                      setPair({ winner: c._id, loser: c._id === winner._id ? loser._id : winner._id });
                    }}
                  />
                  {c.displayName} ({c.number})
                </label>
              ))}
            </fieldset>
            {differing.length > 0 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">{t("fields")}</legend>
                {differing.map((f) => (
                  <div
                    key={f}
                    role="radiogroup"
                    aria-label={MERGE_FIELD_LABELS[f]}
                    className="flex flex-col gap-1 rounded-md border p-2"
                  >
                    <span className="text-muted-foreground">{MERGE_FIELD_LABELS[f]}</span>
                    {[winner, loser].map((c) => (
                      <label key={c._id} className="flex min-h-11 items-center gap-2 md:min-h-7">
                        <input
                          type="radio"
                          name={`${searchId}-${f}`}
                          className="size-5 accent-primary md:size-4"
                          checked={(choices[f] ?? pair.winner) === c._id}
                          onChange={() => setChoices((x) => ({ ...x, [f]: c._id }))}
                        />
                        <span className="break-all">{show(c[f])}</span>
                      </label>
                    ))}
                  </div>
                ))}
              </fieldset>
            )}
            {preview && (
              <>
                <p>
                  {t("moves", {
                    addresses: preview.moves.addresses,
                    channels: preview.moves.channels,
                    activities: preview.moves.activities,
                    prices: preview.moves.customerPrices,
                    persons: preview.moves.persons,
                  })}
                </p>
                <p>{t("stays", { checks: preview.stays.vatIdChecks })}</p>
              </>
            )}
            {vatConflict && (
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5 accent-primary md:size-4"
                  checked={confirmVat}
                  onChange={(e) => setConfirmVat(e.target.checked)}
                />
                {t("confirmVat")}
              </label>
            )}
          </>
        )}
      </div>
    </ConfirmDialog>
  );
}
