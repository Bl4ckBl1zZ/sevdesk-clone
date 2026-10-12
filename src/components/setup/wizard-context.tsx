"use client";

import * as React from "react";
import type { CompanyValues } from "@/domain/schemas/settings";
import { useAdapterErrorToast } from "@/hooks/use-adapter-error-toast";
import type { SetupState } from "./actions";

/** Values entered in this browser session before the server state has caught up (e.g. legal form for step 7). */
export interface WizardDrafts {
  company?: CompanyValues;
}

interface WizardContextValue {
  formId: string;
  /** Live server state; `null` while loading. */
  state: SetupState | null;
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
 * Saves a step, then continues (F01 SET-003 "each step saves on Weiter"). A failed save shows the German server
 * message and keeps the user on the step; nothing pretends to be saved.
 */
export function useStepSubmit() {
  const { next } = useWizard();
  const showError = useAdapterErrorToast();
  return React.useCallback(
    async (save: () => Promise<unknown>) => {
      try {
        await save();
      } catch (error) {
        showError(error);
        return;
      }
      next();
    },
    [next, showError],
  );
}
