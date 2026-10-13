"use client";

import { api } from "@convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { HistoryIcon, KeyRoundIcon, PlusIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { toast } from "sonner";
import { useFreshAction } from "@/components/auth/fresh-action";
import { ConfirmDialog, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { FormErrorSummary, SelectField, TextField } from "@/components/forms/fields";
import { useZodForm } from "@/components/setup/use-zod-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { DEFAULT_RATE_LIMIT_PER_MINUTE } from "@/domain/api/rate-limit";
import {
  matchingPreset,
  presetScopes,
  SCOPE_GROUPS,
  SCOPE_LABELS,
  SCOPE_PRESET_CHANNEL,
  SCOPE_PRESET_KEYS,
  SCOPE_PRESET_LABELS,
  type ScopePreset,
} from "@/domain/api/scopes";
import {
  API_KEY_CHANNEL_LABELS,
  API_KEY_CHANNELS,
  type ApiKeyCreateFormValues,
  apiKeyCreateSchema,
} from "@/domain/schemas/api-keys";
import type { Scope } from "@/domain/schemas/scopes";
import { berlinCalendarDate } from "@/domain/time/berlin";
import { addDays } from "@/domain/time/calendar-date";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { formatTimestamp } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { apiHostUrl, useLocationHost } from "./api-host";
import { CopyButton } from "./copy-button";

type ApiKey = FunctionReturnType<typeof api.apiKeys.list>[number];
type KeyForm = UseFormReturn<ApiKeyCreateFormValues, unknown, ApiKeyCreateFormValues>;
type PresetMode = ScopePreset | "custom";

const loading = <div className="h-96" aria-busy="true" />;

/**
 * `/einstellungen/api` (05 §2.1, API-001…API-008): the owner's API keys with preset, channel, scopes, usage, expiry,
 * per-key rate limit and status; „Neuer Schlüssel“ (fresh session, plaintext shown once); revoke with a reason
 * (effective on the key's next request, EC-186); the last requests per key. The server checks `apiKeys.*`.
 */
export function ApiKeysAdmin() {
  return (
    <ConvexGuard fallback={loading}>
      <ApiKeysAdminInner />
    </ConvexGuard>
  );
}

function ApiKeysAdminInner() {
  const t = useTranslations("apiKeys");
  const keys = useAuthedQuery(api.apiKeys.list, {});
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<KeyAction | null>(null);

  if (keys === undefined) return loading;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1.5">
            <CardTitle>
              <h2>{t("title")}</h2>
            </CardTitle>
            <CardDescription>{t("description")}</CardDescription>
          </div>
          <Button className="h-11 md:h-9" onClick={() => setCreating(true)}>
            <PlusIcon aria-hidden="true" />
            {t("create")}
          </Button>
        </CardHeader>
        <CardContent>
          {keys.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
          ) : (
            <KeyList keys={keys} onAction={setAction} />
          )}
        </CardContent>
      </Card>

      <ApiAccessInfo />

      {creating && <ApiKeyCreateDialog initialPreset="website" onClose={() => setCreating(false)} />}
      {action?.kind === "revoke" && <RevokeDialog apiKey={action.key} onClose={() => setAction(null)} />}
      {action?.kind === "requests" && <RequestsDialog apiKey={action.key} onClose={() => setAction(null)} />}
    </div>
  );
}

type KeyAction = { kind: "revoke" | "requests"; key: ApiKey };

function StatusBadge({ status }: { status: ApiKey["status"] }) {
  const t = useTranslations("apiKeys");
  const variant = status === "active" ? "default" : status === "revoked" ? "destructive" : "secondary";
  return <Badge variant={variant}>{t(`status.${status}`)}</Badge>;
}

function presetLabel(preset: ApiKey["preset"], custom: string): string {
  return preset ? SCOPE_PRESET_LABELS[preset] : custom;
}

function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope as Scope] ?? scope;
}

/** Scope count with the expandable German list (native disclosure: keyboard and screen-reader friendly). */
function ScopesDetails({ scopes }: { scopes: readonly string[] }) {
  const t = useTranslations("apiKeys");
  return (
    <details className="group">
      <summary className="flex min-h-11 cursor-pointer items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-0">
        {t("scopesCount", { count: scopes.length })}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {scopes.map((s) => (
          <li key={s}>{scopeLabel(s)}</li>
        ))}
      </ul>
    </details>
  );
}

