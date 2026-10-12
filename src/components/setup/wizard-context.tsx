"use client";

import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { isNotConnected } from "@/components/not-connected";
import type { SetupState } from "./actions";
import type { CompanyValues } from "./schema";

/** Values entered in this browser session; NOT persisted (the adapter is not connected yet). */
export interface WizardDrafts {
  company?: CompanyValues;
}

interface WizardContextValue {
  formId: string;
  state: SetupState | null;
  connected: boolean;
  drafts: WizardDrafts;
  setDrafts: React.Dispatch<React.SetStateAction<WizardDrafts>>;
  next: () => void;
  setNextDisabled: (disabled: boolean) => void;
}

export const WizardContext = React.createContext<WizardContextValue | null>(null);

export function useWizard(): WizardContextValue {
  const ctx = React.useContext(WizardContext);
  if (!ctx) throw new Error("useWizard must be used within SetupWizard");
  return ctx;
}

/**
 * Saves a step, then continues (F01 SET-003 "each step saves on Weiter"). While the backend is not connected the
 * adapter throws NotConnectedError: the toast says nothing was saved and the wizard still moves on so the steps
 * can be reviewed. Any other error keeps the user on the step.
 */
export function useStepSubmit() {
  const { next } = useWizard();
  const t = useTranslations("common");
  return React.useCallback(
    async (save: () => Promise<unknown>) => {
      try {
        await save();
      } catch (error) {
        if (isNotConnected(error)) {
          toast.info(t("notConnected"), { description: t("notConnectedDescription") });
        } else {
          console.error(error);
          toast.error(t("unknownError"));
          return;
        }
      }
      next();
    },
    [next, t],
  );
}
