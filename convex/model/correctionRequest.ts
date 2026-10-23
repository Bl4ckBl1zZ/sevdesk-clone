import {
  effectiveMark,
  type SendChannel,
  type SendLogRow,
  validateRetraction,
} from "../../src/domain/documents/dispatch";
import { blocking } from "../../src/domain/documents/validate/finding";
import type { ReceivedAddress, ReceivedInvoice } from "../../src/domain/einvoice/received";
import {
  CORRECTION_MESSAGES,
  type CorrectionLetterInput,
  correctionLetterSubject,
  correctionLetterText,
  correctionReasons,
  validateCorrectionMark,
} from "../../src/domain/inbox/correction-request";
import { retentionUntilFor } from "../../src/domain/rules/retention";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { requireInboxItem } from "./inbox";
import { r2ConfigOf } from "./inboxSettings";
import { getIntegration } from "./integrations";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * F06 INB-046 supplier correction request (D-11): the letter text is generated from the item's findings; „Als PDF
 * exportieren“ archives it ONCE as `documentArtifacts` kind `supplier_correction_letter` (owner = the inbox item,
 * retention `letters6`); „Als versendet markieren“ / „Versandmarkierung zurücknehmen“ append `sendLog` rows with
 * purpose `supplier_correction_request` and `inboxItemId` (append-only, F04 rules). The app never sends anything.
 */

const addressLines = (a: ReceivedAddress | undefined): string[] =>
  a
    ? [
        a.line1,
        a.line2,
        [a.postalCode, a.city].filter(Boolean).join(" "),
        a.countryCode && a.countryCode !== "DE" ? a.countryCode : undefined,
      ]
        .map((s) => s?.trim())
        .filter((s): s is string => !!s)
    : [];

export async function correctionLetterOf(
  ctx: ReadCtx,
  item: Doc<"inboxItems">,
  today: string,
): Promise<{ subject: string; text: string; input: CorrectionLetterInput } | null> {
  const reasons = correctionReasons({
    validation: item.einvoice?.validation,
    notEInvoice: item.einvoice?.notEInvoice === true || (item.flags ?? []).includes("not_einvoice"),
    warnings: item.warnings ?? [],
  });
  if (!reasons) return null;
  const model = item.einvoice?.model as ReceivedInvoice | undefined;
  const voucher = item.voucherId ? await ctx.db.get(item.voucherId) : null;
  const profile = await getCompanyProfile(ctx);
  const r2 = r2ConfigOf(await getIntegration(ctx, "r2_inbox"));
  const supplierName = model?.seller.name ?? voucher?.supplierName ?? item.from ?? "Lieferant";
  const supplierLines = model
    ? addressLines(model.seller.address)
    : (voucher?.supplierAddress
        ?.split(/\n|,\s*/)
        .map((s) => s.trim())
        .filter(Boolean) ?? []);
  const number = model?.number ?? voucher?.documentNumber;
  const date = model?.issueDate ?? voucher?.documentDate;
  const company = profile
    ? {
        name: profile.name,
        addressLines: [
          profile.address.street,
          ...(profile.address.street2 ? [profile.address.street2] : []),
          `${profile.address.postalCode} ${profile.address.city}`,
        ],
        city: profile.address.city,
      }
    : { name: "Unser Unternehmen", addressLines: [] };
  const input: CorrectionLetterInput = {
    company,
    supplier: { name: supplierName, addressLines: supplierLines },
    invoice: { ...(number ? { number } : {}), ...(date ? { date } : {}) },
    reasons,
    ...(r2.receivingAddress ? { receivingAddress: r2.receivingAddress } : {}),
    today: today as CorrectionLetterInput["today"],
  };
  return { subject: correctionLetterSubject(input.invoice), text: correctionLetterText(input), input };
}

export async function correctionArtifactOf(ctx: ReadCtx, id: Id<"inboxItems">) {
  return ctx.db
    .query("documentArtifacts")
    .withIndex("by_inboxItem", (q) => q.eq("inboxItemId", id).eq("kind", "supplier_correction_letter"))
    .first();
}

export async function correctionMarksOf(ctx: ReadCtx, id: Id<"inboxItems">): Promise<Doc<"sendLog">[]> {
  return ctx.db
    .query("sendLog")
    .withIndex("by_inboxItem_at", (q) => q.eq("inboxItemId", id))
    .collect();
}

const rowsOf = (marks: readonly Doc<"sendLog">[]): SendLogRow[] =>
  marks.map((m) => ({
    id: String(m._id),
    kind: m.kind,
    ...(m.retractsId ? { retractsId: String(m.retractsId) } : {}),
    sentOn: m.sentOn,
    channel: m.channel,
    at: m.at,
  }));

