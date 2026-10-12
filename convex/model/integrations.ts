import type { Doc } from "../_generated/dataModel";
import { auditedInsert, auditedPatch } from "./audit";
import type { ModelCtx, ReadCtx } from "./types";

type Kind = Doc<"integrations">["kind"];

export async function getIntegration(ctx: ReadCtx, kind: Kind): Promise<Doc<"integrations"> | null> {
  return ctx.db
    .query("integrations")
    .withIndex("by_kind", (q) => q.eq("kind", kind))
    .first();
}

/** F01 SET-107/SET-115: store the result of „Test-Code senden" / „Verbindung testen" (audited settings change). */
export async function recordIntegrationTest(
  ctx: ModelCtx,
  kind: Kind,
  result: { ok: boolean; detail: string },
): Promise<void> {
  const fields = { lastTestAt: ctx.now(), lastTestOk: result.ok, lastTestDetail: result.detail.slice(0, 500) };
  const existing = await getIntegration(ctx, kind);
  if (existing) {
    await auditedPatch(ctx, "integrations", existing._id, fields, {
      action: "settings.integrations.update",
      label: kind,
    });
    return;
  }
  await auditedInsert(
    ctx,
    "integrations",
    { kind, config: {}, enabled: true, ...fields },
    { action: "settings.integrations.update", label: kind },
  );
}