function useKeyFormatters() {
  const t = useTranslations("apiKeys");
  return {
    lastUsed: (k: ApiKey) => (k.lastUsedAt === null ? t("never") : formatTimestamp(k.lastUsedAt, { withTime: true })),
    expires: (k: ApiKey) => (k.expiresAt === null ? t("noExpiry") : formatTimestamp(k.expiresAt)),
    rateLimit: (k: ApiKey) =>
      k.rateLimitPerMinute === null
        ? t("rateLimitDefault", { rate: DEFAULT_RATE_LIMIT_PER_MINUTE })
        : t("rateLimit", { rate: k.rateLimitPerMinute }),
  };
}

function KeyActions({ apiKey, onAction }: { apiKey: ApiKey; onAction: (a: KeyAction) => void }) {
  const t = useTranslations("apiKeys");
  return (
    <div className="flex flex-wrap gap-2 @3xl/main:justify-end">
      <Button
        variant="outline"
        size="sm"
        className="h-11 md:h-8"
        onClick={() => onAction({ kind: "requests", key: apiKey })}
      >
        <HistoryIcon aria-hidden="true" />
        {t("requests")}
        <span className="sr-only"> ({apiKey.name})</span>
      </Button>
      {apiKey.status === "active" && (
        <Button
          variant="outline"
          size="sm"
          className="h-11 text-destructive md:h-8"
          onClick={() => onAction({ kind: "revoke", key: apiKey })}
        >
          {t("revoke")}
          <span className="sr-only"> ({apiKey.name})</span>
        </Button>
      )}
    </div>
  );
}

