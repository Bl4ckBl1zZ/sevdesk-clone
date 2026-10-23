"use client";

import type { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import type { FunctionReturnType } from "convex/server";
import { CircleAlertIcon, ExternalLinkIcon, FileIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog, formatDateTime, selectClass } from "@/components/catalog/shared";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ReasonField } from "@/components/vouchers/voucher-payment";
import { money } from "@/components/vouchers/voucher-shared";
import type { ReceivedInvoice } from "@/domain/einvoice/received";
import { CATEGORY_LABEL_DE } from "@/domain/einvoice/verdict";
import { REJECT_REASON_LABEL_DE, REJECT_REASONS, type RejectReason } from "@/domain/inbox/status";
import { cn } from "@/lib/utils";
import { EinvoiceView } from "./einvoice-view";
import { type MergeCandidate, MergeDialog, SPLIT_MERGE_OPEN, SplitDialog, SplitMergeLinks } from "./inbox-split-merge";

/**
 * One Posteingang item (F06 §6.1): source, status, flags and ⚑ warnings; the viewer (PDF/image, or for an
 * E-Rechnung the tabs „Darstellung | Prüfbericht | XML | Anlagen“); actions „Beleg öffnen“, „Ablehnen“ (INB-010)
 * „Trotzdem verarbeiten“ (VOU-050) and „Aufteilen“ / „Zusammenführen“ (INB-009). All supplier/mail/OCR text is rendered as escaped text (INB-030).
 */

export type InboxDetail = NonNullable<FunctionReturnType<typeof api.inbox.get>>;

const SOURCE_KEYS = ["email", "upload", "app", "api", "mcp"] as const;
const FLAG_KEYS = [
  "unknown_sender",
  "sender_auth_failed",
  "not_einvoice",
  "einvoice_faulty",
  "low_confidence",
  "attachment_too_large",
  "mail_unparseable",
  "ocr_pending",
  "pdf_encrypted",
  "kleinunternehmer_supplier",
  "no_attachment",
] as const;
type FlagKey = (typeof FLAG_KEYS)[number];
const isFlag = (f: string): f is FlagKey => (FLAG_KEYS as readonly string[]).includes(f);

export const shortHash = (sha256: string) => `${sha256.slice(0, 4)}…`;

const STATUS_TONES: Record<string, string> = {
  new: "border-info/30 bg-info/10 text-info",
  processing: "border-info/30 bg-transparent text-info",
  needs_review: "border-warning bg-transparent text-warning",
  converted: "border-success/30 bg-success/10 text-success",
  rejected: "border-border bg-muted text-foreground line-through",
  duplicate: "border-danger/30 bg-danger/10 text-danger",
  superseded: "border-border bg-muted text-muted-foreground",
};

export function InboxStatusBadge({ status, label }: { status: string; label: string }) {
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex h-6 items-center whitespace-nowrap rounded-full border px-2 font-medium text-xs",
        STATUS_TONES[status] ?? STATUS_TONES.new,
      )}
    >
      {label}
    </span>
  );
}

export function useFlagLabel() {
  const t = useTranslations("inbox.flags");
  return (f: string) => (isFlag(f) ? t(f) : f);
}

export function sourceKey(source: string): (typeof SOURCE_KEYS)[number] {
  return (SOURCE_KEYS as readonly string[]).includes(source) ? (source as (typeof SOURCE_KEYS)[number]) : "upload";
}

export interface InboxItemActions {
  reject: (reason: RejectReason, text: string) => Promise<boolean>;
  overrideDuplicate: (reason: string) => Promise<boolean>;
  createDraft: () => Promise<void>;
  /** INB-009: `groups` = file indexes (role `original`) per new item. */
  split?: (groups: number[][]) => Promise<boolean>;
  /** INB-009: merge the current item with `ids` (current item first). */
  merge?: (ids: string[]) => Promise<boolean>;
}