/** „Als PDF exportieren“: archives the rendered letter once; a second export returns the archived artifact. */
export async function archiveCorrectionLetter(
  ctx: ModelCtx,
  args: { id: Id<"inboxItems">; storageId: Id<"_storage">; sha256: string; bytes: number; name: string },
): Promise<{ artifactId: Id<"documentArtifacts">; sha256: string; existed: boolean }> {
  const item = await requireInboxItem(ctx, args.id);
  const existing = await correctionArtifactOf(ctx, item._id);
  if (existing) return { artifactId: existing._id, sha256: existing.sha256, existed: true };
  if (!(await correctionLetterOf(ctx, item, berlinCalendarDate(ctx.now())))) {
    throw appError("invalid_input", CORRECTION_MESSAGES.notAvailable);
  }
  const now = ctx.now();
  const today = berlinCalendarDate(now);
  const artifactId = await auditedInsert(
    ctx,
    "documentArtifacts",
    {
      inboxItemId: item._id,
      kind: "supplier_correction_letter",
      storageId: args.storageId,
      sha256: args.sha256,
      bytes: args.bytes,
      mime: "application/pdf",
      name: args.name,
      createdAt: now,
      retentionUntil: retentionUntilFor("letters6", today) as string,
    },
    { action: "inbox.correction_exported", label: args.name },
  );
  return { artifactId, sha256: args.sha256, existed: false };
}

export async function markCorrectionSent(
  ctx: ModelCtx,
  id: Id<"inboxItems">,
  values: { sentOn: string; channel: SendChannel; note?: string },
): Promise<Id<"sendLog">> {
  const item = await requireInboxItem(ctx, id);
  const artifact = await correctionArtifactOf(ctx, id);
  const errors = blocking(
    validateCorrectionMark(values, { today: berlinCalendarDate(ctx.now()), letterArchived: artifact !== null }),
  );
  if (errors.length > 0 || !artifact) {
    throw appError("mark_sent_invalid", errors[0]?.message ?? CORRECTION_MESSAGES.letterMissing, {
      reason: errors[0]?.code ?? "mark_sent_artifacts_missing",
      findings: errors.map((f) => ({ code: f.code, message: f.message })),
    });
  }
  const note = values.note?.trim();
  return auditedInsert(
    ctx,
    "sendLog",
    {
      inboxItemId: id,
      purpose: "supplier_correction_request",
      kind: "mark_sent",
      sentOn: values.sentOn,
      channel: values.channel,
      ...(note ? { note } : {}),
      artifacts: [{ artifactId: artifact._id, sha256: artifact.sha256 }],
      at: ctx.now(),
      actor: ctx.actor,
    },
    { action: "inbox.correction_mark_sent", label: item.subject ?? artifact.name },
  );
}

export async function retractCorrectionMark(
  ctx: ModelCtx,
  id: Id<"inboxItems">,
  input: { retractsId: string; reason: string },
): Promise<void> {
  const item = await requireInboxItem(ctx, id);
  const rows = rowsOf(await correctionMarksOf(ctx, id));
  const r = validateRetraction(input, rows, { postalDeliveryDays: 0, at: ctx.now() });
  const errors = blocking([...r.findings]);
  if (errors.length > 0) {
    throw appError("retraction_invalid", errors[0]?.message, { reason: errors[0]?.code ?? "retraction_invalid" });
  }
  const target = rows.find((x) => x.id === input.retractsId);
  const reason = input.reason.trim();
  await auditedInsert(
    ctx,
    "sendLog",
    {
      inboxItemId: id,
      purpose: "supplier_correction_request",
      kind: "retraction",
      retractsId: input.retractsId as Id<"sendLog">,
      sentOn: target?.sentOn ?? berlinCalendarDate(ctx.now()),
      channel: target?.channel ?? "other",
      note: reason,
      artifacts: [],
      at: ctx.now(),
      actor: ctx.actor,
    },
    { action: "inbox.correction_mark_retracted", label: item.subject ?? "Korrekturanforderung", reason },
  );
}

/** Everything the „Korrektur anfordern“ panel shows. */
export async function correctionRequestView(ctx: ReadCtx, id: Id<"inboxItems">, today: string) {
  const item = await requireInboxItem(ctx, id);
  const letter = await correctionLetterOf(ctx, item, today);
  const artifact = await correctionArtifactOf(ctx, id);
  const marks = await correctionMarksOf(ctx, id);
  const rows = rowsOf(marks);
  const retracted = new Set(rows.filter((r) => r.kind === "retraction").map((r) => r.retractsId));
  return {
    available: letter !== null,
    subject: letter?.subject ?? null,
    text: letter?.text ?? null,
    artifact: artifact
      ? {
          id: artifact._id,
          sha256: artifact.sha256,
          name: artifact.name,
          createdAt: artifact.createdAt,
          url: await ctx.storage.getUrl(artifact.storageId),
        }
      : null,
    effectiveMarkId: effectiveMark(rows)?.id ?? null,
    marks: marks.map((m) => ({
      id: m._id,
      kind: m.kind,
      sentOn: m.sentOn,
      channel: m.channel,
      note: m.note ?? null,
      at: m.at,
      actor: m.actor,
      retractsId: m.retractsId ?? null,
      retracted: retracted.has(String(m._id)),
    })),
  };
}
