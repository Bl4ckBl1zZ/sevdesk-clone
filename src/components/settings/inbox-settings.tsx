"use client";

import { api } from "@convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { formatDateTime, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CLAUDE_DEFAULTS, type ClaudeRegion, checkClaudeSettings } from "@/domain/inbox/ocr-settings";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

/**
 * Einstellungen › Posteingang (F01 SET-110, F06 INB-011/051/052, §6.6) and › Belegerkennung (SET-111…113).
 * Credentials: the R2 keys live only in the Convex env („konfiguriert / fehlt“); the Claude API key is write-only.
 */

export type InboxSettingsView = FunctionReturnType<typeof api.inbox.settings>;

export function InboxMailSettings() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <InboxMailInner />
    </ConvexGuard>
  );
}

export function OcrSettings() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <OcrInner />
    </ConvexGuard>
  );
}

function InboxMailInner() {
  const data = useAuthedQuery(api.inbox.settings, {});
  const save = useMutation(api.inbox.saveInbox);
  const test = useAction(api.inboxNode.testR2);
  const canManage = useCan("integrations.manage");
  if (!data) return <div className="h-96" aria-busy="true" />;
  return (
    <InboxMailForm
      view={data.inbox}
      canManage={canManage}
      onSave={(v) => save(v)}
      onTest={async () => {
        const r = await test({});
        return { ok: r.ok, detail: r.detail };
      }}
    />
  );
}

