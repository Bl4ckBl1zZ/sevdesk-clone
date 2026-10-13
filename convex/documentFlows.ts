import { v } from "convex/values";
import { CONVERSION_MATRIX } from "../src/domain/documents/conversion";
import {
  acceptQuoteSchema,
  collectiveSchema,
  convertSchema,
  markReceivedSchema,
  rejectQuoteSchema,
  reopenSchema,
  reviseSchema,
  withdrawSchema,
} from "../src/domain/schemas/documents";
import type { Id } from "./_generated/dataModel";
import { mutation, query } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import { chainOverview, progressOf } from "./model/documentChains";
import {
  acceptQuote,
  conversionProposal,
  convert as convertModel,
  createCollectiveInvoice,
  createRevision,
  markReceived as markReceivedModel,
  rejectQuote,
  reopenQuote,
  uninvoicedDeliveryNotes,
  withdrawDocument,
} from "./model/documentFlows";
import { getDocument } from "./model/salesDocuments";

/**
 * Quotes, order confirmations, delivery notes and proforma after finalisation (F04 §4.2/§4.3, QUO-04…15, DOC-33/34):
 * acceptance, rejection, reopening, withdrawal, „Erhalten“, new quote versions, conversions, the collective invoice
 * and the chain view. UI, REST and MCP call these with the shared zod schemas; all writes go through
 * convex/model/documentFlows.ts. Drafting, finalising, export and the sent mark stay in convex/invoices.ts (one
 * pipeline for every type).
 */

const vId = v.id("salesDocuments");

export const accept = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.any() },
  handler: async (ctx, { id, values }) => acceptQuote(ctx, id, parse(acceptQuoteSchema, values)),
});

export const reject = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.any() },
  handler: async (ctx, { id, values }) => rejectQuote(ctx, id, parse(rejectQuoteSchema, values)),
});

export const reopen = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.any() },
  handler: async (ctx, { id, values }) => reopenQuote(ctx, id, parse(reopenSchema, values).reason),
});

export const withdraw = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.any() },
  handler: async (ctx, { id, values }) => withdrawDocument(ctx, id, parse(withdrawSchema, values).reason),
});

export const markReceived = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.any() },
  handler: async (ctx, { id, values }) => markReceivedModel(ctx, id, parse(markReceivedSchema, values)),
});

/** „Neue Version“ (QUO-06): returns the new draft. */
export const revise = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.optional(v.any()) },
  handler: async (ctx, { id, values }) => ({
    id: await createRevision(ctx, id, parse(reviseSchema, values ?? {}).reason),
  }),
});

/** „Umwandeln“ (DOC-33): returns the new draft and notices (tax case / rate changed). */
export const convert = mutation({
  permission: "documents.write",
  args: { id: vId, values: v.any() },
  handler: async (ctx, { id, values }) => convertModel(ctx, id, parse(convertSchema, values)),
});

/** QUO-11 Sammelrechnung from delivery notes. */
export const collectiveInvoice = mutation({
  permission: "documents.write",
  args: { values: v.any() },
  handler: async (ctx, { values }) => {
    const { deliveryNoteIds } = parse(collectiveSchema, values);
    const ids: Id<"salesDocuments">[] = [];
    for (const raw of deliveryNoteIds) {
      const id = ctx.db.normalizeId("salesDocuments", raw);
      if (!id) throw appError("not_found", "Lieferschein nicht gefunden.");
      ids.push(id);
    }
    return createCollectiveInvoice(ctx, ids);
  },
});

/** Data of the „Umwandeln“ dialog: allowed targets, proposed quantities, acceptance needed. */
export const proposal = query({
  permission: "documents.read",
  args: {
    id: vId,
    to: v.union(
      v.literal("order_confirmation"),
      v.literal("delivery_note"),
      v.literal("proforma"),
      v.literal("invoice"),
    ),
  },
  handler: async (ctx, { id, to }) => conversionProposal(ctx, id, to),
});

/** DOC-34 chain view („Verknüpft“) with invoicing progress, plus the conversion targets of this document. */
export const chain = query({
  permission: "documents.read",
  args: { id: vId },
  handler: async (ctx, { id }) => {
    const doc = await getDocument(ctx, id);
    const { progress } = await progressOf(ctx, doc);
    const own = progress.get(id);
    return {
      documents: await chainOverview(ctx, doc),
      targets: (CONVERSION_MATRIX[doc.type] ?? []).filter((t) =>
        ["order_confirmation", "delivery_note", "proforma", "invoice"].includes(t),
      ),
      invoicedBy: own?.invoicedBy ?? [],
      coveredBp: own?.coveredBp ?? 0,
    };
  },
});

/** Finalised, not yet invoiced delivery notes of a contact (Sammelrechnung, „+ Lieferscheine übernehmen“). */
export const openDeliveryNotes = query({
  permission: "documents.read",
  args: { contactId: v.id("contacts") },
  handler: async (ctx, { contactId }) => {
    const out = [];
    for (const n of await uninvoicedDeliveryNotes(ctx, contactId)) {
      const doc = await getDocument(ctx, n._id);
      const { progress } = await progressOf(ctx, doc);
      if ((progress.get(n._id)?.invoicedBy.length ?? 0) === 0) out.push(n);
    }
    return out;
  },
});
