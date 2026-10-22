import { z } from "zod";
import type {} from "zod-openapi";
import { encodeId } from "../../api/ids";
import type { AccountLedger, BwaRow, Susa, SusaTotals } from "../../reports/ledger-reports";
import type { ReportMeta } from "../../reports/meta";
import type { OposReport, OposSide } from "../../reports/opos";
import type { Aveuer, EuerSheet } from "../../tax/euer";
import { isoDate, toInstant } from "./common";

/**
 * Wire schemas of the read-only F08 reports over REST (05 §4.7 `GET /reports/{euer,bwa,susa,open-items}`) and the
 * F09 EXP-020 Kennzahlen sheet downloads. The values are F08's (Convex `reports.*`, `taxes.euer`,
 * `kennzahlenNode.download`); this module only maps them to the wire: snake_case, `*_cents` integers, ISO dates,
 * RFC 3339 instants and prefixed ids (05 §3). No report logic lives here (CLAUDE.md rule 5).
 */

const cents = (description: string) => z.number().int().meta({ description });
const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Monat im Format JJJJ-MM.")
  .meta({ description: "Monat (YYYY-MM)", example: "2026-09" });
const year = z.coerce.number().int().min(2000).max(2100).meta({ description: "Kalenderjahr", example: 2026 });
const boolString = z.enum(["true", "false"]);

// ── meta ─────────────────────────────────────────────────────────────────────────────────────────────
export const reportMetaOut = z
  .object({
    report: z.string(),
    params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    generated_at: z.string().meta({ description: "Erzeugt am (RFC 3339)" }),
    rule_versions: z.array(z.string()),
    months: z.array(z.string()),
    locked_months: z.array(z.string()),
    provisional: z.boolean().meta({ description: "„vorläufig“: nicht alle Monate festgeschrieben" }),
    notice: z.string().nullable(),
  })
  .meta({ id: "ReportMeta" });

export function serializeMeta(m: ReportMeta): z.infer<typeof reportMetaOut> {
  return {
    report: m.report,
    params: m.params,
    generated_at: toInstant(m.generatedAt),
    rule_versions: m.ruleVersions,
    months: m.months,
    locked_months: m.lockedMonths,
    provisional: m.provisional,
    notice: m.notice,
  };
}

// ── SuSa (RPT-004) ───────────────────────────────────────────────────────────────────────────────────
export const susaQuery = z
  .object({
    from: isoDate,
    to: isoDate,
    account_class: z.string().regex(/^\d$/).optional().meta({ description: "Kontenklasse 0–9" }),
    include_personal: boolString.optional().meta({ description: "Personenkonten einzeln (Standard: false)" }),
  })
  .strict();

export function susaArgs(q: z.infer<typeof susaQuery>) {
  return {
    from: q.from,
    to: q.to,
    ...(q.account_class !== undefined ? { accountClass: q.account_class } : {}),
    ...(q.include_personal !== undefined ? { includePersonal: q.include_personal === "true" } : {}),
  };
}

const totalsShape = {
  opening_cents: cents("EB-Wert"),
  period_debit_cents: cents("Soll im Zeitraum"),
  period_credit_cents: cents("Haben im Zeitraum"),
  ytd_debit_cents: cents("Soll kumuliert (Wirtschaftsjahr)"),
  ytd_credit_cents: cents("Haben kumuliert (Wirtschaftsjahr)"),
  balance_cents: cents("Saldo (positiv = Soll)"),
};
const totalsOf = (t: SusaTotals) => ({
  opening_cents: t.openingCents,
  period_debit_cents: t.periodDebitCents,
  period_credit_cents: t.periodCreditCents,
  ytd_debit_cents: t.ytdDebitCents,
  ytd_credit_cents: t.ytdCreditCents,
  balance_cents: t.balanceCents,
});

export const susaOut = z
  .object({
    meta: reportMetaOut,
    currency: z.literal("EUR"),
    from: z.string(),
    to: z.string(),
    fiscal_year_start: z.string(),
    balanced: z.boolean().meta({ description: "Σ Soll = Σ Haben" }),
    rows: z.array(z.object({ account: z.string(), name: z.string(), account_class: z.string(), ...totalsShape })),
    classes: z.array(z.object({ account_class: z.string(), ...totalsShape })),
    totals: z.object(totalsShape),
  })
  .meta({ id: "SusaReport" });

export function serializeSusa(r: Susa & { meta: ReportMeta }): z.infer<typeof susaOut> {
  return {
    meta: serializeMeta(r.meta),
    currency: "EUR",
    from: r.from,
    to: r.to,
    fiscal_year_start: r.fiscalYearStart,
    balanced: r.balanced,
    rows: r.rows.map((x) => ({ account: x.account, name: x.name, account_class: x.accountClass, ...totalsOf(x) })),
    classes: r.classes.map((c) => ({ account_class: c.accountClass, ...totalsOf(c) })),
    totals: totalsOf(r.totals),
  };
}

