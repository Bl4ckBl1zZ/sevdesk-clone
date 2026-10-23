"use client";

import { api } from "@convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { PlusIcon, TriangleAlertIcon, WebhookIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
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
import { WEBHOOK_EVENT_GROUPS } from "@/domain/webhooks/events";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { formatTimestamp } from "@/i18n/format";
import { cn } from "@/lib/utils";
import { CopyButton } from "./copy-button";

type Endpoint = FunctionReturnType<typeof api.webhooks.list>[number];
type Delivery = FunctionReturnType<typeof api.webhooks.deliveries>[number];
type EndpointAction = { kind: "edit" | "roll" | "log" | "delete"; endpoint: Endpoint };
type ShownSecret = { secret: string; hint: string; rolledUntil?: number };

const loading = <div className="h-96" aria-busy="true" />;
const at = (ms: number) => formatTimestamp(ms, { withTime: true });

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * `/einstellungen/webhooks` (05 §5.1, API-028): the owner's outbound webhook endpoints — URL, description, events
 * or `*`, enabled; the `whsec_…` secret shown once (create and roll); „Test senden“; the 30-day delivery log with
 * „Erneut senden“. The server checks `webhooks.*` (owner) and the URL policy (SSRF guard, API-031).
 */
export function WebhooksAdmin() {
  return (
    <ConvexGuard fallback={loading}>
      <WebhooksAdminInner />
    </ConvexGuard>
  );
}

