import { z } from "zod";
import type {} from "zod-openapi";
import { encodeId, encodeOptionalId } from "../../api/ids";
import type { PolicyValues, reminderCreateSchema } from "../dunning";
import { instant, isoDate, toOptionalInstant } from "./common";

/**
 * Wire shapes of the F05 dunning endpoints (05 §4.4, F05 §7.1) and the MCP tools `dunning_preview`, ⚠ `dunning_run`
 * and `reminder_create` (06 §3.5). Reminders are sales documents (`rem_…`) with their own claim block; the app never
 * sends them — they are exported and marked sent like every document.
 */

const cents = z.number().int().meta({ description: "Cent" });

// ── reminders ───────────────────────────────────────────────────────────────────────────────────────────────────

export const reminderOut = z
  .object({
    id: z.string().meta({ description: "Mahnungs-ID (rem_…)" }),
    number: z.string().nullable().meta({ description: "Nummer (MA-…); null im Entwurf" }),
    status: z.enum(["draft", "finalized", "sent", "cancelled"]).meta({
      description:
        "draft, finalized (fertiggestellt, noch nicht als versendet markiert), sent, cancelled (gegenstandslos)",
    }),
    level: z.number().int(),
    title: z.string(),
    invoice_id: z.string().nullable().meta({ description: "Gemahnte Rechnung (inv_…)" }),
    invoice_number: z.string().nullable(),
    contact_id: z.string().nullable(),
    contact_name: z.string().nullable(),
    document_date: isoDate.nullable(),
    open_amount_cents: cents,
    fee_cents: cents,
    interest_cents: cents,
    flat_fee_40_cents: cents.meta({ description: "Verzugspauschale § 288 Abs. 5 BGB (nur B2B, einmal je Rechnung)" }),
    total_cents: cents,
    new_due_date: isoDate.nullable().meta({ description: "Neue Zahlungsfrist (§ 193 BGB auf Werktag verschoben)" }),
    default_start_date: isoDate.nullable().meta({ description: "Verzugsbeginn, falls bereits im Verzug" }),
    created_by_run: z.boolean(),
    finalized_at: instant.nullable(),
    sent_on: isoDate.nullable(),
    zugang: isoDate.nullable().meta({ description: "Zugang beim Kunden (aus der Markierung oder manuell)" }),
    artifact_status: z.string().nullable(),
    cancellation_reason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "Reminder" });

export type ReminderOut = z.infer<typeof reminderOut>;

/** Structural input (convex/dunning.ts `reminderView`), kept local so the domain layer never imports Convex. */
export interface ReminderViewLike {
  id: string;
  number: string | null;
  status: string;
  level: number;
  title: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  contactId: string | null;
  contactName: string | null;
  documentDate: string | null;
  openAmountCents: number;
  feeCents: number;
  interestCents: number;
  flatFee40Cents: number;
  totalCents: number;
  newDueDate: string | null;
  defaultStartDate: string | null;
  createdByRun: boolean;
  finalizedAt: number | null;
  sentOn: string | null;
  zugang: { date: string } | null;
  artifactStatus: string | null;
  cancellation: { reason?: string } | null;
  version: number;
}

export function serializeReminder(r: ReminderViewLike): ReminderOut {
  return {
    id: encodeId("reminders", r.id),
    number: r.number,
    status: r.status as ReminderOut["status"],
    level: r.level,
    title: r.title,
    invoice_id: encodeOptionalId("invoices", r.invoiceId),
    invoice_number: r.invoiceNumber,
    contact_id: encodeOptionalId("contacts", r.contactId),
    contact_name: r.contactName,
    document_date: r.documentDate,
    open_amount_cents: r.openAmountCents,
    fee_cents: r.feeCents,
    interest_cents: r.interestCents,
    flat_fee_40_cents: r.flatFee40Cents,
    total_cents: r.totalCents,
    new_due_date: r.newDueDate,
    default_start_date: r.defaultStartDate,
    created_by_run: r.createdByRun,
    finalized_at: toOptionalInstant(r.finalizedAt),
    sent_on: r.sentOn,
    zugang: r.zugang?.date ?? null,
    artifact_status: r.artifactStatus,
    cancellation_reason: r.cancellation?.reason ?? null,
    version: r.version,
  };
}