export function InboxItem({
  item,
  canWrite,
  actions,
  mergeCandidates = [],
}: {
  item: InboxDetail;
  canWrite: boolean;
  actions: InboxItemActions;
  mergeCandidates?: readonly MergeCandidate[];
}) {
  const t = useTranslations("inbox.item");
  const tSource = useTranslations("inbox.source");
  const flagLabel = useFlagLabel();
  const headingId = useId();
  const [rejecting, setRejecting] = useState(false);
  const [overriding, setOverriding] = useState(false);
  const [splitMerge, setSplitMerge] = useState<"split" | "merge" | null>(null);
  const open = item.status !== "converted" && item.status !== "rejected" && item.status !== "superseded";
  const voucherBooked = item.voucherId !== null && item.voucherStatus !== null && item.voucherStatus !== "draft";
  const canSplitMerge = (SPLIT_MERGE_OPEN as readonly string[]).includes(item.status) && !voucherBooked;
  const originalCount = item.files.filter((f) => f.role === "original").length;
  const title = item.supplierName ?? item.subject ?? item.fileName ?? t("untitled");

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-4" data-testid="inbox-item">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <InboxStatusBadge status={item.status} label={item.statusLabel} />
          <span className="text-muted-foreground text-xs">{tSource(sourceKey(item.source))}</span>
          {item.einvoiceOk !== null && (
            <span
              className={cn(
                "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-xs",
                item.einvoiceOk ? "border-success/30 text-success" : "border-danger/30 text-danger",
              )}
            >
              {item.einvoiceOk ? t("einvoiceOk") : t("einvoiceFaulty")}
            </span>
          )}
          {item.flags.map((f) => (
            <span key={f} className="inline-flex h-6 items-center rounded-full border px-2 text-xs" data-flag={f}>
              {flagLabel(f)}
            </span>
          ))}
          {item.confidence !== null && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {t("confidence", { percent: Math.round(item.confidence * 100) })}
            </span>
          )}
        </div>
        <h2 id={headingId} className="break-words font-semibold text-lg">
          {title}
        </h2>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("receivedAt")}</dt>
          <dd className="tabular-nums">{formatDateTime(item.receivedAt)}</dd>
          {item.from && (
            <>
              <dt className="text-muted-foreground">{t("from")}</dt>
              <dd className="break-all">{item.from}</dd>
            </>
          )}
          {item.subject && (
            <>
              <dt className="text-muted-foreground">{t("subject")}</dt>
              <dd className="break-words">{item.subject}</dd>
            </>
          )}
          {item.grossCents !== null && (
            <>
              <dt className="text-muted-foreground">{t("amount")}</dt>
              <dd className="tabular-nums">{money(item.grossCents, item.currency ?? "EUR")}</dd>
            </>
          )}
          {item.rejectReason && (
            <>
              <dt className="text-muted-foreground">{t("rejectReason")}</dt>
              <dd>
                {REJECT_REASON_LABEL_DE[item.rejectReason as RejectReason] ?? item.rejectReason}
                {item.rejectText ? ` – ${item.rejectText}` : ""}
              </dd>
            </>
          )}
          {item.retentionUntil && (
            <>
              <dt className="text-muted-foreground">{t("retentionUntil")}</dt>
              <dd className="tabular-nums">{item.retentionUntil}</dd>
            </>
          )}
        </dl>
      </header>

      {item.warnings.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label={t("warnings")}>
          {item.warnings.map((w) => (
            <li
              key={w.code}
              data-code={w.code}
              className={cn(
                "flex items-start gap-2 rounded-md border p-2 text-sm",
                w.acknowledge ? "border-warning/50" : "border-border",
              )}
            >
              {w.acknowledge ? (
                <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
              ) : (
                <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span>
                {w.acknowledge && <span className="sr-only">{t("warningAck")}: </span>}
                {w.message}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <div className="flex flex-wrap gap-2">
          {item.voucherId ? (
            <Link
              href={`/belege/${item.voucherId}` as Route}
              className={cn(buttonVariants(), "h-11 md:h-9")}
              data-testid="open-draft"
            >
              <ExternalLinkIcon aria-hidden="true" />
              {item.voucherStatus === "draft" || item.voucherStatus === null ? t("openDraft") : t("openVoucher")}
            </Link>
          ) : (
            open &&
            item.status !== "processing" &&
            item.status !== "duplicate" && (
              <Button className="h-11 md:h-9" onClick={() => void actions.createDraft()}>
                {t("createDraft")}
              </Button>
            )
          )}
          {item.status === "duplicate" && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setOverriding(true)}>
              {t("override")}
            </Button>
          )}
          {canSplitMerge && actions.split && originalCount >= 2 && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setSplitMerge("split")}>
              {t("split")}
            </Button>
          )}
          {canSplitMerge && actions.merge && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setSplitMerge("merge")}>
              {t("merge")}
            </Button>
          )}
          {open && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setRejecting(true)}>
              {t("reject")}
            </Button>
          )}
        </div>
      )}
      <SplitMergeLinks item={item} />
      {item.duplicateOfInboxItemId && (
        <p className="text-sm">
          <Link href={`/posteingang?id=${item.duplicateOfInboxItemId}` as Route} className="underline">
            {t("duplicateOf")}
          </Link>
        </p>
      )}
      {item.duplicateOfVoucherId && (
        <p className="text-sm">
          <Link href={`/belege/${item.duplicateOfVoucherId}` as Route} className="underline">
            {t("duplicateOfVoucher")}
          </Link>
        </p>
      )}

      <InboxViewer item={item} />

      {item.mailText && (
        <details className="rounded-md border p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t("mailText")}</summary>
          <p className="mt-1 text-muted-foreground text-xs">{t("untrusted")}</p>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words font-sans" data-untrusted>
            {item.mailText}
          </pre>
        </details>
      )}

      {rejecting && (
        <RejectDialog
          onClose={() => setRejecting(false)}
          onReject={async (reason, text) => {
            if (await actions.reject(reason, text)) setRejecting(false);
          }}
        />
      )}
      {splitMerge === "split" && actions.split && (
        <SplitDialog
          item={item}
          onClose={() => setSplitMerge(null)}
          onSplit={async (groups) => {
            if (await actions.split?.(groups)) setSplitMerge(null);
          }}
        />
      )}
      {splitMerge === "merge" && actions.merge && (
        <MergeDialog
          candidates={mergeCandidates.filter((c) => c.id !== item.id)}
          onClose={() => setSplitMerge(null)}
          onMerge={async (ids) => {
            if (await actions.merge?.(ids)) setSplitMerge(null);
          }}
        />
      )}
      {overriding && (
        <OverrideDialog
          onClose={() => setOverriding(false)}
          onConfirm={async (reason) => {
            if (await actions.overrideDuplicate(reason)) setOverriding(false);
          }}
        />
      )}
    </section>
  );
}