function WebhooksAdminInner() {
  const t = useTranslations("webhooks");
  const endpoints = useAuthedQuery(api.webhooks.list, {});
  const [creating, setCreating] = useState(false);
  const [action, setAction] = useState<EndpointAction | null>(null);
  const [secret, setSecret] = useState<ShownSecret | null>(null);

  if (endpoints === undefined) return loading;

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
          {endpoints.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("empty")}</p>
          ) : (
            <EndpointList endpoints={endpoints} onAction={setAction} />
          )}
        </CardContent>
      </Card>

      <VerifyInfo />

      {creating && (
        <EndpointDialog
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
          }}
        />
      )}
      {action?.kind === "edit" && <EndpointDialog endpoint={action.endpoint} onClose={() => setAction(null)} />}
      {action?.kind === "roll" && (
        <RollDialog
          endpoint={action.endpoint}
          onClose={() => setAction(null)}
          onRolled={(s) => {
            setAction(null);
            setSecret(s);
          }}
        />
      )}
      {action?.kind === "delete" && <DeleteDialog endpoint={action.endpoint} onClose={() => setAction(null)} />}
      {action?.kind === "log" && <DeliveryLog endpoint={action.endpoint} onClose={() => setAction(null)} />}
      {secret && <SecretDialog shown={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function StatusBadge({ endpoint }: { endpoint: Endpoint }) {
  const t = useTranslations("webhooks");
  if (endpoint.enabled) return <Badge variant="default">{t("status.active")}</Badge>;
  return (
    <Badge variant={endpoint.disabledReason === "manual" ? "secondary" : "destructive"}>
      {t(`status.${endpoint.disabledReason ?? "manual"}`)}
    </Badge>
  );
}

function EventsSummary({ events }: { events: readonly string[] }) {
  const t = useTranslations("webhooks");
  if (events.includes("*")) return <span>{t("allEvents")}</span>;
  return (
    <details>
      <summary className="flex min-h-11 cursor-pointer items-center rounded-sm underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-0">
        {t("eventsCount", { count: events.length })}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5 text-xs">
        {events.map((e) => (
          <li key={e}>
            <code>{e}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

function LastDelivery({ endpoint }: { endpoint: Endpoint }) {
  const t = useTranslations("webhooks");
  if (endpoint.lastSuccessAt === null && endpoint.lastFailureAt === null) {
    return <span className="text-muted-foreground">{t("never")}</span>;
  }
  return (
    <div className="flex flex-col text-xs" data-volatile="">
      {endpoint.lastSuccessAt !== null && <span>{t("lastSuccess", { at: at(endpoint.lastSuccessAt) })}</span>}
      {endpoint.lastFailureAt !== null && (
        <span className="text-danger">{t("lastFailure", { at: at(endpoint.lastFailureAt) })}</span>
      )}
      {endpoint.failingSince !== null && (
        <span className="text-danger">{t("status.failingSince", { at: at(endpoint.failingSince) })}</span>
      )}
    </div>
  );
}

function SecretHint({ endpoint }: { endpoint: Endpoint }) {
  const t = useTranslations("webhooks");
  return (
    <div className="flex flex-col">
      <code className="text-xs">{endpoint.secretHint}</code>
      {endpoint.secretRollingUntil !== null && (
        <span className="text-muted-foreground text-xs">
          {t("rollingUntil", { at: at(endpoint.secretRollingUntil) })}
        </span>
      )}
    </div>
  );
}

function EndpointActions({ endpoint, onAction }: { endpoint: Endpoint; onAction: (a: EndpointAction) => void }) {
  const t = useTranslations("webhooks");
  const sendTest = useMutation(api.webhooks.sendTest);
  const run = useRun();
  const host = hostOf(endpoint.url);
  const button = (label: string, onClick: () => void, className?: string) => (
    <Button
      variant="outline"
      size="sm"
      className={cn("h-11 md:h-8", className)}
      aria-label={`${label} (${host})`}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return (
    <div className="flex flex-wrap gap-2 @3xl/main:justify-end">
      {button(
        t("actions.test"),
        () => void run(() => sendTest({ endpointId: endpoint.endpointId }), t("toast.testQueued")),
      )}
      {button(t("actions.log"), () => onAction({ kind: "log", endpoint }))}
      {button(t("actions.edit"), () => onAction({ kind: "edit", endpoint }))}
      {button(t("actions.roll"), () => onAction({ kind: "roll", endpoint }))}
      {button(t("actions.delete"), () => onAction({ kind: "delete", endpoint }), "text-destructive")}
    </div>
  );
}

function EndpointList({ endpoints, onAction }: { endpoints: Endpoint[]; onAction: (a: EndpointAction) => void }) {
  const t = useTranslations("webhooks");
  return (
    <>
      {/* Desktop: table; narrow main area: cards (04-ui-ux §4.1). */}
      <div className="hidden @3xl/main:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.endpoint")}</TableHead>
              <TableHead>{t("columns.events")}</TableHead>
              <TableHead>{t("columns.status")}</TableHead>
              <TableHead>{t("columns.lastDelivery")}</TableHead>
              <TableHead>{t("columns.secret")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("columns.actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.map((e) => (
              <TableRow key={e.endpointId} className={cn("align-top", !e.enabled && "text-muted-foreground")}>
                <TableCell className="max-w-72">
                  <div className="flex flex-col">
                    <span className="break-all font-medium">{e.url}</span>
                    {e.description && <span className="text-muted-foreground text-xs">{e.description}</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <EventsSummary events={e.events} />
                </TableCell>
                <TableCell>
                  <StatusBadge endpoint={e} />
                </TableCell>
                <TableCell>
                  <LastDelivery endpoint={e} />
                </TableCell>
                <TableCell>
                  <SecretHint endpoint={e} />
                </TableCell>
                <TableCell>
                  <EndpointActions endpoint={e} onAction={onAction} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y rounded-lg border @3xl/main:hidden">
        {endpoints.map((e) => (
          <li
            key={e.endpointId}
            data-webhook-endpoint=""
            className={cn("flex flex-col gap-2 p-3 text-sm", !e.enabled && "text-muted-foreground")}
          >
            <div className="flex flex-wrap items-center gap-2">
              <WebhookIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <span className="min-w-0 flex-1 break-all font-medium">{e.url}</span>
              <StatusBadge endpoint={e} />
            </div>
            {e.description && <span className="text-muted-foreground text-xs">{e.description}</span>}
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
              <dt className="text-muted-foreground">{t("columns.events")}</dt>
              <dd>
                <EventsSummary events={e.events} />
              </dd>
              <dt className="text-muted-foreground">{t("columns.lastDelivery")}</dt>
              <dd>
                <LastDelivery endpoint={e} />
              </dd>
              <dt className="text-muted-foreground">{t("columns.secret")}</dt>
              <dd>
                <SecretHint endpoint={e} />
              </dd>
            </dl>
            <EndpointActions endpoint={e} onAction={onAction} />
          </li>
        ))}
      </ul>
    </>
  );
}

/** Event picker: „Alle Ereignisse“ (`*`) or individual events grouped by area. */
function EventsField({
  value,
  onChange,
  error,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  error: string | null;
}) {
  const t = useTranslations("webhooks");
  const id = useId();
  const all = value.includes("*");
  const toggle = (event: string, checked: boolean) =>
    onChange(checked ? [...value.filter((v) => v !== "*"), event] : value.filter((v) => v !== event));
  return (
    <fieldset
      className="flex flex-col gap-3"
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-hint ${id}-error` : `${id}-hint`}
    >
      <legend className="mb-1 font-medium text-sm">
        {t("form.events")}
        <span aria-hidden="true" className="text-danger">
          {" "}
          *
        </span>
      </legend>
      <p id={`${id}-hint`} className="text-muted-foreground text-sm">
        {t("form.eventsHint")}
      </p>
      <label htmlFor={`${id}-all`} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
        <input
          id={`${id}-all`}
          type="checkbox"
          className="size-5 shrink-0 accent-primary md:size-4"
          checked={all}
          onChange={(e) => onChange(e.target.checked ? ["*"] : [])}
        />
        <span className="font-medium">{t("allEvents")}</span>
      </label>
      {!all && (
        <div className="grid gap-3 @lg/form:grid-cols-2">
          {WEBHOOK_EVENT_GROUPS.map((group) => (
            <fieldset key={group.key} className="flex flex-col gap-1 rounded-lg border p-3">
              <legend className="px-1 font-medium text-sm">{t(`groups.${group.key}`)}</legend>
              {group.events.map((event) => {
                const boxId = `${id}-${event}`;
                return (
                  <label key={event} htmlFor={boxId} className="flex min-h-11 items-center gap-2 py-0.5 md:min-h-0">
                    <input
                      id={boxId}
                      type="checkbox"
                      className="size-5 shrink-0 accent-primary md:size-4"
                      checked={value.includes(event)}
                      onChange={(e) => toggle(event, e.target.checked)}
                    />
                    <code className="text-xs">{event}</code>
                  </label>
                );
              })}
            </fieldset>
          ))}
        </div>
      )}
      {error && (
        <p id={`${id}-error`} className="text-danger text-sm">
          {error}
        </p>
      )}
    </fieldset>
  );
}

/** Create (secret shown once afterwards) or edit an endpoint. The server re-checks URL policy and events. */
function EndpointDialog({
  endpoint,
  onClose,
  onCreated,
}: {
  endpoint?: Endpoint;
  onClose: () => void;
  onCreated?: (s: ShownSecret) => void;
}) {
  const t = useTranslations("webhooks");
  const tCommon = useTranslations("common");
  const create = useAction(api.webhooks.create);
  const update = useMutation(api.webhooks.update);
  const run = useRun();
  const formId = useId();
  const urlId = useId();
  const descId = useId();
  const enabledId = useId();
  const [url, setUrl] = useState(endpoint?.url ?? "");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [events, setEvents] = useState<string[]>(endpoint?.events ?? ["*"]);
  const [enabled, setEnabled] = useState(endpoint?.enabled ?? true);
  const [errors, setErrors] = useState<{ url: string | null; events: string | null }>({ url: null, events: null });
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = {
      url: url.trim() ? null : t("form.urlRequired"),
      events: events.length > 0 ? null : t("form.eventsRequired"),
    };
    setErrors(next);
    if (next.url || next.events) return;
    setBusy(true);
    const values = { url: url.trim(), description: description.trim(), events, enabled };
    if (endpoint) {
      const r = await run(
        () =>
          update({
            endpointId: endpoint.endpointId,
            values: { ...values, description: values.description || null },
          }),
        t("toast.saved"),
      );
      setBusy(false);
      if (r.ok) onClose();
      return;
    }
    const r = await run(
      () => create({ values: { ...values, ...(values.description ? {} : { description: undefined }) } }),
      t("toast.created"),
    );
    setBusy(false);
    if (r.ok) onCreated?.({ secret: r.value.secret, hint: `whsec_…${r.value.secret.slice(-4)}` });
  };

  const urlError = errors.url;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{endpoint ? t("form.editTitle") : t("form.createTitle")}</DialogTitle>
          <DialogDescription>{t("form.formDescription")}</DialogDescription>
        </DialogHeader>
        <form id={formId} noValidate onSubmit={submit} className="@container/form flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={urlId}>
              {t("form.url")}
              <span aria-hidden="true" className="text-danger">
                *
              </span>
            </Label>
            <Input
              id={urlId}
              type="url"
              inputMode="url"
              autoComplete="off"
              aria-required
              aria-invalid={urlError ? true : undefined}
              aria-describedby={urlError ? `${urlId}-hint ${urlId}-error` : `${urlId}-hint`}
              className="h-11 md:h-9"
              value={url}
              maxLength={2000}
              onChange={(e) => setUrl(e.target.value)}
            />
            <p id={`${urlId}-hint`} className="text-muted-foreground text-sm">
              {t("form.urlHint")}
            </p>
            {urlError && (
              <p id={`${urlId}-error`} className="text-danger text-sm">
                {urlError}
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={descId}>{t("form.descriptionField")}</Label>
            <Input
              id={descId}
              className="h-11 md:h-9"
              value={description}
              maxLength={500}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <EventsField value={events} onChange={setEvents} error={errors.events} />
          <label htmlFor={enabledId} className="flex min-h-11 items-center gap-2 text-sm md:min-h-0">
            <input
              id={enabledId}
              type="checkbox"
              className="size-5 shrink-0 accent-primary md:size-4"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("form.enabled")}
          </label>
        </form>
        <DialogFooter>
          <Button variant="outline" className="h-11 md:h-9" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button type="submit" form={formId} className="h-11 md:h-9" disabled={busy}>
            {endpoint ? t("form.submitEdit") : t("form.submitCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The `whsec_…` secret, shown exactly once after create or roll. */
function SecretDialog({ shown, onClose }: { shown: ShownSecret; onClose: () => void }) {
  const t = useTranslations("webhooks");
  const id = useId();
  const rolled = shown.rolledUntil !== undefined;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{rolled ? t("secret.rolledTitle") : t("secret.createdTitle")}</DialogTitle>
          <DialogDescription>
            {rolled
              ? t("secret.rolledDescription", { at: at(shown.rolledUntil ?? 0) })
              : t("secret.createdDescription")}
          </DialogDescription>
        </DialogHeader>
        <p role="status" className="flex items-start gap-2 rounded-md border border-warning bg-warning/10 p-3 text-sm">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("secret.onceWarning", { hint: shown.hint })}
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={id}>{t("secret.label")}</Label>
          <div className="flex gap-2">
            <Input
              id={id}
              readOnly
              value={shown.secret}
              className="h-11 font-mono md:h-9"
              onFocus={(e) => e.currentTarget.select()}
            />
            <CopyButton value={shown.secret} label={t("secret.copy")} />
          </div>
        </div>
        <DialogFooter>
          <Button className="h-11 md:h-9" onClick={onClose}>
            {t("secret.done")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RollDialog({
  endpoint,
  onClose,
  onRolled,
}: {
  endpoint: Endpoint;
  onClose: () => void;
  onRolled: (s: ShownSecret) => void;
}) {
  const t = useTranslations("webhooks");
  const roll = useAction(api.webhooks.rollSecret);
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    const r = await run(() => roll({ endpointId: endpoint.endpointId }), t("toast.rolled"));
    setBusy(false);
    if (r.ok) {
      onRolled({
        secret: r.value.secret,
        hint: `whsec_…${r.value.secret.slice(-4)}`,
        rolledUntil: r.value.previousValidUntil,
      });
    }
  };
  return (
    <ConfirmDialog
      title={t("rollTitle")}
      description={t("rollDescription")}
      confirmLabel={t("rollConfirm")}
      confirmDisabled={busy}
      onConfirm={confirm}
      onClose={onClose}
    />
  );
}

function DeleteDialog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const t = useTranslations("webhooks");
  const remove = useMutation(api.webhooks.remove);
  const run = useRun();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    const r = await run(() => remove({ endpointId: endpoint.endpointId }), t("toast.deleted"));
    setBusy(false);
    if (r.ok) onClose();
  };
  return (
    <ConfirmDialog
      title={t("deleteTitle", { host: hostOf(endpoint.url) })}
      description={t("deleteDescription")}
      confirmLabel={t("deleteConfirm")}
      destructive
      confirmDisabled={busy}
      onConfirm={confirm}
      onClose={onClose}
    />
  );
}

function DeliveryStatus({ delivery }: { delivery: Delivery }) {
  const t = useTranslations("webhooks");
  const variant =
    delivery.status === "success"
      ? "default"
      : delivery.status === "failed" || delivery.status === "gave_up"
        ? "destructive"
        : "secondary";
  return <Badge variant={variant}>{t(`log.statuses.${delivery.status}`)}</Badge>;
}

/** 30-day delivery log with request/response snippets and „Erneut senden“. */
function DeliveryLog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const t = useTranslations("webhooks");
  const tCommon = useTranslations("common");
  const rows = useAuthedQuery(api.webhooks.deliveries, { endpointId: endpoint.endpointId });
  const replay = useMutation(api.webhooks.replay);
  const run = useRun();
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("log.title", { host: hostOf(endpoint.url) })}</DialogTitle>
          <DialogDescription>{t("log.description")}</DialogDescription>
        </DialogHeader>
        {rows === undefined ? (
          <div className="h-32" aria-busy="true" />
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("log.empty")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {rows.map((d) => (
              <li key={d.deliveryId} className="flex flex-col gap-2 p-3 text-sm" data-webhook-delivery="">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-medium">{d.type}</code>
                  <DeliveryStatus delivery={d} />
                  {d.replayOf !== null && <Badge variant="outline">{t("log.replayOf")}</Badge>}
                  <span className="text-muted-foreground tabular-nums">{at(d.lastAttemptAt ?? d.createdAt)}</span>
                  <span className="ml-auto flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-11 md:h-8"
                      onClick={() => void run(() => replay({ deliveryId: d.deliveryId }), t("toast.replayQueued"))}
                    >
                      {t("log.replay")}
                      <span className="sr-only">
                        {" "}
                        ({d.type}, {at(d.createdAt)})
                      </span>
                    </Button>
                  </span>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">{t("log.attempts")}</dt>
                  <dd className="tabular-nums">{d.attempts}</dd>
                  <dt className="text-muted-foreground">{t("log.response")}</dt>
                  <dd className={cn("tabular-nums", d.httpStatus !== null && d.httpStatus >= 300 && "text-danger")}>
                    {d.httpStatus ?? "–"}
                    {d.durationMs !== null && ` · ${t("log.durationMs", { ms: d.durationMs })}`}
                    {d.error && <span className="block text-danger">{d.error}</span>}
                  </dd>
                  {d.nextAttemptAt !== null && (
                    <>
                      <dt className="sr-only">{t("log.status")}</dt>
                      <dd className="col-span-2 text-muted-foreground">{t("log.next", { at: at(d.nextAttemptAt) })}</dd>
                    </>
                  )}
                  <dt className="text-muted-foreground">webhook-id</dt>
                  <dd>
                    <code className="break-all">{d.eventId}</code>
                  </dd>
                </dl>
                {(d.requestSnippet || d.responseSnippet) && (
                  <details>
                    <summary className="flex min-h-11 cursor-pointer items-center rounded-sm text-xs underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring md:min-h-0">
                      {t("log.details")}
                    </summary>
                    {d.requestSnippet && (
                      <div className="mt-2 flex flex-col gap-1">
                        <span className="font-medium text-xs">{t("log.request")}</span>
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                          {d.requestSnippet}
                        </pre>
                      </div>
                    )}
                    {d.responseSnippet && (
                      <div className="mt-2 flex flex-col gap-1">
                        <span className="font-medium text-xs">{t("log.responseBody")}</span>
                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-2 text-xs">
                          {d.responseSnippet}
                        </pre>
                      </div>
                    )}
                  </details>
                )}
              </li>
            ))}
          </ul>
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

function VerifyInfo() {
  const t = useTranslations("webhooks");
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{t("info.title")}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
          <li>{t("info.standard")}</li>
          <li>{t("info.verify")}</li>
          <li>{t("info.success")}</li>
          <li>{t("info.retries")}</li>
          <li>{t("info.order")}</li>
        </ul>
      </CardContent>
    </Card>
  );
}
