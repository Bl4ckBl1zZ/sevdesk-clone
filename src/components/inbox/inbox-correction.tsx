"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import { CopyIcon, FileDownIcon, SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, formatDate, formatDateTime, selectClass, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ReasonField } from "@/components/vouchers/voucher-payment";
import { SEND_CHANNEL_LABELS, SEND_CHANNELS, type SendChannel } from "@/domain/documents/dispatch";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { useAuthedQuery } from "@/hooks/use-authed-query";

/**
 * INB-046 „Korrektur anfordern“ (B2 — the app never sends): the German letter „Bitte um Rechnungskorrektur“, „Text
 * kopieren“, „Als PDF exportieren“ (archived once with SHA-256), „Als versendet markieren“ (date, channel, note) and
 * the history of marks with „Versandmarkierung zurücknehmen“ (reason).
 */
export function InboxCorrection({ id, canWrite }: { id: string; canWrite: boolean }) {
  const t = useTranslations("inbox.correction");
  const view = useAuthedQuery(api.inbox.correctionRequest, { id: id as Id<"inboxItems"> });
  const exportPdf = useAction(api.inboxNode.exportCorrectionLetter);
  const mark = useMutation(api.inbox.markCorrectionSent);
  const retract = useMutation(api.inbox.retractCorrectionMark);
  const run = useRun();
  const fid = useId();
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [retracting, setRetracting] = useState<string | null>(null);
  const [sentOn, setSentOn] = useState(() => berlinCalendarDate(Date.now()));
  const [channel, setChannel] = useState<SendChannel>("email_manual");
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  if (!view?.available || !view.text) return null;
  const text = view.text;

  return (
    <section className="flex flex-col gap-3 rounded-md border p-3" data-testid="inbox-correction">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">{t("title")}</h3>
        {!open && (
          <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(true)}>
            {t("open")}
          </Button>
        )}
      </div>
      {open && (
        <>
          <p className="text-muted-foreground text-xs">{t("hint")}</p>
          <pre
            className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-sans text-sm"
            data-testid="correction-text"
          >
            {text}
          </pre>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              className="h-11 md:h-9"
              onClick={() =>
                void navigator.clipboard.writeText(text).then(
                  () => toast.success(t("copied")),
                  () => toast.error(t("copyFailed")),
                )
              }
            >
              <CopyIcon aria-hidden="true" />
              {t("copy")}
            </Button>
            {canWrite && (
              <Button
                variant="outline"
                className="h-11 md:h-9"
                onClick={async () => {
                  const r = await run(() => exportPdf({ id: id as Id<"inboxItems"> }), t("exported"));
                  if (r.ok && r.value.url) window.open(r.value.url, "_blank", "noopener");
                }}
              >
                <FileDownIcon aria-hidden="true" />
                {t("exportPdf")}
              </Button>
            )}
            {canWrite && (
              <Button className="h-11 md:h-9" onClick={() => setMarking(true)} disabled={!view.artifact}>
                <SendIcon aria-hidden="true" />
                {t("markSent")}
              </Button>
            )}
          </div>
          {view.artifact && (
            <p className="text-muted-foreground text-xs">
              {view.artifact.url ? (
                <a href={view.artifact.url} target="_blank" rel="noreferrer" className="underline">
                  {view.artifact.name}
                </a>
              ) : (
                view.artifact.name
              )}{" "}
              · {t("archived", { at: formatDateTime(view.artifact.createdAt), hash: view.artifact.sha256.slice(0, 8) })}
            </p>
          )}
          {!view.artifact && canWrite && <p className="text-muted-foreground text-xs">{t("exportFirst")}</p>}
        </>
      )}
      {view.marks.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" aria-label={t("history")} data-testid="correction-marks">
          {view.marks.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-2">
              <span className={m.retracted ? "line-through" : undefined}>
                {m.kind === "mark_sent"
                  ? t("markRow", { date: formatDate(m.sentOn), channel: SEND_CHANNEL_LABELS[m.channel] })
                  : t("retractionRow", { reason: m.note ?? "" })}
              </span>
              {canWrite && m.kind === "mark_sent" && !m.retracted && (
                <Button variant="ghost" size="sm" onClick={() => setRetracting(m.id)}>
                  {t("retract")}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {marking && (
        <ConfirmDialog
          title={t("markTitle")}
          description={t("markDescription")}
          confirmLabel={t("markSent")}
          confirmDisabled={!sentOn || (channel === "other" && !note.trim())}
          onClose={() => setMarking(false)}
          onConfirm={async () => {
            const r = await run(
              () =>
                mark({
                  id: id as Id<"inboxItems">,
                  sentOn,
                  channel,
                  ...(note.trim() ? { note: note.trim() } : {}),
                }),
              t("marked"),
            );
            if (r.ok) setMarking(false);
          }}
        >
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fid}-date`}>{t("sentOn")}</Label>
              <Input
                id={`${fid}-date`}
                type="date"
                value={sentOn}
                max={berlinCalendarDate(Date.now())}
                onChange={(e) => setSentOn(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${fid}-channel`}>{t("channel")}</Label>
              <select
                id={`${fid}-channel`}
                className={selectClass}
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
            <ReasonField label={channel === "other" ? t("noteRequired") : t("note")} value={note} onChange={setNote} />
          </div>
        </ConfirmDialog>
      )}
      {retracting && (
        <ConfirmDialog
          title={t("retractTitle")}
          description={t("retractDescription")}
          confirmLabel={t("retract")}
          destructive
          confirmDisabled={reason.trim().length < 10}
          onClose={() => setRetracting(null)}
          onConfirm={async () => {
            const r = await run(
              () =>
                retract({
                  id: id as Id<"inboxItems">,
                  retractsId: retracting as Id<"sendLog">,
                  reason: reason.trim(),
                }),
              t("retracted"),
            );
            if (r.ok) {
              setRetracting(null);
              setReason("");
            }
          }}
        >
          <ReasonField label={t("reason")} value={reason} onChange={setReason} />
        </ConfirmDialog>
      )}
    </section>
  );
}
