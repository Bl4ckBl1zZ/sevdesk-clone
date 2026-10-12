"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { authClient } from "@/lib/auth-client";
import { LoginForm } from "./login-form";
import { OtpForm } from "./otp-form";

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

/** Re-authentication inside the dialog: passkey or e-mail code, without navigation. */
export function ReauthPanel({ onSuccess }: { onSuccess: () => void }) {
  const [codeEmail, setCodeEmail] = React.useState<string | null>(null);
  if (codeEmail) {
    return <OtpForm email={codeEmail} onSignedIn={onSuccess} onChangeEmail={() => setCodeEmail(null)} />;
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
