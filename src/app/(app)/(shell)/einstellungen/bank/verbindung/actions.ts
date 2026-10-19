"use server";

import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { headers } from "next/headers";
import { AccessError, fetchAuthAction, requireRole } from "@/lib/auth-server";
import { psuFromHeaders } from "@/server/bank/psu";

/**
 * BNK-107 „Jetzt abrufen“ (owner/bookkeeper present in the UI): the Server Action adds the PSU headers of the
 * signed-in member's browser and calls the Convex action with the session token (channel `ui`). Convex re-checks
 * the role and the budget (4 unattended fetches per account and day do not apply to owner-present fetches).
 */
export async function syncNowAction(
  accountId?: string,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  try {
    await requireRole("bankFeed.fetch");
  } catch (e) {
    if (e instanceof AccessError) return { ok: false, message: e.message };
    throw e;
  }
  const h = await headers();
  try {
    const result = await fetchAuthAction(api.bankFeedNode.syncNow, {
      ...(accountId ? { accountId: accountId as Id<"bankAccounts"> } : {}),
      ...psuFromHeaders((n) => h.get(n)),
    });
    return { ok: true, result };
  } catch (e) {
    const message =
      (e as { data?: { message?: string } }).data?.message ??
      "Der Abruf ist fehlgeschlagen. Bitte später erneut versuchen.";
    return { ok: false, message };
  }
}