export const reminderCreateWire = z
  .object({
    level: z.number().int().min(1).max(20).optional().meta({ description: "Mahnstufe (Standard: nächste Stufe)" }),
    fee_cents: z.number().int().min(0).max(100_000_000).optional().meta({ description: "Mahngebühr (überschreibt)" }),
    interest_cents: z
      .number()
      .int()
      .min(0)
      .max(100_000_000)
      .optional()
      .meta({ description: "Verzugszinsen (überschreibt; Abweichung braucht interest_reason)" }),
    interest_reason: z.string().max(500).optional(),
    include_flat_fee: z.boolean().optional().meta({ description: "Verzugspauschale 40 € (nur B2B im Verzug)" }),
    new_due_date: isoDate.optional(),
    head_text: z.string().max(20_000).optional(),
    foot_text: z.string().max(20_000).optional(),
    acknowledge_warnings: z.array(z.string().max(60)).max(20).optional(),
    finalize: z
      .boolean()
      .optional()
      .meta({ description: "true = sofort fertigstellen (braucht zusätzlich invoices:finalize)" }),
  })
  .strict()
  .meta({ id: "ReminderCreateRequest" });

export type ReminderCreateWire = z.infer<typeof reminderCreateWire>;

/** Wire → `reminderCreateSchema` values (src/domain/schemas/dunning.ts). */
export function reminderCreateValues(w: Omit<ReminderCreateWire, "finalize">): z.input<typeof reminderCreateSchema> {
  return {
    ...(w.level !== undefined ? { level: w.level } : {}),
    ...(w.fee_cents !== undefined ? { feeCents: w.fee_cents } : {}),
    ...(w.interest_cents !== undefined ? { interestCents: w.interest_cents } : {}),
    ...(w.interest_reason ? { interestReason: w.interest_reason } : {}),
    ...(w.include_flat_fee !== undefined ? { includeFlatFee: w.include_flat_fee } : {}),
    ...(w.new_due_date ? { newDueDate: w.new_due_date } : {}),
    ...(w.head_text !== undefined ? { headText: w.head_text } : {}),
    ...(w.foot_text !== undefined ? { footText: w.foot_text } : {}),
    ...(w.acknowledge_warnings ? { acknowledgeWarnings: w.acknowledge_warnings } : {}),
  };
}

export const reminderFinalizeWire = z
  .object({
    version: z.number().int().min(1).optional(),
    acknowledge_warnings: z.array(z.string().max(60)).max(20).optional(),
  })
  .strict()
  .meta({ id: "ReminderFinalizeRequest" });

export const reminderWithdrawWire = z
  .object({
    reason: z.string().max(1000).meta({ description: "Grund (mindestens 5 Zeichen)" }),
    void_notice: z.boolean().optional().meta({ description: "Hinweisschreiben an den Kunden (noch nicht verfügbar)" }),
  })
  .strict()
  .meta({ id: "ReminderWithdrawRequest" });

export const zugangWire = z
  .object({ date: isoDate, reason: z.string().max(1000).meta({ description: "Begründung (mindestens 5 Zeichen)" }) })
  .strict()
  .meta({ id: "DunningZugangOverrideRequest" });

export const caseActionWire = z
  .object({
    action: z.enum(["pause", "resume", "dispute", "block", "unblock", "hand_over"]),
    reason: z.string().max(1000).optional(),
    until: isoDate.optional().meta({ description: "pause: bis wann (Standard laut Richtlinie)" }),
    partner: z.string().max(200).optional().meta({ description: "hand_over: Inkasso/Anwalt" }),
    acknowledge_warnings: z.array(z.string().max(60)).max(10).optional(),
  })
  .strict()
  .meta({ id: "DunningCaseActionRequest" });

export function caseActionValues(w: z.infer<typeof caseActionWire>) {
  return {
    action: w.action,
    ...(w.reason ? { reason: w.reason } : {}),
    ...(w.until ? { until: w.until } : {}),
    ...(w.partner ? { partner: w.partner } : {}),
    ...(w.acknowledge_warnings ? { acknowledgeWarnings: w.acknowledge_warnings } : {}),
  };
}

// ── export / mark sent (05 §4.3 bodies) ─────────────────────────────────────────────────────────────────────────

export const reminderExportWire = z
  .object({
    original: z.boolean().optional().meta({ description: "Original erneut exportieren (nach der Markierung)" }),
    reason: z.string().max(2000).optional().meta({ description: "Pflicht bei original nach der Markierung" }),
  })
  .strict()
  .meta({ id: "ReminderExportRequest" });