function RejectDialog({
  onClose,
  onReject,
}: {
  onClose: () => void;
  onReject: (reason: RejectReason, text: string) => Promise<void>;
}) {
  const t = useTranslations("inbox.reject");
  const id = useId();
  const [reason, setReason] = useState<RejectReason>("no_business_document");
  const [text, setText] = useState("");
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      destructive
      confirmDisabled={reason === "other" && text.trim().length < 5}
      onClose={onClose}
      onConfirm={() => onReject(reason, text)}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{t("reason")}</Label>
        <select
          id={id}
          className={selectClass}
          value={reason}
          onChange={(e) => setReason(e.target.value as RejectReason)}
          data-testid="reject-reason"
        >
          {REJECT_REASONS.map((r) => (
            <option key={r} value={r}>
              {REJECT_REASON_LABEL_DE[r]}
            </option>
          ))}
        </select>
        <p className="text-muted-foreground text-xs">
          {reason === "no_business_document" ? t("retentionShort") : t("retentionLong")}
        </p>
      </div>
      <ReasonField label={reason === "other" ? t("textRequired") : t("text")} value={text} onChange={setText} />
    </ConfirmDialog>
  );
}

function OverrideDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const t = useTranslations("inbox.override");
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      confirmDisabled={reason.trim().length < 5}
      onClose={onClose}
      onConfirm={() => onConfirm(reason)}
    >
      <ReasonField label={t("reason")} value={reason} onChange={setReason} />
    </ConfirmDialog>
  );
}

