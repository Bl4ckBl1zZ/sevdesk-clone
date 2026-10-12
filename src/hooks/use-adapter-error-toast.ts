"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";
import { useOptionalSessionState } from "@/components/auth/session-provider";
import { adapterErrorCode, adapterErrorMessage, SESSION_ERROR_CODES } from "@/components/setup/actions";

/**
 * Shows the German message of a failed backend call. Auth errors (session gone, member disabled/expired) open the
 * "Sitzung abgelaufen" dialog instead (04 §4.9).
 */
export function useAdapterErrorToast() {
  const t = useTranslations("common");
  const session = useOptionalSessionState();
  return useCallback(
    (error: unknown) => {
      const code = adapterErrorCode(error);
      if (code && SESSION_ERROR_CODES.has(code) && session) {
        session.markExpired();
        return;
      }
      const message = adapterErrorMessage(error);
      if (message) {
        toast.error(message);
        return;
      }
      console.error(error);
      toast.error(
        error instanceof Error && /Verbindung|hochgeladen/.test(error.message) ? error.message : t("unknownError"),
      );
    },
    [t, session],
  );
}
