"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useConvex, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { DownloadIcon, PaperclipIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { formatDateTime, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ATTACHMENT_MAX_FILES,
  attachmentIssue,
  EVIDENCE_KINDS,
  EVIDENCE_LABEL_DE,
  type EvidenceKind,
  XML_EMBEDDABLE_MIMES,
} from "@/domain/documents/attachments";

type Files = NonNullable<FunctionReturnType<typeof api.invoices.get>>["files"];

async function upload(url: string, file: File): Promise<Id<"_storage">> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload fehlgeschlagen (${res.status})`);
  return ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
}

const kb = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("de-DE")} KB`;

/**
 * F04 DOC-18 attachments (editable on drafts, frozen after finalisation) and INV-30 „Nachweise“ (proofs appended to
 * finalised documents, with the `proof_missing_igl` / `proof_missing_export` warning).
 */
export function AttachmentsSection({ id, draft, files }: { id: Id<"salesDocuments">; draft: boolean; files: Files }) {
  const t = useTranslations("invoices.attachments");
  const canWrite = useCan("documents.write");
  const headingId = useId();
  return (
    <section className="flex flex-col gap-3 rounded-xl border p-4" aria-labelledby={headingId}>
      <h2 id={headingId} className="font-semibold text-base">
        {t("title")}
      </h2>
      {files.proofWarning && (
        <p
          role="alert"
          data-code={files.proofWarning.code}
          className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300"
        >
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {files.proofWarning.message}
        </p>
      )}
      <AttachmentList id={id} draft={draft && canWrite} files={files} />
      {draft && canWrite && <AttachmentUpload id={id} count={files.attachments.length} />}
      {!draft && <p className="text-muted-foreground text-xs">{t("frozen")}</p>}
      {!draft && <EvidenceList id={id} files={files} canWrite={canWrite} />}
    </section>
  );
}

function useDownload(id: Id<"salesDocuments">) {
  const convex = useConvex();
  const run = useRun();
  return (sha256: string) =>
    run(async () => {
      const url = await convex.query(api.invoices.attachmentUrl, { id, sha256 });
      if (url) window.open(url, "_blank", "noopener");
    });
}

