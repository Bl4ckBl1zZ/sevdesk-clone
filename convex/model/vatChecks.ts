import type { PostalAddress } from "../../src/domain/contacts/address";
import { normalizeContactVatId } from "../../src/domain/contacts/tax";
import {
  type CheckPlan,
  fingerprint,
  isQualified,
  planCheck,
  type QualifiedResult,
  reusableCheck,
  type VatCheckProvider,
  type VatCheckStatus,
  vatCheckRetentionUntil,
} from "../../src/domain/contacts/vat-check";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { Doc, Id } from "../_generated/dataModel";
import { appError } from "../lib/errors";
import { auditedInsert, auditedPatch } from "./audit";
import { getCompanyProfile } from "./companyProfile";
import { contactAddresses, defaultAddressOf, fail, getContact } from "./contacts";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * VAT-ID checks (F02 §4.2, CON-050…061). The outbound call happens in the action (convex/vatIdChecks.ts); this
 * module prepares the request data, decides about the 24-hour reuse (CON-058) and stores the append-only evidence
 * row (`vatIdChecks` 🔒, CON-053) plus the contact's `vatIdStatus` (CON-054).
 */
export interface CheckPreparation {
  vatId: string;
  name: string;
  address?: PostalAddress;
  ownVatId?: string;
  plan: CheckPlan;
  fingerprint: string;
  reusable?: Doc<"vatIdChecks">;
}

export async function contactChecks(ctx: ReadCtx, contactId: Id<"contacts">): Promise<Doc<"vatIdChecks">[]> {
  return ctx.db
    .query("vatIdChecks")
    .withIndex("by_contact", (q) => q.eq("contactId", contactId))
    .order("desc")
    .collect();
}

export async function prepareCheck(
  ctx: ReadCtx,
  contactId: Id<"contacts">,
  now: number,
  force: boolean,
): Promise<CheckPreparation> {
  const c = await getContact(ctx, contactId);
  if (!c.vatId) {
    fail({ code: "VAT_ID_MISSING", message: "Für diesen Kontakt ist keine USt-IdNr hinterlegt.", field: "vatId" });
  }
  const today = berlinCalendarDate(now);
  // §4.2 step 1: format check first — no external call and no evidence row for malformed IDs.
  const n = normalizeContactVatId(c.vatId, { today });
  if (n.error) fail(n.error);
  const profile = await getCompanyProfile(ctx);
  const billing = defaultAddressOf(await contactAddresses(ctx, contactId), "billing");
  const name = c.organizationName ?? c.displayName;
  const fp = fingerprint({
    vatId: c.vatId,
    name,
    street: billing?.address.street,
    postalCode: billing?.address.postalCode,
    city: billing?.address.city,
  });
  const reusable = reusableCheck(await contactChecks(ctx, contactId), fp, now, force) ?? undefined;
  return {
    vatId: c.vatId,
    name,
    ...(billing ? { address: billing.address } : {}),
    ...(profile?.vatId ? { ownVatId: profile.vatId } : {}),
    plan: planCheck(c.vatId, profile?.vatId),
    fingerprint: fp,
    ...(reusable ? { reusable } : {}),
  };
}

export interface CheckResult {
  provider: VatCheckProvider;
  request: unknown;
  response: unknown;
  status: VatCheckStatus;
  qualified?: QualifiedResult;
  providerRequestId?: string;
  message: string;
  fingerprint: string;
}

/** CON-053/054: stores the evidence (append-only) and points the contact's status at it. */
export async function recordCheck(
  ctx: ModelCtx,
  contactId: Id<"contacts">,
  vatId: string,
  r: CheckResult,
): Promise<Id<"vatIdChecks">> {
  const c = await getContact(ctx, contactId);
  const checkedAt = ctx.now();
  const id = await auditedInsert(
    ctx,
    "vatIdChecks",
    {
      contactId,
      vatId,
      provider: r.provider,
      request: r.request,
      response: r.response,
      status: r.status,
      ...(r.qualified ? { qualified: r.qualified } : {}),
      ...(r.providerRequestId ? { providerRequestId: r.providerRequestId } : {}),
      checkedAt,
      retentionUntil: vatCheckRetentionUntil(berlinCalendarDate(checkedAt)),
      fingerprint: r.fingerprint,
      message: r.message,
    },
    { action: "contact.vat_check", label: `${c.number} ${vatId}` },
  );
  // The VAT ID may have changed while the provider answered: then the evidence stays, the status is not touched.
  if (c.vatId === vatId) {
    await auditedPatch(
      ctx,
      "contacts",
      contactId,
      {
        vatIdStatus: {
          lastCheckId: id,
          status: r.status,
          qualified: isQualified(r.provider, r.status, r.qualified),
          checkedAt,
        },
      },
      { action: "contact.vat_check", label: c.number },
    );
  }
  return id;
}

/** CON-058: a reused check becomes the contact's status again (no new evidence row). */
export async function reuseCheck(ctx: ModelCtx, contactId: Id<"contacts">, checkId: Id<"vatIdChecks">): Promise<void> {
  const c = await getContact(ctx, contactId);
  const check = await ctx.db.get(checkId);
  if (!check || check.contactId !== contactId) throw appError("not_found", "Prüfnachweis nicht gefunden.");
  if (c.vatIdStatus?.lastCheckId === checkId || c.vatId !== check.vatId) return;
  await auditedPatch(
    ctx,
    "contacts",
    contactId,
    {
      vatIdStatus: {
        lastCheckId: checkId,
        status: check.status,
        qualified: isQualified(check.provider, check.status, check.qualified),
        checkedAt: check.checkedAt,
      },
    },
    { action: "contact.vat_check", label: c.number },
  );
}
