import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import {
  CONFIRM_TOKEN_PREFIX,
  CONFIRM_TOKEN_TTL_MS,
  type ConfirmIntent,
  documentPreviewIntent,
} from "@/domain/api/confirm";
import { encodeId } from "@/domain/api/ids";
import { sha256Hex } from "@/domain/audit/chain";
import { contactMergeArgs, contactMergeWire } from "@/domain/schemas/api/contacts";
import { cancelArgs, cancelWire, rawDocumentId } from "@/domain/schemas/api/corrections";
import type { Scope } from "@/domain/schemas/scopes";
import { ApiProblem } from "../../api/http";
import { cancelPreviewWire } from "../../api/resources/corrections";
import { defineTool, type ToolContext } from "../tool";
import { PAYMENT_PREVIEWS } from "./payment-previews";

/**
 * Previews and confirmation tokens (06 §2.2/§2.3). A preview runs the same reads/validation as the act, returns the
 * effect for the approval prompt and a single-use token (10 min) bound to key + intent + the canonical arguments
 * of the guarded Convex mutation + the previewed entity versions. Only the token's SHA-256 reaches Convex.
 *
 * Later slices register a preview per ⚠ intent in `ACTION_PREVIEWS` (issuer `preview_action`) or implement
 * `document_preview` / `dunning_preview`.
 */
export interface PreviewPlan {
  /** Exactly the arguments the ⚠ tool will pass to its Convex mutation (without `confirmToken`). */
  args: Record<string, unknown>;
  /** Entities whose `version` the token pins (EC-003). */
  entities: { table: string; id: string }[];
  /** What happens — shown to the owner in the approval prompt. */
  effect: Record<string, unknown>;
}

interface ActionPreview {
  scope: Scope;
  params: z.ZodType;
  plan: (params: never, ctx: ToolContext) => Promise<PreviewPlan>;
}

