"use client";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { useAction, useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";
import { syncNowAction } from "@/app/(app)/(shell)/einstellungen/bank/verbindung/actions";
import { ConfirmDialog, formatDateTime, selectClass, useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { CopyButton } from "@/components/settings/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import { cn } from "@/lib/utils";

/**
 * Einstellungen › Bank › Verbindung (F01 SET-049/049a/050a/050c, F07 BNK-101…117, 04 §4.13): setup checklist,
 * application ID + key (generated here or uploaded; encrypted server-side, never shown again), consent status with
 * validity, „Bank verbinden“ / „Neu verbinden“, „Jetzt abrufen“ (owner present), „Trennen“, the account mapping and
 * the written confirmation of Enable Banking. Every action is re-checked in Convex (owner, fresh session).
 */

export type ConnectionView = FunctionReturnType<typeof api.bankFeed.connection>;

export function BankConnectionPanel() {
  return (
    <ConvexGuard fallback={<div className="h-96" aria-busy="true" />}>
      <BankConnectionInner />
    </ConvexGuard>
  );
}

function BankConnectionInner() {
  const view = useAuthedQuery(api.bankFeed.connection, {});
  const canSetup = useCan("bankFeed.setup");
  const canFetch = useCan("bankFeed.fetch");
  if (!view) return <div className="h-96" aria-busy="true" />;
  return <BankConnectionView view={view} canSetup={canSetup} canFetch={canFetch} />;
}

export function BankConnectionView({
  view,
  canSetup,
  canFetch,
}: {
  view: ConnectionView;
  canSetup: boolean;
  canFetch: boolean;
}) {
  const t = useTranslations("bankFeed");
  return (
    <div className="@container flex flex-col gap-6">
      {view.evaluationNotice && (
        <p role="status" className="rounded-md border border-info/40 bg-info/10 px-3 py-2 text-sm">
          {view.evaluationNotice}
        </p>
      )}
      {view.banner && (
        <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {view.banner.message}
        </p>
      )}
      {view.sandboxNotice && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {view.sandboxNotice}
        </p>
      )}
      {view.feedLostMessage && (
        <p role="status" className="rounded-md border px-3 py-2 text-sm">
          {view.feedLostMessage}
        </p>
      )}
      <div className="grid gap-6 @3xl:grid-cols-2">
        <Checklist view={view} />
        <StatusCard view={view} canSetup={canSetup} canFetch={canFetch} />
      </div>
      {canSetup && <SetupCard view={view} />}
      {view.pendingAccounts.length > 0 && <PendingAccounts view={view} canMap={canSetup} />}
      <AccountsCard view={view} />
      <ConfirmationCard view={view} canEdit={canSetup} />
      <p className="text-sm text-muted-foreground">
        <Link className="underline underline-offset-4" href="/einstellungen/bank/regeln">
          {t("rulesLink")}
        </Link>
      </p>
    </div>
  );
}

function Checklist({ view }: { view: ConnectionView }) {
  const t = useTranslations("bankFeed");
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("checklist.title")}</h2>
        </CardTitle>
        <CardDescription>{t("checklist.description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="flex flex-col gap-2 text-sm">
          {view.checklist.map((s, i) => (
            <li key={s.step} className="flex items-start gap-2">
              {s.done ? (
                <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <CircleDashedIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              )}
              <span>
                {i + 1}. {s.label}
                <span className="sr-only">{s.done ? t("checklist.done") : t("checklist.open")}</span>
              </span>
            </li>
          ))}
        </ol>
        {view.redirectUrl && (
          <div className="mt-4 flex flex-col gap-1">
            <span className="text-sm text-muted-foreground">{t("redirectUrl")}</span>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate rounded bg-muted px-2 py-1 text-xs">{view.redirectUrl}</code>
              <CopyButton value={view.redirectUrl} label={t("copyRedirect")} />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusCard({ view, canSetup, canFetch }: { view: ConnectionView; canSetup: boolean; canFetch: boolean }) {
  const t = useTranslations("bankFeed");
  const run = useRun();
  const start = useAction(api.bankFeedNode.startConsent);
  const [pending, startTransition] = useTransition();
  const [disconnecting, setDisconnecting] = useState(false);
  const connected = view.status === "active" || view.status === "error";
  const reconnect = view.status === "reauth_required" || view.status === "disconnected" || connected;

  const connect = async () => {
    const r = await run(() => start({}));
    if (r.ok) window.location.assign(r.value.url);
  };
  const syncNow = () =>
    startTransition(async () => {
      const r = await syncNowAction();
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      const res = r.result as { skipped: string | null; accounts: { inserted: number }[] };
      if (res.skipped) toast.error(t("sync.skipped"));
      else toast.success(t("sync.done", { count: res.accounts.reduce((s, a) => s + a.inserted, 0) }));
    });

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("status.title")}</h2>
        </CardTitle>
        <CardDescription>
          <Badge variant={view.status === "active" ? "default" : "secondary"}>{view.statusLabel}</Badge>
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1">
          {view.aspsp && (
            <>
              <dt className="text-muted-foreground">{t("status.bank")}</dt>
              <dd>
                {view.aspsp.name} ({view.aspsp.country})
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">{t("status.validity")}</dt>
          <dd>{view.validity ?? "—"}</dd>
          <dt className="text-muted-foreground">{t("status.lastPoll")}</dt>
          <dd>{view.lastSuccessfulPollAt ? formatDateTime(view.lastSuccessfulPollAt) : "—"}</dd>
          <dt className="text-muted-foreground">{t("status.nextPoll")}</dt>
          <dd>{view.nextPollAt ? formatDateTime(view.nextPollAt) : "—"}</dd>
          {view.lastError && (
            <>
              <dt className="text-muted-foreground">{t("status.lastError")}</dt>
              <dd className="text-danger">{view.lastError}</dd>
            </>
          )}
          {view.backfill && (
            <>
              <dt className="text-muted-foreground">{t("status.backfill")}</dt>
              <dd>
                {view.backfill.finishedAt
                  ? t("status.backfillDone", { count: view.backfill.inserted ?? 0, from: view.backfill.from })
                  : t("status.backfillRunning")}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          {canSetup && (
            <Button className="h-11 md:h-9" disabled={!view.configured} onClick={connect}>
              {reconnect ? t("actions.reconnect") : t("actions.connect")}
            </Button>
          )}
          {canFetch && view.status === "active" && (
            <Button variant="outline" className="h-11 md:h-9" disabled={pending} onClick={syncNow}>
              <RefreshCwIcon className={cn("size-4", pending && "animate-spin")} aria-hidden="true" />
              {t("actions.syncNow")}
            </Button>
          )}
          {canSetup && view.configured && view.status !== "not_configured" && (
            <Button variant="outline" className="h-11 md:h-9" onClick={() => setDisconnecting(true)}>
              {t("actions.disconnect")}
            </Button>
          )}
        </div>
        {!view.configured && canSetup && <p className="text-muted-foreground">{t("actions.disabledHint")}</p>}
      </CardContent>
      {disconnecting && <DisconnectDialog onClose={() => setDisconnecting(false)} />}
    </Card>
  );
}

function DisconnectDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations("bankFeed.disconnect");
  const run = useRun();
  const disconnect = useAction(api.bankFeedNode.disconnect);
  const [deleteKey, setDeleteKey] = useState(false);
  const [lost, setLost] = useState(false);
  const [reason, setReason] = useState("");
  const keyId = useId();
  const lostId = useId();
  const reasonId = useId();
  return (
    <ConfirmDialog
      title={t("title")}
      description={t("description")}
      confirmLabel={t("confirm")}
      destructive
      confirmDisabled={lost && reason.trim().length < 5}
      onClose={onClose}
      onConfirm={async () => {
        const r = await run(() => disconnect({ deleteKey, ...(lost ? { feedLost: reason.trim() } : {}) }), t("done"));
        if (r.ok) onClose();
      }}
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex items-center gap-2">
          <Checkbox id={keyId} checked={deleteKey} onCheckedChange={(v) => setDeleteKey(v === true)} />
          <Label htmlFor={keyId}>{t("deleteKey")}</Label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id={lostId} checked={lost} onCheckedChange={(v) => setLost(v === true)} />
          <Label htmlFor={lostId}>{t("feedLost")}</Label>
        </div>
        {lost && (
          <div className="flex flex-col gap-1">
            <Label htmlFor={reasonId}>{t("reason")}</Label>
            <Input id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        )}
      </div>
    </ConfirmDialog>
  );
}

function SetupCard({ view }: { view: ConnectionView }) {
  const t = useTranslations("bankFeed.setup");
  const run = useRun();
  const save = useAction(api.bankFeedNode.saveSetup);
  const [appId, setAppId] = useState(view.applicationId ?? "");
  const [mode, setMode] = useState<"generate" | "upload" | "keep">(view.keyStored ? "keep" : "generate");
  const [pem, setPem] = useState("");
  const [publicKey, setPublicKey] = useState<string | null>(view.publicKeyPem);
  const [environment, setEnvironment] = useState(view.environment);
  const appIdId = useId();
  const pemId = useId();
  const envId = useId();
  const modeName = useId();
  const validAppId = /^[0-9a-fA-F-]{8,64}$/.test(appId.trim());
  const canSave = validAppId && (mode !== "upload" || pem.includes("PRIVATE KEY"));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const r = await run(
      () =>
        save({
          applicationId: appId.trim(),
          environment,
          ...(mode === "generate" ? { generateKey: true } : {}),
          ...(mode === "upload" ? { privateKeyPem: pem } : {}),
        }),
      t("saved"),
    );
    if (r.ok) {
      setPem("");
      if (r.value.publicKeyPem) setPublicKey(r.value.publicKeyPem);
      setMode("keep");
    }
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-1">
            <Label htmlFor={appIdId}>{t("appId")}</Label>
            <Input
              id={appIdId}
              value={appId}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={appId !== "" && !validAppId}
              onChange={(e) => setAppId(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t("appIdHint")}</p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={envId}>{t("environment")}</Label>
            <select
              id={envId}
              className={selectClass}
              value={environment}
              onChange={(e) => setEnvironment(e.target.value as typeof environment)}
            >
              <option value="production">{t("production")}</option>
              <option value="sandbox">{t("sandbox")}</option>
            </select>
          </div>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 font-medium">{t("key")}</legend>
            {view.keyStored && (
              <label className="flex items-center gap-2">
                <input type="radio" name={modeName} checked={mode === "keep"} onChange={() => setMode("keep")} />
                {t("keyKeep")}
              </label>
            )}
            <label className="flex items-center gap-2">
              <input type="radio" name={modeName} checked={mode === "generate"} onChange={() => setMode("generate")} />
              {t("keyGenerate")}
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name={modeName} checked={mode === "upload"} onChange={() => setMode("upload")} />
              {t("keyUpload")}
            </label>
          </fieldset>
          {mode === "upload" && (
            <div className="flex flex-col gap-1">
              <Label htmlFor={pemId}>{t("pem")}</Label>
              <Textarea
                id={pemId}
                rows={6}
                value={pem}
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
                onChange={(e) => setPem(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("pemHint")}</p>
            </div>
          )}
          <Button type="submit" className="h-11 self-start md:h-9" disabled={!canSave}>
            {t("save")}
          </Button>
        </form>
        {publicKey && (
          <div className="mt-4 flex flex-col gap-1">
            <span className="text-sm font-medium">{t("publicKey")}</span>
            <p className="text-xs text-muted-foreground">{t("publicKeyHint")}</p>
            <pre className="max-h-40 overflow-auto rounded bg-muted p-2 text-xs">{publicKey}</pre>
            <CopyButton value={publicKey} label={t("copyPublicKey")} className="self-start" />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PendingAccounts({ view, canMap }: { view: ConnectionView; canMap: boolean }) {
  const t = useTranslations("bankFeed.pending");
  const run = useRun();
  const accounts = useAuthedQuery(api.banking.accounts, {});
  const map = useAction(api.bankFeedNode.mapAccount);
  const [choice, setChoice] = useState<Record<string, string>>({});
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-4">
          {view.pendingAccounts.map((p) => {
            const options = (accounts ?? []).filter((a) => a.kind === "bank" && a.currency === p.currency);
            const selectId = `map-${p.uid}`;
            return (
              <li key={p.uid} className="flex flex-col gap-2 rounded-md border p-3 text-sm">
                <span className="font-medium">{p.message}</span>
                <span className="text-muted-foreground">
                  {p.iban ?? p.localDetails.map((d) => `${d.scheme} ${d.identification}`).join(", ")} · {p.currency}
                  {p.name ? ` · ${p.name}` : ""}
                </span>
                {!p.printable && <span className="text-muted-foreground">{t("notPrintable")}</span>}
                {canMap && (
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex min-w-0 flex-col gap-1">
                      <Label htmlFor={selectId}>{t("target")}</Label>
                      <select
                        id={selectId}
                        className={selectClass}
                        value={choice[p.uid] ?? ""}
                        onChange={(e) => setChoice({ ...choice, [p.uid]: e.target.value })}
                      >
                        <option value="">{t("createNew")}</option>
                        {options.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button
                      className="h-11 md:h-9"
                      onClick={() =>
                        run(
                          () =>
                            map({
                              uid: p.uid,
                              ...(choice[p.uid] ? { accountId: choice[p.uid] as Id<"bankAccounts"> } : {}),
                            }),
                          t("mapped"),
                        )
                      }
                    >
                      {t("map")}
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

function AccountsCard({ view }: { view: ConnectionView }) {
  const t = useTranslations("bankFeed.accounts");
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        {view.accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <Table scrollLabel={t("title")}>
            <TableHeader>
              <TableRow>
                <TableHead>{t("name")}</TableHead>
                <TableHead>{t("iban")}</TableHead>
                <TableHead>{t("lastPoll")}</TableHead>
                <TableHead>{t("budget")}</TableHead>
                <TableHead>{t("state")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.accounts.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link className="underline-offset-4 hover:underline" href={`/bank/${a.id}`}>
                      {a.name}
                    </Link>{" "}
                    <span className="text-muted-foreground">{a.currency}</span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{a.iban ?? "—"}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {a.lastPolledAt ? formatDateTime(a.lastPolledAt) : "—"}
                  </TableCell>
                  <TableCell>{t("budgetValue", { used: a.unattendedToday, limit: a.unattendedLimit })}</TableCell>
                  <TableCell className="text-sm">
                    {a.missing ? (
                      <span className="inline-flex items-center gap-1 text-warning">
                        <CircleAlertIcon className="size-4" aria-hidden="true" />
                        {t("missing")}
                      </span>
                    ) : a.backoffUntil ? (
                      t("backoff", { until: formatDateTime(a.backoffUntil) })
                    ) : a.linked ? (
                      t("linked")
                    ) : (
                      t("notLinked")
                    )}
                    {a.pending > 0 && (
                      <span className="block text-muted-foreground">{t("pending", { count: a.pending })}</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ConfirmationCard({ view, canEdit }: { view: ConnectionView; canEdit: boolean }) {
  const t = useTranslations("bankFeed.confirmation");
  const run = useRun();
  const record = useMutation(api.bankFeed.recordEvaluationConfirmation);
  const uploadUrl = useMutation(api.bankFeed.generateUploadUrl);
  const [status, setStatus] = useState(view.confirmation.status);
  const [note, setNote] = useState(view.confirmation.note ?? "");
  const [file, setFile] = useState<File | null>(null);
  const statusId = useId();
  const noteId = useId();
  const fileId = useId();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    await run(async () => {
      let fileStorageId: Id<"_storage"> | undefined;
      if (file) {
        const url = await uploadUrl({});
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file });
        if (!res.ok) throw new Error(t("uploadFailed"));
        fileStorageId = ((await res.json()) as { storageId: Id<"_storage"> }).storageId;
      }
      await record({
        status,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(fileStorageId ? { fileStorageId, fileName: file?.name } : {}),
      });
    }, t("saved"));
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm">
        <p className="mb-3">
          {view.confirmation.label}
          {view.confirmation.recordedAt ? ` · ${formatDateTime(view.confirmation.recordedAt)}` : ""}
          {view.confirmation.fileName ? ` · ${view.confirmation.fileName}` : ""}
        </p>
        {canEdit && (
          <form className="flex flex-col gap-3" onSubmit={submit}>
            <div className="flex flex-col gap-1">
              <Label htmlFor={statusId}>{t("status")}</Label>
              <select
                id={statusId}
                className={selectClass}
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="pending">{t("statuses.pending")}</option>
                <option value="confirmed">{t("statuses.confirmed")}</option>
                <option value="quoted">{t("statuses.quoted")}</option>
                <option value="declined">{t("statuses.declined")}</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={noteId}>{t("note")}</Label>
              <Textarea id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={fileId}>{t("file")}</Label>
              <Input
                id={fileId}
                type="file"
                accept="application/pdf,image/*,message/rfc822,.eml"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <Button type="submit" variant="outline" className="h-11 self-start md:h-9">
              {t("save")}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
