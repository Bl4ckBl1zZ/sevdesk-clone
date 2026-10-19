import "server-only";
import { api } from "@convex/_generated/api";
import type { Id } from "@convex/_generated/dataModel";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import { prefixedId } from "@/domain/schemas/api/common";
import {
  serializeVoucherRow,
  type VoucherListRecord,
  voucherDraftWire,
  voucherFinalizeArgs,
  voucherFinalizeWire,
} from "@/domain/schemas/api/vouchers";
import { ApiProblem } from "../../api/http";
import { rawId } from "../../api/resources/shared";
import { draftInputOrThrow, patchVoucherWire, voucherWire } from "../../api/resources/vouchers";
import { confirmTokenArg, defineTool, type ToolContext } from "../tool";
import type { PreviewPlan } from "./previews";

/**
 * 06 §3 purchase voucher tools (F06 P2). Reads and drafts are free; `voucher_finalize` is ⚠ (assigns the Belegnummer and
 * books the journal) and needs a `preview_action` token whose arguments are built by the same `voucherFinalizeArgs`
 * as the act. `voucher_create_from_file` waits for the inbox/classification slice (INB-*); Bewirtung/Eigenbeleg
 * approval is a personal act and stays in the app.
 */

type VId = Id<"vouchers">;

export const voucherFinalizeParams = voucherFinalizeWire.extend({ id: prefixedId("vouchers") });

/** `preview_action { action: "voucher_finalize" }`: the booking dry run, the payment and the resulting cash balance. */
export async function voucherFinalizePlan(
  params: z.infer<typeof voucherFinalizeParams>,
  { convex }: ToolContext,
): Promise<PreviewPlan> {
  const { id, ...wire } = params;
  const raw = rawId("vouchers", id);
  const args = voucherFinalizeArgs(raw, wire);
  const p = await convex.query(api.vouchers.preview, {
    id: raw as VId,
    ...(args.payment ? { payment: args.payment as never } : {}),
  });
  if (p.errors.length > 0) {
    throw new ApiProblem("validation_failed", {
      detail: "Der Beleg kann so nicht gebucht werden.",
      errors: p.errors.map((e) => ({ code: e.code, field: "voucher", message: e.message })),
    });
  }
  const acknowledged = new Set(wire.acknowledge_warnings ?? []);
  const open = p.warnings.filter((w) => !acknowledged.has(w.code));
  if (open.length > 0) {
    throw new ApiProblem("validation_failed", {
      detail: "Warnungen erst nach Rückfrage beim Nutzer mit acknowledge_warnings bestätigen.",
      errors: open.map((w) => ({ code: w.code, field: "acknowledge_warnings", message: w.message })),
    });
  }
  return {
    args,
    entities: [{ table: "vouchers", id: raw }],
    effect: {
      voucher: id,
      version: p.version,
      tax_rule: p.effectiveTaxRule,
      tax_rule_label: p.effectiveTaxRuleLabel,
      totals_eur: p.totalsEur,
      input_vat_at_risk_cents: p.inputVatAtRisk,
      payment: { method: p.payment.method, date: p.payment.date, amount_cents: p.payment.amountCents },
      ...(p.cash
        ? { cash_balance_cents: p.cash.balanceCents, cash_balance_after_cents: p.cash.balanceAfterCents }
        : {}),
      journal: p.journal,
      summary: "Vergibt die Belegnummer (BE-…) und bucht den Beleg ins Journal; danach nur Korrektur oder Storno.",
    },
  };
}

export const voucherTools = [
  defineTool({
    name: "voucher_search",
    title: "Belege suchen",
    description:
      "Belege (Ausgaben), neueste zuerst. status: all, draft, open, overdue (fällig), partially_paid, paid, cancelled, unbooked (Unbearbeitet > 10 Tage); q sucht in Lieferant und Nummern.",
    kind: "read",
    scopes: ["vouchers:read"],
    input: z.object({
      status: z.enum(["all", "draft", "open", "overdue", "partially_paid", "paid", "cancelled", "unbooked"]).optional(),
      q: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().max(500).optional(),
    }),
    handler: async ({ status, q, limit, cursor }, { convex }) => {
      const page = await convex.query(api.vouchers.list, {
        paginationOpts: { numItems: limit ?? 25, cursor: cursor ?? null },
        ...(status ? { tab: status } : {}),
        ...(q ? { q } : {}),
      });
      return {
        data: page.page.map((r) => serializeVoucherRow(r as unknown as VoucherListRecord)),
        next_cursor: page.isDone ? null : page.continueCursor,
      };
    },
  }),
  defineTool({
    name: "voucher_get",
    title: "Beleg abrufen",
    description:
      "Ein Beleg (vou_…) mit Positionen, Dateien (SHA-256), Zahlungen und bei Entwürfen der Prüfung (Fehler/Warnungen mit Codes).",
    kind: "read",
    scopes: ["vouchers:read"],
    input: z.object({ id: prefixedId("vouchers") }),
    handler: async ({ id }, { convex }) => voucherWire(convex, rawId("vouchers", id)),
  }),
  defineTool({
    name: "voucher_update_draft",
    title: "Belegentwurf bearbeiten",
    description:
      "Legt einen Belegentwurf an (ohne id) oder ändert einen Entwurf (id, version). lines ersetzt alle Positionen (Cent, Steuersatz in Basispunkten). Gebuchte Belege werden nur in der App korrigiert oder storniert.",
    kind: "write",
    scopes: ["vouchers:write"],
    input: voucherDraftWire.extend({
      id: prefixedId("vouchers").optional(),
      version: z.number().int().min(1).optional(),
    }),
    handler: async ({ id, version, ...rest }, { convex }) => {
      if (!id) {
        const created = await convex.mutation(api.vouchers.create, { input: draftInputOrThrow(rest) as never });
        return voucherWire(convex, created);
      }
      const raw = rawId("vouchers", id);
      const current = await voucherWire(convex, raw);
      if (current.status !== "draft") {
        throw new ApiProblem("immutable_record", {
          detail: `Beleg ${current.internal_number ?? encodeId("vouchers", raw)} ist gebucht; Änderungen nur als Korrektur in der App.`,
        });
      }
      return patchVoucherWire(convex, raw, rest, { ...(version !== undefined ? { version } : {}) });
    },
  }),
  defineTool({
    name: "voucher_finalize",
    title: "Beleg buchen ⚠",
    description:
      '⚠ Bucht einen Belegentwurf (vou_…) und vergibt die Belegnummer; optional payment {method: bank | card_pending | cash | private, date?, amount_cents?, backdate_reason?} für „Bezahlt mit“. Erst preview_action {action:"voucher_finalize", params:{id, version?, acknowledge_warnings?, payment?}}, Auswirkung zeigen und bestätigen lassen, dann mit denselben Argumenten und confirm_token. Zahlungen nur so erfassen, wie der Nutzer sie genannt hat.',
    kind: "danger",
    confirmIntent: "voucher_finalize",
    scopes: ["vouchers:write"],
    input: voucherFinalizeParams.extend({ confirm_token: confirmTokenArg }),
    handler: async ({ confirm_token, id, ...wire }, { convex }) => {
      const raw = rawId("vouchers", id);
      await convex.mutation(api.vouchers.finalize, {
        ...(voucherFinalizeArgs(raw, wire) as { id: VId }),
        confirmToken: confirm_token,
      });
      return voucherWire(convex, raw);
    },
  }),
];
