"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FileDownIcon, FileUpIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { uploadFile } from "@/components/banking/shared";
import { formatDateTime, selectClass, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  checkGenericMapping,
  GENERIC_STATUS_LABELS,
  GENERIC_TARGET_LABELS,
  type GenericTarget,
  genericErrorCsv,
} from "@/domain/import/generic/csv-import";
import { targetFields, targetLabel } from "@/domain/import/sevdesk/mapping";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type View = NonNullable<FunctionReturnType<typeof api.csvImports.get>>;

const STATUS_VARIANT = {
  uploaded: "outline",
  previewed: "secondary",
  running: "secondary",
  done: "default",
  failed: "destructive",
  discarded: "outline",
} as const;

/**
 * „CSV-Import (Kontakte/Produkte)“ (F09 IMP-012) on `/einstellungen/import`: target + CSV upload (encoding and
 * delimiter are detected on the server) → column mapping with saved presets → preview with the not-imported rows and
 * „Fehler-CSV herunterladen“ → commit (owner) or discard. All rules run in Convex and src/domain/import/generic.
 */
export function GenericCsvImport({ canRun, canCommit }: { canRun: boolean; canCommit: boolean }) {
  return (
    <ConvexGuard fallback={<div className="h-48" aria-busy="true" />}>
      <GenericCsvImportInner canRun={canRun} canCommit={canCommit} />
    </ConvexGuard>
  );
}

