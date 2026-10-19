"use client";

import { api } from "@convex/_generated/api";
import { useAction, useMutation } from "convex/react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { useCan, useRun } from "@/components/catalog/shared";
import { ConvexGuard } from "@/components/convex/convex-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { NotificationChannels } from "@/domain/notifications/catalog";
import { useAuthedQuery } from "@/hooks/use-authed-query";

const CHANNELS = ["inApp", "email", "ntfy", "digest"] as const;

/** F12 §6 `/einstellungen/benachrichtigungen`: channel matrix (NTF-002), e-mail address (NTF-003), ntfy (NTF-004). */
export function NotificationSettings() {
  return (
    <ConvexGuard>
      <Inner />
    </ConvexGuard>
  );
}

function Inner() {
  const t = useTranslations("notificationCenter.settings");
  const data = useAuthedQuery(api.notifications.settings, {});
  const isOwner = useCan("settings.ownerOnly");
  const setChannels = useMutation(api.notifications.setChannels);
  const run = useRun();
  if (!data) return <p className="text-muted-foreground text-sm">{t("loading")}</p>;

  const toggle = (kind: string, current: NotificationChannels, ch: (typeof CHANNELS)[number], value: boolean) =>
    run(() => setChannels({ kind, channels: { ...current, [ch]: value } }), t("saved"));

  return (
    <div className="@container flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("matrixTitle")}</CardTitle>
          <CardDescription>{t("matrixHint")}</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t("matrixTitle")}</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="py-2 pr-3 font-medium">
                  {t("kind")}
                </th>
                {CHANNELS.map((ch) => (
                  <th key={ch} scope="col" className="px-2 py-2 text-center font-medium">
                    {t(`channel.${ch}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.kind} className="border-b last:border-0">
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="block">{r.label}</span>
                    <span className="text-muted-foreground text-xs">
                      {t(`severity.${r.severity}`)}
                      {r.locked ? ` · ${t("locked")}` : ""}
                    </span>
                  </th>
                  {CHANNELS.map((ch) => {
                    const locked = r.locked && (ch === "inApp" || ch === "email");
                    return (
                      <td key={ch} className="px-2 py-2 text-center">
                        <input
                          type="checkbox"
                          className="size-5"
                          checked={r.channels[ch]}
                          disabled={!isOwner || locked}
                          aria-label={`${r.label}: ${t(`channel.${ch}`)}`}
                          title={locked ? t("lockedHint") : undefined}
                          onChange={(e) => toggle(r.kind, r.channels, ch, e.target.checked)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("emailTitle")}</CardTitle>
          <CardDescription>{t("emailHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm">{data.email ?? t("emailMissing")}</p>
        </CardContent>
      </Card>

      <NtfyCard ntfy={data.ntfy} isPublic={data.ntfyIsPublic} isOwner={isOwner} />
    </div>
  );
}

function NtfyCard({
  ntfy,
  isPublic,
  isOwner,
}: {
  ntfy: { serverUrl: string; topic: string; hasToken: boolean; sendDetails: boolean; failures: number } | null;
  isPublic: boolean;
  isOwner: boolean;
}) {
  const t = useTranslations("notificationCenter.settings");
  const id = useId();
  const save = useMutation(api.notifications.saveNtfy);
  const test = useAction(api.notifications.testNtfy);
  const run = useRun();
  const [serverUrl, setServerUrl] = useState(ntfy?.serverUrl ?? "");
  const [topic, setTopic] = useState(ntfy?.topic ?? "");
  const [token, setToken] = useState("");
  const [sendDetails, setSendDetails] = useState(ntfy?.sendDetails ?? false);
  const [regionWarning, setRegionWarning] = useState<string | null>(null);
  useEffect(() => {
    setServerUrl(ntfy?.serverUrl ?? "");
    setTopic(ntfy?.topic ?? "");
    setSendDetails(ntfy?.sendDetails ?? false);
  }, [ntfy?.serverUrl, ntfy?.topic, ntfy?.sendDetails]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("ntfyTitle")}</CardTitle>
        <CardDescription>{t("ntfyHint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => save({ ntfy: { serverUrl, topic, ...(token ? { token } : {}), sendDetails } }),
              t("saved"),
            ).then((r) => {
              if (!r.ok) return;
              setToken("");
              setRegionWarning(r.value?.warning ?? null);
            });
          }}
        >
          {isPublic && (
            <p role="note" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              {t("ntfyPublicWarning")}
            </p>
          )}
          {regionWarning && (
            <p role="alert" className="rounded-md border border-warning/50 bg-warning/10 p-3 text-sm">
              {regionWarning}
            </p>
          )}
          {ntfy && ntfy.failures >= 3 && (
            <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm">
              {t("ntfyFailing")}
            </p>
          )}
          <div className="grid @lg:grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-url`}>{t("ntfyServer")}</Label>
              <Input
                id={`${id}-url`}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                placeholder="https://ntfy.example.org"
                disabled={!isOwner}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-topic`}>{t("ntfyTopic")}</Label>
              <Input
                id={`${id}-topic`}
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                disabled={!isOwner}
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-token`}>{t("ntfyToken")}</Label>
              <Input
                id={`${id}-token`}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={ntfy?.hasToken ? t("ntfyTokenSet") : ""}
                disabled={!isOwner}
              />
            </div>
            <label className="flex items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                className="size-5"
                checked={sendDetails}
                onChange={(e) => setSendDetails(e.target.checked)}
                disabled={!isOwner}
              />
              {t("ntfyDetails")}
            </label>
          </div>
          <p className="text-muted-foreground text-xs">{t("ntfyDetailsHint")}</p>
          {isOwner && (
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="min-h-11">
                {t("save")}
              </Button>
              {ntfy && (
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-11"
                  onClick={async () => {
                    const r = await run(() => test({}));
                    if (r.ok) (r.value.ok ? toast.success : toast.error)(r.value.message);
                  }}
                >
                  {t("ntfyTest")}
                </Button>
              )}
              {ntfy && (
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-11"
                  onClick={() => run(() => save({ ntfy: null }), t("ntfyRemoved"))}
                >
                  {t("ntfyRemove")}
                </Button>
              )}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
