"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { DownloadIcon, PlusIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { ConfirmDialog, formatDate, selectClass, todayBerlin, useCan, useRun } from "@/components/catalog/shared";
import { downloadText } from "@/components/exports/export-menu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { DSGVO_CHANNELS, DSGVO_KIND_LABEL_DE, DSGVO_KINDS } from "@/domain/privacy/dsgvo";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type Row = FunctionReturnType<typeof api.dsgvo.list>[number];
type Dialog = { kind: "verify" | "extend" | "erase" | "reject"; row: Row } | { kind: "create" } | null;

/**
 * F12 §6 Anfragen: DSGVO request register (PRV-010), erasure/restriction (PRV-011/012), access export (PRV-013) and
 * response letters (PRV-014). Owner only — every action is re-checked by Convex (`dsgvo.*`, scope null).
 */
export function DsgvoRequests({ contactId }: { contactId?: string }) {
  const t = useTranslations("privacy.requests");
  const isOwner = useCan("dsgvo.manage");
  const rows = useAuthedQuery(api.dsgvo.list, {}, isOwner);
  const [dialog, setDialog] = useState<Dialog>(contactId ? { kind: "create" } : null);
  if (!isOwner) return <p className="text-muted-foreground text-sm">{t("ownerOnly")}</p>;
  if (!rows) return <div className="h-40" aria-busy="true" />;
  return (
    <div className="@container flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t("hint")}</p>
        <Button className="min-h-11 md:min-h-9" onClick={() => setDialog({ kind: "create" })}>
          <PlusIcon aria-hidden="true" />
          {t("new")}
        </Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3" aria-label={t("listLabel")}>
          {rows.map((r) => (
            <RequestRow key={r.id} row={r} open={(kind) => setDialog({ kind, row: r })} />
          ))}
        </ul>
      )}
      {dialog?.kind === "create" && <CreateDialog contactId={contactId} onClose={() => setDialog(null)} />}
      {dialog?.kind === "verify" && <VerifyDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === "extend" && <ExtendDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === "reject" && <RejectDialog row={dialog.row} onClose={() => setDialog(null)} />}
      {dialog?.kind === "erase" && <EraseDialog row={dialog.row} onClose={() => setDialog(null)} />}
    </div>
  );
}

function RequestRow({ row: r, open }: { row: Row; open: (k: "verify" | "extend" | "erase" | "reject") => void }) {
  const t = useTranslations("privacy.requests");
  const run = useRun();
  const setStatus = useMutation(api.dsgvo.setRequestStatus);
  const startExport = useMutation(api.dsgvo.startExport);
  const [letter, setLetter] = useState(false);
  const active = r.status !== "done" && r.status !== "rejected";
  const exportable = (r.kind === "access" || r.kind === "portability") && r.contactId !== null;
  const erasable = (r.kind === "erasure" || r.kind === "restriction") && r.contactId !== null && !r.erasure;
  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{r.subject}</span>
        <Badge variant="outline">{r.kindLabel}</Badge>
        <Badge variant="outline">{t(`status.${r.status}`)}</Badge>
        {r.overdue && <Badge variant="destructive">{t("overdue")}</Badge>}
        {!r.overdue && (r.stage === "due7" || r.stage === "due1") && (
          <Badge variant="outline" className="border-warning/60 text-warning">
            {t("dueSoon")}
          </Badge>
        )}
      </div>
      <p className="text-muted-foreground text-sm">
        {t("dates", {
          received: formatDate(r.receivedAt),
          due: formatDate(r.dueAt),
          channel: t(`channel.${r.channel}`),
        })}
        {r.identityVerified ? ` · ${t("verified", { method: r.identityVerified.method })}` : ` · ${t("notVerified")}`}
      </p>
      {r.erasure && (
        <p className="text-sm">
          {r.erasure.contactDeleted
            ? t("erasedFully", { count: r.erasure.deleted })
            : t("restricted", { count: r.erasure.deleted, date: formatDate(r.erasure.scheduledPurgeAt ?? null) })}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {active && !r.identityVerified && (
          <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => open("verify")}>
            {t("verify")}
          </Button>
        )}
        {active && !r.extension && (
          <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => open("extend")}>
            {t("extend")}
          </Button>
        )}
        {active && exportable && (
          <Button
            variant="outline"
            size="sm"
            className="min-h-11 md:min-h-8"
            onClick={() => void run(() => startExport({ id: r.id }), t("exportStarted"))}
          >
            {t("export")}
          </Button>
        )}
        {r.hasResult && <ResultLink id={r.id} />}
        {active && erasable && (
          <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8" onClick={() => open("erase")}>
            {t("erase")}
          </Button>
        )}
        <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => setLetter(true)}>
          {t("letter")}
        </Button>
        {active && (
          <>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => void run(() => setStatus({ id: r.id, to: "done" }), t("doneSaved"))}
            >
              {t("done")}
            </Button>
            <Button variant="outline" size="sm" className="min-h-11 md:min-h-8" onClick={() => open("reject")}>
              {t("reject")}
            </Button>
          </>
        )}
      </div>
      {letter && <LetterDownload id={r.id} onDone={() => setLetter(false)} />}
    </li>
  );
}

