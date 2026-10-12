import { v } from "convex/values";
import { evatrRequest, mapEvatrResponse, mapViesResponse, viesRequest } from "../src/domain/contacts/vat-check";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { action, actorMutation, query } from "./functions";
import { rateLimiter } from "./lib/rateLimits";
import { httpVatTransport } from "./lib/vatProviders";
import { type CheckResult, contactChecks, prepareCheck, recordCheck, reuseCheck } from "./model/vatChecks";

/**
 * USt-IdNr-Prüfung (F02 §4.2, CON-050…061). `check` is an action (outbound HTTP): it reads the request data with
 * the caller's identity, calls eVatR (qualified) or VIES (simple), and stores the evidence through an attributed
 * internal mutation. Unverified provider codes are classified in src/domain/rules/evatr-status.ts (LEGAL-OPEN).
 */

/** Request data and the 24-hour reuse decision for `check` (no writes). */
export const prepare = query({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), force: v.boolean() },
  handler: async (ctx, { contactId, force }) => {
    const p = await prepareCheck(ctx, contactId, ctx.now(), force);
    return {
      vatId: p.vatId,
      name: p.name,
      address: p.address ?? null,
      ownVatId: p.ownVatId ?? null,
      provider: p.plan.provider,
      warning: p.plan.warning ?? null,
      fingerprint: p.fingerprint,
      reusable: p.reusable
        ? { id: p.reusable._id, status: p.reusable.status, message: p.reusable.message ?? "" }
        : null,
    };
  },
});

export const record = actorMutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), vatId: v.string(), result: v.any() },
  handler: async (ctx, { contactId, vatId, result }) => recordCheck(ctx, contactId, vatId, result as CheckResult),
});

export const reuse = actorMutation({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), checkId: v.id("vatIdChecks") },
  handler: async (ctx, { contactId, checkId }) => reuseCheck(ctx, contactId, checkId),
});

async function throttle(ctx: Parameters<typeof rateLimiter.limit>[0], name: "vatCheckBzst" | "vatCheckVies") {
  const s = await rateLimiter.limit(ctx, name, { reserve: true });
  if (s.retryAfter) await new Promise((r) => setTimeout(r, s.retryAfter));
}

/**
 * „USt-IdNr prüfen“ / „Erneut prüfen“ (CON-051…058). Returns the stored (or reused) result for the UI.
 * §4.2 step 4: an unavailable eVatR is retried once via VIES; otherwise the result is stored as unavailable.
 */
export const check = action({
  permission: "contacts.write",
  args: { contactId: v.id("contacts"), force: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { contactId, force },
  ): Promise<{
    checkId: Id<"vatIdChecks">;
    status: "valid" | "invalid" | "unavailable";
    message: string;
    warning: string | null;
    reused: boolean;
  }> => {
    const p = await ctx.runQuery(api.vatIdChecks.prepare, { contactId, force: force ?? false });
    if (p.reusable) {
      await ctx.runMutation(internal.vatIdChecks.reuse, {
        actorContext: ctx.actorContext,
        contactId,
        checkId: p.reusable.id,
      });
      return {
        checkId: p.reusable.id,
        status: p.reusable.status,
        message: p.reusable.message,
        warning: p.warning,
        reused: true,
      };
    }
    const transport = httpVatTransport();
    const address = p.address ?? undefined;
    const runVies = async (): Promise<CheckResult> => {
      const req = viesRequest(p.vatId, p.ownVatId ?? undefined, p.name, address);
      await throttle(ctx, "vatCheckVies");
      const res = await transport.vies(req);
      return {
        provider: "eu_vies",
        request: req,
        response: res.body,
        ...mapViesResponse(res.httpStatus, res.body),
        fingerprint: p.fingerprint,
      };
    };
    let result: CheckResult;
    if (p.provider === "bzst_evatr" && p.ownVatId) {
      const req = evatrRequest(p.ownVatId, p.vatId, p.name, address);
      await throttle(ctx, "vatCheckBzst");
      const res = await transport.evatr(req);
      result = {
        provider: "bzst_evatr",
        request: req,
        response: res.body,
        ...mapEvatrResponse(res.httpStatus, res.body),
        fingerprint: p.fingerprint,
      };
      if (result.status === "unavailable") {
        // §4.2 step 4: retry once via VIES; the eVatR attempt stays as evidence.
        await ctx.runMutation(internal.vatIdChecks.record, {
          actorContext: ctx.actorContext,
          contactId,
          vatId: p.vatId,
          result,
        });
        result = await runVies();
      }
    } else {
      result = await runVies();
    }
    const checkId: Id<"vatIdChecks"> = await ctx.runMutation(internal.vatIdChecks.record, {
      actorContext: ctx.actorContext,
      contactId,
      vatId: p.vatId,
      result,
    });
    return { checkId, status: result.status, message: result.message, warning: p.warning, reused: false };
  },
});

/** CON-061 evidence view: every check of the contact, newest first. */
export const list = query({
  permission: "contacts.read",
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => contactChecks(ctx, contactId),
});

/** CON-061 „Nachweis als PDF“: one stored check (rendered as a printable page). */
export const evidence = query({
  permission: "contacts.read",
  args: { checkId: v.id("vatIdChecks") },
  handler: async (ctx, { checkId }) => {
    const check = await ctx.db.get(checkId);
    if (!check) return null;
    const contact = check.contactId ? await ctx.db.get(check.contactId) : null;
    return { check, contact: contact ? { number: contact.number, displayName: contact.displayName } : null };
  },
});