function GenericCsvImportInner({ canRun, canCommit }: { canRun: boolean; canCommit: boolean }) {
  const t = useTranslations("genericImport");
  const run = useRun();
  const targetId = useId();
  const fileId = useId();
  const list = useAuthedQuery(api.csvImports.list, {});
  const create = useMutation(api.csvImports.create);
  const uploadUrl = useMutation(api.imports.generateUploadUrl);
  const setFile = useAction(api.csvImports.setFile);
  const [target, setTarget] = useState<GenericTarget>("contacts");
  const [selected, setSelected] = useState<Id<"imports"> | null>(null);
  const [busy, setBusy] = useState(false);
  const active = selected ?? list?.find((i) => i.status !== "done" && i.status !== "discarded")?.id ?? null;

  const start = async (file: File) => {
    setBusy(true);
    try {
      const r = await run(async () => {
        const importId = await create({});
        const storageId = await uploadFile(await uploadUrl({}), file);
        await setFile({ importId, storageId, name: file.name, target });
        return importId;
      }, t("uploaded"));
      if (r.ok) setSelected(r.value);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card data-testid="generic-csv-import">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4">
        {canRun ? (
          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={targetId}>{t("target")}</Label>
              <select
                id={targetId}
                className={selectClass}
                value={target}
                onChange={(e) => setTarget(e.target.value as GenericTarget)}
              >
                {(Object.keys(GENERIC_TARGET_LABELS) as GenericTarget[]).map((k) => (
                  <option key={k} value={k}>
                    {GENERIC_TARGET_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fileId}>
                <FileUpIcon aria-hidden="true" className="size-4" /> {t("chooseFile")}
              </Label>
              <Input
                id={fileId}
                type="file"
                accept=".csv,text/csv,text/plain"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void start(f);
                }}
              />
            </div>
          </div>
        ) : null}
        <p className="text-muted-foreground text-xs">{t("limits")}</p>

        {list && list.length > 0 ? (
          <ul className="divide-y rounded-md border" aria-label={t("projects")}>
            {list.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                <span className="flex flex-col">
                  <span>
                    {i.fileName ?? t("noFile")} · {i.target ? GENERIC_TARGET_LABELS[i.target] : "–"} ·{" "}
                    {formatDateTime(i.startedAt)}
                  </span>
                  <span>
                    <Badge variant={STATUS_VARIANT[i.status]}>{t(`status.${i.status}`)}</Badge>
                  </span>
                </span>
                <Button
                  variant={active === i.id ? "secondary" : "outline"}
                  size="sm"
                  aria-pressed={active === i.id}
                  onClick={() => setSelected(i.id)}
                >
                  {t("open")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}

        {busy ? (
          <p role="status" aria-busy="true" className="text-muted-foreground text-sm">
            {t("uploading")}
          </p>
        ) : active ? (
          <GenericProject key={active} importId={active} canRun={canRun} canCommit={canCommit} />
        ) : null}
      </CardContent>
    </Card>
  );
}

function GenericProject({
  importId,
  canRun,
  canCommit,
}: {
  importId: Id<"imports">;
  canRun: boolean;
  canCommit: boolean;
}) {
  const view = useAuthedQuery(api.csvImports.get, { importId });
  if (view === undefined) return <div className="h-32" aria-busy="true" />;
  if (view === null || !view.file || !view.target) return null;
  const editable = canRun && (view.status === "uploaded" || view.status === "previewed");
  return (
    <div className="flex flex-col gap-4">
      <GenericMapping key={`${view.revision}-${view.target}`} view={view} editable={editable} />
      <GenericPreview view={view} canRun={canRun} canCommit={canCommit} editable={editable} />
    </div>
  );
}

function GenericMapping({ view, editable }: { view: View; editable: boolean }) {
  const t = useTranslations("genericImport");
  const run = useRun();
  const targetId = useId();
  const presetId = useId();
  const presetNameId = useId();
  const setMapping = useMutation(api.csvImports.setMapping);
  const setTarget = useMutation(api.csvImports.setTarget);
  const target = view.target as GenericTarget;
  const file = view.file as NonNullable<View["file"]>;
  const headers = file.headers;
  const [columns, setColumns] = useState<Record<string, string>>(view.columns);
  const [presetName, setPresetName] = useState(view.preset ?? "");
  const [savePreset, setSavePreset] = useState(false);
  const check = checkGenericMapping(target, headers, columns);
  const sample = (header: string | undefined) => {
    const i = header ? headers.indexOf(header) : -1;
    return i < 0 ? "" : (file.samples[0]?.[i] ?? "");
  };
  const applyPreset = (id: string) => {
    const p = view.presets.find((x) => x.id === id);
    if (!p) return;
    setColumns(Object.fromEntries(Object.entries(p.columns).filter(([, h]) => headers.includes(h))));
    setPresetName(p.name);
  };

  return (
    <section aria-labelledby={`${targetId}-h`} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={`${targetId}-h`} className="font-medium">
        {t("mappingTitle", { name: file.name })}
      </h3>
      <p className="text-muted-foreground text-xs">
        {t("fileInfo", { rows: file.rows, encoding: file.encoding ?? "?", delimiter: file.delimiter ?? "?" })}
      </p>
      <div className="grid gap-3 @lg:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={targetId}>{t("target")}</Label>
          <select
            id={targetId}
            className={selectClass}
            value={target}
            disabled={!editable}
            onChange={(e) => void run(() => setTarget({ importId: view.id, target: e.target.value as GenericTarget }))}
          >
            {(Object.keys(GENERIC_TARGET_LABELS) as GenericTarget[]).map((k) => (
              <option key={k} value={k}>
                {GENERIC_TARGET_LABELS[k]}
              </option>
            ))}
          </select>
        </div>
        {view.presets.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={presetId}>{t("applyPreset")}</Label>
            <select
              id={presetId}
              className={selectClass}
              defaultValue=""
              disabled={!editable}
              onChange={(e) => applyPreset(e.target.value)}
            >
              <option value="">{t("choosePreset")}</option>
              {view.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {check.missing.length > 0 ? (
        <ul className="list-disc pl-5 text-danger text-sm" role="alert">
          {check.missing.map((m) => (
            <li key={m}>{t("missingColumn", { field: targetLabel(target, m) })}</li>
          ))}
        </ul>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("targetField")}</TableHead>
            <TableHead>{t("sourceColumn")}</TableHead>
            <TableHead className="hidden @2xl:table-cell">{t("sample")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {targetFields(target).map((f) => (
            <TableRow key={f.key}>
              <TableCell>
                {f.label}
                {f.required ? (
                  <Badge variant="outline" className="ml-2">
                    {t("required")}
                  </Badge>
                ) : null}
              </TableCell>
              <TableCell>
                <select
                  aria-label={`${t("sourceColumn")}: ${f.label}`}
                  className={selectClass}
                  value={columns[f.key] ?? ""}
                  disabled={!editable}
                  onChange={(e) => setColumns((c) => ({ ...c, [f.key]: e.target.value }))}
                >
                  <option value="">{t("notMapped")}</option>
                  {[...new Set(headers.filter((h) => h !== ""))].map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </TableCell>
              <TableCell className="hidden max-w-48 truncate text-muted-foreground @2xl:table-cell">
                {sample(columns[f.key])}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editable ? (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={presetNameId}>{t("presetName")}</Label>
            <Input
              id={presetNameId}
              value={presetName}
              maxLength={80}
              onChange={(e) => setPresetName(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={savePreset} onChange={(e) => setSavePreset(e.target.checked)} />
            {t("savePreset")}
          </label>
          <Button
            variant="outline"
            className="h-11 md:h-9"
            onClick={() =>
              void run(
                () =>
                  setMapping({
                    importId: view.id,
                    columns,
                    ...(presetName.trim() ? { preset: presetName.trim() } : {}),
                    ...(savePreset ? { savePreset: true } : {}),
                  }),
                t("mappingSaved"),
              )
            }
          >
            {t("saveMapping")}
          </Button>
        </div>
      ) : null}
      <p className="text-muted-foreground text-xs">{t("presetHint")}</p>
    </section>
  );
}

function GenericPreview({
  view,
  canRun,
  canCommit,
  editable,
}: {
  view: View;
  canRun: boolean;
  canCommit: boolean;
  editable: boolean;
}) {
  const t = useTranslations("genericImport");
  const run = useRun();
  const previewAction = useAction(api.csvImports.preview);
  const commitAction = useAction(api.csvImports.commit);
  const discard = useMutation(api.imports.discard);
  const [busy, setBusy] = useState(false);
  const p = view.preview;
  const headingId = useId();

  const download = () => {
    if (!p || !view.file) return;
    const csv = genericErrorCsv(view.file.headers, p.problems);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${view.file.name.replace(/\.csv$/i, "")}-fehler.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    try {
      await run(fn, ok);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={headingId} className="font-medium">
        {t("previewTitle")}
      </h3>
      {view.status === "done" ? (
        <p role="status" className="text-sm" data-testid="generic-import-done">
          {t("done", {
            created: view.stats.created ?? 0,
            skipped: view.stats.skipped ?? 0,
            existing: view.stats.existing ?? 0,
            errors: view.stats.errors ?? 0,
          })}
        </p>
      ) : null}
      {view.error ? (
        <p role="alert" className="text-danger text-sm">
          {view.error}
        </p>
      ) : null}
      {p ? (
        <>
          <dl className="grid grid-cols-2 gap-2 text-sm @lg:grid-cols-6" data-testid="generic-import-counts">
            {(["rows", "new", "skipped", "existing", "duplicates", "errors"] as const).map((k) => (
              <div key={k} className="flex flex-col rounded-md border p-2">
                <dt className="text-muted-foreground text-xs">{t(`counts.${k}`)}</dt>
                <dd className="font-semibold tabular-nums">{p.counts[k]}</dd>
              </div>
            ))}
          </dl>
          {p.samples.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {t("samples", { names: p.samples.map((s) => s.display).join(", ") })}
            </p>
          ) : null}
          {p.problems.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("line")}</TableHead>
                    <TableHead>{t("statusColumn")}</TableHead>
                    <TableHead>{t("message")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.problems.slice(0, 100).map((r) => (
                    <TableRow key={r.line}>
                      <TableCell className="tabular-nums">{r.line}</TableCell>
                      <TableCell>
                        <Badge variant={r.status === "error" ? "destructive" : "outline"}>
                          {GENERIC_STATUS_LABELS[r.status]}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-normal">{r.message}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {p.problemsTotal > 100 ? (
                <p className="text-muted-foreground text-xs">{t("moreProblems", { n: p.problemsTotal - 100 })}</p>
              ) : null}
              <div>
                <Button variant="outline" size="sm" onClick={download}>
                  <FileDownIcon aria-hidden="true" /> {t("errorCsv")}
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : view.status !== "done" ? (
        <p className="text-muted-foreground text-sm">{t("noPreview")}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canRun && editable ? (
          <Button
            variant="secondary"
            className="h-11 md:h-9"
            disabled={busy}
            onClick={() => void act(() => previewAction({ importId: view.id }))}
          >
            {t("preview")}
          </Button>
        ) : null}
        {canCommit && view.status === "previewed" && view.previewHash && p ? (
          <Button
            className="h-11 md:h-9"
            disabled={busy || p.counts.new === 0}
            onClick={() =>
              void act(
                () => commitAction({ importId: view.id, previewHash: view.previewHash as string }),
                t("committed"),
              )
            }
          >
            {t("commit", { n: p.counts.new })}
          </Button>
        ) : null}
        {canCommit && view.status === "failed" && view.previewHash ? (
          <Button
            className="h-11 md:h-9"
            disabled={busy}
            onClick={() => void act(() => commitAction({ importId: view.id, previewHash: view.previewHash as string }))}
          >
            {t("resume")}
          </Button>
        ) : null}
        {canRun && editable ? (
          <Button
            variant="ghost"
            className="h-11 md:h-9"
            disabled={busy}
            onClick={() => void act(() => discard({ importId: view.id }), t("discarded"))}
          >
            <Trash2Icon aria-hidden="true" /> {t("discard")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
