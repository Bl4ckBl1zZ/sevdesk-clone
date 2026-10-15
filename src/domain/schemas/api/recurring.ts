import { z } from "zod";
import type {} from "zod-openapi";
import { encodeDocumentId, encodeId } from "../../api/ids";
import type { SalesDocType } from "../../documents/snapshot";
import type { TemplateDraft } from "../../recurring/generate";
import { BILLING_MODES, RECURRING_INTERVALS } from "../../recurring/schedule";
import type { DraftValues } from "../documents";
import type { RecurringTemplateValues } from "../recurring";
import { decimalString, isoDate, listEnvelope, scaledToDecimal } from "./common";
import { type DocumentCreateWire, type DraftDefaults, documentLineWire, type WireIssue, wireToDraft } from "./documents";

/**
 * Recurring invoice templates on the wire (05 §4.3 `/recurring-invoices`, 06 §3.4 `recurring_invoice_*`, F04 §7).
 * `automation` is strict and `{ finalize }` only (REC-16): a `send` field is an unknown field → 422. The draft part
 * maps onto the shared draft schema via `wireToDraft`, so REST, MCP and the editor share one validation.
 */

const str = (max: number) => z.string().max(max);

export const recurringScheduleWire = z
  .object({
    interval: z.enum(RECURRING_INTERVALS).meta({
      description: "P7D, P14D, P1M, P2M, P3M (vierteljährlich), P6M, P1Y, P2Y … P5Y",
      example: "P1M",
    }),
    first_date: isoDate.meta({ description: "Erste Rechnung (Ankertag für monatsbasierte Intervalle)" }),
    end_date: isoDate.optional().meta({ description: "Letzte Rechnung spätestens an diesem Tag" }),
    max_count: z.number().int().min(1).max(1000).optional().meta({ description: "Ende nach N Rechnungen" }),
    billing: z.enum(BILLING_MODES).default("in_advance").meta({ description: "Abrechnung im Voraus oder nachträglich" }),
    period_text: z.boolean().default(true).meta({ description: "Zeitraumtext im Kopftext" }),
  })
  .strict()
  .meta({ id: "RecurringSchedule" });

export const recurringAutomationWire = z
  .object({
    finalize: z.boolean().meta({
      description:
        "Automatisch fertigstellen (braucht invoices:finalize; wirkt erst nach einmaliger Bestätigung in der App). Versendet wird nie.",
    }),
  })
  .strict()
  .meta({ id: "RecurringAutomation" });

