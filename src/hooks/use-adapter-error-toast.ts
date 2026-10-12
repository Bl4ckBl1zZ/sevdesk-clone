"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { toast } from "sonner";
import { isNotConnected } from "@/components/not-connected";

/** Shows "Noch nicht verbunden" for adapter stubs, or a generic German error otherwise. */
export function useAdapterErrorToast() {
  const t = useTranslations("common");
  return useCallback(
    (error: unknown) => {
      if (isNotConnected(error)) {
        toast.info(t("notConnected"), { description: t("notConnectedDescription") });
      } else {
        console.error(error);
        toast.error(t("unknownError"));
      }
    },
    [t],
  );
}
