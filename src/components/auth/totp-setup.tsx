"use client";

import { ShieldCheckIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import QRCode from "qrcode";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { CODE_LENGTH, CodeInput } from "./code-input";
import { type AuthErrorMessage, mapAuthError } from "./errors";

interface Pending {
  qr: string;
  secret: string;
  backupCodes: string[];
}

/** Secret of an `otpauth://totp/...?secret=XYZ` URI for manual entry. */
export function totpSecret(uri: string): string {
  try {
    return new URL(uri).searchParams.get("secret") ?? "";
  } catch {
    return "";
  }
}

/**
 * Optional TOTP (02 §4.2, 04 §4.9 /konto; F01 SET-009 step 1): enable → QR code + manual key → confirm with a code
 * (`twoFactor.verifyTotp`). All buttons are `type="button"` because the wizard renders this inside its step form.
 * Once enabled, e-mail-code sign-ins need the TOTP code (passkeys are exempt).
 */
export function TotpSetup() {
  const t = useTranslations("account");
  const tAuth = useTranslations("auth");
  const { data: session, refetch } = authClient.useSession();
  const enabled = Boolean((session?.user as { twoFactorEnabled?: boolean | null } | undefined)?.twoFactorEnabled);
  const [pending, setPending] = useState<Pending | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorMessage | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      // Passwordless accounts (`allowPasswordless`): no password is sent.
      const res = await authClient.twoFactor.enable({} as never);
      if (res?.error || !res?.data) return setError(mapAuthError(res?.error, "unknown"));
      const { totpURI, backupCodes } = res.data as { totpURI: string; backupCodes: string[] };
      setPending({
        qr: await QRCode.toDataURL(totpURI, { margin: 1, width: 192 }),
        secret: totpSecret(totpURI),
        backupCodes,
      });
    } catch (e) {
      setError(mapAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (code.length !== CODE_LENGTH) return setError({ key: "codeIncomplete" });
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.verifyTotp({ code });
      if (res?.error) return setError(mapAuthError(res.error, "totpInvalid"));
      toast.success(t("totpEnabled"));
      setPending(null);
      setCode("");
      refetch?.();
    } catch (e) {
      setError(mapAuthError(e, "totpInvalid"));
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await authClient.twoFactor.disable({} as never);
      if (res?.error) return setError(mapAuthError(res.error));
      toast.success(t("totpDisabled"));
      refetch?.();
    } catch (e) {
      setError(mapAuthError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {enabled ? (
        <>
          <p className="flex items-center gap-2 text-sm text-success">
            <ShieldCheckIcon className="size-4" aria-hidden="true" />
            {t("totpActive")}
          </p>
          <Button
            type="button"
            variant="outline"
            className="h-11 self-start md:h-9"
            disabled={busy}
            onClick={() => void disable()}
          >
            {t("totpDisable")}
          </Button>
        </>
      ) : pending ? (
        <div className="flex flex-col gap-3">
          <p className="text-sm">{t("totpScan")}</p>
          {/* biome-ignore lint/performance/noImgElement: data URL QR code, not an optimisable asset */}
          <img
            src={pending.qr}
            alt={t("totpQrAlt")}
            width={192}
            height={192}
            className="rounded-md border bg-white p-1"
          />
          <p className="text-sm">
            {t("totpManualKey")}: <code className="break-all rounded bg-muted px-1 font-mono">{pending.secret}</code>
          </p>
          <details className="text-sm">
            <summary className="cursor-pointer">{t("totpBackupCodes")}</summary>
            <ul className="mt-2 grid grid-cols-2 gap-1 font-mono">
              {pending.backupCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </details>
          <CodeInput value={code} onChange={setCode} legend={tAuth("totpLabel")} invalid={!!error} disabled={busy} />
          <Button type="button" className="h-11 self-start md:h-9" disabled={busy} onClick={() => void confirm()}>
            {t("totpConfirm")}
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          className="h-11 self-start md:h-9"
          disabled={busy}
          onClick={() => void start()}
        >
          {t("totpEnable")}
        </Button>
      )}
      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-danger text-sm">
            {tAuth(`errors.${error.key}`, error.values)}
          </p>
        )}
      </div>
    </div>
  );
}
