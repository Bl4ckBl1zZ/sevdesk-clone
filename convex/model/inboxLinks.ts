import type { Id } from "../_generated/dataModel";
import { auditedPatch } from "./audit";
import type { ModelCtx } from "./types";

/**
 * Inbox ↔ voucher hooks called by convex/model/vouchers.ts (kept apart from model/inbox.ts to avoid an import cycle).
 *
 *  - INB-028: the inbox item becomes `converted` when its voucher is booked.
 *  - VOU-007 / EC-VOU-36: deleting the draft keeps the originals on the inbox item, which returns to `needs_review`.
 */
export async function markInboxConverted(
  ctx: ModelCtx,
  inboxItemId: Id<"inboxItems">,
  voucherId: Id<"vouchers">,
): Promise<void> {
  const item = await ctx.db.get(inboxItemId);
  if (!item || item.status === "converted") return;
  await auditedPatch(
    ctx,
    "inboxItems",
    inboxItemId,
    { status: "converted", voucherId },
    { action: "inbox.convert", label: item.subject ?? item.files[0]?.name ?? "Beleg" },
  );
}

export async function releaseInboxDraft(
  ctx: ModelCtx,
  inboxItemId: Id<"inboxItems">,
  voucherId: Id<"vouchers">,
): Promise<void> {
  const item = await ctx.db.get(inboxItemId);
  if (!item || item.voucherId !== voucherId) return;
  await auditedPatch(
    ctx,
    "inboxItems",
    inboxItemId,
    { voucherId: undefined, ...(item.status === "converted" ? {} : { status: "needs_review" as const }) },
    { action: "inbox.draft_deleted", label: item.subject ?? item.files[0]?.name ?? "Beleg" },
  );
}
