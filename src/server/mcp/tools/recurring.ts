import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { decodeId } from "@/domain/api/ids";
import {
  type OccurrenceRecord,
  recurringPatchWire,
  serializeOccurrence,
  serializeTemplate,
  type TemplateRecord,
} from "@/domain/schemas/api/recurring";
import { ApiProblem } from "../../api/http";
import { createTemplateWire, patchTemplateWire } from "../../api/resources/recurring";
import { defineTool } from "../tool";

/**
 * F04 §7.2 / 06 §3.4 recurring invoice templates. Templates never send (REC-16). `automation.finalize` needs
 * `invoices:finalize` on the key and stays inactive until the owner confirms it once in the app (REC-14).
 */
export const recurringTools = [
  defineTool({
    name: "recurring_invoice_upsert",
    title: "Wiederkehrende Rechnung anlegen/ändern",
    description:
      "Legt eine Vorlage für wiederkehrende Rechnungen an (ohne id: name, contact_id, lines, schedule {interval P7D…P5Y, first_date, end_date?, max_count?, billing in_advance|in_arrears, period_text}) oder ändert sie (mit id rec_… und version). Änderungen wirken nur auf künftige Rechnungen. automation {finalize} braucht invoices:finalize und wirkt erst nach Bestätigung in der App. Die App versendet nie: fertige Rechnungen erscheinen beim Inhaber als Aufgabe „Exportieren und versenden“.",
    kind: "write",
    scopes: ["documents:write"],
    input: recurringPatchWire.extend({
      id: z
        .string()
        .regex(/^rec_[0-9a-zA-Z]{16,64}$/, "Erwartet rec_…")
        .optional(),
    }),
    handler: async ({ id, version, ...body }, { convex }) => {
      if (id) {
        const raw = decodeId("recurringTemplates", id);
        if (!raw) throw new ApiProblem("not_found");
        return patchTemplateWire(convex, raw, version, body);
      }
      const missing = (["name", "contact_id", "lines", "schedule"] as const).filter((k) => body[k] === undefined);
      if (missing.length > 0) {
        throw new ApiProblem("validation_failed", {
          errors: missing.map((f) => ({ code: "required", field: f, message: "Pflichtfeld beim Anlegen." })),
        });
      }
      return createTemplateWire(convex, {
        ...body,
        name: body.name as string,
        contact_id: body.contact_id as string,
        lines: body.lines ?? [],
        schedule: body.schedule as NonNullable<typeof body.schedule>,
        automation: body.automation ?? { finalize: false },
      });
    },
  }),
  defineTool({
    name: "recurring_invoice_list",
    title: "Wiederkehrende Rechnungen auflisten",
    description:
      "Listet Vorlagen (state active, paused oder ended; Standard active) mit Kunde, Intervall, nächstem Termin, Betrag, Automatik und den nächsten Terminen (Leistungszeitraum, Betrag, ER-03).",
    kind: "read",
    scopes: ["documents:read"],
    input: z.object({
      state: z.enum(["active", "paused", "ended"]).optional(),
      next_occurrences: z
        .number()
        .int()
        .min(0)
        .max(12)
        .optional()
        .meta({ description: "Termine je Vorlage (Standard 3)" }),
    }),
    handler: async ({ state, next_occurrences }, { convex }) => {
      const r = await convex.query(api.recurring.list, { tab: state ?? "active" });
      const n = next_occurrences ?? 3;
      const data = [];
      for (const t of r.rows) {
        const occ = n > 0 ? ((await convex.query(api.recurring.occurrences, { id: t._id, count: n })) ?? []) : [];
        data.push({
          ...serializeTemplate(t as unknown as TemplateRecord),
          next_occurrences: (occ as OccurrenceRecord[]).map(serializeOccurrence),
        });
      }
      return { data, counts: r.counts };
    },
  }),
];