// ── viewer ──────────────────────────────────────────────────────────────────────────────────────────────

type FileView = InboxDetail["files"][number];

function FilePreview({ file }: { file: FileView | undefined }) {
  const t = useTranslations("inbox.viewer");
  if (!file?.url) return <p className="text-muted-foreground text-sm">{t("noPreview")}</p>;
  if (file.mime.startsWith("image/") && file.mime !== "image/heic" && file.mime !== "image/tiff") {
    return (
      // biome-ignore lint/performance/noImgElement: signed Convex storage URL, no Next image optimisation.
      <img src={file.url} alt={t("imageAlt", { name: file.name })} className="max-h-[70dvh] w-full object-contain" />
    );
  }
  if (file.mime === "application/pdf") {
    return (
      <object
        data={file.url}
        type="application/pdf"
        className="h-[70dvh] w-full rounded-md border"
        aria-label={file.name}
      >
        <a href={file.url} target="_blank" rel="noreferrer" className="underline">
          {t("download", { name: file.name })}
        </a>
      </object>
    );
  }
  return (
    <a href={file.url} target="_blank" rel="noreferrer" className="text-sm underline">
      {t("download", { name: file.name })}
    </a>
  );
}

function FilesList({ item }: { item: InboxDetail }) {
  const t = useTranslations("inbox.viewer");
  return (
    <ul className="flex flex-col gap-2" data-testid="inbox-files">
      {item.files.map((f) => (
        <li key={f.index} className="flex flex-wrap items-start gap-2 rounded-md border p-2 text-sm">
          <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-col">
            {f.url ? (
              <a href={f.url} target="_blank" rel="noreferrer" className="break-all font-medium hover:underline">
                {f.name}
              </a>
            ) : (
              <span className="break-all font-medium">{f.name}</span>
            )}
            <span className="text-muted-foreground text-xs">
              {t(`roles.${f.role}`)} · {t("original", { hash: shortHash(f.sha256) })} · {Math.ceil(f.bytes / 1024)} KB
            </span>
            <span className="break-all font-mono text-[11px] text-muted-foreground" title={t("sha256")}>
              {f.sha256}
            </span>
          </div>
        </li>
      ))}
      {item.visualisationUrl && (
        <li className="flex flex-wrap items-start gap-2 rounded-md border border-dashed p-2 text-sm">
          <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-col">
            <a href={item.visualisationUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              {t("visualisation")}
            </a>
            <span className="text-muted-foreground text-xs">{t("rendition")}</span>
          </div>
        </li>
      )}
      {item.mailRenditionUrl && (
        <li className="flex flex-wrap items-start gap-2 rounded-md border border-dashed p-2 text-sm">
          <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="flex min-w-0 flex-col">
            <a href={item.mailRenditionUrl} target="_blank" rel="noreferrer" className="font-medium hover:underline">
              {t("mailRendition")}
            </a>
            <span className="text-muted-foreground text-xs">{t("rendition")}</span>
          </div>
        </li>
      )}
      {item.skippedAttachments.map((s) => (
        <li key={`${s.name}-${s.reason}`} className="rounded-md border border-dashed p-2 text-muted-foreground text-sm">
          {t(`skipped.${s.reason}`, { name: s.name, mb: Math.ceil(s.bytes / 1024 / 1024) })}
        </li>
      ))}
    </ul>
  );
}

function XmlSource({ url }: { url: string | null }) {
  const t = useTranslations("inbox.viewer");
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((s) => alive && setText(s))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [url]);
  if (failed || !url) return <p className="text-muted-foreground text-sm">{t("xmlUnavailable")}</p>;
  if (text === null) return <div className="h-32" aria-busy="true" />;
  return (
    <pre className="max-h-[70dvh] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs" data-untrusted>
      {text}
    </pre>
  );
}

