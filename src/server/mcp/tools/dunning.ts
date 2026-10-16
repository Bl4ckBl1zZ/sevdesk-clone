import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { prefixedId } from "@/domain/schemas/api/common";
import { reminderCreateValues, reminderCreateWire, serializeRunResult } from "@/domain/schemas/api/dunning";
import { ApiProblem } from "../../api/http";
import { loadReminder, previewWire, rawInvoiceIds } from "../../api/resources/dunning";
import { rawId } from "../../api/resources/shared";
import { confirmTokenArg, defineTool, type ToolContext } from "../tool";
import { issueToken } from "./previews";

/**
 * 06 §3.5 dunning tools (F05 §7.2). `dunning_preview` issues the token for ⚠ `dunning_run`; the token binds the
 * exact arguments of `api.dunning.run` — mode, the (sorted) invoice ids and the plan digest — so a changed plan or
 * other parameters fail with `preview_outdated` (DUN-031). Nothing is ever sent: finalised reminders are exported
 * and marked sent by the owner.
 */

const modeArg = z
  .enum(["drafts", "finalize"])
  .meta({ description: "drafts = nur Entwürfe; finalize = laut Richtlinie fertigstellen (braucht invoices:finalize)" });
const invoiceIdsArg = z
  .array(z.string().max(80))
  .max(500)
  .optional()
  .meta({ description: "Nur diese Rechnungen (inv_…)" });

/** The arguments of `api.dunning.run` (without `confirmToken`) for the current plan — identical in preview and act. */
async function runArgs(ctx: ToolContext, mode: "drafts" | "finalize", invoiceIds: readonly string[] | undefined) {
  if (mode === "finalize" && !ctx.key.scopes.includes("invoices:finalize")) {
    throw new ApiProblem("insufficient_scope", { extra: { required_scope: "invoices:finalize" } });
  }
  const ids = rawInvoiceIds(invoiceIds)?.sort();
  const p = await previewWire(ctx.convex, ids ? { invoiceIds: ids } : {});
  return { preview: p.wire, args: { mode, ...(ids ? { invoiceIds: ids } : {}), expectedDigest: p.digest } };
}

export const dunningTools = [
  defineTool({
    name: "dunning_preview",
    title: "Mahnlauf-Vorschau",
    description:
      "Vorschau des heutigen Mahnlaufs: je Rechnung Entwurf, Fertigstellen, Erinnerung oder Überspringen mit Grund, Beträge (Gebühr, Zinsen, 40-€-Pauschale) und neue Frist; dazu ein confirm_token (10 min) für dunning_run mit demselben mode und denselben invoice_ids. Zeige die Liste und frage den Nutzer, bevor du dunning_run aufrufst.",
    kind: "read",
    scopes: ["payments:read"],
    input: z.object({ mode: modeArg.default("drafts"), invoice_ids: invoiceIdsArg }),
    handler: async ({ mode, invoice_ids }, ctx) => {
      const { preview, args } = await runArgs(ctx, mode, invoice_ids);
      const { confirm_token: _digest, ...shown } = preview;
      const plan = { args, entities: [], effect: { mode, ...shown } };
      return { mode, ...shown, ...(await issueToken("dunning_run", plan, ctx)) };
    },
  }),
  defineTool({
    name: "dunning_run",
    title: "Mahnlauf ausführen ⚠",
    description:
      "⚠ Führt den Mahnlauf wie in dunning_preview geplant aus: legt Mahnungsentwürfe an (mode drafts) oder stellt laut Richtlinie fertig (mode finalize). Versendet NIE – fertige Mahnungen exportiert der Inhaber und markiert sie als versendet. Erst dunning_preview mit denselben Parametern, Plan zeigen, Freigabe einholen, dann mit confirm_token.",
    kind: "danger",
    confirmIntent: "dunning_run",
    scopes: ["dunning:write"],
    input: z.object({ mode: modeArg, invoice_ids: invoiceIdsArg, confirm_token: confirmTokenArg }),
    handler: async ({ mode, invoice_ids, confirm_token }, ctx) => {
      const { args } = await runArgs(ctx, mode, invoice_ids);
      const r = await ctx.convex.mutation(api.dunning.run, { ...args, confirmToken: confirm_token } as never);
      return serializeRunResult(r);
    },
  }),
  defineTool({
    name: "reminder_create",
    title: "Mahnungsentwurf anlegen",
    description:
      "Legt einen Mahnungsentwurf zur Rechnung (inv_…) an: nächste Stufe der Mahnrichtlinie, Beträge vorbelegt (überschreibbar). Nur ein Entwurf – Fertigstellen und Versand macht der Inhaber.",
    kind: "write",
    scopes: ["dunning:write"],
    input: reminderCreateWire.omit({ finalize: true }).extend({ invoice_id: prefixedId("invoices") }),
    handler: async ({ invoice_id, ...rest }, { convex }) => {
      const r = await convex.mutation(api.dunning.createReminder, {
        invoiceId: rawId("invoices", invoice_id) as never,
        values: reminderCreateValues(rest),
      });
      return await loadReminder(convex, r.id);
    },
  }),
];
