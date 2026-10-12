import { normalizeEmail } from "../../src/domain/access/signup";
import type { Doc } from "../_generated/dataModel";
import { auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

/** `notificationSettings` singleton (03 §10). P0: the owner's notification address (F01 SET-009a). */
export async function getNotificationSettings(ctx: ReadCtx): Promise<Doc<"notificationSettings"> | null> {
  return ctx.db.query("notificationSettings").first();
}

export async function saveNotificationAddress(ctx: ModelCtx, address: string): Promise<void> {
  const email = { address: normalizeEmail(address), digest: false };
  const existing = await getNotificationSettings(ctx);
  if (existing) {
    await auditedPatch(
      ctx,
      "notificationSettings",
      existing._id,
      { email: { ...email, digest: existing.email?.digest ?? false } },
      { action: "settings.notifications.update" },
    );
    return;
  }
  await auditedInsert(
    ctx,
    "notificationSettings",
    { email, channelsByKind: {} },
    { action: "settings.notifications.update" },
  );
}
