"use client";

import { api } from "@convex/_generated/api";
import { PlayIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { useCan } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { formatElapsed } from "@/domain/projects/time-entries";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { TimerCard, useNow } from "./timer";

/**
 * Header timer (F11 §6, PRJ-005): running → pill with project and elapsed time; idle → „▶ Zeit starten“. A click
 * opens the timer (description, project, stop/discard) in a popover. Live on every device via the subscription.
 */
export function TimerPill() {
  return (
    <ConvexGuard fallback={null}>
      <TimerPillInner />
    </ConvexGuard>
  );
}

function TimerPillInner() {
  const t = useTranslations("time.timer");
  const canRead = useCan("projects.read");
  const canWrite = useCan("time.write");
  const timer = useAuthedQuery(api.timeEntries.timer, {}, canRead);
  const [open, setOpen] = useState(false);
  const now = useNow(Boolean(timer));
  if (!canRead || timer === undefined || (!timer && !canWrite)) return null;
  const project = timer ? (timer.projectName ?? timer.description ?? t("noProject")) : "";
  const elapsed = timer ? formatElapsed(now - timer.startedAt) : "";
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // A confirmation opened from the popover (E-PRJ-01 „Stoppen und neu starten“, „Timer verwerfen?“) lives in a
        // portal; a press inside it must not close the popover and unmount the dialog with it.
        if (!next && document.querySelector("[data-slot=dialog-content]")) return;
        setOpen(next);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant={timer ? "secondary" : "ghost"}
            className="h-9 max-w-72 gap-2 rounded-full px-3"
            data-testid="timer-pill"
            data-running={timer ? "true" : "false"}
            aria-label={timer ? t("pillRunning", { project }) : t("pillIdle")}
          />
        }
      >
        {timer ? (
          <>
            <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-success" />
            <span className="min-w-0 truncate">{project}</span>
            <span className="font-semibold tabular-nums" data-testid="timer-pill-elapsed">
              {elapsed}
            </span>
          </>
        ) : (
          <>
            <PlayIcon aria-hidden="true" />
            {t("pillIdle")}
          </>
        )}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(28rem,calc(100vw-2rem))] p-0">
        <TimerCard embedded />
      </PopoverContent>
    </Popover>
  );
}
