"use client";

import { api } from "@convex/_generated/api";
import { useMutation } from "convex/react";
import { DownloadIcon, HistoryIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { EmptyState } from "@/components/layout/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ACTOR_KINDS, AUDIT_PRESETS, type AuditPreset, PRESET_LABEL_DE } from "@/domain/audit/viewer";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { AuditEntries, type AuditEntryView } from "./audit-entries";

const CHANNELS = ["ui", "api", "mcp", "cron", "system"] as const;

interface Filters {
  preset?: AuditPreset;
  apiKeyActor?: string;
  actorKind?: (typeof ACTOR_KINDS)[number];
  channel?: string;
  entityTable?: string;
  text?: string;
  from?: number;
  to?: number;
}

const dayStart = (iso: string) => (iso ? Date.parse(`${iso}T00:00:00`) : undefined);
const dayEnd = (iso: string) => (iso ? Date.parse(`${iso}T23:59:59.999`) : undefined);

function download(filename: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** F12 AUD-006 viewer + AUD-008 export (`/einstellungen/audit`). */
export function AuditViewer() {
  return (
    <ConvexGuard>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("audit");
  const id = useId();
  const [filters, setFilters] = useState<Filters>({});
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");
  const [cursor, setCursor] = useState<number | undefined>(undefined);
  const [older, setOlder] = useState<AuditEntryView[]>([]);
  const args = {
    ...filters,
    ...(dayStart(fromDay) !== undefined ? { from: dayStart(fromDay) } : {}),
    ...(dayEnd(toDay) !== undefined ? { to: dayEnd(toDay) } : {}),
  };
  const page = useAuthedQuery(api.auditLog.search, { ...args, ...(cursor !== undefined ? { beforeSeq: cursor } : {}) });
  const keys = useAuthedQuery(api.auditLog.actors, {});
  const exportLog = useMutation(api.auditLog.exportLog);
  const run = useRun();
  const argsKey = JSON.stringify(args);

  // a new filter starts from the newest entry again
  // biome-ignore lint/correctness/useExhaustiveDependencies: argsKey is the filter identity
  useEffect(() => {
    setCursor(undefined);
    setOlder([]);
  }, [argsKey]);

  const entries = cursor === undefined ? (page?.entries ?? []) : [...older, ...(page?.entries ?? [])];
  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="@container flex flex-col gap-4">
      {page && (
        <p className="text-muted-foreground text-sm" data-testid="chain-status">
          {page.lastRun
            ? t(page.lastRun.ok ? "chainOk" : "chainFailed", {
                seq: page.lastRun.lastVerifiedSeq,
                head: page.head?.seq ?? 0,
              })
            : t("chainNever", { head: page.head?.seq ?? 0 })}
        </p>
      )}
      <fieldset className="flex flex-wrap gap-2">
        <legend className="sr-only">{t("presets")}</legend>
        {AUDIT_PRESETS.filter((p) => p !== "api_key").map((p) => (
          <Button
            key={p}
            type="button"
            size="sm"
            variant={filters.preset === p ? "default" : "outline"}
            aria-pressed={filters.preset === p}
            className="min-h-11"
            onClick={() => set({ preset: filters.preset === p ? undefined : p, apiKeyActor: undefined })}
          >
            {PRESET_LABEL_DE[p]}
          </Button>
        ))}
        {(keys ?? []).map((k) => (
          <Button
            key={k.actor}
            type="button"
            size="sm"
            variant={filters.apiKeyActor === k.actor ? "default" : "outline"}
            aria-pressed={filters.apiKeyActor === k.actor}
            className="min-h-11"
            onClick={() =>
              filters.apiKeyActor === k.actor
                ? set({ preset: undefined, apiKeyActor: undefined })
                : set({ preset: "api_key", apiKeyActor: k.actor })
            }
          >
            {t("apiKeyPreset", { name: k.name })}
          </Button>
        ))}
      </fieldset>
      <div className="grid @3xl:grid-cols-6 @md:grid-cols-3 grid-cols-1 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-from`}>{t("from")}</Label>
          <Input id={`${id}-from`} type="date" value={fromDay} onChange={(e) => setFromDay(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-to`}>{t("to")}</Label>
          <Input id={`${id}-to`} type="date" value={toDay} onChange={(e) => setToDay(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-kind`}>{t("actorKind")}</Label>
          <select
            id={`${id}-kind`}
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={filters.actorKind ?? ""}
            onChange={(e) => set({ actorKind: (e.target.value || undefined) as Filters["actorKind"] })}
          >
            <option value="">{t("all")}</option>
            {ACTOR_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`actorKinds.${k}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-channel`}>{t("channelLabel")}</Label>
          <select
            id={`${id}-channel`}
            className="h-10 rounded-md border bg-background px-3 text-sm"
            value={filters.channel ?? ""}
            onChange={(e) => set({ channel: e.target.value || undefined })}
          >
            <option value="">{t("all")}</option>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {t(`channel.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-table`}>{t("entityTable")}</Label>
          <Input
            id={`${id}-table`}
            value={filters.entityTable ?? ""}
            placeholder="salesDocuments"
            onChange={(e) => set({ entityTable: e.target.value || undefined })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-text`}>{t("text")}</Label>
          <Input
            id={`${id}-text`}
            type="search"
            value={filters.text ?? ""}
            onChange={(e) => set({ text: e.target.value || undefined })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {page?.head && <Badge variant="outline">{t("head", { seq: page.head.seq, hash: page.head.hash })}</Badge>}
        <div className="ml-auto flex flex-wrap gap-2">
          {(["csv", "json"] as const).map((format) => (
            <Button
              key={format}
              variant="outline"
              className="min-h-11"
              onClick={async () => {
                const r = await run(() => exportLog({ ...args, format }));
                if (r.ok) download(r.value.filename, r.value.mime, r.value.content);
              }}
            >
              <DownloadIcon aria-hidden="true" />
              {t(format === "csv" ? "exportCsv" : "exportJson")}
            </Button>
          ))}
        </div>
      </div>
      {page === undefined ? (
        <p className="text-muted-foreground text-sm">{t("loading")}</p>
      ) : entries.length === 0 ? (
        <EmptyState icon={HistoryIcon} title={t("empty")} description={t("emptyHint")} />
      ) : (
        <>
          <AuditEntries entries={entries} label={t("listLabel")} />
          {page.nextCursor !== null && (
            <Button
              variant="outline"
              className={cn("min-h-11 self-center")}
              onClick={() => {
                setOlder(entries);
                setCursor(page.nextCursor ?? undefined);
              }}
            >
              {t("more")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
