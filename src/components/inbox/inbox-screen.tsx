"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  CameraIcon,
  FolderUpIcon,
  InboxIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { uploadFile } from "@/components/banking/shared";
import { formatDateTime, useCan, useRun, useUrlState } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { PageBody, StatusFilter } from "@/components/layout/list-layout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { money } from "@/components/vouchers/voucher-shared";
import { INBOX_FILTERS, type InboxFilter } from "@/domain/inbox/status";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { filesFromDataTransfer, type PickedFile, precheckFiles } from "./drop-files";
import { InboxItem, InboxStatusBadge, sourceKey, useFlagLabel } from "./inbox-item";

/**
 * Posteingang (F06 §6.1, 04 §4.5): filter chips with counts, upload button and drop zone (files and folders, one
 * item per file, INB-001/002), mobile camera capture of several pages into one item (INB-003), list and the selected
 * item with viewer and actions. Keyboard: `j`/`k` next/previous, `Enter` opens the draft.
 */

type Row = NonNullable<ReturnType<typeof useRows>>[number];
const useRows = (filter: InboxFilter) => useAuthedQuery(api.inbox.list, { filter });

export const inboxPath = (id: string) => `/posteingang?id=${id}` as Route;

export function InboxScreen() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InboxScreenInner />
    </ConvexGuard>
  );
}

/** Upload of one capture (one or more pages = one inbox item). */
function useInboxUpload() {
  const generateUploadUrl = useMutation(api.inbox.generateUploadUrl);
  const ingest = useAction(api.inbox.ingest);
  return async (files: readonly File[], via: "upload" | "app") => {
    const stored: { storageId: Id<"_storage">; name: string; clientCapturedAt: number }[] = [];
    for (const f of files) {
      stored.push({
        storageId: await uploadFile(await generateUploadUrl({}), f),
        name: f.name,
        clientCapturedAt: f.lastModified || Date.now(),
      });
    }
    return ingest({ files: stored, via });
  };
}

