import "server-only";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import { listQuery, prefixedId } from "@/domain/schemas/api/common";
import {
  serializeVoucher,
  serializeVoucherRow,
  type VoucherDetailRecord,
  type VoucherListRecord,
  voucherDraftWire,
  voucherFinalizeArgs,
  voucherFinalizeWire,
  voucherLaterPaymentWire,
  voucherList,
  voucherOut,
  voucherPaymentArgs,
  voucherPaymentWire,
  wireToDraftInput,
} from "@/domain/schemas/api/vouchers";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { nextCursor, paginationOpts, rawId, requireVersion, versionField } from "./shared";

/**
 * F06 §7.1 purchase vouchers (05 §4.5 `/vouchers`). Thin wire ⇄ Convex mapping; booking, payments, corrections and the
 * GoBD rules live in convex/model/vouchers.ts and src/domain/vouchers. Inbox uploads, classification and Bewirtung/
 * Eigenbeleg approval (a personal act, only in the app) are not part of this slice.
 */

type VId = Id<"vouchers">;
const params = z.object({ id: prefixedId("vouchers") });
const TABS = ["all", "draft", "open", "paid", "cancelled", "unbooked"] as const;

export async function loadVoucher(convex: ConvexCaller, raw: string) {
  try {
    return (await convex.query(api.vouchers.get, { id: raw as VId })) as unknown as VoucherDetailRecord;
  } catch (e) {
    if ((e as { data?: { code?: string } }).data?.code === "not_found") {
      throw new ApiProblem("not_found", { detail: "Beleg nicht gefunden." });
    }
    throw e;
  }
}

export const voucherWire = async (convex: ConvexCaller, raw: string) =>
  serializeVoucher(await loadVoucher(convex, raw));

export function draftInputOrThrow(body: z.infer<typeof voucherDraftWire>) {
  const { input, issues } = wireToDraftInput(body);
  if (issues.length > 0) {
    throw new ApiProblem("validation_failed", {
      errors: issues.map((i) => ({ code: "invalid", field: i.field, message: i.message })),
    });
  }
  return input;
}

/** PATCH: a draft is updated; a booked, unlocked voucher only with `correction_reason` (VOU-008). */
export async function patchVoucherWire(
  convex: ConvexCaller,
  raw: string,
  body: z.infer<typeof voucherDraftWire>,
  opts: { version?: number; correctionReason?: string; acknowledgeWarnings?: string[] },
) {
  const current = await loadVoucher(convex, raw);
  const input = draftInputOrThrow(body);
  if (current.voucher.status === "draft") {
    await convex.mutation(api.vouchers.updateDraft, {
      id: raw as VId,
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      input: input as never,
    });
  } else {
    if (!opts.correctionReason) {
      throw new ApiProblem("validation_failed", {
        errors: [
          {
            code: "correction_reason_required",
            field: "correction_reason",
            message: "Gebuchte Belege werden nur mit Korrekturgrund geändert (Generalumkehr und Neubuchung).",
          },
        ],
      });
    }
    await convex.mutation(api.vouchers.correct, {
      id: raw as VId,
      ...(opts.version !== undefined ? { version: opts.version } : {}),
      input: input as never,
      reason: opts.correctionReason,
      ...(opts.acknowledgeWarnings?.length ? { acknowledgeWarnings: opts.acknowledgeWarnings } : {}),
    });
  }
  return voucherWire(convex, raw);
}

const patchBody = voucherDraftWire.extend({
  version: versionField,
  correction_reason: z.string().min(5).max(1000).optional().meta({ description: "Pflicht bei gebuchten Belegen" }),
  acknowledge_warnings: z.array(z.string().max(60)).max(20).optional(),
});

