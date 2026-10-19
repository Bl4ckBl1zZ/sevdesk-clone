"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import { PackageIcon, SendIcon } from "lucide-react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SEND_CHANNEL_LABELS, SEND_CHANNELS, type SendChannel } from "@/domain/documents/dispatch";
import { BULK_MAX_DOCUMENTS } from "@/domain/jobs/jobs";
import { berlinCalendarDate } from "@/domain/time/berlin";

/**
 * F04 SND-20 bulk bar for the selected documents: „Sammel-Export" (ZIP job) and „Sammel-Markierung" (one sentOn,
 * channel and note; each document is validated individually by the job, failures are listed on /export).
 */
export function BulkActions({ selected, onDone }: { selected: readonly string[]; onDone: () => void }) {
  const t = useTranslations("invoices.bulk");
  const run = useRun();
  const router = useRouter();
  const startExport = useMutation(api.bulk.startExport);
  const canSend = useCan("invoices.send");
  const [markOpen, setMarkOpen] = useState(false);
  if (selected.length === 0) return null;
  const tooMany = selected.length > BULK_MAX_DOCUMENTS;
  const started = () => {
    toast.info(t("started"), { action: { label: t("toJobs"), onClick: () => router.push("/export" as Route) } });
    onDone();
  };
  return (
    <section
      aria-label={t("label")}
      className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 p-2 text-sm"
      data-testid="bulk-bar"
    >
      <span className="font-medium">{t("selected", { count: selected.length })}</span>
      {tooMany && <span className="text-destructive">{t("tooMany", { max: BULK_MAX_DOCUMENTS })}</span>}
      <Button
        variant="outline"
        className="min-h-11 md:min-h-9"
        disabled={tooMany}
        onClick={async () => {
          const r = await run(() => startExport({ ids: selected as Id<"salesDocuments">[] }));
          if (r.ok) started();
        }}
      >
        <PackageIcon aria-hidden="true" />
        {t("export")}
      </Button>
      {canSend && (
        <Button className="min-h-11 md:min-h-9" disabled={tooMany} onClick={() => setMarkOpen(true)}>
          <SendIcon aria-hidden="true" />
          {t("mark")}
        </Button>
      )}
      {markOpen && (
        <BulkMarkDialog
          ids={selected}
          onClose={() => setMarkOpen(false)}
          onStarted={() => {
            setMarkOpen(false);
            started();
          }}
        />
      )}
    </section>
  );
}

function BulkMarkDialog({
  ids,
  onClose,
  onStarted,
}: {
  ids: readonly string[];
  onClose: () => void;
  onStarted: () => void;
}) {
  const t = useTranslations("invoices.bulk");
  const run = useRun();
  const start = useMutation(api.bulk.startMarkSent);
  const [sentOn, setSentOn] = useState<string>(berlinCalendarDate(Date.now()));
  const [channel, setChannel] = useState<SendChannel>("email_manual");
  const [note, setNote] = useState("");
  const id = useId();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("markTitle", { count: ids.length })}</DialogTitle>
          <DialogDescription>{t("markHint")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-date`}>{t("sentOn")}</Label>
            <Input id={`${id}-date`} type="date" value={sentOn} onChange={(e) => setSentOn(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-channel`}>{t("channel")}</Label>
            <select
              id={`${id}-channel`}
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={channel}
              onChange={(e) => setChannel(e.target.value as SendChannel)}
            >
              {SEND_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {SEND_CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-note`}>{t("note")}</Label>
            <Textarea id={`${id}-note`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            onClick={async () => {
              const r = await run(() =>
                start({
                  ids: ids as Id<"salesDocuments">[],
                  values: { sentOn, channel, ...(note.trim() ? { note: note.trim() } : {}) },
                }),
              );
              if (r.ok) onStarted();
            }}
          >
            {t("markConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
