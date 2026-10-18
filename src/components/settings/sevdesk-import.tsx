"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { FileUpIcon, MonitorIcon, Trash2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { toast } from "sonner";
import { uploadFile } from "@/components/banking/shared";
import { formatDate, formatDateTime, selectClass, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import {
  checkMapping,
  IMPORT_FILE_KIND_LABELS,
  IMPORT_FILE_KINDS,
  isMappedCsvKind,
  type MappedCsvKind,
  targetFields,
  targetLabel,
} from "@/domain/import/sevdesk/mapping";
import { formatEuro } from "@/domain/money/format";
import { parseCents } from "@/domain/money/parse";
import { useAuthedQuery } from "@/hooks/use-authed-query";

type View = NonNullable<FunctionReturnType<typeof api.imports.get>>;
type Preview = NonNullable<View["preview"]>;
type Finding = Preview["findings"][number];
type FileView = View["files"][number];
type Resolutions = View["resolutions"];

const STATUS_VARIANT = {
  uploaded: "outline",
  previewed: "secondary",
  running: "secondary",
  done: "default",
  failed: "destructive",
  discarded: "outline",
} as const;

const euro = formatEuro;

/**
 * „sevdesk-Exporte importieren“ (F09 §6 `/einstellungen/import`, IMP-009/016/017/019/023): upload → file kinds →
 * column mapping with sample values and saved presets → preview (counts, Fehler/Warnungen/Hinweise with row
 * exclusion, PDF assignment and entered open amounts, number-range continuation) → commit (owner) or discard.
 * Every rule runs on the server and in src/domain; the component only edits the workspace and shows the result.
 */
export function SevdeskImport({ canRun, canCommit }: { canRun: boolean; canCommit: boolean }) {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <SevdeskImportInner canRun={canRun} canCommit={canCommit} />
    </ConvexGuard>
  );
}