function ValidationReport({
  validation,
}: {
  validation: NonNullable<NonNullable<InboxDetail["einvoice"]>["validation"]> | null;
}) {
  const t = useTranslations("inbox.report");
  if (!validation) return <p className="text-muted-foreground text-sm">{t("pending")}</p>;
  const category = validation.category ?? null;
  return (
    <div className="flex flex-col gap-3" data-testid="validation-report">
      <p
        role="status"
        className={cn("flex items-center gap-2 text-sm", validation.acceptable ? "text-success" : "text-danger")}
      >
        {!validation.acceptable && <CircleAlertIcon className="size-4" aria-hidden="true" />}
        {validation.unavailable
          ? t("notValidated")
          : validation.acceptable
            ? t("ok")
            : t("faulty", {
                category: category ? CATEGORY_LABEL_DE[category] : "—",
                count: validation.findings.length,
              })}
      </p>
      <p className="text-muted-foreground text-xs">
        {t("meta", { tool: validation.tool, at: formatDateTime(validation.at) })}
        {validation.reportSha256 ? ` · SHA-256 ${shortHash(validation.reportSha256)}` : ""}
      </p>
      {validation.findings.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-1 pr-2 font-medium">{t("rule")}</th>
              <th className="py-1 pr-2 font-medium">{t("category")}</th>
              <th className="py-1 font-medium">{t("text")}</th>
            </tr>
          </thead>
          <tbody>
            {validation.findings.map((f) => (
              <tr key={`${f.ruleId}-${f.text}`} className="border-b align-top">
                <td className="py-1 pr-2 font-mono text-xs">{f.ruleId}</td>
                <td className="py-1 pr-2">{CATEGORY_LABEL_DE[f.category]}</td>
                <td className="py-1 break-words">{f.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {validation.reportUrl && (
        <a href={validation.reportUrl} target="_blank" rel="noreferrer" className="text-sm underline">
          {t("download")}
        </a>
      )}
    </div>
  );
}

function InboxViewer({ item }: { item: InboxDetail }) {
  const t = useTranslations("inbox.viewer");
  const [tab, setTab] = useState("view");
  const main = item.files.find((f) => f.role === "original" && f.mime !== "message/rfc822") ?? item.files[0];
  const model = item.einvoice?.model as ReceivedInvoice | null | undefined;
  if (!item.einvoice || !model) {
    return (
      <div className="flex flex-col gap-3">
        <FilePreview file={main} />
        <FilesList item={item} />
      </div>
    );
  }
  const xml = item.files[item.einvoice.xmlFileIndex];
  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
      <TabsList className="h-auto w-full justify-start overflow-x-auto">
        {(["view", "report", "xml", "files"] as const).map((k) => (
          <TabsTrigger key={k} value={k} className="h-11 flex-none px-3 md:h-9">
            {t(`tabs.${k}`)}
          </TabsTrigger>
        ))}
      </TabsList>
      <TabsContent value="view" className="pt-3">
        <EinvoiceView invoice={model} />
      </TabsContent>
      <TabsContent value="report" className="pt-3">
        <ValidationReport validation={item.einvoice.validation} />
      </TabsContent>
      <TabsContent value="xml" className="pt-3">
        {tab === "xml" && <XmlSource url={xml?.url ?? null} />}
      </TabsContent>
      <TabsContent value="files" className="pt-3">
        <FilesList item={item} />
      </TabsContent>
    </Tabs>
  );
}

export type InboxItemId = Id<"inboxItems">;
