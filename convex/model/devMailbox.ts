import { normalizeEmail } from "../../src/domain/access/signup";
import type { ModelCtx, ReadCtx } from "./types";

/** Dev/test mailbox of the memory auth-mail transport (07 §3.2). Not business data; exempt from audit. */
export async function storeDevMail(
  ctx: ModelCtx,
  mail: { to: string; subject: string; text: string; kind: string },
): Promise<void> {
  await ctx.db.insert("devMailbox", { ...mail, to: normalizeEmail(mail.to), at: ctx.now() });
}

export async function latestDevMail(ctx: ReadCtx, to: string) {
  return ctx.db
    .query("devMailbox")
    .withIndex("by_to", (q) => q.eq("to", normalizeEmail(to)))
    .order("desc")
    .first();
}
