import "server-only";
import { api } from "@convex/_generated/api";
import { z } from "zod";
import { encodeId } from "@/domain/api/ids";
import { prefixedId } from "@/domain/schemas/api/common";
import {
  cancelArgs,
  cancelOut,
  cancelPreviewOut,
  cancelRequest,
  chainOut,
  correctionDraftOut,
  correctWire,
  creditChanges,
  type MirrorView,
  mirrorToWire,
} from "@/domain/schemas/api/corrections";
import type { ConvexCaller } from "../backend";
import { defineEndpoint, defineResource } from "../endpoint";
import { ApiProblem } from "../http";
import { rawId } from "./shared";

/**
 * F04 §7.1 Storno, Rechnungskorrektur/-berichtigung and the advance chain (05 §4.3). Thin wire ⇄ Convex mapping; the
 * guards and postings live in convex/model/invoiceCorrections.ts. Correction drafts are finalised like every draft.
 */

const docRef = (type: string, id: string) => encodeId(type === "correction" ? "corrections" : "invoices", id);

/** Storno preview: mirror, guard, dispatch notice and the XML check of the mirror (INV-20). */
export async function cancelPreviewWire(convex: ConvexCaller, id: string, w: z.infer<typeof cancelRequest>) {
  const args = cancelArgs(id, w);
  const p = await convex.query(api.corrections.cancelPreview, args as never);
  const xml = p.guard ? null : await convex.action(api.corrections.validateCancel, args as never);
  const blocked =
    p.guard ?? (xml?.status === "failed" ? { code: "einvoice_validation_failed", message: xml.message ?? "" } : null);
  return {
    version: p.version,
    wire: {
      original: {
        id: docRef(p.original.type, p.original.id),
        number: p.original.number,
        document_date: p.original.documentDate,
      },
      allowed: blocked === null,
      blocked,
      notice: p.notice,
      mirror: p.mirror ? mirrorToWire(p.mirror as MirrorView) : null,
      einvoice_validation: xml?.status ?? null,
    },
  };
}

async function cancel(convex: ConvexCaller, id: string, wireId: string, body: z.infer<typeof cancelRequest>) {
  if (body.dry_run) return { status: 200, body: (await cancelPreviewWire(convex, id, body)).wire };
  const r = await convex.mutation(api.corrections.cancel, cancelArgs(id, body) as never);
  return {
    status: 201,
    body: { id: encodeId("invoices", r.id), number: r.number, original_id: wireId, artifact_status: "pending" },
    headers: { Location: `/api/v1/invoices/${encodeId("invoices", r.id)}` },
  };
}

const cancelResponse = z.union([cancelOut, cancelPreviewOut]).meta({ id: "CancelResponse" });