export const exportOut = z
  .object({
    files: z.array(
      z.object({
        artifact_id: z.string().meta({ description: "art_…" }),
        name: z.string(),
        url: z.string().meta({ description: "Kurzlebiger Link (nur im Tailnet erreichbar)" }),
        sha256: z.string(),
        mime: z.string(),
      }),
    ),
  })
  .meta({ id: "ReminderExportResult" });

export const markSentWire = z
  .object({
    sent_on: isoDate,
    channel: z.enum(["email_manual", "post", "hand", "upload_portal", "other"]),
    note: z.string().max(2000).optional(),
    artifacts: z.array(z.string().max(80)).max(50).meta({ description: "Versendete Dateien (art_…)" }),
  })
  .strict()
  .meta({ id: "ReminderMarkSentRequest" });

export const markSentOut = z
  .object({
    send_log_id: z.string().meta({ description: "snd_…" }),
    first_effective: z.boolean(),
    warnings: z.array(z.string()),
  })
  .meta({ id: "ReminderMarkSentResult" });

export const retractWire = z
  .object({ reason: z.string().max(2000) })
  .strict()
  .meta({ id: "ReminderMarkSentRetractRequest" });

// ── preview / run ───────────────────────────────────────────────────────────────────────────────────────────────

const claimOut = z.object({
  title: z.string(),
  open_amount_cents: cents,
  fee_cents: cents,
  interest_cents: cents,
  flat_fee_40_cents: cents,
  flat_fee_already_claimed: z.boolean(),
  total_cents: cents,
  new_due_date: isoDate,
  in_default: z.boolean(),
  default_start_date: isoDate.nullable(),
});

export const dunningActionOut = z.object({
  invoice_id: z.string(),
  invoice_number: z.string(),
  contact_name: z.string(),
  kind: z.enum(["create_draft", "finalize", "todo_mark_sent", "skip"]),
  level: z.number().int().nullable(),
  earliest_date: isoDate.nullable().meta({ description: "Frühestens am (DUN-054); null ohne bekanntes Datum" }),
  reason: z.string().nullable().meta({ description: "Grund beim Überspringen (z. B. not_marked_sent, disputed)" }),
  label: z.string(),
  detail: z.string().nullable(),
  claim: claimOut.nullable(),
  notes: z.array(z.string()),
});

export const dunningPreviewOut = z
  .object({
    date: isoDate,
    bank_data_current: z.boolean(),
    bank_data_note: z.string().nullable(),
    actions: z.array(dunningActionOut),
    summary: z.object({ drafts: z.number().int(), finalize: z.number().int(), skipped: z.number().int() }),
    confirm_token: z.string().nullable().meta({
      description: "Für POST /dunning/run (bindet genau diesen Plan); null bei einem anderen Datum als heute",
    }),
  })
  .meta({ id: "DunningPreview" });

export interface PreviewLike {
  date: string;
  digest: string;
  bankDataCurrent: boolean;
  bankDataNote: string | null;
  actions: readonly {
    invoiceId: string;
    number: string;
    contactName: string;
    kind: string;
    level: number | null;
    earliestDate?: string | null;
    reason: string | null;
    reasonLabel: string;
    detail: string | null;
    claim: {
      title: string;
      openAmountCents: number;
      feeCents: number;
      interestCents: number;
      flatFee40Cents: number;
      flatFeeAlreadyClaimed: boolean;
      totalCents: number;
      newDueDate: string;
      inDefault: boolean;
      defaultStartDate: string | null;
    } | null;
    notes: readonly string[];
  }[];
}