function Status({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-sm", ok ? "text-success" : "text-danger")}>
      {ok ? (
        <CircleCheckIcon className="size-4" aria-hidden="true" />
      ) : (
        <CircleAlertIcon className="size-4" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}

export function InboxMailForm({
  view,
  canManage,
  onSave,
  onTest,
}: {
  view: InboxSettingsView["inbox"];
  canManage: boolean;
  onSave: (v: {
    enabled: boolean;
    receivingAddress?: string;
    allowlist: string;
    dpaConfirmed: boolean;
  }) => Promise<unknown>;
  onTest: () => Promise<{ ok: boolean; detail: string }>;
}) {
  const t = useTranslations("inboxSettings");
  const run = useRun();
  const ids = { address: useId(), allowlist: useId(), enabled: useId(), dpa: useId() };
  const [enabled, setEnabled] = useState(view.enabled);
  const [address, setAddress] = useState(view.receivingAddress ?? "");
  const [allowlist, setAllowlist] = useState(view.allowlist.join("\n"));
  const [dpa, setDpa] = useState(view.dpaConfirmedAt !== null);
  const [testing, setTesting] = useState(false);
  const h = view.health;
  return (
    <div className="grid gap-4 @4xl/main:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("mail.title")}</h2>
          </CardTitle>
          <CardDescription>{t("mail.description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run(
                () =>
                  onSave({
                    enabled,
                    ...(address.trim() ? { receivingAddress: address.trim() } : {}),
                    allowlist,
                    dpaConfirmed: dpa,
                  }),
                t("saved"),
              );
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.address}>{t("mail.address")}</Label>
              <div className="flex gap-2">
                <Input
                  id={ids.address}
                  type="email"
                  inputMode="email"
                  placeholder="belege@in.example.de"
                  value={address}
                  disabled={!canManage}
                  onChange={(e) => setAddress(e.target.value)}
                  className="h-11 md:h-9"
                />
                {view.receivingAddress && <CopyButton value={view.receivingAddress} label={t("mail.copyAddress")} />}
              </div>
              <p className="text-muted-foreground text-xs">{t("mail.addressHint")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.allowlist}>{t("mail.allowlist")}</Label>
              <textarea
                id={ids.allowlist}
                rows={4}
                className="rounded-md border border-input bg-background p-2 text-base md:text-sm"
                value={allowlist}
                disabled={!canManage}
                placeholder={"@lieferant.de\nbuchhaltung@partner.de"}
                onChange={(e) => setAllowlist(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">{t("mail.allowlistHint")}</p>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox id={ids.dpa} checked={dpa} disabled={!canManage} onCheckedChange={(on) => setDpa(on)} />
              <Label htmlFor={ids.dpa} className="font-normal leading-snug">
                {t("mail.dpa")}
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id={ids.enabled}
                checked={enabled}
                disabled={!canManage}
                onCheckedChange={(on) => setEnabled(on)}
              />
              <Label htmlFor={ids.enabled} className="font-normal">
                {t("mail.enabled")}
              </Label>
            </div>
            {canManage && (
              <Button type="submit" className="h-11 self-start md:h-9">
                {t("save")}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
      <Card data-testid="inbox-health">
        <CardHeader>
          <CardTitle>
            <h2>{t("health.title")}</h2>
          </CardTitle>
          <CardDescription>{t("health.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("health.credentials")}</dt>
            <dd>
              <Status
                ok={view.credentials === "configured"}
                label={view.credentials === "configured" ? t("health.configured") : t("health.missing")}
              />
            </dd>
            <dt className="text-muted-foreground">{t("health.bucket")}</dt>
            <dd className="break-all">{view.bucket ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("health.endpoint")}</dt>
            <dd className="break-all">{view.endpoint ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("health.interval")}</dt>
            <dd>{t("health.minutes", { n: view.pollIntervalMinutes })}</dd>
            <dt className="text-muted-foreground">{t("health.limits")}</dt>
            <dd>{t("health.limitsValue", { mail: view.limits.mailMb, attachment: view.limits.attachmentMb })}</dd>
            <dt className="text-muted-foreground">{t("health.lastSuccess")}</dt>
            <dd className="tabular-nums">{h.lastSuccessAt ? formatDateTime(h.lastSuccessAt) : "—"}</dd>
            <dt className="text-muted-foreground">{t("health.waiting")}</dt>
            <dd className="tabular-nums">{h.objectsWaiting ?? "—"}</dd>
            {h.consecutiveFailures > 0 && (
              <>
                <dt className="text-muted-foreground">{t("health.failures")}</dt>
                <dd className="tabular-nums">{h.consecutiveFailures}</dd>
              </>
            )}
            {h.lastError && (
              <>
                <dt className="text-muted-foreground">{t("health.lastError")}</dt>
                <dd className="break-words text-danger">{h.lastError}</dd>
              </>
            )}
          </dl>
          {h.pausedAt && (
            <p role="alert" className="rounded-md border border-danger/40 p-2 text-danger text-sm">
              {t("health.paused", { since: formatDateTime(h.pausedAt) })}
            </p>
          )}
          {view.lastTestAt && (
            <p className="text-sm" role="status">
              <Status
                ok={view.lastTestOk === true}
                label={t("health.lastTest", { at: formatDateTime(view.lastTestAt), detail: view.lastTestDetail ?? "" })}
              />
            </p>
          )}
          {canManage && (
            <Button
              variant="outline"
              className="h-11 self-start md:h-9"
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                const r = await run(onTest);
                setTesting(false);
                if (r.ok) (r.value.ok ? toast.success : toast.error)(r.value.detail);
              }}
            >
              {t("test")}
            </Button>
          )}
          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{t("guide.title")}</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>{t("guide.step1")}</li>
              <li>{t("guide.step2")}</li>
              <li>{t("guide.step3")}</li>
              <li>{t("guide.step4")}</li>
            </ol>
          </details>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Belegerkennung (SET-111…113) ────────────────────────────────────────────────────────────────────────

function OcrInner() {
  const data = useAuthedQuery(api.inbox.settings, {});
  const save = useMutation(api.inbox.saveOcr);
  const test = useAction(api.inboxNode.testClaude);
  const canManage = useCan("integrations.manage");
  if (!data) return <div className="h-96" aria-busy="true" />;
  return (
    <OcrForm
      view={data.ocr}
      canManage={canManage}
      onSave={(v) => save(v)}
      onTest={async () => {
        const r = await test({});
        return { ok: r.ok, detail: r.detail };
      }}
    />
  );
}

const REGIONS: readonly ClaudeRegion[] = ["eu", "us", "global", "other"];

export function OcrForm({
  view,
  canManage,
  onSave,
  onTest,
}: {
  view: InboxSettingsView["ocr"];
  canManage: boolean;
  onSave: (v: {
    enabled: boolean;
    dpaConfirmed: boolean;
    endpoint?: string;
    model?: string;
    region: ClaudeRegion;
    pageLimit?: number;
    monthlyBudget?: number;
    apiKey?: string;
  }) => Promise<{ warnings: { code: string; message: string }[]; released: number }>;
  onTest: () => Promise<{ ok: boolean; detail: string }>;
}) {
  const t = useTranslations("ocrSettings");
  const run = useRun();
  const ids = {
    enabled: useId(),
    dpa: useId(),
    key: useId(),
    endpoint: useId(),
    model: useId(),
    region: useId(),
    pages: useId(),
    budget: useId(),
  };
  const [enabled, setEnabled] = useState(view.enabled);
  const [dpa, setDpa] = useState(view.dpaConfirmedAt !== null);
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState(view.endpoint ?? "");
  const [model, setModel] = useState(view.model);
  const [region, setRegion] = useState<ClaudeRegion>(view.region as ClaudeRegion);
  const [pages, setPages] = useState(String(view.pageLimit));
  const [budget, setBudget] = useState(view.monthlyBudget ? String(view.monthlyBudget) : "");
  const [testing, setTesting] = useState(false);
  useEffect(() => setModel(view.model), [view.model]);
  const liveWarnings = checkClaudeSettings({ enabled, dpaConfirmed: dpa, region }).warnings;
  return (
    <div className="grid gap-4 @4xl/main:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("title")}</h2>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void (async () => {
                const r = await run(
                  () =>
                    onSave({
                      enabled,
                      dpaConfirmed: dpa,
                      region,
                      ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}),
                      ...(model.trim() ? { model: model.trim() } : {}),
                      ...(pages.trim() ? { pageLimit: Number(pages) } : {}),
                      ...(budget.trim() ? { monthlyBudget: Number(budget) } : {}),
                      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
                    }),
                  t("saved"),
                );
                if (r.ok) {
                  setApiKey("");
                  if (r.value.released > 0) toast.info(t("released", { count: r.value.released }));
                }
              })();
            }}
          >
            <div className="flex items-start gap-2">
              <Checkbox id={ids.dpa} checked={dpa} disabled={!canManage} onCheckedChange={(on) => setDpa(on)} />
              <Label htmlFor={ids.dpa} className="font-normal leading-snug">
                {t("dpa")}
              </Label>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id={ids.enabled}
                checked={enabled}
                disabled={!canManage}
                onCheckedChange={(on) => setEnabled(on)}
              />
              <Label htmlFor={ids.enabled} className="font-normal">
                {t("enabled")}
              </Label>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.key}>{t("apiKey")}</Label>
              <Input
                id={ids.key}
                type="password"
                autoComplete="off"
                value={apiKey}
                disabled={!canManage}
                placeholder={view.apiKeyStored ? t("apiKeyStored") : ""}
                onChange={(e) => setApiKey(e.target.value)}
                className="h-11 md:h-9"
              />
              <p className="text-muted-foreground text-xs">{t("apiKeyHint")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.endpoint}>{t("endpoint")}</Label>
              <Input
                id={ids.endpoint}
                type="url"
                value={endpoint}
                disabled={!canManage}
                placeholder="https://api.anthropic.com"
                onChange={(e) => setEndpoint(e.target.value)}
                className="h-11 md:h-9"
              />
            </div>
            <div className="grid gap-4 @lg/main:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.model}>{t("model")}</Label>
                <Input
                  id={ids.model}
                  value={model}
                  disabled={!canManage}
                  placeholder={CLAUDE_DEFAULTS.model}
                  onChange={(e) => setModel(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.region}>{t("region")}</Label>
                <select
                  id={ids.region}
                  className={selectClass}
                  value={region}
                  disabled={!canManage}
                  onChange={(e) => setRegion(e.target.value as ClaudeRegion)}
                >
                  {REGIONS.map((r) => (
                    <option key={r} value={r}>
                      {t(`regions.${r}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.pages}>{t("pageLimit")}</Label>
                <Input
                  id={ids.pages}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={100}
                  value={pages}
                  disabled={!canManage}
                  onChange={(e) => setPages(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.budget}>{t("budget")}</Label>
                <Input
                  id={ids.budget}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  value={budget}
                  disabled={!canManage}
                  onChange={(e) => setBudget(e.target.value)}
                  className="h-11 md:h-9"
                />
              </div>
            </div>
            {/* SET-111 / EC-INB-17: the same check as the server, live while editing. */}
            {liveWarnings.map((w) => (
              <p key={w.code} role="note" className="rounded-md border border-warning/50 p-2 text-sm">
                {w.message}
              </p>
            ))}
            {canManage && (
              <Button type="submit" className="h-11 self-start md:h-9">
                {t("save")}
              </Button>
            )}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("status.title")}</h2>
          </CardTitle>
          <CardDescription>{t("status.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            <dt className="text-muted-foreground">{t("status.state")}</dt>
            <dd>
              <Status ok={view.active} label={view.active ? t("status.active") : t("status.inactive")} />
            </dd>
            <dt className="text-muted-foreground">{t("status.key")}</dt>
            <dd>{view.apiKeyStored ? t("status.keyStored") : t("status.keyMissing")}</dd>
            <dt className="text-muted-foreground">{t("status.usage")}</dt>
            <dd className="tabular-nums">
              {view.usage
                ? t("status.usageValue", {
                    calls: view.usage.calls,
                    month: view.usage.month,
                    budget: view.monthlyBudget ?? "∞",
                  })
                : "—"}
            </dd>
          </dl>
          {view.lastTestAt && (
            <p className="text-sm" role="status">
              <Status
                ok={view.lastTestOk === true}
                label={t("status.lastTest", { at: formatDateTime(view.lastTestAt), detail: view.lastTestDetail ?? "" })}
              />
            </p>
          )}
          {canManage && (
            <Button
              variant="outline"
              className="h-11 self-start md:h-9"
              disabled={testing || !view.apiKeyStored}
              onClick={async () => {
                setTesting(true);
                const r = await run(onTest);
                setTesting(false);
                if (r.ok) (r.value.ok ? toast.success : toast.error)(r.value.detail);
              }}
            >
              {t("test")}
            </Button>
          )}
          <p className="text-muted-foreground text-xs">{t("testHint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
