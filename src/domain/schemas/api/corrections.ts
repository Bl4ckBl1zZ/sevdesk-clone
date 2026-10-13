import { z } from "zod";
import type {} from "zod-openapi";
import { decimalString, decimalToScaled, isoDate, scaledToDecimal } from "./common";

/**
 * Wire shapes of Storno, Rechnungskorrektur/-berichtigung and the advance chain (F04 §7.1/§7.2, 05 §4.3), shared by
 * the REST handlers (`POST /invoices/{id}/cancel|correct`, `POST /corrections/{id}/cancel`,
 * `GET /invoices/{id}/chain`) and the MCP tools (`document_preview` intent `cancel`, ⚠ `invoice_cancel`,
 * `invoice_create_correction`).
 */

export const documentId = z
  .string()
  .regex(/^(inv|cor)_[0-9a-zA-Z]{16,64}$/, "Erwartet eine Beleg-ID (inv_… oder cor_…).")
  .meta({ description: "Beleg-ID (inv_… Rechnung, cor_… Korrektur)", example: "inv_k57f3x2m9q8w1e4r6t" });

/** `inv_…`/`cor_…` → the Convex id (one table); null when malformed. */
export function rawDocumentId(value: string): string | null {
  const m = /^(?:inv|cor)_([0-9a-zA-Z]{16,64})$/.exec(value);
  return m?.[1] ?? null;
}

export const cancelWire = z
  .object({
    reason: z.string().max(1000).optional().meta({ description: "Grund (wird auf der Stornorechnung gedruckt)" }),
    document_date: isoDate.optional().meta({ description: "Datum der Stornorechnung (Standard: heute)" }),
  })
  .meta({ id: "CancelRequest" });

export const cancelRequest = cancelWire.extend({
  dry_run: z.boolean().optional().meta({ description: "true = nur die Spiegel-Vorschau (nichts wird angelegt)" }),
});

/** Arguments of the guarded Convex mutation `corrections.cancel` (without `confirmToken`) — bound by the token. */
export function cancelArgs(id: string, w: z.infer<typeof cancelWire>) {
  return {
    id,
    ...(w.reason?.trim() ? { reason: w.reason.trim() } : {}),
    ...(w.document_date ? { documentDate: w.document_date } : {}),
  };
}

export const creditChangeWire = z.object({
  position: z.number().int().min(1).meta({ description: "Position (1 = erste Artikelposition der Rechnung)" }),
  quantity: decimalString(3, "Neue Menge (statt der berechneten)", "8").optional(),
  unit_price: decimalString(4, "Neuer Einzelpreis (statt des berechneten)", "90.0000").optional(),
});

export const correctWire = z
  .object({
    kind: z.enum(["credit", "rectification"]).meta({
      description:
        "credit = Rechnungskorrektur (mindert Beträge, TypeCode 381); rectification = Rechnungsberichtigung (nur formale Angaben, gleiche Beträge, 384)",
    }),
    changes: z
      .array(creditChangeWire)
      .max(2500)
      .optional()
      .meta({ description: "Nur credit: geänderte Positionen; ohne Angabe wird der volle Betrag korrigiert" }),
  })
  .meta({ id: "CorrectRequest" });

export type CorrectWire = z.infer<typeof correctWire>;

/** Wire changes → Convex `changes` (quantityMilli, unitPriceMicros); null with the offending field on bad decimals. */
export function creditChanges(
  w: CorrectWire,
): { position: number; quantityMilli?: number; unitPriceMicros?: number }[] {
  return (w.changes ?? []).map((c) => {
    const q = c.quantity === undefined ? undefined : decimalToScaled(c.quantity, 3);
    const p = c.unit_price === undefined ? undefined : decimalToScaled(c.unit_price, 4);
    return {
      position: c.position,
      ...(q !== undefined && q !== null ? { quantityMilli: q } : {}),
      ...(p !== undefined && p !== null ? { unitPriceMicros: p } : {}),
    };
  });
}

const money = z.number().int().meta({ description: "Cent" });

export const mirrorOut = z
  .object({
    document_date: isoDate,
    currency: z.string(),
    einvoice_format: z.string(),
    lines: z.array(z.object({ name: z.string(), quantity: z.string(), unit_code: z.string(), net_cents: money })),
    totals: z.object({ net_cents: money, vat_cents: money, gross_cents: money, payable_cents: money }),
    notes: z.array(z.string()),
  })
  .meta({ id: "StornoMirror" });

export const cancelPreviewOut = z
  .object({
    original: z.object({ id: z.string(), number: z.string(), document_date: z.string() }),
    allowed: z.boolean(),
    blocked: z.object({ code: z.string(), message: z.string() }).nullable(),
    notice: z.string(),
    mirror: mirrorOut.nullable(),
    einvoice_validation: z.string().nullable(),
  })
  .meta({ id: "CancelPreview" });

export interface MirrorView {
  documentDate: string;
  currency: string;
  format: string;
  lines: { name: string; quantityMilli: number; unitCode: string; netCents: number }[];
  totals: { netCents: number; vatCents: number; grossCents: number; payableCents: number };
  notes: string[];
}

export function mirrorToWire(m: MirrorView): z.infer<typeof mirrorOut> {
  return {
    document_date: m.documentDate,
    currency: m.currency,
    einvoice_format: m.format,
    lines: m.lines.map((l) => ({
      name: l.name,
      quantity: scaledToDecimal(l.quantityMilli, 3),
      unit_code: l.unitCode,
      net_cents: l.netCents,
    })),
    totals: {
      net_cents: m.totals.netCents,
      vat_cents: m.totals.vatCents,
      gross_cents: m.totals.grossCents,
      payable_cents: m.totals.payableCents,
    },
    notes: m.notes,
  };
}

export const cancelOut = z
  .object({ id: z.string(), number: z.string(), original_id: z.string(), artifact_status: z.string() })
  .meta({ id: "CancelResult" });

export const correctionDraftOut = z
  .object({
    id: z.string(),
    version: z.number().int(),
    correction_kind: z.enum(["credit", "rectification"]),
    corrects_id: z.string(),
    totals: z.object({ net_cents: money, vat_cents: money, gross_cents: money }),
    validation: z.object({
      errors: z.array(z.object({ code: z.string(), message: z.string() })),
      warnings: z.array(z.object({ code: z.string(), message: z.string() })),
    }),
  })
  .meta({ id: "CorrectionDraft" });

export const chainOut = z
  .object({
    root_id: z.string(),
    order: z.object({ number: z.string(), date: z.string() }).nullable(),
    advances: z.array(
      z.object({
        id: z.string(),
        invoice_type: z.enum(["advance", "partial"]),
        number: z.string(),
        document_date: z.string(),
        status: z.string(),
        invoiced_cents: money,
        received_cents: money,
        credited_cents: money,
        open_cents: money,
        deducted_in: z.string().nullable(),
        resolution: z.enum(["settled", "storno", "reduce", "cancelled", "deducted"]).meta({
          description:
            "Vor der Schlussrechnung: settled = abziehbar; storno = unbezahlt, stornieren; reduce = teilbezahlt, per Rechnungskorrektur auf den erhaltenen Betrag mindern (EC-071)",
        }),
      }),
    ),
    finals: z.array(z.object({ id: z.string(), number: z.string().nullable(), status: z.string() })),
    can_create_final: z.boolean(),
  })
  .meta({ id: "InvoiceChain" });
