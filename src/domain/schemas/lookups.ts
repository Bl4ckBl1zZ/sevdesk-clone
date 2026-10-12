/**
 * zod schemas of the settings lookups (F01 §3.8–3.9): text templates, units, payment methods, tags, custom fields
 * and cost centres. Shared by the settings UI, Convex, REST and MCP (CLAUDE.md §5).
 */
import { z } from "zod";
import { SALES_DOC_TYPES } from "../documents/layout";
import { TEMPLATE_KINDS, TEMPLATE_LANGUAGES } from "../templates/defaults";
import { validatePlaceholders } from "../templates/placeholders";

const trimmed = () => z.string().trim();

// ── text templates (SET-080…087) ─────────────────────────────────────────────────────────────────────────
export const textTemplateSchema = z
  .object({
    kind: z.enum(TEMPLATE_KINDS),
    docTypes: z.array(z.enum(SALES_DOC_TYPES)).min(1, "Bitte mindestens eine Dokumentart wählen."),
    language: z.enum(TEMPLATE_LANGUAGES),
    name: trimmed().min(1, "Bitte einen Namen angeben.").max(80, "Höchstens 80 Zeichen."),
    subject: trimmed().max(200, "Höchstens 200 Zeichen.").optional(),
    body: z.string().max(40_000, "Höchstens 20.000 Zeichen."),
    isDefault: z.boolean(),
  })
  .superRefine((t, ctx) => {
    const scope = { kind: t.kind, docTypes: t.docTypes };
    const body = validatePlaceholders(t.body, scope);
    if (!body.ok) ctx.addIssue({ code: "custom", path: ["body"], message: body.error.message });
    if (t.kind === "message_text" && t.subject) {
      const subject = validatePlaceholders(t.subject, scope);
      if (!subject.ok) ctx.addIssue({ code: "custom", path: ["subject"], message: subject.error.message });
    }
  });
export type TextTemplateValues = z.infer<typeof textTemplateSchema>;