// ── Kontenblatt (RPT-003) ────────────────────────────────────────────────────────────────────────────
export const ledgerQuery = z
  .object({ account: z.string().regex(/^\d{4,9}$/, "Kontonummer (4–9 Ziffern)."), from: isoDate, to: isoDate })
  .strict();

export const ledgerOut = z
  .object({
    meta: reportMetaOut,
    currency: z.literal("EUR"),
    account: z.string(),
    name: z.string(),
    from: z.string(),
    to: z.string(),
    opening_cents: cents("Anfangssaldo"),
    debit_cents: cents("Soll im Zeitraum"),
    credit_cents: cents("Haben im Zeitraum"),
    closing_cents: cents("Endsaldo"),
    rows: z.array(
      z.object({
        seq: z.number().int(),
        date: z.string(),
        belegfeld1: z.string(),
        text: z.string(),
        contra: z.string(),
        debit_cents: z.number().int(),
        credit_cents: z.number().int(),
        balance_cents: z.number().int(),
        source_kind: z.string(),
      }),
    ),
  })
  .meta({ id: "LedgerReport" });

export function serializeLedger(r: AccountLedger & { meta: ReportMeta }): z.infer<typeof ledgerOut> {
  return {
    meta: serializeMeta(r.meta),
    currency: "EUR",
    account: r.account,
    name: r.name,
    from: r.from,
    to: r.to,
    opening_cents: r.openingCents,
    debit_cents: r.debitCents,
    credit_cents: r.creditCents,
    closing_cents: r.closingCents,
    rows: r.rows.map((x) => ({
      seq: x.seq,
      date: x.date,
      belegfeld1: x.belegfeld1,
      text: x.text,
      contra: x.contra,
      debit_cents: x.debitCents,
      credit_cents: x.creditCents,
      balance_cents: x.balanceCents,
      source_kind: x.sourceKind,
    })),
  };
}

// ── BWA (RPT-005) ────────────────────────────────────────────────────────────────────────────────────
export const bwaQuery = z
  .object({
    month,
    variant: z.enum(["accrual", "cash"]).default("accrual").meta({ description: "accrual (Soll) oder cash (Ist)" }),
    cost_center_id: z.string().max(100).optional().meta({ description: "Kostenstelle (cc_…)" }),
  })
  .strict();

export const bwaOut = z
  .object({
    meta: reportMetaOut,
    currency: z.literal("EUR"),
    month: z.string(),
    variant: z.enum(["accrual", "cash"]),
    ytd_from: z.string(),
    rows: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        sum: z.boolean(),
        month_cents: z.number().int(),
        ytd_cents: z.number().int(),
        prior_ytd_cents: z.number().int(),
        ytd_share_bp: z.number().int().nullable().meta({ description: "Anteil an der Gesamtleistung (Basispunkte)" }),
      }),
    ),
  })
  .meta({ id: "BwaReport" });

export function serializeBwa(r: {
  meta: ReportMeta;
  month: string;
  variant: "accrual" | "cash";
  ytdFrom: string;
  rows: BwaRow[];
}): z.infer<typeof bwaOut> {
  return {
    meta: serializeMeta(r.meta),
    currency: "EUR",
    month: r.month,
    variant: r.variant,
    ytd_from: r.ytdFrom,
    rows: r.rows.map((x) => ({
      key: x.key,
      label: x.label,
      sum: x.sum,
      month_cents: x.monthCents,
      ytd_cents: x.ytdCents,
      prior_ytd_cents: x.priorYtdCents,
      ytd_share_bp: x.ytdShareBp,
    })),
  };
}

// ── Offene Posten (RPT-006) ──────────────────────────────────────────────────────────────────────────
export const oposQuery = z
  .object({
    side: z.enum(["debtors", "creditors"]).default("debtors"),
    as_of: isoDate.optional().meta({ description: "Stichtag (Standard: heute)" }),
  })
  .strict();

/** Public id of an OPOS item: invoices/corrections, opening items (ACC-013) or purchase vouchers. */
export function oposItemId(side: OposSide, item: { id: string; kind: string; docType?: string | undefined }): string {
  if (side === "creditors") return encodeId("vouchers", item.id);
  if (item.kind === "opening_item") return encodeId("openingItems", item.id);
  return encodeId(item.docType === "correction" ? "corrections" : "invoices", item.id);
}

