"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionArgs } from "convex/server";
import { FileTextIcon, SendIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { ConfirmDialog, formatDate, selectClass, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SEND_CHANNEL_LABELS, type SendChannel } from "@/domain/documents/dispatch";
import { LETTER_KIND_LABEL_DE } from "@/domain/receivables/letter";
import { useAuthedQuery } from "@/hooks/use-authed-query";

export type LetterRequest = FunctionArgs<typeof api.payments.letter>["request"];

function download(href: string, name: string) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.target = "_blank";
  a.rel = "noopener";
  a.click();
}

/**
 * F05 PAY-005/PAY-048/DUN-028/DUN-044: renders the letter as PDF, archives it and downloads it (and the DUN-044 JSON).
 * The app never sends it (B2) — the user sends it and marks it as sent in the archived list.
 */
export function useLetter() {
  const letter = useAction(api.payments.letter);
  const run = useRun();
  const t = useTranslations("receivables.letters");
  return async (request: LetterRequest) => {
    const r = await run(() => letter({ request }), t("ready"));
    if (!r.ok) return false;
    const pdf = new Blob([Uint8Array.from(atob(r.value.pdfBase64), (c) => c.charCodeAt(0))], {
      type: "application/pdf",
    });
    download(URL.createObjectURL(pdf), r.value.name);
    if (r.value.data) {
      const json = new Blob([r.value.data], { type: "application/json" });
      download(URL.createObjectURL(json), r.value.name.replace(/\.pdf$/, ".json"));
    }
    return true;
  };
}

export function LetterButton({
  request,
  label,
  testId,
  variant = "outline",
}: {
  request: LetterRequest;
  label: string;
  testId?: string;
  variant?: "outline" | "ghost";
}) {
  const create = useLetter();
  const canCreate = useCan("payments.receipt");
  const [busy, setBusy] = useState(false);
  if (!canCreate) return null;
  return (
    <Button
      variant={variant}
      className="h-11 md:h-9"
      disabled={busy}
      data-testid={testId}
      onClick={async () => {
        setBusy(true);
        await create(request);
        setBusy(false);
      }}
    >
      <FileTextIcon aria-hidden="true" />
      {label}
    </Button>
  );
}

/** PAY-005 „Kontoauszug erstellen“: period (default: 1 January until today), optional Saldenbestätigung. */
export function StatementButton({ contactId }: { contactId: string }) {
  const t = useTranslations("receivables.letters");
  const create = useLetter();
  const canCreate = useCan("payments.receipt");
  const ids = { from: useId(), to: useId(), confirm: useId() };
  const today = todayBerlin();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState(`${today.slice(0, 4)}-01-01`);
  const [to, setTo] = useState(today);
  const [confirmationRequest, setConfirmationRequest] = useState(false);
  if (!canCreate) return null;
  return (
    <>
      <Button variant="outline" className="h-11 md:h-9" onClick={() => setOpen(true)} data-testid="create-statement">
        <FileTextIcon aria-hidden="true" />
        {t("statement")}
      </Button>
      {open && (
        <ConfirmDialog
          title={t("statementTitle")}
          description={t("statementHint")}
          confirmLabel={t("createPdf")}
          confirmDisabled={!from || !to || to < from}
          onClose={() => setOpen(false)}
          onConfirm={async () => {
            const ok = await create({
              kind: "account_statement",
              contactId: contactId as Id<"contacts">,
              from,
              to,
              ...(confirmationRequest ? { confirmationRequest: true } : {}),
            });
            if (ok) setOpen(false);
          }}
        >
          <div className="grid gap-3 @md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.from}>{t("from")}</Label>
              <Input id={ids.from} type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.to}>{t("to")}</Label>
              <Input id={ids.to} type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
            </div>
          </div>
          <label htmlFor={ids.confirm} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              id={ids.confirm}
              type="checkbox"
              className="size-4"
              checked={confirmationRequest}
              onChange={(e) => setConfirmationRequest(e.target.checked)}
            />
            {t("confirmationRequest")}
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

const CHANNELS = Object.keys(SEND_CHANNEL_LABELS) as SendChannel[];

function MarkSentDialog({ id, date, onClose }: { id: string; date: string; onClose: () => void }) {
  const t = useTranslations("receivables.letters");
  const mark = useMutation(api.payments.markLetterSent);
  const run = useRun();
  const ids = { date: useId(), channel: useId(), note: useId() };
  const [sentOn, setSentOn] = useState(todayBerlin());
  const [channel, setChannel] = useState<SendChannel>("post");
  const [note, setNote] = useState("");
  return (
    <ConfirmDialog
      title={t("markSentTitle")}
      description={t("markSentHint")}
      confirmLabel={t("markSent")}
      confirmDisabled={!sentOn || (channel === "other" && note.trim() === "")}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(
          () =>
            mark({
              id: id as Id<"receivableLetters">,
              sentOn,
              channel,
              ...(note.trim() ? { note: note.trim() } : {}),
            }),
          t("markedSent"),
        );
        if (r.ok) onClose();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.date}>{t("sentOn")}</Label>
        <Input
          id={ids.date}
          type="date"
          value={sentOn}
          min={date}
          max={todayBerlin()}
          onChange={(e) => setSentOn(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.channel}>{t("channel")}</Label>
        <select
          id={ids.channel}
          className={selectClass}
          value={channel}
          onChange={(e) => setChannel(e.target.value as SendChannel)}
        >
          {CHANNELS.map((c) => (
            <option key={c} value={c}>
              {SEND_CHANNEL_LABELS[c]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.note}>{t("note")}</Label>
        <Textarea id={ids.note} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

/** Archived letters (PDF links, sent mark) of a contact or an invoice. */
export function ArchivedLetters({ contactId, documentId }: { contactId?: string; documentId?: string }) {
  const t = useTranslations("receivables.letters");
  const rows = useAuthedQuery(api.payments.letters, {
    ...(contactId ? { contactId: contactId as Id<"contacts"> } : {}),
    ...(documentId ? { documentId: documentId as Id<"salesDocuments"> } : {}),
  });
  const canMark = useCan("dunning.write");
  const [marking, setMarking] = useState<{ id: string; date: string } | null>(null);
  if (!rows || rows.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label={t("archived")} data-testid="archived-letters">
      <h3 className="font-medium text-sm">{t("archived")}</h3>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2 text-sm">
            <span className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{formatDate(r.date)}</span>
              <Badge variant="outline">{LETTER_KIND_LABEL_DE[r.kind]}</Badge>
              {r.url ? (
                <a
                  className="inline-flex min-h-11 items-center underline md:min-h-9"
                  href={r.url}
                  download={r.fileName}
                >
                  {r.subject}
                </a>
              ) : (
                <span>{r.subject}</span>
              )}
            </span>
            {r.sent ? (
              <Badge variant="secondary">
                {t("sentBadge", { date: formatDate(r.sent.sentOn), channel: SEND_CHANNEL_LABELS[r.sent.channel] })}
              </Badge>
            ) : (
              canMark && (
                <Button variant="ghost" className="h-11 md:h-9" onClick={() => setMarking({ id: r.id, date: r.date })}>
                  <SendIcon aria-hidden="true" />
                  {t("markSent")}
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
      {marking && <MarkSentDialog id={marking.id} date={marking.date} onClose={() => setMarking(null)} />}
    </section>
  );
}
