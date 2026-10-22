"use client";

import type { Id } from "@convex/_generated/dataModel";
import { CameraIcon, FileIcon, PlusIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { ConfirmDialog, formatDateTime, useRun } from "@/components/catalog/shared";
import { Button } from "@/components/ui/button";
import { ReasonField } from "./voucher-payment";
import { useVoucherUpload } from "./voucher-shared";

export interface VoucherFileView {
  index: number;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  pages: number | null;
  capturedAt: number;
  replacedBy: number | null;
  replaceReason: string | null;
  /** VOU-124 „Bildqualität niedrig“ (German text from the server). */
  qualityWarning?: string | null;
  url: string | null;
}

/**
 * Originals (VOU-120…122, GOBD-08): name, size, capture time and SHA-256; „Ersetzen“ adds a new version and keeps
 * the old file retrievable (a reason is required once the voucher is booked); after the lock only additions.
 */
export function VoucherFiles({
  id,
  files,
  eigenbelegFile,
  bewirtungFile,
  canAdd,
  canReplace,
  reasonRequired,
}: {
  id: Id<"vouchers">;
  files: readonly VoucherFileView[];
  eigenbelegFile?: { name: string; sha256: string; url: string | null } | null;
  bewirtungFile?: { name: string; sha256: string; url: string | null } | null;
  canAdd: boolean;
  canReplace: boolean;
  reasonRequired: boolean;
}) {
  const t = useTranslations("vouchers.files");
  const upload = useVoucherUpload();
  const run = useRun();
  const headingId = useId();
  const addRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<{ index: number; file?: File } | null>(null);
  const [reason, setReason] = useState("");

  const doReplace = async (index: number, file: File, why: string) => {
    const r = await run(
      () => upload(file, { voucherId: id, replaceIndex: index, ...(why ? { reason: why } : {}) }),
      t("added"),
    );
    if (r.ok) {
      setReplacing(null);
      setReason("");
    }
  };
  const extras = [
    eigenbelegFile ? { key: "eigenbeleg", label: t("eigenbelegFile"), f: eigenbelegFile } : null,
    bewirtungFile ? { key: "bewirtung", label: t("bewirtungFile"), f: bewirtungFile } : null,
  ].filter((x) => x !== null);

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border p-4"
      data-testid="voucher-files"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} className="font-semibold text-base">
          {t("title")}
        </h2>
        {canAdd && (
          <>
            <Button variant="outline" className="h-11 md:h-9" onClick={() => addRef.current?.click()}>
              <PlusIcon aria-hidden="true" />
              {t("add")}
            </Button>
            <input
              ref={addRef}
              type="file"
              accept="application/pdf,image/*,.xml,application/xml"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) void run(() => upload(file, { voucherId: id }), t("added"));
              }}
            />
          </>
        )}
      </div>
      {files.length === 0 && extras.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("none")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f) => (
            <li
              key={f.index}
              className="flex flex-wrap items-start justify-between gap-2 rounded-md border p-2 text-sm"
              data-replaced={f.replacedBy !== null || undefined}
            >
              <div className="flex min-w-0 items-start gap-2">
                <FileIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="flex min-w-0 flex-col">
                  {f.url ? (
                    <a href={f.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                      {f.name}
                    </a>
                  ) : (
                    <span className="font-medium">{f.name}</span>
                  )}
                  <span className="text-muted-foreground text-xs">
                    {(f.bytes / 1024).toLocaleString("de-DE", { maximumFractionDigits: 0 })} KB ·{" "}
                    {t("captured", { date: formatDateTime(f.capturedAt) })}
                  </span>
                  <span className="break-all font-mono text-muted-foreground text-xs">
                    {t("sha", { hash: f.sha256 })}
                  </span>
                  {f.qualityWarning && f.replacedBy === null && (
                    <span className="flex items-start gap-1 text-xs" data-testid="quality-low">
                      <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden="true" />
                      <span>
                        <span className="sr-only">{t("qualityLow")}: </span>
                        {f.qualityWarning}
                      </span>
                    </span>
                  )}
                  {f.replacedBy !== null && (
                    <span className="text-muted-foreground text-xs">
                      {t("replacedBy", { n: f.replacedBy + 1 })}
                      {f.replaceReason ? ` – ${f.replaceReason}` : ""}
                    </span>
                  )}
                </div>
              </div>
              {canReplace && f.replacedBy === null && (
                <Button
                  variant="ghost"
                  className="h-11 md:h-9"
                  onClick={() => {
                    setReplacing({ index: f.index });
                    replaceRef.current?.click();
                  }}
                >
                  {f.qualityWarning ? <CameraIcon aria-hidden="true" /> : <RefreshCwIcon aria-hidden="true" />}
                  {f.qualityWarning ? t("retake") : t("replace")}
                </Button>
              )}
            </li>
          ))}
          {extras.map((x) => (
            <li key={x.key} className="flex flex-col rounded-md border p-2 text-sm">
              {x.f.url ? (
                <a href={x.f.url} target="_blank" rel="noreferrer" className="font-medium hover:underline">
                  {x.label}: {x.f.name}
                </a>
              ) : (
                <span className="font-medium">
                  {x.label}: {x.f.name}
                </span>
              )}
              <span className="break-all font-mono text-muted-foreground text-xs">
                {t("sha", { hash: x.f.sha256 })}
              </span>
            </li>
          ))}
        </ul>
      )}
      <input
        ref={replaceRef}
        type="file"
        accept="application/pdf,image/*,.xml,application/xml"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file || !replacing) return;
          if (reasonRequired) setReplacing({ index: replacing.index, file });
          else void doReplace(replacing.index, file, "");
        }}
      />
      {replacing?.file && (
        <ConfirmDialog
          title={t("replace")}
          description={t("replaceHint")}
          confirmLabel={t("replace")}
          confirmDisabled={reason.trim().length < 5}
          onClose={() => setReplacing(null)}
          onConfirm={() => doReplace(replacing.index, replacing.file as File, reason.trim())}
        >
          <ReasonField label={t("replaceReason")} value={reason} onChange={setReason} />
        </ConfirmDialog>
      )}
    </section>
  );
}
