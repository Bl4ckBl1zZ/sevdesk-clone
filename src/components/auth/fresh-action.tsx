"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { adapterErrorCode } from "@/components/setup/actions";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReauthPanel } from "./session-provider";

/**
 * Fresh session for ⚠ actions (02 §4.2, 04 §4.9, F12 E-AUD-28). Convex answers `reauth_required` when the session
 * is older than 10 minutes. `useFreshAction()` wraps such a call: on that error it opens the confirmation dialog
 * (passkey, or a new e-mail code), and after the re-authentication — which creates a new, fresh session — it retries
 * the call until the Convex client carries the new token.
 *
 *   const fresh = useFreshAction();
 *   await fresh(() => changeRole({ memberId, role }));
 */
type Runner = <T>(fn: () => Promise<T>) => Promise<T>;

const FreshActionContext = React.createContext<Runner | null>(null);

export const REAUTH_CODE = "reauth_required";
/** The Convex token follows the new session asynchronously; retry for up to ~6 s. */
const RETRIES = 12;
const RETRY_DELAY_MS = 500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function retryWhileStale<T>(fn: () => Promise<T>, retries = RETRIES, delayMs = RETRY_DELAY_MS) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (adapterErrorCode(e) !== REAUTH_CODE || attempt >= retries) throw e;
      await sleep(delayMs);
    }
  }
}

export function FreshActionProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("auth");
  const [pending, setPending] = React.useState<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const run = React.useCallback<Runner>(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (adapterErrorCode(e) !== REAUTH_CODE) throw e;
      await new Promise<void>((resolve, reject) => setPending({ resolve, reject }));
      return retryWhileStale(fn);
    }
  }, []);

  return (
    <FreshActionContext.Provider value={run}>
      {children}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (open || !pending) return;
          pending.reject(new Error(t("reauthCancelled")));
          setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("reauthTitle")}</DialogTitle>
            <DialogDescription>{t("reauthDescription")}</DialogDescription>
          </DialogHeader>
          <ReauthPanel
            onSuccess={() => {
              pending?.resolve();
              setPending(null);
            }}
          />
        </DialogContent>
      </Dialog>
    </FreshActionContext.Provider>
  );
}

/** Outside the provider (tests, auth pages) the call runs unchanged. */
export function useFreshAction(): Runner {
  return React.useContext(FreshActionContext) ?? ((fn) => fn());
}