function KeyList({ keys, onAction }: { keys: ApiKey[]; onAction: (a: KeyAction) => void }) {
  const t = useTranslations("apiKeys");
  const fmt = useKeyFormatters();
  return (
    <>
      {/* Desktop: table; narrow main area: cards (04-ui-ux §4.1). */}
      <div className="hidden @3xl/main:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              <TableHead>{t("columns.preset")}</TableHead>
              <TableHead>{t("columns.scopes")}</TableHead>
              <TableHead>{t("columns.created")}</TableHead>
              <TableHead>{t("columns.lastUsed")}</TableHead>
              <TableHead>{t("columns.expires")}</TableHead>
              <TableHead>{t("columns.rateLimit")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => {
              const inactive = k.status !== "active";
              return (
                <TableRow
                  key={k.keyId}
                  data-inactive={inactive ? "" : undefined}
                  className={cn("align-top", inactive && "text-muted-foreground")}
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="font-medium">{k.name}</span>
                      <code className="text-muted-foreground text-xs">{k.display}</code>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <span>{presetLabel(k.preset, t("custom"))}</span>
                      <span className="text-muted-foreground text-xs">{API_KEY_CHANNEL_LABELS[k.channel]}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <ScopesDetails scopes={k.scopes} />
                  </TableCell>
                  <TableCell className="tabular-nums">{formatTimestamp(k.createdAt)}</TableCell>
                  <TableCell className="tabular-nums" data-volatile="">
                    {fmt.lastUsed(k)}
                  </TableCell>
                  <TableCell className="tabular-nums">{fmt.expires(k)}</TableCell>
                  <TableCell className="tabular-nums">{fmt.rateLimit(k)}</TableCell>
                  <TableCell>
                    <StatusBadge status={k.status} />
                  </TableCell>
                  <TableCell>
                    <KeyActions apiKey={k} onAction={onAction} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y rounded-lg border @3xl/main:hidden">
        {keys.map((k) => (
          <li
            key={k.keyId}
            data-api-key=""
            data-inactive={k.status !== "active" ? "" : undefined}
            className={cn("flex flex-col gap-2 p-3 text-sm", k.status !== "active" && "text-muted-foreground")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium">{k.name}</span>
              <StatusBadge status={k.status} />
            </div>
            <code className="break-all text-muted-foreground text-xs">{k.display}</code>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{t("columns.preset")}</dt>
              <dd>{presetLabel(k.preset, t("custom"))}</dd>
              <dt className="text-muted-foreground">{t("columns.channel")}</dt>
              <dd>{API_KEY_CHANNEL_LABELS[k.channel]}</dd>
              <dt className="text-muted-foreground">{t("columns.scopes")}</dt>
              <dd>
                <ScopesDetails scopes={k.scopes} />
              </dd>
              <dt className="text-muted-foreground">{t("columns.created")}</dt>
              <dd>{formatTimestamp(k.createdAt)}</dd>
              <dt className="text-muted-foreground">{t("columns.lastUsed")}</dt>
              <dd data-volatile="">{fmt.lastUsed(k)}</dd>
              <dt className="text-muted-foreground">{t("columns.expires")}</dt>
              <dd>{fmt.expires(k)}</dd>
              <dt className="text-muted-foreground">{t("columns.rateLimit")}</dt>
              <dd>{fmt.rateLimit(k)}</dd>
            </dl>
            <KeyActions apiKey={k} onAction={onAction} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** API-008: how keys are used (tailnet only, Bearer header, no keys in URLs, per-key limit) and where the docs are. */
function ApiAccessInfo() {
  const t = useTranslations("apiKeys");
  const docs = apiHostUrl(useLocationHost(), "/api/docs") ?? "/api/docs";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("info.title")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>{t("info.tailnet")}</li>
          <li>
            {t("info.header")}{" "}
            <code className="break-all rounded bg-muted px-1.5 py-0.5">Authorization: Bearer sk_live_…</code>
          </li>
          <li>{t("info.noUrlKeys")}</li>
          <li>{t("info.rateLimit", { rate: DEFAULT_RATE_LIMIT_PER_MINUTE })}</li>
          <li>
            {t("info.docs")}{" "}
            <a href={docs} target="_blank" rel="noopener noreferrer" className="break-all text-primary underline">
              {docs}
            </a>
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

function defaultsFor(preset: ScopePreset): ApiKeyCreateFormValues {
  return {
    name: "",
    channel: SCOPE_PRESET_CHANNEL[preset],
    scopes: presetScopes(preset),
    expiresOn: "",
    rateLimitPerMinute: "",
  };
}

/** Preset radios (Website, Claude sicher/voll, Nur lesen, Benutzerdefiniert); a preset fills channel and scopes. */
function PresetField({ mode, onChange }: { mode: PresetMode; onChange: (mode: PresetMode) => void }) {
  const t = useTranslations("apiKeys");
  const id = useId();
  const options: PresetMode[] = [...SCOPE_PRESET_KEYS, "custom"];
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 font-medium text-sm">{t("preset")}</legend>
      <div className="grid gap-2 @md/form:grid-cols-2">
        {options.map((p) => {
          const optionId = `${id}-${p}`;
          return (
            <label
              key={p}
              htmlFor={optionId}
              className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-primary has-checked:bg-primary/5 has-focus-visible:ring-3 has-focus-visible:ring-ring/50"
            >
              <input
                id={optionId}
                type="radio"
                name={`${id}-preset`}
                value={p}
                checked={mode === p}
                onChange={() => onChange(p)}
                aria-describedby={`${optionId}-hint`}
                className="mt-0.5 size-5 shrink-0 accent-primary md:size-4"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm">{p === "custom" ? t("custom") : SCOPE_PRESET_LABELS[p]}</span>
                <span id={`${optionId}-hint`} className="text-muted-foreground text-xs">
                  {t(`presetHints.${p}`)}
                </span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Scope checkboxes grouped by area (SCOPE_GROUPS); editing switches the preset to the matching one or custom. */
function ScopesField({ form, onEdited }: { form: KeyForm; onEdited: (scopes: string[]) => void }) {
  const t = useTranslations("apiKeys");
  const id = useId();
  const error = form.formState.errors.scopes?.message;
  return (
    <Controller
      control={form.control}
      name="scopes"
      render={({ field }) => (
        <fieldset
          className="flex flex-col gap-3"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
        >
          <legend className="mb-1 font-medium text-sm">
            {t("scopes")}
            <span aria-hidden="true" className="text-danger">
              {" "}
              *
            </span>
          </legend>
          <p id={`${id}-hint`} className="text-muted-foreground text-sm">
            {t("scopesHint")}
          </p>
          <div className="grid gap-3 @lg/form:grid-cols-2">
            {SCOPE_GROUPS.map((group) => (
              <fieldset key={group.key} className="flex flex-col gap-1 rounded-lg border p-3">
                <legend className="px-1 font-medium text-sm">{group.label}</legend>
                {group.scopes.map((scope) => {
                  const boxId = `${id}-${scope}`;
                  return (
                    <label
                      key={scope}
                      htmlFor={boxId}
                      className="flex min-h-11 items-start gap-2 py-1 text-sm md:min-h-0"
                    >
                      <input
                        id={boxId}
                        type="checkbox"
                        value={scope}
                        className="mt-0.5 size-5 shrink-0 accent-primary md:size-4"
                        checked={field.value.includes(scope)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...field.value, scope]
                            : field.value.filter((s: string) => s !== scope);
                          field.onChange(next);
                          onEdited(next);
                        }}
                      />
                      <span className="flex flex-col">
                        <span>{SCOPE_LABELS[scope]}</span>
                        <code className="text-muted-foreground text-xs">{scope}</code>
                      </span>
                    </label>
                  );
                })}
              </fieldset>
            ))}
          </div>
          {error && (
            <p id={`${id}-error`} className="text-danger text-sm">
              {error}
            </p>
          )}
        </fieldset>
      )}
    />
  );
}

/**
 * „Neuer Schlüssel“ (05 §2.1, API-002/API-003): validated with `apiKeyCreateSchema`, created by the Convex action
 * under a fresh session (`useFreshAction` handles `reauth_required`). The plaintext key is shown exactly once.
 * Also used by Einstellungen › MCP with `initialPreset="claude_safe"`.
 */
export function ApiKeyCreateDialog({ initialPreset, onClose }: { initialPreset: ScopePreset; onClose: () => void }) {
  const [created, setCreated] = useState<{ key: string; display: string } | null>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        {created ? (
          <CreatedKey created={created} onClose={onClose} />
        ) : (
          <CreateKeyForm initialPreset={initialPreset} onClose={onClose} onCreated={setCreated} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CreateKeyForm({
  initialPreset,
  onClose,
  onCreated,
}: {
  initialPreset: ScopePreset;
  onClose: () => void;
  onCreated: (created: { key: string; display: string }) => void;
}) {
  const t = useTranslations("apiKeys");
  const tCommon = useTranslations("common");
  const formId = useId();
  const create = useAction(api.apiKeys.create);
  const fresh = useFreshAction();
  const showError = useAdapterErrorToast();
  const form = useZodForm(apiKeyCreateSchema, defaultsFor(initialPreset)) as KeyForm;
  const [mode, setMode] = useState<PresetMode>(initialPreset);
  const tomorrow = addDays(berlinCalendarDate(Date.now()), 1);

  const applyPreset = (next: PresetMode) => {
    setMode(next);
    if (next === "custom") return;
    const opts = { shouldDirty: true, shouldValidate: form.formState.isSubmitted };
    form.setValue("channel", SCOPE_PRESET_CHANNEL[next], opts);
    form.setValue("scopes", presetScopes(next), opts);
  };

  const submit = form.handleSubmit(async (values) => {
    try {
      const result = await fresh(() => create({ values }));
      toast.success(t("createdToast"));
      onCreated({ key: result.key, display: result.display });
    } catch (e) {
      showError(e);
    }
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("createTitle")}</DialogTitle>
        <DialogDescription>{t("createDescription")}</DialogDescription>
      </DialogHeader>
      <form id={formId} noValidate onSubmit={submit} className="@container/form flex flex-col gap-4">
        <FormErrorSummary form={form} />
        <TextField form={form} name="name" label={t("name")} description={t("nameHint")} maxLength={60} required />
        <PresetField mode={mode} onChange={applyPreset} />
        <SelectField
          form={form}
          name="channel"
          label={t("channel")}
          description={t("channelHint")}
          required
          options={API_KEY_CHANNELS.map((c) => ({ value: c, label: API_KEY_CHANNEL_LABELS[c] }))}
        />
        <ScopesField form={form} onEdited={(scopes) => setMode(matchingPreset(scopes) ?? "custom")} />
        <div className="grid gap-4 @lg/form:grid-cols-2">
          <TextField
            form={form}
            name="expiresOn"
            label={t("expiresOn")}
            type="date"
            min={tomorrow}
            description={t("expiresOnHint")}
          />
          <TextField
            form={form}
            name="rateLimitPerMinute"
            label={t("rateLimitField")}
            inputMode="numeric"
            autoComplete="off"
            description={t("rateLimitHint", { rate: DEFAULT_RATE_LIMIT_PER_MINUTE })}
          />
        </div>
      </form>
      <DialogFooter>
        <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
          {tCommon("cancel")}
        </Button>
        <Button type="submit" form={formId} className="h-11 md:h-9" disabled={form.formState.isSubmitting}>
          {t("submit")}
        </Button>
      </DialogFooter>
    </>
  );
}

function CreatedKey({ created, onClose }: { created: { key: string; display: string }; onClose: () => void }) {
  const t = useTranslations("apiKeys");
  const id = useId();
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("createdTitle")}</DialogTitle>
        <DialogDescription>{t("createdDescription")}</DialogDescription>
      </DialogHeader>
      <p role="status" className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {t("onceWarning", { display: created.display })}
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={id}>{t("keyLabel")}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            readOnly
            value={created.key}
            className="h-11 font-mono md:h-9"
            onFocus={(e) => e.currentTarget.select()}
          />
          <CopyButton value={created.key} label={t("copyKey")} />
        </div>
      </div>
      <DialogFooter>
        <Button className="h-11 md:h-9" onClick={onClose}>
          {t("done")}
        </Button>
      </DialogFooter>
    </>
  );
}

/** API-005 / EC-186: revoke with an optional reason; takes effect on the key's next request. */
function RevokeDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const t = useTranslations("apiKeys");
  const revoke = useMutation(api.apiKeys.revoke);
  const run = useRun();
  const reasonId = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    setBusy(true);
    const trimmed = reason.trim();
    const result = await run(
      () => revoke({ keyId: apiKey.keyId, ...(trimmed ? { reason: trimmed } : {}) }),
      t("revoked"),
    );
    setBusy(false);
    if (result.ok) onClose();
  };

  return (
    <ConfirmDialog
      title={t("revokeTitle", { name: apiKey.name })}
      description={t("revokeDescription")}
      confirmLabel={t("revokeConfirm")}
      destructive
      confirmDisabled={busy}
      onConfirm={confirm}
      onClose={onClose}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={reasonId}>{t("revokeReason")}</Label>
        <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
      </div>
    </ConfirmDialog>
  );
}

/** „Letzte Zugriffe“ (05 §7 access log): the last 50 requests of one key. */
function RequestsDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const t = useTranslations("apiKeys");
  const tCommon = useTranslations("common");
  const rows = useAuthedQuery(api.apiKeys.requests, { keyId: apiKey.keyId });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("requestsTitle", { name: apiKey.name })}</DialogTitle>
          <DialogDescription>{t("requestsDescription")}</DialogDescription>
        </DialogHeader>
        {rows === undefined ? (
          <div className="h-32" aria-busy="true" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noRequests")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("requestColumns.at")}</TableHead>
                <TableHead>{t("requestColumns.channel")}</TableHead>
                <TableHead>{t("requestColumns.request")}</TableHead>
                <TableHead className="text-right">{t("requestColumns.status")}</TableHead>
                <TableHead className="text-right">{t("requestColumns.duration")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={`${r.requestId}-${r.at}`}>
                  <TableCell className="whitespace-nowrap tabular-nums">
                    {formatTimestamp(r.at, { withTime: true })}
                  </TableCell>
                  <TableCell>{t(`channelShort.${r.channel}`)}</TableCell>
                  <TableCell>
                    <code className="break-all text-xs">
                      {r.method} {r.target}
                    </code>
                  </TableCell>
                  <TableCell className={cn("text-right tabular-nums", r.status >= 400 && "text-danger")}>
                    {r.status}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-right tabular-nums">
                    {t("durationMs", { ms: r.durationMs })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