const draftFields = {
  contract_reference: str(1000).optional().meta({ description: "BT-12 Vertragsreferenz (Standard: Vorlagenname)" }),
  price_mode: z.enum(["net", "gross"]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  language: z.enum(["de", "en"]).optional(),
  subject: str(5000).optional(),
  head_text: str(100_000).optional().meta({ description: "Platzhalter {{recurring.periodText}} möglich" }),
  foot_text: str(100_000).optional(),
  buyer_reference: str(1000).optional(),
  order_reference: str(1000).optional(),
  payment_terms: z
    .object({
      due_days: z.number().int().min(0).max(3650),
      skonto_percent: decimalString(2, "Skonto in Prozent", "2").optional(),
      skonto_days: z.number().int().min(0).max(3650).optional(),
    })
    .optional(),
  internal_note: str(10_000).optional(),
};

export const recurringCreateWire = z
  .object({
    name: str(200).min(1),
    contact_id: str(80).meta({ description: "con_…" }),
    ...draftFields,
    lines: z.array(documentLineWire).min(1).max(2500),
    schedule: recurringScheduleWire,
    automation: recurringAutomationWire.default({ finalize: false }),
  })
  .strict()
  .meta({ id: "RecurringInvoiceCreate" });
export type RecurringCreateWire = z.infer<typeof recurringCreateWire>;

export const recurringPatchWire = z
  .object({
    name: str(200).min(1).optional(),
    contact_id: str(80).optional(),
    ...draftFields,
    lines: z.array(documentLineWire).min(1).max(2500).optional().meta({ description: "Ersetzt alle Positionen" }),
    schedule: recurringScheduleWire.optional(),
    automation: recurringAutomationWire.optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict()
  .meta({ id: "RecurringInvoicePatch" });
export type RecurringPatchWire = z.infer<typeof recurringPatchWire>;

export const resumeWire = z
  .object({ catch_up: z.boolean().meta({ description: "true = nachberechnen, false = überspringen (protokolliert)" }) })
  .strict()
  .meta({ id: "RecurringResume" });

/** Wire (create, or a patch merged onto the stored template) → the shared template values. */
export function wireToTemplate(
  w: Omit<RecurringPatchWire, "lines" | "version"> & { lines: DraftValues["lines"] },
  defaults: DraftDefaults,
  base?: RecurringTemplateValues,
): { values: RecurringTemplateValues; issues: WireIssue[] } {
  const baseDraft = base ? ({ ...base.draft, supplyDateMode: "explicit" } as unknown as DraftValues) : undefined;
  const { contract_reference, name, schedule, automation, ...docFields } = w;
  const { values: draftValues, issues } = wireToDraft(
    docFields as unknown as Omit<DocumentCreateWire, "lines"> & { lines: DraftValues["lines"] },
    "invoice",
    defaults,
    baseDraft,
  );
  const {
    documentDate: _d,
    supplyDate: _s,
    supplyDateMode: _m,
    backdateReason: _b,
    chainOrder: _c,
    validUntil: _v,
    deliveryTerms: _t,
    showPrices: _p,
    ...draft
  } = draftValues;
  const sched = schedule
    ? {
        interval: schedule.interval,
        firstDate: schedule.first_date,
        ...(schedule.end_date ? { endDate: schedule.end_date } : {}),
        ...(schedule.max_count !== undefined ? { maxCount: schedule.max_count } : {}),
        billing: schedule.billing,
        periodTextEnabled: schedule.period_text,
      }
    : base?.schedule;
  if (!sched) issues.push({ field: "schedule", message: "Bitte einen Zeitplan angeben." });
  const contractReference = contract_reference !== undefined ? contract_reference : base?.contractReference;
  return {
    values: {
      name: name ?? base?.name ?? "",
      ...(contractReference ? { contractReference } : {}),
      draft: { ...(draft as TemplateDraft), type: "invoice" },
      schedule: sched as RecurringTemplateValues["schedule"],
      automation: automation ?? base?.automation ?? { finalize: false },
    },
    issues,
  };
}

// ── template → wire ──────────────────────────────────────────────────────────────────────────────────────

export interface TemplateRecord {
  _id: string;
  name: string;
  contactId: string | null;
  contactName: string | null;
  contractReference: string | null;
  state: "active" | "paused" | "ended" | "archived";
  schedule: {
    interval: string;
    firstDate: string;
    nextDate: string;
    endDate?: string;
    maxCount?: number;
    billing: string;
    periodTextEnabled: boolean;
  };
  nextDate: string | null;
  amount: { netCents: number; grossCents: number; currency: string } | null;
  automation: { finalize: boolean };
  automationConfirmed: boolean;
  automationEffective: boolean;
  generatedCount: number;
  skippedOccurrences: string[];
  version: number;
  draft?: TemplateDraft;
  documents?: { _id: string; type: string; number: string | null; status: string; occurrence: string | null }[];
}

const dec = (v: number | undefined, scale: number) => (v === undefined ? null : scaledToDecimal(v, scale));

export function serializeTemplate(t: TemplateRecord) {
  return {
    id: encodeId("recurringTemplates", t._id),
    name: t.name,
    state: t.state,
    contact_id: t.contactId ? encodeId("contacts", t.contactId) : null,
    contact_name: t.contactName,
    contract_reference: t.contractReference,
    schedule: {
      interval: t.schedule.interval,
      first_date: t.schedule.firstDate,
      next_date: t.nextDate,
      end_date: t.schedule.endDate ?? null,
      max_count: t.schedule.maxCount ?? null,
      billing: t.schedule.billing,
      period_text: t.schedule.periodTextEnabled,
    },
    automation: {
      finalize: t.automation.finalize,
      confirmed: t.automationConfirmed,
      effective: t.automationEffective,
    },
    generated_count: t.generatedCount,
    skipped_occurrences: t.skippedOccurrences,
    amount: t.amount
      ? { net_cents: t.amount.netCents, gross_cents: t.amount.grossCents, currency: t.amount.currency }
      : null,
    ...(t.draft
      ? {
          lines: t.draft.lines.map((l) => ({
            kind: l.kind,
            name: l.name ?? null,
            description: l.description ?? null,
            quantity: dec(l.quantityMilli, 3),
            unit_code: l.unitCode ?? null,
            unit_price: dec(l.unitPriceMicros, 4),
            vat_rate_key: l.vatRateKey ?? null,
          })),
          price_mode: t.draft.priceMode,
          currency: t.draft.currency,
          language: t.draft.language,
          head_text: t.draft.headText ?? null,
          foot_text: t.draft.footText ?? null,
          payment_terms: { due_days: t.draft.paymentTerms.dueDays },
        }
      : {}),
    ...(t.documents
      ? {
          documents: t.documents.map((d) => ({
            id: encodeDocumentId(d.type as SalesDocType, d._id),
            number: d.number,
            status: d.status,
            occurrence: d.occurrence,
          })),
        }
      : {}),
    version: t.version,
  };
}

const recurringLineOut = z.object({
  kind: z.string(),
  name: z.string().nullable(),
  description: z.string().nullable(),
  quantity: z.string().nullable(),
  unit_code: z.string().nullable(),
  unit_price: z.string().nullable(),
  vat_rate_key: z.string().nullable(),
});

export const recurringOut = z
  .object({
    id: z.string().meta({ example: "rec_k57f3x2m9q8w1e4r6t" }),
    name: z.string(),
    state: z.enum(["active", "paused", "ended", "archived"]),
    contact_id: z.string().nullable(),
    contact_name: z.string().nullable(),
    contract_reference: z.string().nullable(),
    schedule: z.object({
      interval: z.string(),
      first_date: z.string(),
      next_date: z.string().nullable(),
      end_date: z.string().nullable(),
      max_count: z.number().nullable(),
      billing: z.string(),
      period_text: z.boolean(),
    }),
    automation: z.object({ finalize: z.boolean(), confirmed: z.boolean(), effective: z.boolean() }),
    generated_count: z.number(),
    skipped_occurrences: z.array(z.string()),
    amount: z.object({ net_cents: z.number(), gross_cents: z.number(), currency: z.string() }).nullable(),
    lines: z.array(recurringLineOut).optional(),
    price_mode: z.string().optional(),
    currency: z.string().optional(),
    language: z.string().optional(),
    head_text: z.string().nullable().optional(),
    foot_text: z.string().nullable().optional(),
    payment_terms: z.object({ due_days: z.number() }).optional(),
    documents: z
      .array(z.object({ id: z.string(), number: z.string().nullable(), status: z.string(), occurrence: z.string().nullable() }))
      .optional(),
    version: z.number(),
  })
  .meta({ id: "RecurringInvoice" });

export const recurringList = listEnvelope(recurringOut, "RecurringInvoiceList");

export interface OccurrenceRecord {
  date: string;
  period: { from: string; to: string };
  netCents: number | null;
  grossCents: number | null;
  currency: string;
  rates: { category: string; rateBp: number }[];
  decision: string | null;
  hints: string[];
  blocking: string | null;
}

export const serializeOccurrence = (o: OccurrenceRecord) => ({
  date: o.date,
  period: { from: o.period.from, to: o.period.to },
  net_cents: o.netCents,
  gross_cents: o.grossCents,
  currency: o.currency,
  rates: o.rates.map((r) => ({ category: r.category, rate_bp: r.rateBp })),
  einvoice_decision: o.decision,
  hints: o.hints,
  blocking: o.blocking,
});

export const occurrencesOut = z
  .object({
    data: z.array(
      z.object({
        date: z.string(),
        period: z.object({ from: z.string(), to: z.string() }),
        net_cents: z.number().nullable(),
        gross_cents: z.number().nullable(),
        currency: z.string(),
        rates: z.array(z.object({ category: z.string(), rate_bp: z.number() })),
        einvoice_decision: z.string().nullable().meta({ description: "ER-03-Entscheidung am Termin" }),
        hints: z.array(z.string()),
        blocking: z.string().nullable().meta({ description: "Erster blockierender Fehler (Entwurf statt Automatik)" }),
      }),
    ),
  })
  .meta({ id: "RecurringOccurrences" });

export const runNowOut = z
  .object({
    created: z.number(),
    finalized: z.number(),
    documents: z.array(z.string()).meta({ description: "IDs der erzeugten Rechnungen (inv_…)" }),
  })
  .meta({ id: "RecurringRunNow" });