export const oposOut = z
  .object({
    meta: reportMetaOut,
    side: z.enum(["debtors", "creditors"]),
    as_of: z.string(),
    items: z.array(
      z.object({
        id: z.string().meta({ description: "inv_ / cor_ / opi_ (Debitoren) oder vou_ (Kreditoren)" }),
        number: z.string(),
        contact_id: z.string().nullable(),
        contact_name: z.string(),
        document_date: z.string(),
        due_date: z.string().nullable(),
        currency: z.string(),
        payable_cents: z.number().int(),
        credited_cents: z.number().int(),
        paid_cents: z.number().int(),
        open_cents: z.number().int(),
        days_overdue: z.number().int(),
        overdue: z.boolean(),
        bucket: z.string(),
        dunning_level: z.number().int().nullable(),
      }),
    ),
    credits: z.array(z.object({ contact_id: z.string(), contact_name: z.string(), balance_cents: z.number().int() })),
    totals: z.object({
      open_cents: z.number().int(),
      overdue_cents: z.number().int(),
      due_within_7_cents: z.number().int(),
      credit_cents: z.number().int(),
      buckets: z.array(
        z.object({ key: z.string(), label: z.string(), open_cents: z.number().int(), count: z.number().int() }),
      ),
    }),
    reconciliation: z.object({
      account_balance_cents: z.number().int(),
      open_items_cents: z.number().int(),
      difference_cents: z.number().int(),
      message: z.string().nullable(),
      causes: z.array(z.object({ seq: z.number().int(), date: z.string(), text: z.string(), cents: z.number().int() })),
    }),
  })
  .meta({ id: "OpenItemsReport" });

export function serializeOpos(r: OposReport & { meta: ReportMeta }): z.infer<typeof oposOut> {
  return {
    meta: serializeMeta(r.meta),
    side: r.side,
    as_of: r.asOf,
    items: r.items.map((i) => ({
      id: oposItemId(r.side, i),
      number: i.number,
      contact_id: i.contactId ? encodeId("contacts", i.contactId) : null,
      contact_name: i.contactName,
      document_date: i.documentDate,
      due_date: i.dueDate ?? null,
      currency: i.currency,
      payable_cents: i.payableCents,
      credited_cents: i.creditedCents ?? 0,
      paid_cents: i.paidCents,
      open_cents: i.openCents,
      days_overdue: i.daysOverdue,
      overdue: i.overdue,
      bucket: i.bucket,
      dunning_level: r.dunningLevels[i.id] ?? null,
    })),
    credits: r.credits.map((c) => ({
      contact_id: encodeId("contacts", c.contactId),
      contact_name: c.contactName,
      balance_cents: c.balanceCents,
    })),
    totals: {
      open_cents: r.totals.openCents,
      overdue_cents: r.totals.overdueCents,
      due_within_7_cents: r.totals.dueWithin7Cents,
      credit_cents: r.totals.creditCents,
      buckets: r.totals.buckets.map((b) => ({ key: b.key, label: b.label, open_cents: b.openCents, count: b.count })),
    },
    reconciliation: {
      account_balance_cents: r.reconciliation.accountBalanceCents,
      open_items_cents: r.reconciliation.openItemsCents,
      difference_cents: r.reconciliation.differenceCents,
      message: r.reconciliation.message,
      causes: r.reconciliation.causes.map((c) => ({ seq: c.seq, date: c.date, text: c.text, cents: c.cents })),
    },
  };
}

// ── Anlage EÜR (TAX-015) ─────────────────────────────────────────────────────────────────────────────
export const euerQuery = z.object({ year }).strict();

const aveuerField = z.object({ zeile: z.number().int(), kz: z.string(), label: z.string(), value_cents: z.number() });

export const euerOut = z
  .object({
    year: z.number().int(),
    currency: z.literal("EUR"),
    kleinunternehmer: z.boolean(),
    form_name: z.string(),
    mapping_version: z.string().nullable(),
    verified: z.boolean().meta({ description: "Zeilenzuordnung gegen den amtlichen Vordruck geprüft" }),
    lines: z.array(
      z.object({
        zeile: z.number().int(),
        kz: z.string(),
        label: z.string(),
        section: z.string(),
        column: z.string().nullable(),
        value_cents: z.number().int(),
        drill_down: z.array(
          z.object({ seq: z.number().int(), date: z.string(), cents: z.number().int(), text: z.string() }),
        ),
      }),
    ),
    sums: z.object({
      einnahmen_cents: z.number().int(),
      ausgaben_cents: z.number().int(),
      gewinn_cents: z.number().int(),
      nicht_abziehbar_cents: z.number().int(),
      entnahmen_cents: z.number().int(),
      einlagen_cents: z.number().int(),
    }),
    values: z.record(z.string(), z.number().int()).meta({ description: "Kennzahl → Cent (Werte für Mein ELSTER)" }),
    unmapped: z.array(z.object({ key: z.string(), cents: z.number().int() })),
    aveuer: z
      .object({
        groups: z.array(z.object({ key: z.string(), title: z.string(), fields: z.array(aveuerField) })),
        fields: z.array(aveuerField),
      })
      .nullable(),
    notices: z.array(z.string()),
    blockers: z.array(z.string()),
    filing: z
      .object({
        submitted_on: z.string().nullable(),
        transmission_ticket: z.string().nullable(),
        submitted_values_differ: z.boolean(),
      })
      .nullable(),
    status: z.object({ locked_months: z.number().int(), provisional: z.boolean() }),
    rule_versions: z.array(z.string()),
    generated_at: z.string(),
  })
  .meta({ id: "EuerReport" });

