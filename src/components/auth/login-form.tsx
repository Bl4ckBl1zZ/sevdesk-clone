"use client";

import { FingerprintIcon, MailIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { type AuthErrorMessage, mapAuthError } from "./errors";
import { storePendingEmail } from "./pending-email";
import { safeRedirect, withRedirect } from "./redirect";

const emailSchema = z.string().trim().pipe(z.email());

type Pending = "passkey" | "code" | null;

/**
 * `/anmelden` form (04-ui-ux §4.9): passkey (with conditional UI) first, e-mail code as fallback. No password,
 * no sign-up link. Also used inside the "Sitzung abgelaufen" dialog via the callbacks.
 */
export function LoginForm({
  firstRun = false,
  redirectTo,
  autoFill = true,
  onSignedIn,
  onCodeRequested,
}: {
  firstRun?: boolean;
  redirectTo?: string | null;
  /** Offer stored passkeys in the browser's autofill list (conditional mediation). */
  autoFill?: boolean;
  onSignedIn?: () => void;
  onCodeRequested?: (email: string) => void;
}) {
  const t = useTranslations("auth");
  const router = useRouter();
  const emailId = useId();
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [error, setError] = useState<AuthErrorMessage | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const emailRef = useRef<HTMLInputElement>(null);

  const signedIn = () => {
    if (onSignedIn) return onSignedIn();
    router.replace(safeRedirect(redirectTo));
    router.refresh();
  };
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;

  // Conditional UI: the browser offers stored passkeys directly in the e-mail field's autofill list.
  useEffect(() => {
    if (!autoFill || typeof window === "undefined" || !window.PublicKeyCredential) return;
    let cancelled = false;
    const isAvailable = PublicKeyCredential.isConditionalMediationAvailable?.bind(PublicKeyCredential);
    void (async () => {
      if (!isAvailable || !(await isAvailable()) || cancelled) return;
      const res = await authClient.signIn.passkey({ autoFill: true });
      if (!cancelled && res && !res.error) signedInRef.current();
    })().catch(() => {
      // Aborted by an explicit action or unsupported — the buttons remain.
    });
    return () => {
      cancelled = true;
    };
  }, [autoFill]);

  const signInWithPasskey = async () => {
    setError(null);
    setPending("passkey");
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) setError(mapAuthError(res.error, "passkeyFailed"));
      else signedIn();
    } catch (e) {
      setError(mapAuthError(e, "passkeyFailed"));
    } finally {
      setPending(null);
    }
  };

  const requestCode = async () => {
    setError(null);
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(t("errors.emailInvalid"));
      emailRef.current?.focus();
      return;
    }
    setEmailError(null);
    setPending("code");
    try {
      const res = await authClient.emailOtp.sendVerificationOtp({ email: parsed.data, type: "sign-in" });
      const mapped = res?.error ? mapAuthError(res.error) : null;
      // Throttling and network problems are shown; everything else gets the neutral answer (no enumeration).
      if (mapped && (mapped.key === "rateLimited" || mapped.key === "network")) {
        setError(mapped);
        return;
      }
      if (onCodeRequested) return onCodeRequested(parsed.data);
      storePendingEmail(parsed.data);
      router.push(withRedirect("/anmelden/code", redirectTo));
    } catch (e) {
      setError(mapAuthError(e));
    } finally {
      setPending(null);
    }
  };

  return (
    <form
      className="flex flex-col gap-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void requestCode();
      }}
    >
      {firstRun && <p className="rounded-md border border-info/30 bg-info/10 p-3 text-info text-sm">{t("firstRun")}</p>}
      <Field data-invalid={emailError ? true : undefined}>
        <FieldLabel htmlFor={emailId}>{t("email")}</FieldLabel>
        <Input
          ref={emailRef}
          id={emailId}
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username webauthn"
          placeholder={t("emailPlaceholder")}
          value={email}
          aria-invalid={emailError ? true : undefined}
          aria-describedby={emailError ? `${emailId}-error` : undefined}
          className="h-11 md:h-9"
          onChange={(e) => setEmail(e.target.value)}
        />
        {emailError && <FieldError id={`${emailId}-error`}>{emailError}</FieldError>}
      </Field>

      <Button
        type="button"
        size="lg"
        className="h-11"
        disabled={pending !== null}
        onClick={() => void signInWithPasskey()}
      >
        <FingerprintIcon aria-hidden="true" />
        {t("passkeyButton")}
      </Button>
      <FieldSeparator>{t("or")}</FieldSeparator>
      <Button type="submit" variant="outline" size="lg" className="h-11" disabled={pending !== null}>
        <MailIcon aria-hidden="true" />
        {t("codeButton")}
      </Button>

      <div aria-live="polite">
        {error && (
          <p role="alert" className="text-danger text-sm">
            {t(`errors.${error.key}`, error.values)}
          </p>
        )}
      </div>
    </form>
  );
}
