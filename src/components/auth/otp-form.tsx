"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { CODE_LENGTH, CodeInput } from "./code-input";
import { type AuthErrorMessage, blocksCodeStep, mapAuthError } from "./errors";
import { clearPendingEmail } from "./pending-email";
import { navigation, safeRedirect, withRedirect } from "./redirect";

/** Better Auth emailOTP `expiresIn: 600` (02 §4.2). */
export const CODE_VALIDITY_S = 600;
export const RESEND_COOLDOWN_S = 60;

function useSecondsLeft(total: number, resetKey: number) {
  const [left, setLeft] = useState(total);
  useEffect(() => {
    void resetKey;
    setLeft(total);
    const started = Date.now();
    const id = window.setInterval(() => {
      const remaining = Math.max(0, total - Math.floor((Date.now() - started) / 1000));
      setLeft(remaining);
      if (remaining === 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [total, resetKey]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * `/anmelden/code` (04-ui-ux §4.9): six-digit code, 10-minute validity countdown, resend after 60 s. After a
 * first sign-in without passkey, members continue to `/anmelden/passkey-einrichten`.
 */
export function OtpForm({
  email,
  redirectTo,
  onSignedIn,
  onChangeEmail,
  onTwoFactor,
}: {
  email: string | null;
  redirectTo?: string | null;
  onSignedIn?: () => void;
  onChangeEmail?: () => void;
  /** TOTP required (02 §4.2): the dialog shows the TOTP step in place; the page navigates to /anmelden/zwei-faktor. */
  onTwoFactor?: () => void;
}) {
  const t = useTranslations("auth");
  const router = useRouter();
  const errorId = useId();
  const [code, setCode] = useState("");
  const [error, setError] = useState<AuthErrorMessage | null>(null);
  const [pending, setPending] = useState(false);
  const [sentAt, setSentAt] = useState(0);
  const validLeft = useSecondsLeft(CODE_VALIDITY_S, sentAt);
  const resendLeft = useSecondsLeft(RESEND_COOLDOWN_S, sentAt);
  const lastSubmitted = useRef<string | null>(null);

  const afterSignIn = async () => {
    clearPendingEmail();
    if (onSignedIn) return onSignedIn();
    let hasPasskey = true;
    try {
      const res = await authClient.passkey.listUserPasskeys();
      hasPasskey = !res?.data || res.data.length > 0;
    } catch {
      // Unknown: continue to the target; the setup wizard enforces the owner passkey anyway (F01 SET-009).
    }
    navigation.assign(hasPasskey ? safeRedirect(redirectTo) : withRedirect("/anmelden/passkey-einrichten", redirectTo));
  };

  const submit = async (otp: string) => {
    if (!email) return;
    if (otp.length !== CODE_LENGTH) {
      setError({ key: "codeIncomplete" });
      return;
    }
    lastSubmitted.current = otp;
    setError(null);
    setPending(true);
    try {
      const res = await authClient.signIn.emailOtp({ email, otp });
      if (res?.error) setError(mapAuthError(res.error, "codeInvalid"));
      else if ((res?.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        clearPendingEmail();
        if (onTwoFactor) onTwoFactor();
        else router.replace(withRedirect("/anmelden/zwei-faktor", redirectTo));
      } else await afterSignIn();
    } catch (e) {
      setError(mapAuthError(e));
    } finally {
      setPending(false);
    }
  };

  // Submit automatically once all six digits are present (paste / autofill).
  // biome-ignore lint/correctness/useExhaustiveDependencies: submit is recreated each render; code drives this
  useEffect(() => {
    if (code.length === CODE_LENGTH && code !== lastSubmitted.current && !pending) void submit(code);
  }, [code]);

  const resend = async () => {
    if (!email) return;
    setError(null);
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
      const mapped = res?.error ? mapAuthError(res.error) : null;
      if (blocksCodeStep(mapped)) {
        setError(mapped);
        return;
      }
      setCode("");
      lastSubmitted.current = null;
      setSentAt((n) => n + 1);
      toast.success(t("codeResent"));
    } catch (e) {
      setError(mapAuthError(e));
    }
  };

  if (!email) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm">{t("missingEmail")}</p>
        <Link href="/anmelden" className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11")}>
          {t("otherEmail")}
        </Link>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit(code);
      }}
    >
      <p className="text-muted-foreground text-sm">{t("codeDescription", { email })}</p>
      <p className="text-sm" role="status">
        {t("codeSent")}
      </p>
      <CodeInput
        value={code}
        onChange={setCode}
        legend={t("codeLabel")}
        invalid={!!error}
        describedBy={error ? errorId : undefined}
        disabled={pending}
        autoFocus
      />
      <p className="text-muted-foreground text-sm" data-volatile="">
        {validLeft > 0 ? t("codeValidity", { time: mmss(validLeft) }) : t("codeExpiredHint")}
      </p>
      <div aria-live="polite">
        {error && (
          <p id={errorId} role="alert" className="text-danger text-sm">
            {t(`errors.${error.key}`, error.values)}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" className="h-11" disabled={pending}>
        {t("codeSubmit")}
      </Button>
      <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          className="h-11 md:h-9"
          disabled={resendLeft > 0}
          onClick={() => void resend()}
        >
          {resendLeft > 0 ? t("codeResendIn", { seconds: resendLeft }) : t("codeResend")}
        </Button>
        {onChangeEmail ? (
          <Button type="button" variant="link" className="h-11 md:h-9" onClick={onChangeEmail}>
            {t("otherEmail")}
          </Button>
        ) : (
          <Link
            href={withRedirect("/anmelden", redirectTo)}
            className={cn(buttonVariants({ variant: "link" }), "h-11 md:h-9")}
          >
            {t("otherEmail")}
          </Link>
        )}
      </div>
    </form>
  );
}
