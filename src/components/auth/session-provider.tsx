"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { ConvexGuard, useBackendAuth } from "@/components/convex/convex-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";
import { LoginForm } from "./login-form";
import { OtpForm } from "./otp-form";
import { TotpForm } from "./totp-form";

interface SessionState {
  /** True while the "Sitzung abgelaufen" dialog is shown; content behind it is blurred and inert. */
  expired: boolean;
  /** Call when a Convex call or Server Action fails with an auth error (04-ui-ux §4.9). */
  markExpired: () => void;
  /** Call before an intentional sign-out so it is not reported as an expired session. */
  markSigningOut: () => void;
}

const SessionContext = React.createContext<SessionState | null>(null);

export function useSessionState(): SessionState {
  const ctx = React.useContext(SessionContext);
  if (!ctx) throw new Error("useSessionState must be used within SessionProvider");
  return ctx;
}

/** Like useSessionState, but `null` outside the signed-in area (auth pages). */
export function useOptionalSessionState(): SessionState | null {
  return React.useContext(SessionContext);
}

/**
 * Watches the Better Auth session. When a session that existed disappears (expired, revoked, member disabled),
 * the re-authentication dialog opens without leaving the page (04-ui-ux §4.9).
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { data, isPending } = authClient.useSession();
  const hadSession = React.useRef(false);
  const signingOut = React.useRef(false);
  const [expired, setExpired] = React.useState(false);

  React.useEffect(() => {
    if (isPending) return;
    if (data?.user) {
      hadSession.current = true;
      signingOut.current = false;
      setExpired(false);
    } else if (hadSession.current && !signingOut.current) {
      setExpired(true);
    }
  }, [data, isPending]);

  const value = React.useMemo<SessionState>(
    () => ({
      expired,
      markExpired: () => setExpired(true),
      markSigningOut: () => {
        signingOut.current = true;
      },
    }),
    [expired],
  );

  return (
    <SessionContext.Provider value={value}>
      {children}
      <ConvexGuard>
        <ConvexSessionWatcher
          onLost={() => {
            if (hadSession.current && !signingOut.current) setExpired(true);
          }}
        />
      </ConvexGuard>
      <SessionExpiredDialog
        open={expired}
        onReauthenticated={() => {
          setExpired(false);
          router.refresh();
        }}
      />
    </SessionContext.Provider>
  );
}

/**
 * The Convex side of the session: when the Convex JWT can no longer be obtained (session revoked or expired,
 * member disabled), Convex reports "not authenticated" — open the dialog (04 §4.9).
 */
function ConvexSessionWatcher({ onLost }: { onLost: () => void }) {
  const { isLoading, isAuthenticated } = useBackendAuth();
  const wasAuthenticated = React.useRef(false);
  const onLostRef = React.useRef(onLost);
  onLostRef.current = onLost;
  React.useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated) wasAuthenticated.current = true;
    else if (wasAuthenticated.current) onLostRef.current();
  }, [isLoading, isAuthenticated]);
  return null;
}

/** Re-authentication inside the dialog: passkey or e-mail code, without navigation. */
export function ReauthPanel({ onSuccess }: { onSuccess: () => void }) {
  const [codeEmail, setCodeEmail] = React.useState<string | null>(null);
  const [totp, setTotp] = React.useState(false);
  if (totp) return <TotpForm onSignedIn={onSuccess} />;
  if (codeEmail) {
    return (
      <OtpForm
        email={codeEmail}
        onSignedIn={onSuccess}
        onChangeEmail={() => setCodeEmail(null)}
        onTwoFactor={() => setTotp(true)}
      />
    );
  }
  return <LoginForm autoFill={false} onSignedIn={onSuccess} onCodeRequested={setCodeEmail} />;
}

/** Modal "Sitzung abgelaufen" (04-ui-ux §4.9). Cannot be dismissed; the page content is blurred behind it. */
export function SessionExpiredDialog({ open, onReauthenticated }: { open: boolean; onReauthenticated: () => void }) {
  const t = useTranslations("auth");
  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        overlayClassName="bg-background/60 backdrop-blur-lg supports-backdrop-filter:backdrop-blur-lg"
        onKeyDown={(e) => {
          if (e.key === "Escape") e.stopPropagation();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("sessionExpiredTitle")}</DialogTitle>
          <DialogDescription>{t("sessionExpiredDescription")}</DialogDescription>
        </DialogHeader>
        <ReauthPanel
          onSuccess={() => {
            toast.success(t("reauthSuccess"));
            onReauthenticated();
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
