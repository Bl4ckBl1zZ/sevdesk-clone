/**
 * zod schemas of the settings lookups (F01 §3.8–3.9): text templates, units, payment methods, tags, custom fields
 * and cost centres. Shared by the settings UI, Convex, REST and MCP (CLAUDE.md §5).
 */
import { z } from "zod";
import { SALES_DOC_TYPES } from "../documents/layout";
import { CUSTOM_FIELD_ENTITIES, CUSTOM_FIELD_KEY, CUSTOM_FIELD_TYPES } from "../lookups/custom-fields";
import { PAYMENT_METHOD_KINDS } from "../lookups/payment-methods";
import { TAG_COLORS } from "../lookups/tags";
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

// ── units (SET-090/091) ──────────────────────────────────────────────────────────────────────────────────
export const unitSchema = z.object({
  code: trimmed().min(1, "Bitte einen Einheitencode wählen."),
  labelDe: trimmed()
    .min(1, "Bezeichnungen: 1 bis 20 Zeichen je Sprache.")
    .max(20, "Bezeichnungen: 1 bis 20 Zeichen je Sprache."),
  labelEn: trimmed()
    .min(1, "Bezeichnungen: 1 bis 20 Zeichen je Sprache.")
    .max(20, "Bezeichnungen: 1 bis 20 Zeichen je Sprache."),
});
export type UnitValues = z.infer<typeof unitSchema>;

// ── payment methods (SET-092/093) ────────────────────────────────────────────────────────────────────────
export const paymentMethodSchema = z.object({
  name: trimmed().min(1, "Name: 1 bis 60 Zeichen.").max(60, "Name: 1 bis 60 Zeichen."),
  text: trimmed().max(500, "Höchstens 500 Zeichen."),
  kind: z.enum(PAYMENT_METHOD_KINDS),
  isDefault: z.boolean(),
  active: z.boolean(),
});
export type PaymentMethodFormValues = z.infer<typeof paymentMethodSchema>;

// ── tags (SET-094) ───────────────────────────────────────────────────────────────────────────────────────
export const tagSchema = z.object({
  name: trimmed().min(1, "Name: 1 bis 40 Zeichen.").max(40, "Name: 1 bis 40 Zeichen."),
  color: z.enum(TAG_COLORS).optional(),
});
export type TagValues = z.infer<typeof tagSchema>;

// ── custom fields (SET-095/096) ──────────────────────────────────────────────────────────────────────────
export const customFieldDefSchema = z
  .object({
    entity: z.enum(CUSTOM_FIELD_ENTITIES),
    key: trimmed().regex(
      CUSTOM_FIELD_KEY,
      "Schlüssel: Kleinbuchstaben, Ziffern und _, beginnend mit einem Buchstaben.",
    ),
    label: trimmed().min(1, "Bezeichnung: 1 bis 60 Zeichen.").max(60, "Bezeichnung: 1 bis 60 Zeichen."),
    type: z.enum(CUSTOM_FIELD_TYPES),
    /** Select options, one per line (form) → array. */
    options: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(/\r?\n|;/)
          .map((o) => o.trim())
          .filter(Boolean),
      ),
    printOnDocuments: z.boolean(),
    required: z.boolean(),
  })
  .superRefine((d, ctx) => {
    if (d.type === "select" && (d.options.length < 1 || d.options.length > 50)) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "Auswahlfelder brauchen 1 bis 50 Optionen." });
    }
  });
export type CustomFieldDefFormValues = z.input<typeof customFieldDefSchema>;
export type CustomFieldDefValues = z.output<typeof customFieldDefSchema>;

// ── cost centres (SET-097) ───────────────────────────────────────────────────────────────────────────────
export const costCenterSchema = z.object({
  number: trimmed().regex(/^[A-Za-z0-9]{1,36}$/, "Kostenstellennummer: 1–36 Buchstaben/Ziffern, eindeutig."),
  name: trimmed().min(1, "Bezeichnung: 1 bis 60 Zeichen.").max(60, "Bezeichnung: 1 bis 60 Zeichen."),
  isDefault: z.boolean(),
});
export type CostCenterValues = z.infer<typeof costCenterSchema>;