function AttachmentList({ id, draft, files }: { id: Id<"salesDocuments">; draft: boolean; files: Files }) {
  const t = useTranslations("invoices.attachments");
  const run = useRun();
  const update = useMutation(api.invoices.updateAttachment);
  const download = useDownload(id);
  if (files.attachments.length === 0) return <p className="text-muted-foreground text-sm">{t("empty")}</p>;
  return (
    <ul className="flex flex-col gap-2 text-sm" data-testid="document-attachments">
      {files.attachments.map((a) => (
        <li key={a.sha256} className="flex flex-col gap-1 rounded-lg border p-2 @md:flex-row @md:items-center">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <PaperclipIcon className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">{a.name}</span>
            <span className="text-muted-foreground text-xs">{kb(a.bytes)}</span>
          </span>
          <label className="flex min-h-11 items-center gap-2 @md:min-h-0">
            <input
              type="checkbox"
              checked={a.includeInExport}
              disabled={!draft}
              onChange={(e) => run(() => update({ id, sha256: a.sha256, includeInExport: e.target.checked }))}
            />
            {t("includeInExport")}
          </label>
          {XML_EMBEDDABLE_MIMES.includes(a.mime) && (
            <label className="flex min-h-11 items-center gap-2 @md:min-h-0">
              <input
                type="checkbox"
                checked={a.embedInXml}
                disabled={!draft}
                onChange={(e) => run(() => update({ id, sha256: a.sha256, embedInXml: e.target.checked }))}
              />
              {t("embedInXml")}
            </label>
          )}
          <span className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-11 @md:size-8"
              aria-label={t("download", { name: a.name })}
              onClick={() => download(a.sha256)}
            >
              <DownloadIcon aria-hidden="true" />
            </Button>
            {draft && (
              <Button
                variant="ghost"
                size="icon"
                className="size-11 @md:size-8"
                aria-label={t("remove", { name: a.name })}
                onClick={() => run(() => update({ id, sha256: a.sha256, remove: true }), t("removed"))}
              >
                <Trash2Icon aria-hidden="true" />
              </Button>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AttachmentUpload({ id, count }: { id: Id<"salesDocuments">; count: number }) {
  const t = useTranslations("invoices.attachments");
  const run = useRun();
  const uploadUrl = useMutation(api.invoices.generateAttachmentUploadUrl);
  const add = useMutation(api.invoices.addAttachment);
  const inputId = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const issue = attachmentIssue(count, { name: file.name, mime: file.type, bytes: file.size });
    setError(issue);
    if (issue) return;
    await run(async () => add({ id, storageId: await upload(await uploadUrl({}), file), name: file.name }), t("added"));
    if (ref.current) ref.current.value = "";
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={inputId} className="font-medium text-sm">
        {t("add", { max: ATTACHMENT_MAX_FILES })}
      </label>
      <Input
        id={inputId}
        ref={ref}
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.xlsx,.csv,.txt"
        disabled={count >= ATTACHMENT_MAX_FILES}
        aria-describedby={`${inputId}-hint`}
        onChange={(e) => onFile(e.target.files?.[0])}
      />
      <p id={`${inputId}-hint`} className="text-muted-foreground text-xs">
        {t("hint")}
      </p>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}

function EvidenceList({ id, files, canWrite }: { id: Id<"salesDocuments">; files: Files; canWrite: boolean }) {
  const t = useTranslations("invoices.attachments");
  const download = useDownload(id);
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <h3 className="font-medium text-sm">{t("evidenceTitle")}</h3>
      <p className="text-muted-foreground text-xs">{t("evidenceHint")}</p>
      {files.evidence.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="document-evidence">
          {files.evidence.map((e) => (
            <li key={`${e.sha256}-${e.addedAt}`} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{EVIDENCE_LABEL_DE[e.kind]}</span>
              <span className="truncate">{e.name}</span>
              <span className="text-muted-foreground text-xs">{formatDateTime(e.addedAt)}</span>
              {e.note && <span className="text-muted-foreground text-xs">· {e.note}</span>}
              <Button
                variant="ghost"
                size="icon"
                className="size-11 @md:size-8"
                aria-label={t("download", { name: e.name })}
                onClick={() => download(e.sha256)}
              >
                <DownloadIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {canWrite && <EvidenceUpload id={id} />}
    </div>
  );
}

function EvidenceUpload({ id }: { id: Id<"salesDocuments"> }) {
  const t = useTranslations("invoices.attachments");
  const run = useRun();
  const uploadUrl = useMutation(api.invoices.generateAttachmentUploadUrl);
  const add = useMutation(api.invoices.addEvidence);
  const kindId = useId();
  const noteId = useId();
  const fileId = useId();
  const [kind, setKind] = useState<EvidenceKind>("gelangensbestaetigung");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return setError(t("fileMissing"));
    const issue = attachmentIssue(0, { name: file.name, mime: file.type, bytes: file.size });
    setError(issue);
    if (issue) return;
    setBusy(true);
    const r = await run(
      async () =>
        add({
          id,
          storageId: await upload(await uploadUrl({}), file),
          name: file.name,
          kind,
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      t("evidenceAdded"),
    );
    setBusy(false);
    if (r.ok) {
      setFile(null);
      setNote("");
      (e.target as HTMLFormElement).reset();
    }
  };
  return (
    <form className="grid gap-2 @md:grid-cols-[auto_1fr_1fr_auto] @md:items-end" onSubmit={submit}>
      <div className="flex flex-col gap-1">
        <label htmlFor={kindId} className="text-sm">
          {t("kind")}
        </label>
        <select
          id={kindId}
          className={selectClass}
          value={kind}
          onChange={(e) => setKind(e.target.value as EvidenceKind)}
        >
          {EVIDENCE_KINDS.map((k) => (
            <option key={k} value={k}>
              {EVIDENCE_LABEL_DE[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={fileId} className="text-sm">
          {t("file")}
        </label>
        <Input
          id={fileId}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg,.xlsx,.csv,.txt"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={noteId} className="text-sm">
          {t("note")}
        </label>
        <Input id={noteId} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button type="submit" className="h-11 @md:h-9" disabled={busy}>
        {t("evidenceAdd")}
      </Button>
      {error && (
        <p role="alert" className="text-destructive text-sm @md:col-span-4">
          {error}
        </p>
      )}
    </form>
  );
}
