import { supplyRange } from "../../src/domain/documents/draft";
import type { Actor } from "../../src/domain/schemas/actor";
import { checkKuHistoryChange } from "../../src/domain/tax/ku-history";
import { type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { getCompanyProfile, patchCompanyProfile } from "./companyProfile";
import { finalisedDocumentsForKu } from "./documentHistory";
import { getDocument, validateStored } from "./salesDocuments";
import type { ModelCtx } from "./types";
import { emitEvent } from "./webhooks";

/** The internal process that appends the KU end on the owner's confirmation (02 §4.4, 03 §0.1). */
export const KU_MONITOR_ACTOR: Actor = "system:ku-monitor";

/**
 * F01 SET-035, F08 TAX-012, EC-060: the invoice that crosses the KU limit opens a blocking dialog; on the owner's
 * confirmation `{ validFrom: <supply date>, isKU: false }` is appended to the Kleinunternehmer history by
 * `system:ku-monitor`. The draft then resolves to regular taxation — this invoice and all later supplies carry VAT.
 * The supply start is used for a period so the period does not straddle the KU boundary (EC-025).
 */
export async function confirmKuLimitCrossed(
  ctx: ModelCtx,
  documentId: Id<"salesDocuments">,
): Promise<{ validFrom: string }> {
  const doc = await getDocument(ctx, documentId);
  if (doc.status !== "draft") throw appError("document_not_draft");
  const { result } = await validateStored(ctx, doc, ctx.now());
  const crossed = result.findings.find((f) => f.code === "ku_threshold_crossed");
  if (!crossed) {
    throw appError("invalid_input", "Mit diesem Dokument wird die Kleinunternehmergrenze nicht überschritten.", {
      reason: "KU_LIMIT_NOT_CROSSED",
    });
  }
  const range = supplyRange(result.resolved.supplyDate);
  const validFrom = range?.from ?? result.resolved.documentDate;
  const profile = await getCompanyProfile(ctx);
  if (!profile) throw appError("setup_incomplete");
  const before = profile.kleinunternehmer;
  const after = [...before.filter((e) => e.validFrom !== validFrom), { validFrom, isKU: false }].sort((a, b) =>
    a.validFrom.localeCompare(b.validFrom),
  );
  const reason = `Umsatzgrenze nach § 19 Abs. 1 UStG mit Leistung vom ${formatGermanDate(validFrom as CalendarDate)} überschritten – vom Inhaber bestätigt (${ctx.actor}).`;
  const check = checkKuHistoryChange(before, after, await finalisedDocumentsForKu(ctx), reason);
  if (!check.ok) throw appError("invalid_input", check.error.message, { reason: check.error.code });
  const monitor: ModelCtx = {
    ...ctx,
    actor: KU_MONITOR_ACTOR,
    role: undefined,
    actorContext: { actor: KU_MONITOR_ACTOR, channel: "system", label: "Kleinunternehmer-Monitor" },
  };
  await patchCompanyProfile(monitor, { kleinunternehmer: after }, { action: "settings.tax.update", reason });
  // F08 §7 threshold.warning: the KU limit (§ 19 Abs. 1 UStG) was crossed and regular taxation starts
  await emitEvent(monitor, "threshold.warning", {
    id: `threshold_ku_${validFrom}`,
    object: "threshold",
    threshold: "ku",
    crossed: true,
    valid_from: validFrom,
    updated_at: new Date(ctx.now()).toISOString(),
  });
  return { validFrom };
}