export function serializeDunningPreview(p: PreviewLike, today: string): z.infer<typeof dunningPreviewOut> {
  const actions = p.actions.map((a) => ({
    invoice_id: encodeId("invoices", a.invoiceId),
    invoice_number: a.number,
    contact_name: a.contactName,
    kind: a.kind as z.infer<typeof dunningActionOut>["kind"],
    level: a.level,
    earliest_date: a.earliestDate ?? null,
    reason: a.reason,
    label: a.reasonLabel,
    detail: a.detail,
    claim: a.claim
      ? {
          title: a.claim.title,
          open_amount_cents: a.claim.openAmountCents,
          fee_cents: a.claim.feeCents,
          interest_cents: a.claim.interestCents,
          flat_fee_40_cents: a.claim.flatFee40Cents,
          flat_fee_already_claimed: a.claim.flatFeeAlreadyClaimed,
          total_cents: a.claim.totalCents,
          new_due_date: a.claim.newDueDate,
          in_default: a.claim.inDefault,
          default_start_date: a.claim.defaultStartDate,
        }
      : null,
    notes: [...a.notes],
  }));
  return {
    date: p.date,
    bank_data_current: p.bankDataCurrent,
    bank_data_note: p.bankDataNote,
    actions,
    summary: {
      drafts: actions.filter((a) => a.kind === "create_draft").length,
      finalize: actions.filter((a) => a.kind === "finalize").length,
      skipped: actions.filter((a) => a.kind === "skip").length,
    },
    // The run always evaluates today (Europe/Berlin): a plan for another date can be shown, never confirmed.
    confirm_token: p.date === today ? p.digest : null,
  };
}

export const dunningRunWire = z
  .object({
    mode: z.enum(["drafts", "finalize"]).meta({
      description: "drafts = nur Entwürfe; finalize = laut Richtlinie fertigstellen (braucht invoices:finalize)",
    }),
    invoice_ids: z.array(z.string().max(80)).max(500).optional().meta({ description: "Nur diese Rechnungen (inv_…)" }),
    dry_run: z.boolean().optional().meta({ description: "true = nur die Vorschau (schreibt nichts)" }),
    confirm_token: z
      .string()
      .max(200)
      .optional()
      .meta({ description: "confirm_token aus GET /dunning/preview mit denselben invoice_ids (Pflicht ohne dry_run)" }),
  })
  .strict()
  .meta({ id: "DunningRunRequest" });

export const dunningRunOut = z
  .object({
    run_id: z.string().meta({ description: "drn_…" }),
    evaluated: z.number().int(),
    drafts: z.number().int(),
    finalized_ids: z
      .array(z.string())
      .meta({ description: "Fertiggestellte Mahnungen (rem_…) – exportieren und als versendet markieren" }),
    todos: z.number().int(),
    skipped: z.number().int(),
    errors: z.number().int(),
  })
  .meta({ id: "DunningRunResult" });

export function serializeRunResult(r: {
  runId: string;
  evaluated: number;
  drafts: number;
  finalized: readonly string[];
  todos: number;
  skipped: number;
  errors: number;
}): z.infer<typeof dunningRunOut> {
  return {
    run_id: encodeId("dunningRuns", r.runId),
    evaluated: r.evaluated,
    drafts: r.drafts,
    finalized_ids: r.finalized.map((id) => encodeId("reminders", id)),
    todos: r.todos,
    skipped: r.skipped,
    errors: r.errors,
  };
}

// ── interest calculator (DUN-022) ───────────────────────────────────────────────────────────────────────────────

export const interestQueryWire = z.object({
  amount_cents: z.coerce.number().int().min(1).max(10_000_000_000),
  from: isoDate.meta({ description: "Erster Verzugstag" }),
  to: isoDate.meta({ description: "Letzter Zinstag (inklusive)" }),
  margin: z
    .string()
    .regex(/^(b2b|b2c|-?\d{1,4})$/)
    .default("b2b")
    .meta({ description: "b2b (+9 Prozentpunkte), b2c (+5) oder Aufschlag in Basispunkten" }),
});

export function interestValues(q: z.infer<typeof interestQueryWire>) {
  return {
    amountCents: q.amount_cents,
    from: q.from,
    to: q.to,
    margin: q.margin === "b2b" || q.margin === "b2c" ? q.margin : Number(q.margin),
  };
}

export const interestOut = z
  .object({
    total_cents: cents,
    segments: z.array(
      z.object({
        from: isoDate,
        to: isoDate,
        days: z.number().int(),
        principal_cents: cents,
        rate_bp: z.number().int().meta({ description: "Zinssatz p. a. in Basispunkten" }),
        amount_cents: cents,
      }),
    ),
    printable: z.boolean().meta({ description: "false = unter 0,01 € (keine Zinszeile auf der Mahnung)" }),
  })
  .meta({ id: "DunningInterestCalculation" });

