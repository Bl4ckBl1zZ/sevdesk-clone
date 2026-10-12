"use client";

import { api } from "@convex/_generated/api";
import { useAuthedQuery } from "@/hooks/use-authed-query";
import type { SetupChecklist, SetupState } from "./actions";

/**
 * Live wizard/settings state from Convex (`settings.getSetupState`, SET-003). `undefined` while loading. Must be
 * rendered inside <ConvexGuard> (the pages do that).
 */
export function useSetupState(): SetupState | undefined {
  return useAuthedQuery(api.settings.getSetupState, {});
}

/** Live checklist of step 11 (SET-004) — `undefined` while loading. */
export function useSetupChecklist(): SetupChecklist | undefined {
  return useAuthedQuery(api.settings.getSetupChecklist, {});
}
