"use client";

import { FingerprintIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import { authClient } from "@/lib/auth-client";
import { NotConnectedError } from "../not-connected";
import { CODE_LENGTH, CodeInput } from "./code-input";
import { type AuthErrorMessage, mapAuthError } from "./errors";
import { safeRedirect } from "./redirect";

/**
 * TODO(auth branch): verify with `authClient.twoFactor.verifyTotp({ code })` once `twoFactorClient` is part of
 * `src/lib/auth-client.ts` (02 §4.2: TOTP gates e-mail-code sessions, enforced by our wrappers).
 */
async function verifyTotp(_code: string): Promise<void> {
  throw new NotConnectedError("twoFactor.verifyTotp");
}

/** `/anmelden/zwei-faktor` (04-ui-ux §4.9): 6-digit TOTP, "Passkey verwenden" as the alternative. */
export function TotpForm({ redirectTo }: { redirectTo?: string | null }) {
  const t = useTranslations("auth");
  const router = useRouter();
  const showAdapterError = useAdapterErrorToast();
  const [code, setCode] = useState("");
  const [error, setError] = useState<AuthErrorMessage | null>(null);
  const [pending, setPending] = useState(false);

  const done = () => {
    router.replace(safeRedirect(redirectTo));
    router.refresh();
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
          await verifyTotp(code);
          done();
        } catch (err) {
          showAdapterError(err);
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