type EuerViewLike = {
  year: number;
  ku: boolean;
  sheet: Omit<EuerSheet, "lines"> & {
    lines: (Omit<EuerSheet["lines"][number], "drillDown"> & {
      drillDown: { seq: number; date: string; cents: number; text?: string }[];
    })[];
  };
  aveuer: Aveuer | null;
  blockers: string[];
  values: Record<string, number>;
  filing: { submittedOn: string | null; transmissionTicket: string | null; submittedValuesDiffer: boolean } | null;
  status: { lockedMonths: number; provisional: boolean };
  ruleVersions: (string | null)[];
  generatedAt: number;
};

const aveuerFieldOf = (f: { zeile: number; kz: string; label: string; valueCents: number }) => ({
  zeile: f.zeile,
  kz: f.kz,
  label: f.label,
  value_cents: f.valueCents,
});

export function serializeEuer(v: EuerViewLike): z.infer<typeof euerOut> {
  const s = v.sheet;
  return {
    year: v.year,
    currency: "EUR",
    kleinunternehmer: v.ku,
    form_name: s.formName,
    mapping_version: s.mappingVersion,
    verified: s.verified,
    lines: s.lines.map((l) => ({
      zeile: l.zeile,
      kz: l.kz,
      label: l.label,
      section: l.section,
      column: l.column ?? null,
      value_cents: l.valueCents,
      drill_down: l.drillDown.map((d) => ({ seq: d.seq, date: d.date, cents: d.cents, text: d.text ?? "" })),
    })),
    sums: {
      einnahmen_cents: s.sums.einnahmenCents,
      ausgaben_cents: s.sums.ausgabenCents,
      gewinn_cents: s.sums.gewinnCents,
      nicht_abziehbar_cents: s.sums.nichtAbziehbarCents,
      entnahmen_cents: s.sums.entnahmenCents,
      einlagen_cents: s.sums.einlagenCents,
    },
    values: v.values,
    unmapped: s.unmapped.map((u) => ({ key: u.key, cents: u.cents })),
    aveuer: v.aveuer
      ? {
          groups: v.aveuer.groups.map((g) => ({ key: g.key, title: g.title, fields: g.fields.map(aveuerFieldOf) })),
          fields: v.aveuer.fields.map(aveuerFieldOf),
        }
      : null,
    notices: s.notices,
    blockers: v.blockers,
    filing: v.filing
      ? {
          submitted_on: v.filing.submittedOn,
          transmission_ticket: v.filing.transmissionTicket,
          submitted_values_differ: v.filing.submittedValuesDiffer,
        }
      : null,
    status: { locked_months: v.status.lockedMonths, provisional: v.status.provisional },
    rule_versions: v.ruleVersions.filter((x): x is string => typeof x === "string"),
    generated_at: toInstant(v.generatedAt),
  };
}

// ── Kennzahlen sheets (F09 EXP-020) ──────────────────────────────────────────────────────────────────
export const SHEET_FORMS = ["ustva", "zm", "euer"] as const;

export const sheetParams = z.object({
  form: z.enum(SHEET_FORMS).meta({ description: "ustva, zm oder euer" }),
  period: z
    .string()
    .regex(/^\d{4}(-(0[1-9]|1[0-2]|Q[1-4]))?$/, "Zeitraum: JJJJ-MM, JJJJ-Qn (UStVA/ZM) oder JJJJ (EÜR).")
    .meta({ description: "UStVA/ZM: 2026-09 oder 2026-Q3; EÜR: 2026", example: "2026-09" }),
});

/** A sheet period must fit its form: the EÜR is per calendar year, UStVA/ZM per month or quarter. */
export function sheetPeriodValid(form: (typeof SHEET_FORMS)[number], period: string): boolean {
  return form === "euer" ? /^\d{4}$/.test(period) : /^\d{4}-(0[1-9]|1[0-2]|Q[1-4])$/.test(period);
}

export const fileOut = z
  .object({
    file_name: z.string(),
    content_type: z.string(),
    sha256: z.string(),
    content_base64: z.string(),
  })
  .meta({ id: "FileDownload" });