export const correctionsResource = defineResource("corrections", "Storno, Rechnungskorrekturen und Abschlagsketten", [
  defineEndpoint({
    method: "POST",
    path: "/invoices/{id}/cancel",
    operationId: "cancelInvoice",
    summary: "Rechnung stornieren (Stornorechnung)",
    description:
      "Erstellt und stellt die Stornorechnung in einem Schritt fertig (vollständiger Spiegel, eigene Nummer, Bezug BT-25/26). Nur für unbezahlte Rechnungen; bezahlte → Rechnungskorrektur + Erstattung. `dry_run: true` liefert die Spiegel-Vorschau samt E-Rechnungs-Prüfung und schreibt nichts. Ohne `dry_run` ist `Idempotency-Key` Pflicht.",
    tag: "Rechnungen",
    scope: "invoices:cancel",
    params: z.object({ id: prefixedId("invoices") }),
    body: cancelRequest,
    idempotency: "required",
    response: { status: 201, schema: cancelResponse, description: "Stornorechnung (201) oder Vorschau (200)" },
    errors: [
      "not_found",
      "storno_paid_invoice",
      "already_cancelled",
      "storno_of_storno",
      "storno_advance_deducted",
      "storno_has_corrections",
      "validation_failed",
      "idempotency_key_required",
    ],
    handler: async ({ convex, params, body }) => cancel(convex, rawId("invoices", params.id), params.id, body),
  }),
  defineEndpoint({
    method: "POST",
    path: "/corrections/{id}/cancel",
    operationId: "cancelCorrection",
    summary: "Rechnungskorrektur stornieren",
    description:
      "Storno einer Rechnungskorrektur, solange keine Erstattung/Verrechnung zugeordnet ist (INV-15); die korrigierte Rechnung erhält den gutgeschriebenen Betrag zurück.",
    tag: "Rechnungen",
    scope: "invoices:cancel",
    params: z.object({ id: prefixedId("corrections") }),
    body: cancelRequest,
    idempotency: "required",
    response: { status: 201, schema: cancelResponse, description: "Stornorechnung (201) oder Vorschau (200)" },
    errors: ["not_found", "correction_refund_allocated", "already_cancelled", "illegal_transition"],
    handler: async ({ convex, params, body }) => cancel(convex, rawId("corrections", params.id), params.id, body),
  }),
  defineEndpoint({
    method: "POST",
    path: "/invoices/{id}/correct",
    operationId: "correctInvoice",
    summary: "Korrekturentwurf anlegen",
    description:
      "`kind: credit` = Rechnungskorrektur (negative Differenz; `changes` mit neuer Menge/neuem Preis je Position, ohne `changes` der volle Betrag). `kind: rectification` = Rechnungsberichtigung (vollständige Wiederholung mit gleichen Beträgen; Anschrift, USt-IdNr usw. vorher am Kontakt bzw. im Entwurf ändern). Fertigstellen wie jeder Entwurf.",
    tag: "Rechnungen",
    scope: "documents:write",
    params: z.object({ id: prefixedId("invoices") }),
    body: correctWire,
    response: { status: 201, schema: correctionDraftOut, description: "Der Korrekturentwurf" },
    errors: ["not_found", "correction_target_invalid", "already_cancelled", "validation_failed"],
    handler: async ({ convex, params, body }) => {
      const originalId = rawId("invoices", params.id);
      const changes = creditChanges(body);
      const r = await convex.mutation(api.corrections.createCorrection, {
        originalId: originalId as never,
        kind: body.kind,
        ...(changes.length ? { changes } : {}),
      });
      return {
        status: 201,
        body: await correctionDraftWire(convex, r.id, params.id),
        headers: { Location: `/api/v1/corrections/${encodeId("corrections", r.id)}` },
      };
    },
  }),
  defineEndpoint({
    method: "GET",
    path: "/invoices/{id}/chain",
    operationId: "getInvoiceChain",
    summary: "Abschlagskette abrufen",
    description:
      "Abschlags-/Teilrechnungen der Kette mit berechnetem, erhaltenem und offenem Betrag und der vor der Schlussrechnung nötigen Auflösung (EC-071), Schlussrechnung(en).",
    tag: "Rechnungen",
    scope: "documents:read",
    params: z.object({ id: prefixedId("invoices") }),
    response: { status: 200, schema: chainOut, description: "Die Kette" },
    errors: ["not_found"],
    handler: async ({ convex, params }) => {
      const r = await convex.query(api.corrections.relations, { id: rawId("invoices", params.id) as never });
      if (!r?.chain) throw new ApiProblem("not_found", { detail: "Kein Abschlags-/Schlussrechnungsbeleg." });
      const c = r.chain;
      return {
        body: {
          root_id: encodeId("invoices", c.rootId),
          order: c.order,
          advances: c.advances.map((a) => ({
            id: encodeId("invoices", a.id),
            invoice_type: a.type === "partial_invoice" ? ("partial" as const) : ("advance" as const),
            number: a.number,
            document_date: a.documentDate,
            status: a.status,
            invoiced_cents: a.invoicedCents,
            received_cents: a.receivedCents,
            credited_cents: a.creditedCents,
            open_cents: a.openCents,
            deducted_in: a.deductedInNumber,
            resolution: a.resolution,
          })),
          finals: c.finals.map((f) => ({ id: encodeId("invoices", f.id), number: f.number, status: f.status })),
          can_create_final: c.canCreateFinal,
        },
      };
    },
  }),
]);

/** The created correction draft with totals and validation (findings of the compliance panel). */
export async function correctionDraftWire(convex: ConvexCaller, id: string, originalWireId: string) {
  const g = await convex.query(api.invoices.get, { id: id as never });
  if (!g) throw new ApiProblem("not_found");
  const findings = g.findings as { code: string; severity: string; message: string }[];
  return {
    id: encodeId("corrections", id),
    version: g.doc.version,
    correction_kind: (g.doc.correctionKind ?? "credit") as "credit" | "rectification",
    corrects_id: originalWireId,
    totals: {
      net_cents: g.doc.totals.netCents,
      vat_cents: g.doc.totals.vatCents,
      gross_cents: g.doc.totals.grossCents,
    },
    validation: {
      errors: findings.filter((f) => f.severity === "E").map((f) => ({ code: f.code, message: f.message })),
      warnings: findings.filter((f) => f.severity !== "E").map((f) => ({ code: f.code, message: f.message })),
    },
  };
}