export const vouchersResource = defineResource("vouchers", "Belege (Ausgaben)", [
  defineEndpoint({
    method: "GET",
    path: "/vouchers/missing-receipts",
    operationId: "listMissingReceipts",
    summary: "Fehlende Belege",
    description:
      "Bankumsätze ohne Beleg (nicht zugeordnet, nicht markiert, nicht „Beleg nicht erforderlich“), überfällige offene Belege und wiederkehrende Belege ohne Abbuchung (VOU-110).",
    tag: "Belege",
    scope: "vouchers:read",
    response: { status: 200, description: "Die drei Listen" },
    handler: async ({ convex }) => {
      const r = await convex.query(api.vouchers.missing, {});
      return {
        body: {
          transactions: r.transactions.map((t) => ({
            id: encodeId("bankTransactions", t.id),
            booking_date: t.bookingDate,
            amount_cents: t.amountCents,
            counterparty_name: t.counterpartyName ?? null,
            purpose: t.purpose ?? null,
            suggestions: t.suggestions.map((s) => ({ id: encodeId("vouchers", s.id), gross_cents: s.grossCents })),
          })),
          overdue: r.overdue.map((v) => serializeVoucherRow(v as unknown as VoucherListRecord)),
          recurring_without_debit: r.recurringWithoutDebit.map((v) =>
            serializeVoucherRow(v as unknown as VoucherListRecord),
          ),
        },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/vouchers",
    operationId: "listVouchers",
    summary: "Belege auflisten",
    description:
      "Neueste zuerst; `status` all, draft, open, paid, cancelled oder unbooked (Unbearbeitet > 10 Tage); `q` sucht in Lieferant und Nummern.",
    tag: "Belege",
    scope: "vouchers:read",
    query: listQuery.extend({
      status: z.enum(TABS).optional(),
      q: z.string().max(200).optional(),
    }),
    response: { status: 200, schema: voucherList, description: "Eine Seite Belege" },
    handler: async ({ convex, query }) => {
      const page = await convex.query(api.vouchers.list, {
        paginationOpts: paginationOpts(query),
        ...(query.status ? { tab: query.status } : {}),
        ...(query.q ? { q: query.q } : {}),
      });
      return {
        body: {
          data: page.page.map((r) => serializeVoucherRow(r as unknown as VoucherListRecord)),
          next_cursor: nextCursor(page),
        },
      };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/vouchers",
    operationId: "createVoucher",
    summary: "Belegentwurf anlegen",
    description:
      "Entwurf mit Kopfdaten und Positionen (Beträge in Cent, Steuersatz in Basispunkten). Die Originaldatei wird über die App oder den Posteingang ergänzt; gebucht wird mit /vouchers/{id}/finalize.",
    tag: "Belege",
    scope: "vouchers:write",
    body: voucherDraftWire,
    response: { status: 201, schema: voucherOut, description: "Der Entwurf" },
    errors: ["validation_failed"],
    handler: async ({ convex, body }) => {
      const id = await convex.mutation(api.vouchers.create, { input: draftInputOrThrow(body) as never });
      const out = await voucherWire(convex, id);
      return { status: 201, body: out, headers: { Location: `/api/v1/vouchers/${out.id}` } };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/vouchers/{id}",
    operationId: "getVoucher",
    summary: "Beleg abrufen",
    description: "Kopf, Positionen, Dateien (Metadaten mit SHA-256), Zahlungen und — bei Entwürfen — die Prüfung.",
    tag: "Belege",
    scope: "vouchers:read",
    params,
    response: { status: 200, schema: voucherOut, description: "Der Beleg" },
    errors: ["not_found"],
    handler: async ({ convex, params: p }) => ({ body: await voucherWire(convex, rawId("vouchers", p.id)) }),
  }),
  defineEndpoint({
    method: "PATCH",
    path: "/vouchers/{id}",
    operationId: "updateVoucher",
    summary: "Beleg ändern",
    description:
      "Entwürfe frei; gebuchte, nicht festgeschriebene Belege nur mit `correction_reason` (Generalumkehr und Neubuchung, VOU-008). `lines` ersetzt alle Positionen. `If-Match` oder `version`.",
    tag: "Belege",
    scope: "vouchers:write",
    params,
    body: patchBody,
    response: { status: 200, schema: voucherOut, description: "Der Beleg" },
    errors: ["not_found", "validation_failed", "conflict", "immutable_record", "period_locked"],
    handler: async ({ convex, params: p, body, ifMatch }) => {
      const { version, correction_reason, acknowledge_warnings, ...rest } = body;
      return {
        body: await patchVoucherWire(convex, rawId("vouchers", p.id), rest, {
          version: requireVersion(ifMatch, version),
          ...(correction_reason ? { correctionReason: correction_reason } : {}),
          ...(acknowledge_warnings ? { acknowledgeWarnings: acknowledge_warnings } : {}),
        }),
      };
    },
  }),
  defineEndpoint({
    method: "DELETE",
    path: "/vouchers/{id}",
    operationId: "deleteVoucher",
    summary: "Entwurf löschen",
    description: "Nur Entwürfe; die Löschung wird mit Inhalt protokolliert.",
    tag: "Belege",
    scope: "vouchers:write",
    params,
    response: { status: 204, description: "Gelöscht" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params: p }) => {
      await convex.mutation(api.vouchers.deleteDraft, { id: rawId("vouchers", p.id) as VId });
      return { status: 204 };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/vouchers/{id}/preview",
    operationId: "previewVoucher",
    summary: "Buchung prüfen",
    description:
      "Trockenlauf der Buchung: Fehler, Warnungen (Codes für acknowledge_warnings), wirksame Steuerregel, Summen in EUR, Zahlung und die Buchungszeilen. Schreibt nichts.",
    tag: "Belege",
    scope: "vouchers:read",
    params,
    body: z.object({ payment: voucherPaymentWire.optional() }).strict(),
    response: { status: 200, description: "Die Vorschau" },
    errors: ["not_found"],
    handler: async ({ convex, params: p, body }) => {
      const raw = rawId("vouchers", p.id);
      const args = voucherFinalizeArgs(raw, { ...(body.payment ? { payment: body.payment } : {}) });
      const r = await convex.query(api.vouchers.preview, args as never);
      return { body: { ...r, id: p.id, allowed: r.errors.length === 0 } };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/vouchers/{id}/finalize",
    operationId: "finalizeVoucher",
    summary: "Beleg buchen",
    description:
      "Vergibt die Belegnummer (BE-…), bucht ins Journal und erfasst optional „Bezahlt mit“ (bank Standard, card_pending, cash, private; VOU-136…138). cash/private schreiben Beleg, Buchung und Zahlung in einer Transaktion — eine fehlgeschlagene Kassenprüfung bucht nichts. ⚑-Warnungen mit acknowledge_warnings bestätigen.",
    tag: "Belege",
    scope: "vouchers:write",
    params,
    body: voucherFinalizeWire,
    idempotency: "required",
    response: { status: 200, schema: voucherOut, description: "Der gebuchte Beleg" },
    errors: ["not_found", "validation_failed", "conflict", "period_locked", "cash_negative"],
    handler: async ({ convex, params: p, body }) => {
      const raw = rawId("vouchers", p.id);
      await convex.mutation(api.vouchers.finalize, voucherFinalizeArgs(raw, body) as never);
      return { body: await voucherWire(convex, raw) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/vouchers/{id}/payments",
    operationId: "recordVoucherPayment",
    summary: "Zahlung zum Beleg erfassen",
    description:
      "Später „Bar/Privat bezahlt“ oder einen Bankumsatz (transaction_id) zuordnen; Differenzen Skonto/Bankgebühren/Sonstige (VOU-131/132). Braucht vouchers:write und payments:write.",
    tag: "Belege",
    scope: "payments:write",
    params,
    body: voucherLaterPaymentWire,
    idempotency: "required",
    response: { status: 200, schema: voucherOut, description: "Der Beleg" },
    errors: ["not_found", "validation_failed", "cash_negative", "insufficient_scope"],
    handler: async ({ convex, params: p, body, key }) => {
      if (!key.scopes.includes("vouchers:write")) {
        throw new ApiProblem("insufficient_scope", { extra: { required_scope: "vouchers:write payments:write" } });
      }
      const raw = rawId("vouchers", p.id);
      if (body.method === "bank" && !body.transaction_id) {
        throw new ApiProblem("validation_failed", {
          errors: [{ code: "required", field: "transaction_id", message: "Bitte den Bankumsatz angeben." }],
        });
      }
      await convex.mutation(api.vouchers.recordPayment, voucherPaymentArgs(raw, body) as never);
      return { body: await voucherWire(convex, raw) };
    },
  }),
  defineEndpoint({
    method: "POST",
    path: "/vouchers/{id}/cancel",
    operationId: "cancelVoucher",
    summary: "Beleg stornieren",
    description:
      "Generalumkehr im laufenden offenen Zeitraum, Status storniert (VOU-009). Zahlungen sind vorher zu stornieren.",
    tag: "Belege",
    scope: "vouchers:write",
    params,
    body: z.object({ reason: z.string().min(5).max(1000) }).strict(),
    idempotency: "required",
    response: { status: 200, schema: voucherOut, description: "Der stornierte Beleg" },
    errors: ["not_found", "validation_failed"],
    handler: async ({ convex, params: p, body }) => {
      const raw = rawId("vouchers", p.id);
      await convex.mutation(api.vouchers.cancel, { id: raw as VId, reason: body.reason });
      return { body: await voucherWire(convex, raw) };
    },
  }),
]);
