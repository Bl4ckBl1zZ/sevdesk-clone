"use client";

import { KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { type AuthErrorMessage, mapAuthError } from "./errors";
import { navigation, safeRedirect } from "./redirect";

/** Registers a passkey for the signed-in member. Returns true on success; errors are German messages. */
export function usePasskeyRegistration() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AuthErrorMessage | null>(null);
  const register = async (name?: string): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      const res = await authClient.passkey.addPasskey(name ? { name } : undefined);
      if (res?.error) {
        setError(mapAuthError(res.error, "passkeyRegistrationFailed"));
        return false;
      }
      return true;
    } catch (e) {
      setError(mapAuthError(e, "passkeyRegistrationFailed"));
      return false;
    } finally {
      setPending(false);
    }
  };
  return { register, pending, error };
}

/**
 * `/anmelden/passkey-einrichten` (04-ui-ux §4.9): shown after the first e-mail-code sign-in without passkey.
 * Mandatory for the owner (F01 SET-009); other roles may choose "Später".
 */
export function PasskeyEnrol({ mandatory, redirectTo }: { mandatory: boolean; redirectTo?: string | null }) {
  const t = useTranslations("auth");
  const { register, pending, error } = usePasskeyRegistration();
  const target = safeRedirect(redirectTo);

  return (
    <div className="flex flex-col gap-5">
      <p className="text-sm">{t("enrolDescription")}</p>
      <p className="text-muted-foreground text-sm">{t("enrolDomainHint")}</p>
      {mandatory && (
        <p className="rounded-md border border-info/30 bg-info/10 p-3 text-info text-sm">{t("enrolMandatory")}</p>
      )}
      <Button
        size="lg"
        className="h-11"
        disabled={pending}
        onClick={async () => {
          if (await register()) {
            toast.success(t("enrolSuccess"));
            navigation.assign(target);
          }
        }}
      >
        <KeyRoundIcon aria-hidden="true" />
        {t("enrolButton")}
      </Button>
      {!mandatory && (
        <Link href={target} className={cn(buttonVariants({ variant: "ghost", size: "lg" }), "h-11")}>
          {t("enrolLater")}
        </Link>
      )}
      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-danger text-sm">
            {t(`errors.${error.key}`, error.values)}
          </p>
        )}
      </div>
    </div>
  );
}
