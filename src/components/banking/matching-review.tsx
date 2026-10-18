"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CheckCheckIcon, CheckIcon, LinkIcon, ShuffleIcon, Undo2Icon, XIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody } from "@/components/layout/list-layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { Amount, money } from "./shared";

type Review = FunctionReturnType<typeof api.matching.review>;
type Row = Review["suggestions"][number];
type Candidate = Row["candidates"][number];
type Tab = "suggestions" | "auto" | "none";

/**
 * Zuordnungen (F07 §6.3, 04 §4.6): transactions with their best candidates (score bar, German reason chips),
 * ✓ Bestätigen (F05 payment), ✗ Ablehnen, ↔ Andere wählen, „Alle sicheren bestätigen (≥ 0,95)“; auto-applied
 * matches with „Rückgängig“ (= F05 reversal, BNK-043/047); transactions without a suggestion.
 */
export function MatchingReview() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <MatchingReviewInner />
    </ConvexGuard>
  );
}

const confirmAllocations = (c: Candidate) =>
  c.allocations.map((a) => ({
    target: a.target,
    amountCents: a.amountCents,
    ...(a.differences?.length ? { differences: a.differences as never } : {}),
  }));

function MatchingReviewInner() {
  const t = useTranslations("banking.matching");
  const data = useAuthedQuery(api.matching.review, {});
  const canMatch = useCan("banking.match");
  const canReverse = useCan("payments.reverse");
  const run = useRun();
  const confirmSafe = useMutation(api.matching.confirmSafe);
  const unmatch = useMutation(api.matching.unmatch);
  const [tab, setTab] = useState<Tab>("suggestions");
  const [bulk, setBulk] = useState(false);
  const [undo, setUndo] = useState<string | null>(null);
  const [undoReason, setUndoReason] = useState("");
  const undoId = useId();
  if (data === undefined) return <PageBody aria-busy="true" className="h-96" />;
  const safe = data.suggestions.filter(
    (r) => r.candidates[0]?.safe && r.candidates[0].allocations[0]?.target.kind !== "payment",
  );
  const safeSum = safe.reduce((s, r) => s + r.tx.openCents, 0);
  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "suggestions", label: t("tabs.suggestions"), count: data.suggestions.length },
    { key: "auto", label: t("tabs.auto"), count: data.autoApplied.length },
    { key: "none", label: t("tabs.none"), count: data.withoutSuggestion.length },
  ];
  return (
    <PageBody className="@container/matching">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={t("tabsLabel")} className="flex flex-wrap gap-1">
          {tabs.map((x) => (
            <Button
              key={x.key}
              role="tab"
              aria-selected={tab === x.key}
              variant={tab === x.key ? "default" : "outline"}
              className="h-11 md:h-9"
              onClick={() => setTab(x.key)}
            >
              {x.label} ({x.count})
            </Button>
          ))}
        </div>
        {canMatch && tab === "suggestions" && safe.length > 0 && (
          <Button className="h-11 md:h-9" onClick={() => setBulk(true)}>
            <CheckCheckIcon aria-hidden="true" />
            {t("confirmSafe", { count: safe.length })}
          </Button>
        )}
      </div>

      {tab === "suggestions" &&
        (data.suggestions.length === 0 ? (
          <EmptyState icon={LinkIcon} title={t("emptySuggestions")} />
        ) : (
          <ul className="flex flex-col gap-3" data-testid="match-suggestions">
            {data.suggestions.map((r) => (
              <SuggestionCard key={r.tx.id} row={r} canMatch={canMatch} />
            ))}
          </ul>
        ))}

      {tab === "auto" &&
        (data.autoApplied.length === 0 ? (
          <EmptyState icon={LinkIcon} title={t("emptyAuto")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {data.autoApplied.map((p) => (
              <li
                key={p.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
              >
                <span className="flex flex-col">
                  <span className="font-medium">
                    {p.number ?? t("credit")} · {money(p.amountCents)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDate(p.date)} · {p.bankTransaction?.counterpartyName ?? p.bankTransaction?.purpose ?? ""}
                    {p.reversedById ? ` · ${t("undone")}` : ""}
                  </span>
                </span>
                {canReverse && !p.reversedById && p.bankTransactionId && (
                  <Button variant="outline" className="h-11 md:h-9" onClick={() => setUndo(p.bankTransactionId)}>
                    <Undo2Icon aria-hidden="true" />
                    {t("undo")}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ))}

      {tab === "none" &&
        (data.withoutSuggestion.length === 0 ? (
          <EmptyState icon={LinkIcon} title={t("emptyNone")} />
        ) : (
          <ul className="flex flex-col gap-2">
            {data.withoutSuggestion.map((tx) => (
              <li key={tx.id} className="flex flex-col gap-1 rounded-lg border p-3 text-sm">
                <TxLine tx={tx} />
                <span className="flex flex-wrap gap-2">
                  {canMatch && <OtherTargetButton tx={tx} />}
                  <Link
                    className="inline-flex min-h-11 items-center underline md:min-h-9"
                    href={`/bank/${tx.accountId}` as Route}
                  >
                    {t("openAccount")}
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        ))}

      {bulk && (
        <ConfirmDialog
          title={t("confirmSafeTitle")}
          description={t("confirmSafeHint", { count: safe.length, sum: money(safeSum) })}
          confirmLabel={t("confirm")}
          onConfirm={async () => {
            const r = await run(
              () => confirmSafe({ transactionIds: safe.map((s) => s.tx.id as Id<"bankTransactions">) }),
              t("confirmed"),
            );
            if (r.ok) setBulk(false);
          }}
          onClose={() => setBulk(false)}
        />
      )}
      {undo && (
        <ConfirmDialog
          title={t("undoTitle")}
          description={t("undoHint")}
          confirmLabel={t("undo")}
          destructive
          confirmDisabled={undoReason.trim().length < 5}
          onConfirm={async () => {
            const r = await run(
              () => unmatch({ transactionId: undo as Id<"bankTransactions">, reason: undoReason.trim() }),
              t("undoneToast"),
            );
            if (r.ok) {
              setUndo(null);
              setUndoReason("");
            }
          }}
          onClose={() => setUndo(null)}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor={undoId} className="font-medium text-sm">
              {t("reason")}
            </label>
            <Textarea id={undoId} value={undoReason} onChange={(e) => setUndoReason(e.target.value)} />
          </div>
        </ConfirmDialog>
      )}
    </PageBody>
  );
}

function TxLine({ tx }: { tx: Row["tx"] }) {
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-2">
      <span className="flex min-w-0 flex-col">
        <span className="font-medium">{tx.counterpartyName ?? tx.accountName}</span>
        <span className="break-words text-muted-foreground">{tx.purpose}</span>
        <span className="text-muted-foreground text-xs">
          {formatDate(tx.bookingDate)} · {tx.accountName}
        </span>
      </span>
      <Amount cents={tx.amountCents} currency={tx.currency} className="font-semibold" />
    </span>
  );
}

function SuggestionCard({ row, canMatch }: { row: Row; canMatch: boolean }) {
  const t = useTranslations("banking.matching");
  const run = useRun();
  const confirm = useMutation(api.matching.confirm);
  const reject = useMutation(api.matching.reject);
  const [index, setIndex] = useState(0);
  const c = row.candidates[index] ?? row.candidates[0];
  if (!c) return null;
  const pct = Math.round(c.score * 100);
  // PAY-033: an outgoing debit refunds a credit balance or a credit correction („Erstattung“).
  const out = row.tx.direction === "out";
  return (
    <li className="flex flex-col gap-3 rounded-xl border p-4 text-sm" data-testid="match-card">
      <TxLine tx={row.tx} />
      <div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{t(out ? `refundKind.${c.kind}` : `kind.${c.kind}`)}</span>
          <meter className="h-2 w-24" aria-label={t("score")} min={0} max={100} value={pct} />
          <span className="tabular-nums">{c.score.toLocaleString("de-DE", { minimumFractionDigits: 2 })}</span>
        </div>
        <ul className="flex flex-col gap-1">
          {c.allocations.map((a) => (
            <li key={`${a.target.kind}-${a.target.id}`} className="flex flex-wrap justify-between gap-2">
              <span>
                {a.target.kind === "salesDocument" ? (
                  <Link className="underline" href={`/rechnungen/${a.target.id}` as Route}>
                    {a.label}
                  </Link>
                ) : (
                  a.label
                )}{" "}
                {a.contactName && <span className="text-muted-foreground">· {a.contactName}</span>}
                {a.differences?.map((d) => (
                  <Badge key={d.reason} variant="outline" className="ml-1">
                    {d.reason === "skonto" ? t("skonto") : t("fees")} {money(d.amountCents)}
                  </Badge>
                ))}
              </span>
              <span className="tabular-nums">{money(a.amountCents)}</span>
            </li>
          ))}
        </ul>
        <span className="flex flex-wrap gap-1">
          {c.labels.map((l) => (
            <Badge key={l} variant="secondary">
              {l}
            </Badge>
          ))}
        </span>
      </div>
      {canMatch && (
        <div className="flex flex-wrap gap-2">
          <Button
            className="h-11 md:h-9"
            onClick={() =>
              void run(
                () =>
                  confirm({
                    transactionId: row.tx.id as Id<"bankTransactions">,
                    allocations: confirmAllocations(c),
                    score: c.score,
                    reasons: c.reasons,
                  }),
                t(out ? "refunded" : "confirmed"),
              )
            }
          >
            <CheckIcon aria-hidden="true" />
            {t("confirm")}
          </Button>
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() => {
              const first = c.allocations[0];
              if (!first) return;
              void run(
                () => reject({ transactionId: row.tx.id as Id<"bankTransactions">, target: first.target }),
                t("rejected"),
              ).then(() => setIndex(0));
            }}
          >
            <XIcon aria-hidden="true" />
            {t("reject")}
          </Button>
          {row.candidates.length > 1 && (
            <Button
              variant="ghost"
              className="h-11 md:h-9"
              onClick={() => setIndex((i) => (i + 1) % row.candidates.length)}
            >
              <ShuffleIcon aria-hidden="true" />
              {t("next", { n: index + 1, total: row.candidates.length })}
            </Button>
          )}
          <OtherTargetButton tx={row.tx} />
        </div>
      )}
    </li>
  );
}

/**
 * ↔ „Andere wählen“: incoming → search an open invoice (the remainder may become a credit balance); outgoing → an open
 * refund of a credit correction (PAY-033 b; a smaller refund leaves the rest of the debit open).
 */
function OtherTargetButton({ tx }: { tx: Row["tx"] }) {
  const t = useTranslations("banking.matching");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" className="h-11 md:h-9" onClick={() => setOpen(true)}>
        <ShuffleIcon aria-hidden="true" />
        {t("other")}
      </Button>
      {open && <OtherTargetDialog tx={tx} onClose={() => setOpen(false)} />}
    </>
  );
}

function OtherTargetDialog({ tx, onClose }: { tx: Row["tx"]; onClose: () => void }) {
  const t = useTranslations("banking.matching");
  const run = useRun();
  const confirm = useMutation(api.matching.confirm);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<{ kind: string; id: string; openCents: number } | null>(null);
  const [remainder, setRemainder] = useState<"credit" | "unallocated">("unallocated");
  const targets = useAuthedQuery(api.matching.openTargets, { q });
  const qid = useId();
  const out = tx.direction === "out";
  const options = (out ? targets?.refunds : targets?.documents) ?? [];
  const amount = selected ? Math.min(selected.openCents, tx.openCents) : 0;
  return (
    <ConfirmDialog
      title={t(out ? "otherRefundTitle" : "otherTitle")}
      description={t("otherHint", { amount: money(tx.openCents) })}
      confirmLabel={t("confirm")}
      confirmDisabled={!selected}
      onConfirm={async () => {
        if (!selected) return;
        const r = await run(
          () =>
            confirm({
              transactionId: tx.id as Id<"bankTransactions">,
              allocations: [{ target: { kind: selected.kind, id: selected.id }, amountCents: amount }],
              ...(!out && amount < tx.openCents ? { remainder } : {}),
            }),
          t(out ? "refunded" : "confirmed"),
        );
        if (r.ok) onClose();
      }}
      onClose={onClose}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={qid} className="font-medium text-sm">
          {t(out ? "searchRefund" : "search")}
        </label>
        <Input id={qid} value={q} onChange={(e) => setQ(e.target.value)} className="h-11 md:h-9" />
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {options.map((d) => (
            <li key={d.id}>
              <label className="flex min-h-11 items-center gap-2 rounded-md border p-2 text-sm md:min-h-9">
                <input
                  type="radio"
                  name={qid}
                  className="size-5 accent-primary md:size-4"
                  checked={selected?.id === d.id}
                  onChange={() => setSelected({ kind: d.kind, id: d.id, openCents: d.openCents })}
                />
                <span className="flex-1">
                  {d.number} · {d.contactName}
                </span>
                <span className="tabular-nums">{money(d.openCents)}</span>
              </label>
            </li>
          ))}
        </ul>
        {!out && selected && amount < tx.openCents && (
          <fieldset className="flex flex-col gap-1 text-sm">
            <legend className="font-medium">{t("remainder", { amount: money(tx.openCents - amount) })}</legend>
            <label className="flex min-h-11 items-center gap-2 md:min-h-9">
              <input
                type="radio"
                className="size-5 accent-primary md:size-4"
                checked={remainder === "unallocated"}
                onChange={() => setRemainder("unallocated")}
              />
              {t("remainderOpen")}
            </label>
            <label className="flex min-h-11 items-center gap-2 md:min-h-9">
              <input
                type="radio"
                className="size-5 accent-primary md:size-4"
                checked={remainder === "credit"}
                onChange={() => setRemainder("credit")}
              />
              {t("remainderCredit")}
            </label>
          </fieldset>
        )}
      </div>
    </ConfirmDialog>
  );
}