function InboxScreenInner() {
  const t = useTranslations("inbox");
  const url = useUrlState();
  const router = useRouter();
  const filter: InboxFilter = (INBOX_FILTERS as readonly string[]).includes(url.get("filter"))
    ? (url.get("filter") as InboxFilter)
    : "all";
  // Only a well-formed Convex id reaches the query (a garbage ?id= would fail argument validation).
  const rawSelected = url.get("id");
  const selectedId = /^[0-9a-zA-Z]{16,64}$/.test(rawSelected) ? rawSelected : "";
  const rows = useRows(filter);
  const counts = useAuthedQuery(api.inbox.counts, {});
  const detail = useAuthedQuery(api.inbox.get, { id: selectedId as Id<"inboxItems"> }, selectedId !== "");
  const canWrite = useCan("vouchers.write");
  const upload = useInboxUpload();
  const reject = useMutation(api.inbox.reject);
  const override = useMutation(api.inbox.overrideDuplicate);
  const createDraft = useMutation(api.inbox.createDraft);
  const split = useMutation(api.inbox.split);
  const merge = useMutation(api.inbox.merge);
  const run = useRun();
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [capturing, setCapturing] = useState(url.get("capture") === "1");

  // „📷 Beleg“ in the mobile tab bar links here with ?capture=1 (INB-003).
  const captureParam = url.get("capture");
  useEffect(() => {
    if (captureParam === "1") setCapturing(true);
  }, [captureParam]);

  const uploadEach = async (picked: readonly PickedFile[]) => {
    const { accepted, rejected } = await precheckFiles(picked);
    if (accepted.length === 0 && rejected.length === 0) return;
    setBusy(true);
    let done = 0;
    let last: string | null = null;
    const failed = [...rejected];
    for (const p of accepted) {
      try {
        const r = await upload([p.file], "upload");
        done++;
        last = r.id;
      } catch (e) {
        failed.push({ name: p.path, message: e instanceof Error ? e.message : String(e) });
      }
    }
    setBusy(false);
    if (done > 0) toast.success(t("uploaded", { count: done }));
    if (failed.length > 0) {
      toast.warning(t("notAccepted", { count: failed.length }), {
        description: failed
          .slice(0, 10)
          .map((f) => `${f.name}: ${f.message}`)
          .join("\n"),
      });
    }
    if (done === 1 && last) router.replace(url.hrefWith({ id: last }), { scroll: false });
  };

  const index = rows?.findIndex((r) => r.id === selectedId) ?? -1;
  const search = useSearchParams().toString();
  // biome-ignore lint/correctness/useExhaustiveDependencies: `url` is a new object per render; `search` is its identity.
  const hrefWith = useCallback(url.hrefWith, [search]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (target?.closest("input, textarea, select, [contenteditable=true], [role=dialog]")) return;
      if (!rows || rows.length === 0) return;
      if (e.key === "j" || e.key === "k") {
        const next = e.key === "j" ? Math.min(rows.length - 1, index + 1) : Math.max(0, index - 1);
        const row = rows[next];
        if (row) {
          e.preventDefault();
          router.replace(hrefWith({ id: row.id }), { scroll: false });
        }
      } else if (e.key === "Enter" && detail?.voucherId) {
        e.preventDefault();
        router.push(`/belege/${detail.voucherId}` as Route);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rows, index, detail?.voucherId, router, hrefWith]);

  const filters = (
    <StatusFilter
      label={t("filtersLabel")}
      current={filter}
      options={INBOX_FILTERS.map((f) => ({
        value: f,
        label: t(`filters.${f}`),
        ...(counts ? { count: counts[f] } : {}),
        href: url.hrefWith({ filter: f === "all" ? "" : f, id: "" }),
      }))}
    />
  );

  const toolbar = canWrite && (
    <div className="flex flex-wrap gap-2">
      <Button className="h-11 md:h-9" disabled={busy} onClick={() => fileRef.current?.click()}>
        <UploadIcon aria-hidden="true" />
        {busy ? t("uploading") : t("upload")}
      </Button>
      <Button variant="outline" className="h-11 md:h-9" disabled={busy} onClick={() => folderRef.current?.click()}>
        <FolderUpIcon aria-hidden="true" />
        {t("uploadFolder")}
      </Button>
      <Button variant="outline" className="h-11 md:h-9" disabled={busy} onClick={() => setCapturing(true)}>
        <CameraIcon aria-hidden="true" />
        {t("camera")}
      </Button>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="application/pdf,image/*,.xml,application/xml,text/xml,.eml,message/rfc822"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="inbox-file-input"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void uploadEach(files.map((f) => ({ file: f, path: f.name })));
        }}
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="inbox-folder-input"
        {...({ webkitdirectory: "" } as Record<string, string>)}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          void uploadEach(
            files.map((f) => ({
              file: f,
              path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
            })),
          );
        }}
      />
    </div>
  );

  const list = (
    <section
      className={cn(
        "flex min-h-40 flex-col gap-2 rounded-lg transition-colors",
        dragging && "outline-2 outline-primary outline-dashed",
      )}
      data-testid="inbox-drop-zone"
      aria-label={t("dropZone")}
      onDragOver={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        void filesFromDataTransfer(e.dataTransfer).then(uploadEach);
      }}
    >
      {canWrite && <p className="hidden text-muted-foreground text-xs @3xl/main:block">{t("dropHint")}</p>}
      {rows === undefined ? (
        <div className="h-64" aria-busy="true" />
      ) : rows.length === 0 ? (
        <EmptyState icon={InboxIcon} title={filter === "all" ? t("empty") : t("noResults")} />
      ) : (
        <ul className="flex flex-col gap-2" aria-label={t("listLabel")} data-testid="inbox-list">
          {rows.map((r) => (
            <InboxRowCard key={r.id} row={r} active={r.id === selectedId} href={url.hrefWith({ id: r.id })} />
          ))}
        </ul>
      )}
    </section>
  );

  const actions = detail
    ? {
        reject: async (reason: Parameters<typeof reject>[0]["reason"], text: string) =>
          (
            await run(
              () => reject({ id: detail.id, reason, ...(text.trim() ? { text: text.trim() } : {}) }),
              t("rejected"),
            )
          ).ok,
        overrideDuplicate: async (reason: string) =>
          (await run(() => override({ id: detail.id, reason }), t("overridden"))).ok,
        createDraft: async () => {
          const r = await run(() => createDraft({ id: detail.id }));
          if (r.ok) router.push(`/belege/${r.value}` as Route);
        },
        split: async (groups: number[][]) => {
          const r = await run(() => split({ id: detail.id, groups }), t("splitDone", { count: groups.length }));
          if (r.ok && r.value.ids[0]) router.replace(url.hrefWith({ id: r.value.ids[0] }), { scroll: false });
          return r.ok;
        },
        merge: async (ids: string[]) => {
          const r = await run(
            () => merge({ ids: [detail.id, ...(ids as Id<"inboxItems">[])] }),
            t("mergeDone", { count: ids.length + 1 }),
          );
          if (r.ok) router.replace(url.hrefWith({ id: r.value.id }), { scroll: false });
          return r.ok;
        },
      }
    : null;
  const mergeCandidates = (rows ?? [])
    .filter((r) => r.status === "new" || r.status === "needs_review" || r.status === "duplicate")
    .map((r) => ({
      id: r.id as string,
      label: `${r.supplierName ?? r.subject ?? r.fileName ?? t("item.untitled")} · ${formatDateTime(r.receivedAt)}`,
    }));

  return (
    <PageBody>
      {filters}
      {toolbar}
      <div className="grid gap-6 @4xl/main:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
        <div className={cn(selectedId && "hidden @4xl/main:block")}>{list}</div>
        {selectedId && (
          <div className="flex min-w-0 flex-col gap-3">
            <Link
              href={url.hrefWith({ id: "" })}
              className="inline-flex min-h-11 items-center gap-1 text-sm underline @4xl/main:hidden"
            >
              <ArrowLeftIcon className="size-4" aria-hidden="true" />
              {t("backToList")}
            </Link>
            {detail === undefined ? (
              <div className="h-96" aria-busy="true" />
            ) : detail === null || !actions ? (
              <p className="text-muted-foreground text-sm">{t("notFound")}</p>
            ) : (
              <InboxItem item={detail} canWrite={canWrite} actions={actions} mergeCandidates={mergeCandidates} />
            )}
          </div>
        )}
      </div>
      {capturing && (
        <CameraCapture
          onClose={() => {
            setCapturing(false);
            if (url.get("capture")) url.set({ capture: "" });
          }}
          onUpload={async (pages) => {
            setBusy(true);
            const r = await run(() => upload(pages, "app"), t("captureUploaded", { count: pages.length }));
            setBusy(false);
            if (r.ok) {
              setCapturing(false);
              router.replace(url.hrefWith({ id: r.value.id, capture: "" }), { scroll: false });
            }
          }}
          busy={busy}
        />
      )}
    </PageBody>
  );
}

