"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { PlayIcon, SquareIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatElapsed } from "@/domain/projects/time-entries";
import { berlinClockTime } from "@/domain/time/berlin";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { deviceId } from "./offline-queue";
import { useProjectOptions } from "./time-shared";
import { useOfflineTime } from "./use-offline-time";

interface ShownTimer {
  _id: string;
  startedAt: number;
  description?: string;
  projectId?: string;
  projectName: string | null;
  /** A queued offline start (PRJ-018), not yet on the server. */
  offline?: boolean;
}

const errorOf = (e: unknown) => (e as { data?: { reason?: string; message?: string } }).data;

/**
 * Timer (F11 PRJ-005/006): one running timer per instance, live on every device through the Convex subscription.
 * Start while another device runs a timer → confirmation (E-PRJ-01); stop saves the entry (incomplete if fields
 * are missing, E-PRJ-02).
 */
export function TimerCard({ projectId, embedded }: { projectId?: string; embedded?: boolean }) {
  return (
    <ConvexGuard fallback={null}>
      <TimerInner projectId={projectId} embedded={embedded === true} />
    </ConvexGuard>
  );
}

/** Ticks every second while `active` (running timer display). */
export function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

function TimerInner({ projectId, embedded }: { projectId?: string; embedded: boolean }) {
  const t = useTranslations("time.timer");
  const serverTimer = useAuthedQuery(api.timeEntries.timer, {});
  const offline = useOfflineTime();
  // PRJ-018: while offline (or until the queue is synced) a queued start is shown as the running timer.
  const local = offline.localTimer;
  const timer: ShownTimer | null | undefined =
    local && (!offline.online || !serverTimer)
      ? {
          _id: "offline",
          startedAt: local.startedAt,
          ...(local.fields.description ? { description: local.fields.description } : {}),
          ...(local.fields.projectId ? { projectId: local.fields.projectId } : {}),
          projectName: null,
          offline: true,
        }
      : serverTimer === undefined && !offline.online
        ? null
        : serverTimer;
  const canWrite = useCan("time.write");
  const projects = useProjectOptions();
  const run = useRun();
  const start = useMutation(api.timeEntries.start);
  const stop = useMutation(api.timeEntries.stop);
  const discard = useMutation(api.timeEntries.discard);
  const updateRunning = useMutation(api.timeEntries.updateRunning);
  const [description, setDescription] = useState("");
  const [project, setProject] = useState(projectId ?? "");
  const [split, setSplit] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [editKey, setEditKey] = useState<number | null>(null);
  const now = useNow(Boolean(timer));
  const ids = { desc: useId(), project: useId(), split: useId(), heading: useId() };

  // Running: the fields mirror the server state until the user edits them (another device may change them).
  const runningKey = timer?._id ? timer.startedAt : null;
  if (timer && editKey !== runningKey) {
    setEditKey(runningKey);
    setDescription(timer.description ?? "");
    setProject(timer.projectId ?? "");
  }
  if (!timer && editKey !== null) {
    setEditKey(null);
    setDescription("");
    setProject(projectId ?? "");
  }

  if (timer === undefined) return null;

  const fields = { ...(description.trim() ? { description } : {}), ...(project ? { projectId: project } : {}) };

  const doStart = async (confirmStop: boolean) => {
    if (!offline.online) {
      await offline.enqueue({ kind: "timer_start", at: Date.now(), fields });
      toast.info(t("offlineQueued"));
      return;
    }
    try {
      await start({ ...fields, deviceId: deviceId(), ...(confirmStop ? { confirmStop } : {}) });
      toast.success(t("started"));
      setConflict(null);
    } catch (e) {
      const data = errorOf(e);
      if (data?.reason === "TIMER_RUNNING") {
        setConflict(data.message ?? t("confirmTitle"));
        return;
      }
      await run(() => Promise.reject(e));
    }
  };

  const doStop = async () => {
    if (!offline.online || timer?.offline) {
      await offline.enqueue({ kind: "timer_stop", at: Date.now(), fields });
      toast.info(t("offlineQueued"));
      return;
    }
    const r = await run(() => stop({ ...fields, ...(split ? { splitAtMidnight: true } : {}) }));
    if (!r.ok) return;
    toast.success(t("stopped"));
    for (const w of r.value.warnings) toast.warning(w);
  };

  return (
    <section
      aria-labelledby={ids.heading}
      data-testid={embedded ? "timer-popover" : "timer"}
      data-running={timer ? "true" : "false"}
      className={cn("@container/timer flex flex-col gap-3 p-4", !embedded && "rounded-xl border")}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={ids.heading} className="flex items-center gap-2 font-semibold text-base">
          {t("heading")}
          {(!offline.online || offline.ops.length > 0) && (
            <span
              className="rounded-full border border-warning/50 bg-warning/10 px-2 font-normal text-xs"
              data-testid="timer-offline"
            >
              {offline.online ? t("offlinePending", { count: offline.ops.length }) : t("offlineBadge")}
            </span>
          )}
        </h2>
        {timer ? (
          <p className="text-sm">
            <span className="sr-only">{t("elapsed")}: </span>
            <span className="font-semibold text-lg tabular-nums" data-testid="timer-elapsed">
              {formatElapsed(now - timer.startedAt)}
            </span>{" "}
            <span className="text-muted-foreground">{t("since", { time: berlinClockTime(timer.startedAt) })}</span>
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">{t("idle")}</p>
        )}
      </div>
      {canWrite && (
        <div className="grid gap-3 @xl/timer:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] @xl/timer:items-end">
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={ids.desc} className="font-medium text-sm">
              {t("description")}
            </label>
            <Input
              id={ids.desc}
              className="h-11 md:h-9"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <label htmlFor={ids.project} className="font-medium text-sm">
              {t("project")}
            </label>
            <select
              id={ids.project}
              className={selectClass}
              value={project}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">{t("noProject")}</option>
              {projects.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.name}
                </option>
              ))}
              {timer?.projectId && !projects.some((p) => p._id === timer.projectId) && (
                <option value={timer.projectId}>{timer.projectName ?? timer.projectId}</option>
              )}
            </select>
          </div>
          <div className="flex flex-wrap gap-2">
            {timer ? (
              <>
                <Button className="h-11 md:h-9" onClick={() => void doStop()}>
                  <SquareIcon aria-hidden="true" />
                  {t("stop")}
                </Button>
                {!timer.offline && (
                  <>
                    <Button
                      variant="outline"
                      className="h-11 md:h-9"
                      onClick={() => void run(() => updateRunning(fields), t("updated"))}
                    >
                      {t("update")}
                    </Button>
                    <Button variant="ghost" className="h-11 text-danger md:h-9" onClick={() => setConfirmDiscard(true)}>
                      {t("discard")}
                    </Button>
                  </>
                )}
              </>
            ) : (
              <Button className="h-11 md:h-9" onClick={() => void doStart(false)}>
                <PlayIcon aria-hidden="true" />
                {t("start")}
              </Button>
            )}
          </div>
          {timer && (
            <label htmlFor={ids.split} className="flex min-h-11 items-center gap-2 text-sm md:min-h-9">
              <input
                id={ids.split}
                type="checkbox"
                className="size-5 md:size-4"
                checked={split}
                onChange={(e) => setSplit(e.target.checked)}
              />
              {t("splitAtMidnight")}
            </label>
          )}
        </div>
      )}
      {conflict && (
        <ConfirmDialog
          title={t("confirmTitle")}
          description={conflict}
          confirmLabel={t("confirmStop")}
          onClose={() => setConflict(null)}
          onConfirm={() => doStart(true)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title={t("discardTitle")}
          description={t("discardDescription")}
          confirmLabel={t("discard")}
          destructive
          onClose={() => setConfirmDiscard(false)}
          onConfirm={async () => {
            const r = await run(() => discard({}), t("discarded"));
            if (r.ok) setConfirmDiscard(false);
          }}
        />
      )}
    </section>
  );
}
