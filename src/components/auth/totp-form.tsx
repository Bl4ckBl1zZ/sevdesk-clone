"use client";

import { FingerprintIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { CODE_LENGTH, CodeInput } from "./code-input";
import { type AuthErrorMessage, mapAuthError } from "./errors";
import { navigation, safeRedirect } from "./redirect";

/**
 * `/anmelden/zwei-faktor` (04-ui-ux §4.9): after an e-mail-code sign-in of a member with TOTP, Better Auth holds
 * a short-lived two-factor cookie instead of a session (02 §4.2); `twoFactor.verifyTotp` creates the session.
 * "Passkey verwenden" is the alternative (passkeys are already two factors).
 */
export function TotpForm({ redirectTo, onSignedIn }: { redirectTo?: string | null; onSignedIn?: () => void }) {
  const t = useTranslations("auth");
  const [code, setCode] = useState("");
  const [error, setError] = useState<AuthErrorMessage | null>(null);
  const [pending, setPending] = useState(false);

  const done = () => {
    if (onSignedIn) return onSignedIn();
    navigation.assign(safeRedirect(redirectTo));
  };

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        if (code.length !== CODE_LENGTH) return setError({ key: "codeIncomplete" });
        setError(null);
        setPending(true);
        try {
          const res = await authClient.twoFactor.verifyTotp({ code });
          if (res?.error) setError(mapAuthError(res.error, "totpInvalid"));
          else done();
        } catch (err) {
          setError(mapAuthError(err, "totpInvalid"));
        } finally {
          setPending(false);
        }
      }}
    >
      <p className="text-muted-foreground text-sm">{t("totpDescription")}</p>
      <CodeInput value={code} onChange={setCode} legend={t("totpLabel")} invalid={!!error} autoFocus />
      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-danger text-sm">
            {t(`errors.${error.key}`, error.values)}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" className="h-11" disabled={pending}>
        {t("codeSubmit")}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="lg"
        className="h-11"
        disabled={pending}
        onClick={async () => {
          const res = await authClient.signIn.passkey().catch((err: unknown) => ({ error: err }));
          if (res?.error) setError(mapAuthError(res.error, "passkeyFailed"));
          else done();
        }}
      >
        <FingerprintIcon aria-hidden="true" />
        {t("totpUsePasskey")}
      </Button>
    </form>
  );
}
