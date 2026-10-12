"use client";

import { KeyRoundIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId } from "react";
import { usePasskeyRegistration } from "@/components/auth/passkey-enrol";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatTimestamp } from "@/i18n/format";
import { authClient } from "@/lib/auth-client";
import { useWizard } from "../wizard-context";

/**
 * Step 1 "Inhaberkonto" (F01 SET-009): e-mail read-only, passkey registration mandatory before "Weiter",
 * second passkey recommended, TOTP optional (follows with the twoFactor plugin).
 */
export function OwnerStep() {
  const t = useTranslations("setup.owner");
  const tAuth = useTranslations("auth");
  const emailId = useId();
  const { formId, next, setNextDisabled, state } = useWizard();
  const { data: session } = authClient.useSession();
  const { data: passkeys } = authClient.useListPasskeys();
  const { register, pending, error } = usePasskeyRegistration();
  const count = passkeys?.length ?? 0;
  const email = session?.user.email ?? state?.ownerEmail ?? "";

  useEffect(() => {
    setNextDisabled(count === 0);
    return () => setNextDisabled(false);
  }, [count, setNextDisabled]);

  return (
    <form
      id={formId}
      noValidate
      className="flex flex-col gap-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (count > 0) next();
      }}
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={emailId} className="font-medium text-sm">
          {t("email")}
        </label>
        <Input id={emailId} value={email} readOnly placeholder="—" className="h-11 md:h-9" />
      </div>

      <section aria-labelledby="owner-passkeys" className="flex flex-col gap-3">
        <h2 id="owner-passkeys" className="font-medium text-sm">
          {t("passkeys")}
        </h2>
        {count === 0 ? (
          <p className="text-muted-foreground text-sm">{t("noPasskey")}</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-lg border">
            {passkeys?.map((p) => (
              <li key={p.id} className="flex items-center gap-3 p-3 text-sm">
                <KeyRoundIcon className="size-4 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1">{p.name || p.deviceType}</span>
                <span className="text-muted-foreground" data-volatile="">
                  {formatTimestamp(new Date(p.createdAt).getTime())}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Button
          type="button"
          variant={count === 0 ? "default" : "outline"}
          className="h-11 self-start md:h-9"
          disabled={pending}
          onClick={() => void register()}
        >
          <KeyRoundIcon aria-hidden="true" />
          {count === 0 ? t("addPasskey") : t("addAnother")}
        </Button>
        {count === 1 && <p className="text-muted-foreground text-sm">{t("recommendSecond")}</p>}
        <div aria-live="polite">
          {error && (
            <p role="alert" className="text-danger text-sm">
              {tAuth(`errors.${error.key}`, error.values)}
            </p>
          )}
          {count === 0 && <p className="text-sm">{t("passkeyRequired")}</p>}
        </div>
      </section>

      <section aria-labelledby="owner-totp" className="flex flex-col gap-1">
        <h2 id="owner-totp" className="font-medium text-sm">
          {t("totp")}
        </h2>
        <p className="text-muted-foreground text-sm">{t("totpHint")}</p>
      </section>
    </form>
  );
}
