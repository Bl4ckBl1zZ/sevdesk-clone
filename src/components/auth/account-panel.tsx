"use client";

import { KeyRoundIcon, LogOutIcon, MonitorSmartphoneIcon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
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
import { formatTimestamp } from "@/i18n/format";
import { authClient } from "@/lib/auth-client";
import { mapAuthError } from "./errors";
import { usePasskeyRegistration } from "./passkey-enrol";
import { useSessionState } from "./session-provider";

interface PasskeyRow {
  id: string;
  name?: string | null;
  createdAt: Date | string;
  deviceType?: string;
}

interface SessionRow {
  id: string;
  token: string;
  userAgent?: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

const ts = (d: Date | string) => new Date(d).getTime();

/**
 * `/konto` (04-ui-ux §4.9): own passkeys (add, rename, remove), TOTP (follows), active sessions, sign out.
 * Removing the owner's last passkey needs a fresh sign-in on the server; the dialog warns.
 */
export function AccountPanel() {
  const t = useTranslations("account");
  const tAuth = useTranslations("auth");
  const router = useRouter();
  const { markSigningOut } = useSessionState();
  const { data: session } = authClient.useSession();
  const { data: passkeys, refetch } = authClient.useListPasskeys();
  const { register, pending, error } = usePasskeyRegistration();
  const [renaming, setRenaming] = useState<PasskeyRow | null>(null);
  const [removing, setRemoving] = useState<PasskeyRow | null>(null);
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const list = (passkeys ?? []) as PasskeyRow[];

  const loadSessions = useCallback(async () => {
    try {
      const res = await authClient.listSessions();
      setSessions(res?.data ? (res.data as SessionRow[]) : []);
    } catch {
      setSessions([]);
    }
  }, []);
  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  const fail = (e: unknown) => toast.error(tAuth(`errors.${mapAuthError(e).key}`, mapAuthError(e).values));

  return (
    <div className="grid gap-4 @4xl/main:grid-cols-2">
      <Card className="@4xl/main:col-span-2">
        <CardHeader>
          <CardTitle>
            <h2>{t("email")}</h2>
          </CardTitle>
          <CardDescription>{t("emailReadOnly")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="font-medium">{session?.user.email ?? "—"}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("passkeys")}</h2>
          </CardTitle>
          <CardDescription>{t("passkeysDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {list.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("noPasskeys")}</p>
          ) : (
            <ul className="flex flex-col divide-y rounded-lg border">
              {list.map((p) => (
                <li key={p.id} className="flex items-center gap-2 p-3">
                  <KeyRoundIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-sm">{p.name || t("unnamedPasskey")}</span>
                    <span className="text-muted-foreground text-xs" data-volatile="">
                      {t("createdAt", { date: formatTimestamp(ts(p.createdAt)) })}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 md:size-8"
                    aria-label={`${t("rename")}: ${p.name || t("unnamedPasskey")}`}
                    onClick={() => setRenaming(p)}
                  >
                    <PencilIcon aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-11 md:size-8"
                    aria-label={`${t("remove")}: ${p.name || t("unnamedPasskey")}`}
                    onClick={() => setRemoving(p)}
                  >
                    <Trash2Icon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <Button
            variant="outline"
            className="h-11 self-start md:h-9"
            disabled={pending}
            onClick={async () => {
              if (await register()) {
                toast.success(t("passkeyAdded"));
                refetch?.();
              }
            }}
          >
            <PlusIcon aria-hidden="true" />
            {list.length === 0 ? t("addPasskey") : t("addAnotherPasskey")}
          </Button>
          <div aria-live="polite">
            {error && (
              <p role="alert" className="text-danger text-sm">
                {tAuth(`errors.${error.key}`, error.values)}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            <h2>{t("totp")}</h2>
          </CardTitle>
          <CardDescription>{t("totpDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground text-sm">{t("totpComingSoon")}</p>
        </CardContent>
      </Card>

      <Card className="@4xl/main:col-span-2">
        <CardHeader>
          <CardTitle>
            <h2>{t("sessions")}</h2>
          </CardTitle>
          <CardDescription>{t("sessionsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {sessions && sessions.length > 0 ? (
            <ul className="flex flex-col divide-y rounded-lg border">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-3 p-3 text-sm">
                  <MonitorSmartphoneIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{s.userAgent || t("unknownDevice")}</span>
                  {s.token === session?.session.token ? (
                    <span className="text-success">{t("currentSession")}</span>
                  ) : (
                    <span className="text-muted-foreground" data-volatile="">
                      {formatTimestamp(ts(s.updatedAt), { withTime: true })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground text-sm">{t("noSessions")}</p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="h-11 md:h-9"
              onClick={async () => {
                try {
                  const res = await authClient.revokeOtherSessions();
                  if (res?.error) return fail(res.error);
                  toast.success(t("revokedOthers"));
                  void loadSessions();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              {t("revokeOthers")}
            </Button>
            <Button
              variant="destructive"
              className="h-11 md:h-9"
              onClick={async () => {
                markSigningOut();
                try {
                  await authClient.signOut();
                  router.replace("/anmelden");
                  router.refresh();
                } catch (e) {
                  fail(e);
                }
              }}
            >
              <LogOutIcon aria-hidden="true" />
              {t("signOut")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <RenameDialog
        passkey={renaming}
        onClose={() => setRenaming(null)}
        onDone={() => {
          setRenaming(null);
          refetch?.();
        }}
        onError={fail}
      />
      <RemoveDialog
        passkey={removing}
        isLast={list.length === 1}
        onClose={() => setRemoving(null)}
        onDone={() => {
          setRemoving(null);
          refetch?.();
        }}
        onError={fail}
      />
    </div>
  );
}

function RenameDialog({
  passkey,
  onClose,
  onDone,
  onError,
}: {
  passkey: PasskeyRow | null;
  onClose: () => void;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");
  const inputId = useId();
  const [name, setName] = useState("");
  useEffect(() => setName(passkey?.name ?? ""), [passkey]);
  return (
    <Dialog open={!!passkey} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!passkey || !name.trim()) return;
            try {
              const res = await authClient.passkey.updatePasskey({ id: passkey.id, name: name.trim() });
              if (res?.error) return onError(res.error);
              toast.success(t("renamed"));
              onDone();
            } catch (err) {
              onError(err);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("rename")}</DialogTitle>
            <DialogDescription>{passkey?.name || t("unnamedPasskey")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={inputId} className="font-medium text-sm">
              {t("renamePrompt")}
            </label>
            <Input id={inputId} value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit">{tCommon("save")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveDialog({
  passkey,
  isLast,
  onClose,
  onDone,
  onError,
}: {
  passkey: PasskeyRow | null;
  isLast: boolean;
  onClose: () => void;
  onDone: () => void;
  onError: (e: unknown) => void;
}) {
  const t = useTranslations("account");
  const tCommon = useTranslations("common");
  return (
    <Dialog open={!!passkey} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("removeTitle")}</DialogTitle>
          <DialogDescription>{t("removeDescription")}</DialogDescription>
        </DialogHeader>
        {isLast && (
          <p className="rounded-md border border-warning bg-warning/10 p-3 text-sm text-warning">
            {t("removeLastWarning")}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {tCommon("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={async () => {
              if (!passkey) return;
              try {
                const res = await authClient.passkey.deletePasskey({ id: passkey.id });
                if (res?.error) return onError(res.error);
                toast.success(t("removed"));
                onDone();
              } catch (err) {
                onError(err);
              }
            }}
          >
            {t("remove")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