export const ACTION_PREVIEWS: Partial<Record<ConfirmIntent, ActionPreview>> = {
  ...(PAYMENT_PREVIEWS as Partial<Record<ConfirmIntent, ActionPreview>>),
  contact_merge: {
    scope: "contacts:write",
    params: contactMergeWire,
    plan: async (params: z.infer<typeof contactMergeWire>, { convex }) => {
      const args = contactMergeArgs(params);
      if (!args) throw new ApiProblem("not_found");
      const p = await convex.query(api.contacts.mergePreview, {
        winnerId: args.values.winnerId as never,
        loserIds: args.values.loserIds as never,
      });
      const [winner, ...losers] = p.contacts;
      return {
        args,
        entities: [args.values.winnerId, ...args.values.loserIds].map((id) => ({ table: "contacts", id })),
        effect: {
          winner: winner
            ? { id: encodeId("contacts", winner._id), number: winner.number, name: winner.displayName }
            : null,
          losers: losers.map((l) => ({ id: encodeId("contacts", l._id), number: l.number, name: l.displayName })),
          moves: p.moves,
          stays: { ...p.stays, finalized_documents: "bleiben unverändert (GoBD)" },
          summary: `${losers.length} Kontakt(e) werden in ${winner?.displayName ?? "den bleibenden Kontakt"} zusammengeführt; rückgängig machen ist möglich.`,
        },
      };
    },
  },
};

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `${CONFIRM_TOKEN_PREFIX}${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/** Issues a token for a plan; Convex stores only its hash with intent, params hash and entity versions. */
export async function issueToken(intent: ConfirmIntent, plan: PreviewPlan, ctx: ToolContext) {
  const token = newToken();
  await ctx.convex.mutation(api.confirmTokens.issue, {
    intent,
    args: plan.args,
    entities: plan.entities,
    tokenHash: await sha256Hex(token),
  });
  return { confirm_token: token, expires_at: new Date(Date.now() + CONFIRM_TOKEN_TTL_MS).toISOString() };
}

const actions = Object.keys(ACTION_PREVIEWS) as [ConfirmIntent, ...ConfirmIntent[]];

export const previewTools = [
  defineTool({
    name: "preview_action",
    title: "Vorschau für eine ⚠ Aktion",
    description:
      "Vorschau für ⚠ Aktionen außer Belegen: { action: <Toolname>, params: <dieselben Argumente wie das Tool ohne confirm_token> }. Schreibt nichts; liefert die Auswirkung und ein confirm_token (10 min, einmalig). Zeige die Auswirkung und frage den Nutzer, bevor du das Tool mit dem Token aufrufst.",
    kind: "read",
    scopes: [...new Set(actions.map((a) => ACTION_PREVIEWS[a]?.scope as Scope))],
    input: z.object({ action: z.enum(actions), params: z.record(z.string(), z.unknown()) }),
    handler: async ({ action, params }, ctx) => {
      const preview = ACTION_PREVIEWS[action];
      if (!preview) throw new ApiProblem("not_implemented");
      if (!ctx.key.scopes.includes(preview.scope)) {
        throw new ApiProblem("insufficient_scope", { extra: { required_scope: preview.scope } });
      }
      const parsed = preview.params.safeParse(params);
      if (!parsed.success) {
        throw new ApiProblem("validation_failed", {
          errors: parsed.error.issues.map((i) => ({ code: "invalid", field: i.path.join("."), message: i.message })),
        });
      }
      const plan = await preview.plan(parsed.data as never, ctx);
      return { action, effect: plan.effect, ...(await issueToken(action, plan, ctx)) };
    },
  }),
  defineTool({
    name: "document_preview",
    title: "Belegvorschau",
    description:
      'Vorschau mit confirm_token. intent "cancel" (Storno einer Rechnung/Rechnungskorrektur): Spiegel-Vorschau (Positionen, Summen, Datum, E-Rechnungs-Prüfung, INV-10-Prüfung) und Token für invoice_cancel mit denselben reason/document_date. intent "finalize" folgt mit document_finalize. Zeige die Vorschau und frage den Nutzer, bevor du das ⚠ Tool aufrufst.',
    kind: "read",
    scopes: ["documents:read"],
    input: z.object({
      id: z.string(),
      intent: z.enum(["finalize", "cancel"]).optional(),
      reason: z.string().max(1000).optional(),
      document_date: z.string().optional(),
    }),
    handler: async ({ id, intent, reason, document_date }, ctx) => {
      if (intent !== "cancel") {
        throw new ApiProblem("not_implemented", {
          detail: 'Die Fertigstellungs-Vorschau (document_finalize) folgt; Storno-Vorschau: intent "cancel".',
        });
      }
      if (!ctx.key.scopes.includes("invoices:cancel")) {
        throw new ApiProblem("insufficient_scope", { extra: { required_scope: "invoices:cancel" } });
      }
      const raw = rawDocumentId(id);
      if (!raw) throw new ApiProblem("not_found");
      const w = cancelWire.parse({ ...(reason ? { reason } : {}), ...(document_date ? { document_date } : {}) });
      const p = await cancelPreviewWire(ctx.convex, raw, w);
      if (!p.wire.allowed) return { intent, ...p.wire };
      const plan: PreviewPlan = {
        args: cancelArgs(raw, w),
        entities: [{ table: "salesDocuments", id: raw }],
        effect: p.wire,
      };
      return { intent, ...p.wire, ...(await issueToken(documentPreviewIntent("cancel"), plan, ctx)) };
    },
  }),
  defineTool({
    name: "dunning_preview",
    title: "Mahnlauf-Vorschau",
    description: "Vorschau eines Mahnlaufs mit confirm_token für dunning_run. Verfügbar mit dem Mahnwesen (F05).",
    kind: "read",
    scopes: ["dunning:write", "dunning:manage"],
    input: z.object({ as_of: z.string().optional() }),
    handler: async () => {
      throw new ApiProblem("not_implemented", {
        detail: "Das Mahnwesen folgt mit F05; bis dahin gibt es keinen Mahnlauf.",
      });
    },
  }),
];