function ResultLink({ id }: { id: Id<"dsgvoRequests"> }) {
  const t = useTranslations("privacy.requests");
  const url = useAuthedQuery(api.dsgvo.resultUrl, { id });
  if (!url) return null;
  return (
    <a
      href={url}
      className="inline-flex min-h-11 items-center gap-1 text-primary text-sm underline-offset-4 hover:underline md:min-h-8"
    >
      <DownloadIcon aria-hidden="true" className="size-4" />
      {t("download")}
    </a>
  );
}

function LetterDownload({ id, onDone }: { id: Id<"dsgvoRequests">; onDone: () => void }) {
  const letter = useAuthedQuery(api.dsgvo.letter, { id });
  const done = useRef(false);
  useEffect(() => {
    if (letter === undefined || done.current) return;
    done.current = true;
    downloadText("dsgvo-antwort.txt", letter, "text/plain;charset=utf-8");
    onDone();
  }, [letter, onDone]);
  return null;
}

function CreateDialog({ contactId, onClose }: { contactId?: string; onClose: () => void }) {
  const t = useTranslations("privacy.requests");
  const run = useRun();
  const create = useMutation(api.dsgvo.create);
  const [kind, setKind] = useState<(typeof DSGVO_KINDS)[number]>("access");
  const [channel, setChannel] = useState<(typeof DSGVO_CHANNELS)[number]>("email");
  const [receivedAt, setReceivedAt] = useState(todayBerlin());
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const ids = { kind: useId(), channel: useId(), received: useId(), name: useId(), email: useId(), notes: useId() };
  return (
    <ConfirmDialog
      title={t("new")}
      description={contactId ? t("forContact") : t("newDescription")}
      confirmLabel={t("save")}
      confirmDisabled={!contactId && name.trim().length === 0}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(
          () =>
            create({
              ...(contactId
                ? { contactId: contactId as Id<"contacts"> }
                : { subject: { name, ...(email ? { email } : {}) } }),
              kind,
              channel,
              receivedAt,
              ...(notes ? { notes } : {}),
            }),
          t("saved"),
        );
        if (r.ok) onClose();
      }}
    >
      <div className="grid gap-3 @md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.kind}>{t("kind")}</Label>
          <select
            id={ids.kind}
            className={selectClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            {DSGVO_KINDS.map((k) => (
              <option key={k} value={k}>
                {DSGVO_KIND_LABEL_DE[k]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.channel}>{t("channelLabel")}</Label>
          <select
            id={ids.channel}
            className={selectClass}
            value={channel}
            onChange={(e) => setChannel(e.target.value as typeof channel)}
          >
            {DSGVO_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {t(`channel.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={ids.received}>{t("receivedAt")}</Label>
          <Input id={ids.received} type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
        </div>
        {!contactId && (
          <>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.name}>{t("subjectName")}</Label>
              <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={ids.email}>{t("subjectEmail")}</Label>
              <Input id={ids.email} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.notes}>{t("notes")}</Label>
        <Textarea id={ids.notes} value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function VerifyDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useTranslations("privacy.requests");
  const run = useRun();
  const verify = useMutation(api.dsgvo.verify);
  const [method, setMethod] = useState("");
  const id = useId();
  return (
    <ConfirmDialog
      title={t("verify")}
      description={t("verifyDescription")}
      confirmLabel={t("verify")}
      confirmDisabled={method.trim().length === 0}
      onClose={onClose}
      onConfirm={async () => {
        if ((await run(() => verify({ id: row.id, method }), t("saved"))).ok) onClose();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{t("verifyMethod")}</Label>
        <Input id={id} value={method} onChange={(e) => setMethod(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function ExtendDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useTranslations("privacy.requests");
  const run = useRun();
  const extend = useMutation(api.dsgvo.extend);
  const [months, setMonths] = useState(2);
  const [reason, setReason] = useState("");
  const [noticeSentOn, setNotice] = useState(todayBerlin());
  const ids = { months: useId(), reason: useId(), notice: useId() };
  return (
    <ConfirmDialog
      title={t("extend")}
      description={t("extendDescription")}
      confirmLabel={t("extend")}
      onClose={onClose}
      onConfirm={async () => {
        if ((await run(() => extend({ id: row.id, months, reason, noticeSentOn }), t("saved"))).ok) onClose();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.months}>{t("months")}</Label>
        <select
          id={ids.months}
          className={selectClass}
          value={months}
          onChange={(e) => setMonths(Number(e.target.value))}
        >
          <option value={1}>1</option>
          <option value={2}>2</option>
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.reason}>{t("extendReason")}</Label>
        <Textarea id={ids.reason} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={ids.notice}>{t("noticeSentOn")}</Label>
        <Input id={ids.notice} type="date" value={noticeSentOn} onChange={(e) => setNotice(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function RejectDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useTranslations("privacy.requests");
  const run = useRun();
  const setStatus = useMutation(api.dsgvo.setRequestStatus);
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <ConfirmDialog
      title={t("reject")}
      confirmLabel={t("reject")}
      confirmDisabled={reason.trim().length === 0}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(() => setStatus({ id: row.id, to: "rejected", rejectionReason: reason }), t("saved"));
        if (r.ok) onClose();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{t("rejectionReason")}</Label>
        <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function EraseDialog({ row, onClose }: { row: Row; onClose: () => void }) {
  const t = useTranslations("privacy.requests");
  const run = useRun();
  const execute = useMutation(api.dsgvo.execute);
  const p = useAuthedQuery(api.dsgvo.preview, { contactId: row.contactId as Id<"contacts"> });
  return (
    <ConfirmDialog
      title={t("eraseTitle")}
      description={t("eraseDescription")}
      confirmLabel={p?.deleteContact ? t("eraseConfirmFull") : t("eraseConfirm")}
      destructive
      confirmDisabled={!p || !row.identityVerified}
      onClose={onClose}
      onConfirm={async () => {
        if ((await run(() => execute({ id: row.id }), t("erased"))).ok) onClose();
      }}
    >
      {!p ? (
        <div className="h-24" aria-busy="true" />
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          {!row.identityVerified && <p role="alert">{t("identityFirst")}</p>}
          {p.receivablesNotice && (
            <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 p-2">
              {p.receivablesNotice}
            </p>
          )}
          <section aria-label={t("bucketDelete")}>
            <h3 className="font-medium">{t("bucketDelete")}</h3>
            {p.deleteNow.length === 0 && p.clearFields.length === 0 ? (
              <p className="text-muted-foreground">{t("none")}</p>
            ) : (
              <ul className="list-disc pl-5">
                {p.deleteNow.map((x) => (
                  <li key={x.id}>{x.label}</li>
                ))}
                {p.clearFields.length > 0 && <li>{t("fields", { fields: p.clearFields.join(", ") })}</li>}
              </ul>
            )}
          </section>
          <section aria-label={t("bucketRestrict")}>
            <h3 className="font-medium">{t("bucketRestrict")}</h3>
            {p.restrict.length === 0 ? (
              <p className="text-muted-foreground">{t("none")}</p>
            ) : (
              <ul className="list-disc pl-5">
                {p.restrict.slice(0, 20).map((x) => (
                  <li key={x.id}>{t("retainedLine", { label: x.label, date: formatDate(x.retentionUntil) })}</li>
                ))}
                {p.restrict.length > 20 && <li>{t("more", { count: p.restrict.length - 20 })}</li>}
              </ul>
            )}
          </section>
          <p>
            {p.deleteContact ? t("contactDeleted") : t("purgeAt", { date: formatDate(p.scheduledPurgeAt ?? null) })}
          </p>
        </div>
      )}
    </ConfirmDialog>
  );
}