export function serializeInterest(r: {
  totalCents: number;
  segments: readonly {
    from: string;
    to: string;
    days: number;
    principalCents: number;
    rateBp: number;
    amountCents: number;
  }[];
  printable: boolean;
}): z.infer<typeof interestOut> {
  return {
    total_cents: r.totalCents,
    segments: r.segments.map((s) => ({
      from: s.from,
      to: s.to,
      days: s.days,
      principal_cents: s.principalCents,
      rate_bp: s.rateBp,
      amount_cents: s.amountCents,
    })),
    printable: r.printable,
  };
}

// ── policies (DUN-001) ──────────────────────────────────────────────────────────────────────────────────────────

const stepWire = z.object({
  level: z.number().int().min(1).max(20),
  days_after: z.number().int().min(0).max(3650).meta({ description: "Tage nach Fälligkeit bzw. Frist der Vorstufe" }),
  title: z.string().min(1).max(80),
  fee_cents: z.number().int().min(0).max(100_000_000),
  add_interest: z.boolean(),
  add_flat_fee_40: z.boolean(),
  new_due_days: z.number().int().min(1).max(365),
  auto_finalize: z.boolean().meta({ description: "Im täglichen Lauf fertigstellen (nie versenden)" }),
});

export const policyWire = z
  .object({
    name: z.string().min(1).max(80),
    is_default: z.boolean(),
    applies_to: z.object({ consumer: z.boolean(), business: z.boolean() }),
    steps: z.array(stepWire).min(1).max(20),
    due_soon_days: z.number().int().min(0).max(3650).optional(),
    due_soon_todo: z.boolean(),
    min_open_amount_cents: z.number().int().min(0).max(100_000_000),
    pause_on_partial_payment_days: z.number().int().min(0).max(3650),
    stop_after_last_level: z.boolean(),
  })
  .strict()
  .meta({ id: "DunningPolicyRequest" });

export const policyPatchWire = policyWire
  .extend({ version: z.number().int().min(1).optional() })
  .meta({ id: "DunningPolicyUpdateRequest" });

export function policyValues(w: z.infer<typeof policyWire>): PolicyValues {
  return {
    name: w.name,
    isDefault: w.is_default,
    appliesTo: w.applies_to,
    steps: w.steps.map((s) => ({
      level: s.level,
      daysAfter: s.days_after,
      title: s.title,
      feeCents: s.fee_cents,
      addInterest: s.add_interest,
      addFlatFee40: s.add_flat_fee_40,
      newDueDays: s.new_due_days,
      autoFinalize: s.auto_finalize,
    })),
    ...(w.due_soon_days !== undefined ? { dueSoonDays: w.due_soon_days } : {}),
    dueSoonTodo: w.due_soon_todo,
    minOpenAmountCents: w.min_open_amount_cents,
    pauseOnPartialPaymentDays: w.pause_on_partial_payment_days,
    stopAfterLastLevel: w.stop_after_last_level,
  };
}

export const policyOut = policyWire
  .extend({
    id: z.string().nullable().meta({ description: "dpo_…; null für die noch nicht gespeicherten Standardrichtlinien" }),
    seeded: z.boolean(),
    version: z.number().int(),
    warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  })
  .meta({ id: "DunningPolicy" });

export interface PolicyLike extends PolicyValues {
  id: string;
  seeded: boolean;
  version: number;
  warnings?: readonly { code: string; message: string }[];
}

export function serializePolicy(p: PolicyLike): z.infer<typeof policyOut> {
  return {
    id: p.seeded ? null : encodeId("dunningPolicies", p.id),
    seeded: p.seeded,
    version: p.version,
    name: p.name,
    is_default: p.isDefault,
    applies_to: p.appliesTo,
    steps: p.steps.map((s) => ({
      level: s.level,
      days_after: s.daysAfter,
      title: s.title,
      fee_cents: s.feeCents,
      add_interest: s.addInterest,
      add_flat_fee_40: s.addFlatFee40,
      new_due_days: s.newDueDays,
      auto_finalize: s.autoFinalize,
    })),
    ...(p.dueSoonDays !== undefined ? { due_soon_days: p.dueSoonDays } : {}),
    due_soon_todo: p.dueSoonTodo,
    min_open_amount_cents: p.minOpenAmountCents,
    pause_on_partial_payment_days: p.pauseOnPartialPaymentDays,
    stop_after_last_level: p.stopAfterLastLevel,
    warnings: (p.warnings ?? []).map((w) => ({ code: w.code, message: w.message })),
  };
}
