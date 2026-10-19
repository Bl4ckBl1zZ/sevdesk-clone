"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { ChevronLeftIcon, ChevronRightIcon, CopyXIcon, SkipForwardIcon, Trash2Icon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { PageBody } from "@/components/layout/list-layout";
import { Button, buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import {
  complete,
  createQueue,
  currentId,
  doneCount,
  isFinished,
  next,
  parseQueueIds,
  prev,
  progressLabel,
  type QueueState,
  queueKeyAction,
  skip,
} from "./queue-model";
import { VoucherEditor } from "./voucher-editor";

/**
 * VOU-100 batch queue (`/belege/warteschlange?ids=…`): the selected drafts one after the other with progress
 * („3 von 17“) and the keyboard: ⌘/Strg+Enter „Buchen und weiter“, s überspringen, j/k, d „Ist Dublette“, r verwerfen.
 */
export function VoucherQueue() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <QueueInner />
    </ConvexGuard>
  );
}

const inField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));

function QueueInner() {
  const t = useTranslations("vouchers.queue");
  const params = useSearchParams();
  const [q, setQ] = useState<QueueState>(() => createQueue(parseQueueIds(params.get("ids"))));
  const id = currentId(q) as Id<"vouchers"> | null;
  const data = useAuthedQuery(api.vouchers.get, id ? { id } : ({} as never), id !== null);
  const remove = useMutation(api.vouchers.deleteDraft);
  const run = useRun();
  const bookRef = useRef<(() => void) | null>(null);
  const [confirm, setConfirm] = useState<"duplicate" | "reject" | null>(null);

  const done = (vid: string) => setQ((s) => complete(s, vid));
  const isDuplicate =
    !!data?.check?.warnings.some((w) => w.code.startsWith("duplicate_")) ||
    !!data?.check?.errors.some((e) => e.code.startsWith("duplicate_"));

  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  keyHandler.current = (e: KeyboardEvent) => {
    if (confirm || !id) return;
    const action = queueKeyAction({
      key: e.key,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      inField: inField(e.target),
    });
    if (!action) return;
    e.preventDefault();
    if (action === "book_next") bookRef.current?.();
    else if (action === "skip") setQ(skip);
    else if (action === "next") setQ(next);
    else if (action === "prev") setQ(prev);
    else if (action === "duplicate") {
      if (isDuplicate) setConfirm("duplicate");
      else toast.info(t("noDuplicate"));
    } else if (action === "reject") setConfirm("reject");
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  if (q.ids.length === 0) {
    return (
      <PageBody>
        <p>{t("empty")}</p>
        <Link
          href={"/belege" as Route}
          className={cn(buttonVariants({ variant: "outline" }), "h-11 self-start md:h-9")}
        >
          {t("backToList")}
        </Link>
      </PageBody>
    );
  }
  if (isFinished(q)) {
    return (
      <PageBody>
        <p role="status" data-testid="queue-finished">
          {t("finished")}
        </p>
        <Link href={"/belege" as Route} className={cn(buttonVariants(), "h-11 self-start md:h-9")}>
          {t("backToList")}
        </Link>
      </PageBody>
    );
  }
  return (
    <PageBody>
      <div className="flex flex-col gap-2 rounded-xl border p-3" data-testid="queue-bar">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium" aria-live="polite" data-testid="queue-progress">
            {t("progress", { label: progressLabel(q) })} · {t("done", { count: doneCount(q) })}
          </p>
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" className="h-11 md:h-9" onClick={() => setQ(prev)}>
              <ChevronLeftIcon aria-hidden="true" />
              {t("prev")}
            </Button>
            <Button variant="ghost" className="h-11 md:h-9" onClick={() => setQ(next)}>
              {t("next")}
              <ChevronRightIcon aria-hidden="true" />
            </Button>
            <Button variant="ghost" className="h-11 md:h-9" onClick={() => setQ(skip)}>
              <SkipForwardIcon aria-hidden="true" />
              {t("skip")}
            </Button>
            <Button
              variant="ghost"
              className="h-11 md:h-9"
              disabled={!isDuplicate}
              onClick={() => setConfirm("duplicate")}
            >
              <CopyXIcon aria-hidden="true" />
              {t("duplicate")}
            </Button>
            <Button variant="ghost" className="h-11 text-danger md:h-9" onClick={() => setConfirm("reject")}>
              <Trash2Icon aria-hidden="true" />
              {t("reject")}
            </Button>
          </div>
        </div>
        <Progress value={(doneCount(q) / q.ids.length) * 100} aria-label={progressLabel(q)} />
        <p className="hidden text-muted-foreground text-xs md:block">{t("shortcuts")}</p>
      </div>
      {data === undefined ? (
        <div className="h-96" aria-busy="true" />
      ) : data === null || data.voucher.status !== "draft" ? (
        <div className="flex flex-col gap-2">
          <p>{t("notDraft")}</p>
          <Button className="h-11 self-start md:h-9" onClick={() => id && done(id)}>
            {t("next")}
          </Button>
        </div>
      ) : (
        <VoucherEditor
          key={data.voucher._id}
          data={data}
          bookRef={bookRef}
          onBooked={() => done(data.voucher._id)}
          onDeleted={() => done(data.voucher._id)}
        />
      )}
      {confirm && id && (
        <ConfirmDialog
          title={confirm === "duplicate" ? t("duplicate") : t("reject")}
          description={confirm === "duplicate" ? t("duplicateConfirm") : t("rejectConfirm")}
          confirmLabel={confirm === "duplicate" ? t("duplicate") : t("reject")}
          destructive
          onClose={() => setConfirm(null)}
          onConfirm={async () => {
            const r = await run(() => remove({ id }));
            setConfirm(null);
            if (r.ok) done(id);
          }}
        />
      )}
    </PageBody>
  );
}