function SevdeskImportInner({ canRun, canCommit }: { canRun: boolean; canCommit: boolean }) {
  const t = useTranslations("imports");
  const run = useRun();
  const list = useAuthedQuery(api.imports.list, {});
  const create = useMutation(api.imports.create);
  const [selected, setSelected] = useState<Id<"imports"> | null>(null);
  // While `create` runs, no project is shown: the previous unfinished one must not take an upload meant for the new.
  const [creating, setCreating] = useState(false);
  const active = selected ?? list?.find((i) => i.status !== "done" && i.status !== "discarded")?.id ?? null;

  const start = async () => {
    setCreating(true);
    try {
      const r = await run(() => create({}));
      if (r.ok) setSelected(r.value);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="@container flex flex-col gap-6">
      <p
        role="note"
        className="flex items-start gap-2 rounded-md border bg-muted/40 p-3 text-sm @3xl:hidden"
        data-testid="desktop-hint"
      >
        <MonitorIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("desktopHint")}
      </p>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("start")}</h2>
          </CardTitle>
          <CardDescription>{t("intro")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div>
            <h3 className="font-medium text-sm">{t("checklistTitle")}</h3>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground text-sm">
              {(["checklist1", "checklist2", "checklist3", "checklist4", "checklist5", "checklist6"] as const).map(
                (k) => (
                  <li key={k}>{t(k)}</li>
                ),
              )}
            </ol>
          </div>
          <p className="text-muted-foreground text-xs">{t("unsureHint")}</p>
          {canRun ? (
            <div>
              <Button onClick={start} disabled={creating}>
                <FileUpIcon aria-hidden="true" /> {t("start")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <section aria-labelledby="imports-list" className="flex flex-col gap-2">
        <h2 id="imports-list" className="font-semibold">
          {t("projects")}
        </h2>
        {list === undefined ? (
          <div className="h-16" aria-busy="true" />
        ) : list.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noProjects")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {list.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <div className="flex flex-col">
                  <span className="text-sm">
                    {t("startedAt")} {formatDateTime(i.startedAt)} · {i.files} {t("file")}
                  </span>
                  <span>
                    <Badge variant={STATUS_VARIANT[i.status]}>{t(`status.${i.status}`)}</Badge>
                  </span>
                </div>
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
        )}
      </section>

      {creating ? (
        <p className="text-muted-foreground text-sm" role="status" aria-busy="true">
          {t("creating")}
        </p>
      ) : active ? (
        <ImportProject key={active} importId={active} canRun={canRun} canCommit={canCommit} />
      ) : null}
    </div>
  );
}

function ImportProject({
  importId,
  canRun,
  canCommit,
}: {
  importId: Id<"imports">;
  canRun: boolean;
  canCommit: boolean;
}) {
  const view = useAuthedQuery(api.imports.get, { importId });
  if (view === undefined) return <div className="h-64" aria-busy="true" />;
  if (view === null) return null;
  const editable = canRun && (view.status === "uploaded" || view.status === "previewed");
  const csvFiles = view.files.filter((f) => isMappedCsvKind(f.kind) && !f.ignored);
  return (
    <div className="flex flex-col gap-6">
      <FilesSection view={view} importId={importId} editable={editable} />
      {csvFiles.map((f) => (
        <MappingSection
          key={`${f.id}:${JSON.stringify(view.mapping[f.id] ?? {})}`}
          importId={importId}
          file={f}
          mapping={view.mapping[f.id]}
          editable={editable}
        />
      ))}
      {view.status !== "done" && view.status !== "discarded" ? (
        <PreviewSection
          key={view.previewHash ?? "none"}
          view={view}
          importId={importId}
          editable={editable}
          canCommit={canCommit}
        />
      ) : null}
      {view.status === "done" ? <ResultSection view={view} /> : null}
    </div>
  );
}

// ── 1. files ──────────────────────────────────────────────────────────────────────────────────────────

function FilesSection({ view, importId, editable }: { view: View; importId: Id<"imports">; editable: boolean }) {
  const t = useTranslations("imports");
  const run = useRun();
  const inputId = useId();
  const uploadUrl = useMutation(api.imports.generateUploadUrl);
  const addFiles = useAction(api.imports.addFiles);
  const updateFile = useMutation(api.imports.updateFile);
  const removeFile = useMutation(api.imports.removeFile);
  const [busy, setBusy] = useState(false);

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    const r = await run(async () => {
      const files = [];
      for (const f of Array.from(list))
        files.push({ storageId: await uploadFile(await uploadUrl({}), f), name: f.name });
      return addFiles({ importId, files });
    });
    setBusy(false);
    if (r.ok) {
      toast.success(t("uploaded", { count: r.value.added.length }));
      if (r.value.duplicates.length > 0) toast.warning(t("duplicates", { names: r.value.duplicates.join(", ") }));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("filesTitle")}</h2>
        </CardTitle>
        <CardDescription>{t("filesHint")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {editable ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={inputId}>{t("chooseFiles")}</Label>
            <Input
              id={inputId}
              type="file"
              multiple
              accept=".csv,.txt,.pdf,.xml,.zip"
              disabled={busy}
              onChange={(e) => onFiles(e.target.files)}
            />
            {busy ? <p className="text-muted-foreground text-sm">{t("uploading")}</p> : null}
          </div>
        ) : null}
        {view.files.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noFiles")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("file")}</TableHead>
                <TableHead>{t("kind")}</TableHead>
                <TableHead className="text-right">{t("rows")}</TableHead>
                <TableHead>{t("ignored")}</TableHead>
                {editable ? <TableHead className="sr-only">{t("remove")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.files.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="max-w-64 truncate" title={f.name}>
                    {f.name}
                    {f.encoding ? <span className="block text-muted-foreground text-xs">{f.encoding}</span> : null}
                  </TableCell>
                  <TableCell>
                    <select
                      aria-label={`${t("kind")}: ${f.name}`}
                      className={selectClass}
                      value={f.kind}
                      disabled={!editable}
                      onChange={(e) => run(() => updateFile({ importId, fileId: f.id, kind: e.target.value }))}
                    >
                      {IMPORT_FILE_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {IMPORT_FILE_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{f.rows ?? "–"}</TableCell>
                  <TableCell>
                    <input
                      type="checkbox"
                      aria-label={`${t("ignored")}: ${f.name}`}
                      className="size-4"
                      checked={f.ignored === true}
                      disabled={!editable}
                      onChange={(e) => run(() => updateFile({ importId, fileId: f.id, ignored: e.target.checked }))}
                    />
                  </TableCell>
                  {editable ? (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`${t("remove")}: ${f.name}`}
                        onClick={() => run(() => removeFile({ importId, fileId: f.id }))}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ── 2. mapping (IMP-017) ──────────────────────────────────────────────────────────────────────────────

function MappingSection({
  importId,
  file,
  mapping,
  editable,
}: {
  importId: Id<"imports">;
  file: FileView;
  mapping: View["mapping"][string] | undefined;
  editable: boolean;
}) {
  const t = useTranslations("imports");
  const run = useRun();
  const presetId = useId();
  const numberId = useId();
  const dateId = useId();
  const setMapping = useMutation(api.imports.setMapping);
  const kind = file.kind as MappedCsvKind;
  const headers = file.headers ?? [];
  const [columns, setColumns] = useState<Record<string, string>>(mapping?.columns ?? {});
  const [numberFormat, setNumberFormat] = useState(mapping?.numberFormat ?? "");
  const [dateFormat, setDateFormat] = useState(mapping?.dateFormat ?? "");
  const [preset, setPreset] = useState("");
  const fields = [
    ...targetFields(kind),
    ...Object.keys(columns)
      .filter((k) => !targetFields(kind).some((f) => f.key === k))
      .map((k) => ({ key: k, label: targetLabel(kind, k), required: false })),
  ];
  const check = checkMapping(kind, headers, columns);
  const sample = (header: string | undefined) => {
    const i = header ? headers.indexOf(header) : -1;
    return i < 0 ? "" : (file.samples?.[0]?.[i] ?? "");
  };

  const save = () =>
    run(
      () =>
        setMapping({
          importId,
          fileId: file.id,
          mapping: {
            columns,
            ...(numberFormat === "de" || numberFormat === "en" ? { numberFormat } : {}),
            ...(dateFormat === "dmy" || dateFormat === "mdy" ? { dateFormat } : {}),
          },
          ...(preset.trim() ? { savePresetAs: preset.trim() } : {}),
        }),
      t("mappingSaved"),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>
            {t("mappingTitle")}: {file.name}
          </h2>
        </CardTitle>
        <CardDescription>
          {IMPORT_FILE_KIND_LABELS[kind]} · {t("mappingHint")}
        </CardDescription>
      </CardHeader>
      <CardContent className="@container flex flex-col gap-4">
        {check.missing.length > 0 ? (
          <ul className="list-disc pl-5 text-danger text-sm" role="alert">
            {check.missing.map((m) => (
              <li key={m}>
                In {file.name} fehlt die Spalte für {targetLabel(kind, m)}. Bitte Spaltenzuordnung ergänzen.
              </li>
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
            {fields.map((f) => (
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
                    {/* Unnamed columns (sevdesk's invoice list ends with `""`) cannot be mapped by name (IMP-017). */}
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
        {check.unmapped.length > 0 ? (
          <p className="text-muted-foreground text-xs">{t("unmapped", { headers: check.unmapped.join(", ") })}</p>
        ) : null}
        {kind === "invoices" ? (
          <div className="grid gap-3 @lg:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={numberId}>{t("numberFormat")}</Label>
              <select
                id={numberId}
                className={selectClass}
                value={numberFormat}
                disabled={!editable}
                onChange={(e) => setNumberFormat(e.target.value as "" | "de" | "en")}
              >
                <option value="">{t("detected")}</option>
                <option value="de">{t("formatDe")}</option>
                <option value="en">{t("formatEn")}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={dateId}>{t("dateFormat")}</Label>
              <select
                id={dateId}
                className={selectClass}
                value={dateFormat}
                disabled={!editable}
                onChange={(e) => setDateFormat(e.target.value as "" | "dmy" | "mdy")}
              >
                <option value="">{t("detected")}</option>
                <option value="dmy">{t("dateDmy")}</option>
                <option value="mdy">{t("dateMdy")}</option>
              </select>
            </div>
          </div>
        ) : null}
        {editable ? (
          <div className="flex flex-col gap-3 @lg:flex-row @lg:items-end">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor={presetId}>{t("presetName")}</Label>
              <Input id={presetId} value={preset} maxLength={80} onChange={(e) => setPreset(e.target.value)} />
            </div>
            <Button variant="secondary" onClick={save}>
              {t("saveMapping")}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── 3. preview + 4. commit ────────────────────────────────────────────────────────────────────────────

type Filter = "error" | "warning" | "info";
type RangeChoice = { enabled: boolean; candidate: number; next: string };

const COUNT_KEYS = [
  "contactsNew",
  "contactsExisting",
  "contactsSkipped",
  "contactsMinimal",
  "productsNew",
  "productsSkipped",
  "invoices",
  "corrections",
  "cancellations",
  "documentsSkipped",
  "openItems",
  "booked",
  "pdfMatched",
  "pdfMissing",
  "pdfOrphans",
  "drafts",
] as const;

function PreviewSection({
  view,
  importId,
  editable,
  canCommit,
}: {
  view: View;
  importId: Id<"imports">;
  editable: boolean;
  canCommit: boolean;
}) {
  const t = useTranslations("imports");
  const tc = useTranslations("common");
  const run = useRun();
  const reasonId = useId();
  const previewAction = useAction(api.imports.preview);
  const commitAction = useAction(api.imports.commit);
  const setResolutions = useMutation(api.imports.setResolutions);
  const discard = useMutation(api.imports.discard);
  const [filter, setFilter] = useState<Filter>("error");
  const [busy, setBusy] = useState(false);
  const [confirmMissing, setConfirmMissing] = useState(false);
  const [reason, setReason] = useState("");
  const [askDiscard, setAskDiscard] = useState(false);
  const preview = view.preview;
  const [ranges, setRanges] = useState<Record<string, RangeChoice>>(() =>
    Object.fromEntries(
      (preview?.numberRanges ?? []).map((r) => {
        const first = r.candidates.findIndex((c) => c.formatValid);
        return [
          r.rangeKey,
          {
            enabled: first >= 0,
            candidate: Math.max(first, 0),
            next: String(r.candidates[Math.max(first, 0)]?.next ?? 1),
          },
        ];
      }),
    ),
  );
  const res: Resolutions = view.resolutions;
  const excluded = new Set(res.excluded ?? []);
  const pdfFiles = view.files.filter((f) => f.kind === "pdf" && !f.ignored);

  const updateRes = (next: Resolutions) => run(() => setResolutions({ importId, resolutions: next }));
  const createPreview = async () => {
    setBusy(true);
    await run(() => previewAction({ importId }));
    setBusy(false);
  };
  const commit = async () => {
    if (!view.previewHash || !preview) return;
    setBusy(true);
    const numberRanges = preview.numberRanges.flatMap((r) => {
      const c = ranges[r.rangeKey];
      const cand = c ? r.candidates[c.candidate] : undefined;
      if (!c?.enabled || !cand?.formatValid) return [];
      return [{ rangeKey: r.rangeKey, format: cand.format, resetPolicy: cand.resetPolicy, next: Number(c.next) }];
    });
    const r = await run(() =>
      commitAction({
        importId,
        previewHash: view.previewHash as string,
        numberRanges,
        ...(confirmMissing && reason.trim() ? { missingPdfReason: reason.trim() } : {}),
      }),
    );
    setBusy(false);
    if (r.ok) {
      toast.success(
        t("done", {
          documents: r.value.counts.documentsCreated ?? 0,
          contacts: r.value.counts.contactsCreated ?? 0,
          products: r.value.counts.productsCreated ?? 0,
        }),
      );
    }
  };

  const findings = preview?.findings ?? [];
  const bySeverity = (s: Filter) => findings.filter((f) => f.severity === s);
  const missingPdf = preview?.counts.pdfMissing ?? 0;
  const resuming = view.status === "failed";
  const canSubmit =
    canCommit &&
    !busy &&
    !!preview &&
    (resuming ||
      (view.status === "previewed" &&
        preview.blocking === 0 &&
        (missingPdf === 0 || (confirmMissing && !!reason.trim()))));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("previewTitle")}</h2>
          </CardTitle>
          <CardDescription>{t("previewHint")}</CardDescription>
        </CardHeader>
        <CardContent className="@container flex flex-col gap-4">
          {view.status === "uploaded" && view.files.length > 0 ? (
            <p className="text-sm" role="status">
              {t("previewStale")}
            </p>
          ) : null}
          {editable ? (
            <div>
              <Button onClick={createPreview} disabled={busy || view.files.length === 0}>
                {t("createPreview")}
              </Button>
            </div>
          ) : null}
          {preview && view.status !== "uploaded" ? (
            <>
              <dl className="grid gap-2 @md:grid-cols-2 @3xl:grid-cols-3" data-testid="preview-counts">
                {COUNT_KEYS.map((k) => (
                  <div key={k} className="flex items-baseline justify-between gap-2 rounded-md border px-3 py-2">
                    <dt className="text-muted-foreground text-sm">{t(`counts.${k}`)}</dt>
                    <dd className="font-medium tabular-nums">{preview.counts[k] ?? 0}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-sm">{t("openTotal", { amount: euro(preview.openItems.totalCents) })}</p>
              {preview.bookedPeriod ? (
                <BookedPeriodChoice
                  booked={preview.bookedPeriod}
                  editable={editable}
                  onChange={(post) => {
                    const { postBookedPeriod: _p, ...rest } = res;
                    updateRes(post ? { ...rest, postBookedPeriod: true } : rest);
                  }}
                />
              ) : null}
              {preview.correctable.length > 0 ? (
                <CorrectedTotals
                  rows={preview.correctable}
                  editable={editable}
                  onChange={(key, value) => {
                    const { [key]: _old, ...others } = res.correctedTotals ?? {};
                    updateRes({ ...res, correctedTotals: value ? { ...others, [key]: value } : others });
                  }}
                />
              ) : null}
              <section aria-labelledby="import-findings" className="flex flex-col gap-2">
                <h3 id="import-findings" className="font-medium">
                  {t("findings")}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {(["error", "warning", "info"] as const).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={filter === s ? "secondary" : "outline"}
                      aria-pressed={filter === s}
                      onClick={() => setFilter(s)}
                    >
                      {t(s === "error" ? "filterErrors" : s === "warning" ? "filterWarnings" : "filterInfo", {
                        // Errors of excluded rows stay listed (to take them back in) but no longer block.
                        count: bySeverity(s).filter((f) => s !== "error" || !(f.rowRef && excluded.has(f.rowRef)))
                          .length,
                      })}
                    </Button>
                  ))}
                </div>
                {bySeverity(filter).length === 0 ? (
                  <p className="text-muted-foreground text-sm">{t("noFindings")}</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("where")}</TableHead>
                        <TableHead>{t("message")}</TableHead>
                        {editable ? <TableHead>{t("action")}</TableHead> : null}
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bySeverity(filter).map((f) => (
                        <FindingRow
                          key={`${f.code}|${f.fileId ?? ""}|${f.line ?? ""}|${f.key ?? ""}|${f.message}`}
                          finding={f}
                          editable={editable}
                          excluded={!!f.rowRef && excluded.has(f.rowRef)}
                          pdfFiles={pdfFiles}
                          resolutions={res}
                          onChange={updateRes}
                        />
                      ))}
                    </TableBody>
                  </Table>
                )}
                {preview.findingsTotal > preview.findings.length ? (
                  <p className="text-muted-foreground text-xs">
                    {t("truncated", { shown: preview.findings.length, total: preview.findingsTotal })}
                  </p>
                ) : null}
              </section>
              {preview.numberRanges.length > 0 ? (
                <section aria-labelledby="import-ranges" className="flex flex-col gap-3">
                  <h3 id="import-ranges" className="font-medium">
                    {t("rangesTitle")}
                  </h3>
                  <p className="text-muted-foreground text-sm">{t("rangesHint")}</p>
                  {preview.numberRanges.map((r) => (
                    <RangeEditor
                      key={r.rangeKey}
                      range={r}
                      choice={ranges[r.rangeKey]}
                      disabled={!canCommit || view.status !== "previewed"}
                      onChange={(c) => setRanges((x) => ({ ...x, [r.rangeKey]: c }))}
                    />
                  ))}
                </section>
              ) : null}
            </>
          ) : null}
        </CardContent>
      </Card>

      {preview || resuming ? (
        <Card>
          <CardHeader>
            <CardTitle>
              <h2>{t("commitTitle")}</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {resuming && view.error ? (
              <p className="text-danger text-sm" role="alert">
                {t("failed", { error: view.error })}
              </p>
            ) : null}
            {preview && view.status === "previewed" && preview.blocking > 0 ? (
              <p className="text-danger text-sm" role="alert">
                {t("blocked", { count: preview.blocking })}
              </p>
            ) : null}
            {preview && view.status === "previewed" && missingPdf > 0 ? (
              <div className="flex flex-col gap-2">
                <p className="text-sm">{t("missingPdf", { count: missingPdf })}</p>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4"
                    checked={confirmMissing}
                    onChange={(e) => setConfirmMissing(e.target.checked)}
                  />
                  {t("missingPdfConfirm")}
                </label>
                {confirmMissing ? (
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor={reasonId}>{t("missingPdfReason")}</Label>
                    <Textarea
                      id={reasonId}
                      value={reason}
                      maxLength={500}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
            {!canCommit ? <p className="text-muted-foreground text-sm">{t("ownerOnly")}</p> : null}
            <div className="flex flex-wrap gap-2">
              {canCommit ? (
                <Button onClick={commit} disabled={!canSubmit}>
                  {busy ? t("committing") : resuming ? t("resume") : t("commit")}
                </Button>
              ) : null}
              {editable ? (
                askDiscard ? (
                  <>
                    <span className="self-center text-sm">{t("discardConfirm")}</span>
                    <Button
                      variant="destructive"
                      onClick={async () => {
                        const r = await run(() => discard({ importId }), t("discarded"));
                        if (r.ok) setAskDiscard(false);
                      }}
                    >
                      {t("discard")}
                    </Button>
                    <Button variant="outline" onClick={() => setAskDiscard(false)}>
                      {tc("cancel")}
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" onClick={() => setAskDiscard(true)}>
                    {t("discard")}
                  </Button>
                )
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

/**
 * E-IMP-10 / EC-204: documents dated on/after the Buchungsbeginn are blocked („Nicht buchen“) or posted at import like
 * own invoices; posted invoices enter as open receivables — their payments come from the bank statements.
 */
function BookedPeriodChoice({
  booked,
  editable,
  onChange,
}: {
  booked: NonNullable<Preview["bookedPeriod"]>;
  editable: boolean;
  onChange: (post: boolean) => void;
}) {
  const t = useTranslations("imports");
  const name = useId();
  const date = formatDate(booked.date);
  return (
    <fieldset className="flex flex-col gap-2 rounded-md border p-3">
      <legend className="px-1 font-medium text-sm">{t("bookedTitle", { date })}</legend>
      <p className="text-sm">{t("bookedHint", { count: booked.count })}</p>
      {(["skip", "post"] as const).map((v) => (
        <label key={v} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name={name}
            className="mt-0.5 size-4"
            value={v}
            checked={booked.post === (v === "post")}
            disabled={!editable}
            onChange={() => onChange(v === "post")}
          />
          <span>
            <span className="font-medium">{t(v === "post" ? "bookedPost" : "bookedSkip")}</span>
            <span className="block text-muted-foreground">{t(v === "post" ? "bookedPostHint" : "bookedSkipHint")}</span>
          </span>
        </label>
      ))}
      {booked.post ? (
        <p className="rounded-md bg-muted/40 p-2 text-sm">
          {booked.paidInSevdesk > 0 ? `${t("bookedPaid", { count: booked.paidInSevdesk })} ` : ""}
          {t("bookedBank", { date })}
        </p>
      ) : null}
    </fieldset>
  );
}

type Correctable = Preview["correctable"][number];

/**
 * EC-203 / E-IMP-37: sevdesk's list total can differ from the PDF — per row the owner enters the gross from the PDF
 * with a reason (rows without VAT only; the server re-checks everything in the preview).
 */
function CorrectedTotals({
  rows,
  editable,
  onChange,
}: {
  rows: Correctable[];
  editable: boolean;
  onChange: (key: string, value: { grossCents: number; reason: string } | null) => void;
}) {
  const t = useTranslations("imports");
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="font-medium">
        {t("totalsTitle")}
      </h3>
      <p className="text-muted-foreground text-sm">{t("totalsHint")}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("totalsDocument")}</TableHead>
            <TableHead className="hidden @2xl:table-cell">{t("totalsDate")}</TableHead>
            <TableHead className="text-right">{t("totalsExported")}</TableHead>
            <TableHead>{t("totalsCorrection")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <CorrectedTotalRow key={r.key} row={r} editable={editable} onChange={onChange} />
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function CorrectedTotalRow({
  row: r,
  editable,
  onChange,
}: {
  row: Correctable;
  editable: boolean;
  onChange: (key: string, value: { grossCents: number; reason: string } | null) => void;
}) {
  const t = useTranslations("imports");
  const amountId = useId();
  const reasonId = useId();
  const [editing, setEditing] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const parsed = parseCents(amount);
  const corrected = r.reason !== undefined;
  return (
    <TableRow>
      <TableCell className="align-top font-medium">{r.number}</TableCell>
      <TableCell className="hidden align-top @2xl:table-cell">{formatDate(r.documentDate)}</TableCell>
      <TableCell className="text-right align-top tabular-nums">{euro(r.exportedGrossCents)}</TableCell>
      <TableCell className="align-top whitespace-normal">
        <div className="flex flex-col gap-2">
          {corrected ? (
            <span className="text-sm">
              {t("totalsCorrected")} {euro(r.grossCents)} ({r.reason})
            </span>
          ) : null}
          {editable && corrected ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              aria-label={`${t("totalsRemove")}: ${r.number}`}
              onClick={() => onChange(r.key, null)}
            >
              {t("totalsRemove")}
            </Button>
          ) : null}
          {editable && !corrected && !editing ? (
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              aria-label={`${t("totalsEdit")}: ${r.number}`}
              onClick={() => setEditing(true)}
            >
              {t("totalsEdit")}
            </Button>
          ) : null}
          {editable && !corrected && editing ? (
            <div className="grid gap-2 @lg:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={amountId}>{t("totalsAmount", { number: r.number })}</Label>
                <Input id={amountId} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={reasonId}>{t("totalsReason", { number: r.number })}</Label>
                <Input id={reasonId} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
              </div>
              <div className="flex gap-2 @lg:col-span-2">
                <Button
                  size="sm"
                  variant="secondary"
                  aria-label={`${t("totalsSave")}: ${r.number}`}
                  disabled={!parsed.ok || parsed.value === 0 || !reason.trim()}
                  onClick={() =>
                    parsed.ok && onChange(r.key, { grossCents: Number(parsed.value), reason: reason.trim() })
                  }
                >
                  {t("totalsSave")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                  {t("totalsCancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  );
}

function FindingRow({
  finding: f,
  editable,
  excluded,
  pdfFiles,
  resolutions,
  onChange,
}: {
  finding: Finding;
  editable: boolean;
  excluded: boolean;
  pdfFiles: FileView[];
  resolutions: Resolutions;
  onChange: (r: Resolutions) => void;
}) {
  const t = useTranslations("imports");
  const [amount, setAmount] = useState("");
  const where = f.fileName ? `${f.fileName}${f.line ? `:${f.line}` : ""}` : "–";
  const ex = resolutions.excluded ?? [];
  const parsed = parseCents(amount);
  return (
    <TableRow data-excluded={excluded || undefined}>
      <TableCell className="whitespace-nowrap align-top text-muted-foreground text-xs">
        <span className="block font-mono">{f.code}</span>
        {where}
      </TableCell>
      <TableCell className="align-top whitespace-normal">
        {/* Excluded rows keep full contrast (WCAG AA); the badge says what dimming used to imply. */}
        {excluded ? (
          <Badge variant="outline" className="mr-2">
            {t("excludedRow")}
          </Badge>
        ) : null}
        {f.message}
      </TableCell>
      {editable ? (
        <TableCell className="align-top">
          <div className="flex flex-col gap-2">
            {f.code === "E-IMP-22" && f.key ? (
              <select
                aria-label={`${t("choosePdf")}: ${f.key}`}
                className={selectClass}
                value={resolutions.pdfAssignments?.[f.key] ?? ""}
                onChange={(e) =>
                  onChange({
                    ...resolutions,
                    pdfAssignments: { ...(resolutions.pdfAssignments ?? {}), [f.key as string]: e.target.value },
                  })
                }
              >
                <option value="">{t("choosePdf")}</option>
                {pdfFiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            ) : null}
            {f.code === "E-IMP-30" && f.key ? (
              <div className="flex gap-2">
                <Input
                  aria-label={`${t("enterOpen")}: ${f.key}`}
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!parsed.ok}
                  onClick={() =>
                    parsed.ok &&
                    onChange({
                      ...resolutions,
                      openAmounts: { ...(resolutions.openAmounts ?? {}), [f.key as string]: parsed.value },
                    })
                  }
                >
                  {t("saveOpen")}
                </Button>
              </div>
            ) : null}
            {f.rowRef && (f.severity === "error" || excluded) ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onChange({
                    ...resolutions,
                    excluded: excluded ? ex.filter((r) => r !== f.rowRef) : [...ex, f.rowRef as string],
                  })
                }
              >
                {excluded ? t("include") : t("exclude")}
              </Button>
            ) : null}
          </div>
        </TableCell>
      ) : null}
    </TableRow>
  );
}

function RangeEditor({
  range,
  choice,
  disabled,
  onChange,
}: {
  range: Preview["numberRanges"][number];
  choice: RangeChoice | undefined;
  disabled: boolean;
  onChange: (c: RangeChoice) => void;
}) {
  const t = useTranslations("imports");
  const formatId = useId();
  const nextId = useId();
  const label = range.rangeKey === "invoice" ? t("rangeInvoice") : t("rangeCorrection");
  const c = choice ?? { enabled: false, candidate: 0, next: "1" };
  const cand = range.candidates[c.candidate];
  return (
    <fieldset className="@container flex flex-col gap-3 rounded-md border p-3">
      <legend className="px-1 font-medium text-sm">{label}</legend>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="size-4"
          checked={c.enabled}
          disabled={disabled || !cand?.formatValid}
          onChange={(e) => onChange({ ...c, enabled: e.target.checked })}
        />
        {t("rangeContinue", { range: label })}
      </label>
      {range.ambiguous ? <p className="text-sm">{t("rangeAmbiguous")}</p> : null}
      <div className="grid gap-3 @md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={formatId}>{t("rangeFormat", { range: label })}</Label>
          <select
            id={formatId}
            className={selectClass}
            value={c.candidate}
            disabled={disabled}
            onChange={(e) => {
              const i = Number(e.target.value);
              onChange({ ...c, candidate: i, next: String(range.candidates[i]?.next ?? 1) });
            }}
          >
            {range.candidates.map((x, i) => (
              <option key={x.format} value={i}>
                {x.format} ({x.count})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={nextId}>{t("rangeNext", { range: label })}</Label>
          <Input
            id={nextId}
            inputMode="numeric"
            value={c.next}
            disabled={disabled}
            onChange={(e) => onChange({ ...c, next: e.target.value.replace(/\D/g, "") })}
          />
        </div>
      </div>
      {cand ? <p className="text-muted-foreground text-xs">{t("rangeLast", { number: cand.lastImported })}</p> : null}
      {cand && !cand.formatValid ? (
        <p className="text-danger text-xs">{t("rangeInvalid", { message: cand.formatMessage ?? "" })}</p>
      ) : null}
    </fieldset>
  );
}

function ResultSection({ view }: { view: View }) {
  const t = useTranslations("imports");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("doneTitle")}</h2>
        </CardTitle>
        <CardDescription>
          {t("done", {
            documents: view.stats.documentsCreated ?? 0,
            contacts: view.stats.contactsCreated ?? 0,
            products: view.stats.productsCreated ?? 0,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm">
        {view.retentionUntil ? <p>{t("retention", { date: formatDate(view.retentionUntil) })}</p> : null}
        {view.log.length > 0 ? (
          <>
            <h3 className="font-medium">{t("log")}</h3>
            <ul className="list-disc pl-5 text-muted-foreground">
              {view.log.map((l, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the run log is append-only text
                <li key={i}>{l}</li>
              ))}
            </ul>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