function InboxRowCard({ row, active, href }: { row: Row; active: boolean; href: Route }) {
  const t = useTranslations("inbox");
  const flagLabel = useFlagLabel();
  const title = row.supplierName ?? row.subject ?? row.fileName ?? t("item.untitled");
  return (
    <li>
      <Link
        href={href}
        scroll={false}
        aria-current={active ? "true" : undefined}
        data-item={row.id}
        className={cn(
          "flex flex-col gap-1 rounded-lg border p-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50",
          active && "border-primary bg-primary/5",
        )}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="min-w-0 break-words font-medium">{title}</span>
          <span className="shrink-0 tabular-nums">
            {row.grossCents !== null ? money(row.grossCents, row.currency ?? "EUR") : ""}
          </span>
        </span>
        <span className="text-muted-foreground text-xs">
          {t(`source.${sourceKey(row.source)}`)} · {formatDateTime(row.receivedAt)}
          {row.fileCount > 1 ? ` · ${t("files", { count: row.fileCount })}` : ""}
        </span>
        <span className="flex flex-wrap gap-1">
          <InboxStatusBadge status={row.status} label={row.statusLabel} />
          {row.einvoiceOk !== null && (
            <span
              className={cn(
                "inline-flex h-6 items-center rounded-full border px-2 text-xs",
                row.einvoiceOk ? "border-success/30 text-success" : "border-danger/30 text-danger",
              )}
            >
              {row.einvoiceOk ? t("item.einvoiceOk") : t("item.einvoiceFaulty")}
            </span>
          )}
          {row.flags.slice(0, 3).map((f) => (
            <span key={f} className="inline-flex h-6 items-center rounded-full border px-2 text-xs">
              {flagLabel(f)}
            </span>
          ))}
          {row.confidence !== null && (
            <span className="inline-flex h-6 items-center text-muted-foreground text-xs tabular-nums">
              {t("item.confidence", { percent: Math.round(row.confidence * 100) })}
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

/**
 * INB-003 multi-page camera capture: each photo is one page; pages can be reordered or removed; „Hochladen“ stores
 * the unaltered camera images as the originals of ONE inbox item, in this order.
 */
export function CameraCapture({
  onClose,
  onUpload,
  busy,
}: {
  onClose: () => void;
  onUpload: (pages: File[]) => Promise<void>;
  busy: boolean;
}) {
  const t = useTranslations("inbox.capture");
  const tCommon = useTranslations("common");
  const inputRef = useRef<HTMLInputElement>(null);
  const [pages, setPages] = useState<{ file: File; url: string }[]>([]);
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(
    () => () => {
      for (const p of pagesRef.current) URL.revokeObjectURL(p.url);
    },
    [],
  );
  const move = (from: number, to: number) =>
    setPages((ps) => {
      if (to < 0 || to >= ps.length) return ps;
      const next = [...ps];
      const [p] = next.splice(from, 1);
      if (p) next.splice(to, 0, p);
      return next;
    });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <Button variant="outline" className="h-11" onClick={() => inputRef.current?.click()}>
          <CameraIcon aria-hidden="true" />
          {pages.length === 0 ? t("take") : t("takeMore")}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*,application/pdf"
          capture="environment"
          multiple
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
          data-testid="camera-input"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = "";
            setPages((ps) => [...ps, ...files.map((f) => ({ file: f, url: URL.createObjectURL(f) }))]);
          }}
        />
        {pages.length > 0 && (
          <ol className="flex flex-col gap-2" aria-label={t("pages")}>
            {pages.map((p, i) => (
              <li key={p.url} className="flex items-center gap-2 rounded-md border p-2 text-sm">
                {p.file.type.startsWith("image/") ? (
                  // biome-ignore lint/performance/noImgElement: local object URL preview.
                  <img src={p.url} alt="" className="size-14 shrink-0 rounded object-cover" />
                ) : (
                  <span className="flex size-14 shrink-0 items-center justify-center rounded bg-muted text-xs">
                    PDF
                  </span>
                )}
                <span className="min-w-0 flex-1">{t("page", { n: i + 1 })}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-9"
                  aria-label={t("up", { n: i + 1 })}
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                >
                  <ArrowUpIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-9"
                  aria-label={t("down", { n: i + 1 })}
                  disabled={i === pages.length - 1}
                  onClick={() => move(i, i + 1)}
                >
                  <ArrowDownIcon aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-11 md:size-9"
                  aria-label={t("remove", { n: i + 1 })}
                  onClick={() => setPages((ps) => ps.filter((_, j) => j !== i))}
                >
                  <Trash2Icon aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            className="h-11 md:h-9"
            disabled={pages.length === 0 || busy}
            onClick={() => void onUpload(pages.map((p) => p.file))}
          >
            {t("upload", { count: pages.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
