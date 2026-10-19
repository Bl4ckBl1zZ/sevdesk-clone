import { DOC_TYPE_LABEL_DE, documentPath } from "../../src/domain/documents/doc-types";
import {
  type InvoicingDeadlineState,
  invoicingDeadlineLevel,
  type UninvoicedSupplyRow,
} from "../../src/domain/documents/uninvoiced-supplies";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { type CalendarDate, formatGermanDate } from "../../src/domain/time/calendar-date";
import type { Doc } from "../_generated/dataModel";
import { resolveNotifications, upsertNotification } from "./salesDocuments";
import type { ModelCtx, ReadCtx } from "./types";

/**
 * UST-01 / F04 QUO-14 in `deadlines.notify` (02 §7): finalised delivery notes that no invoice has billed yet get a
 * warning to-do at day 150 and an escalation at day 180 after the delivery date — for business/legal-person customers
 * and property-related supplies (§ 14 Abs. 2 UStG). The to-dos resolve once the note is invoiced or withdrawn.
 * Rules: src/domain/documents/uninvoiced-supplies.ts.
 */

type SalesDoc = Doc<"salesDocuments">;

export const UST01_KINDS = { warning: "ust01_warning", escalation: "ust01_escalation" } as const;
const OPEN_STATUSES = ["finalized", "sent", "accepted"] as const;

async function rowOf(ctx: ReadCtx, d: SalesDoc): Promise<UninvoicedSupplyRow> {
  const contact = d.contactId ? await ctx.db.get(d.contactId) : null;
  return {
    id: d._id,
    status: d.status,
    supplyDate: d.supplyDate,
    customer: contact ? { isConsumer: contact.isConsumer, kind: contact.kind } : null,
    propertyRelated: d.propertyRelated,
  };
}

/** The badge state of one delivery note (list/detail); null for other types or when nothing is due. */
export async function deliveryNoteDeadline(
  ctx: ReadCtx,
  d: SalesDoc,
  today: CalendarDate,
): Promise<InvoicingDeadlineState | null> {
  if (d.type !== "delivery_note" || !(OPEN_STATUSES as readonly string[]).includes(d.status)) return null;
  return invoicingDeadlineLevel(await rowOf(ctx, d), today);
}

const title = (d: SalesDoc, s: InvoicingDeadlineState) => {
  const label = d.number ?? DOC_TYPE_LABEL_DE[d.type];
  const day = formatGermanDate(s.deliveredOn);
  return s.level === "escalation"
    ? `Rechnungsfrist überschritten: Lieferschein ${label} vom ${day} ist seit ${s.daysSince} Tagen nicht abgerechnet (§ 14 Abs. 2 UStG)`
    : `Lieferschein ${label} vom ${day} ist seit ${s.daysSince} Tagen nicht abgerechnet – bitte bis ${formatGermanDate(s.escalatesOn)} Rechnung stellen (§ 14 Abs. 2 UStG)`;
};

/** Returns how many to-dos were newly opened (an already open to-do with the same dedupe key is a no-op). */
export async function runUninvoicedSupplyDeadlines(ctx: ModelCtx): Promise<{ created: number; resolved: number }> {
  const today = berlinCalendarDate(ctx.now());
  let created = 0;
  for (const status of OPEN_STATUSES) {
    for (const d of await ctx.db
      .query("salesDocuments")
      .withIndex("by_type_status_date", (q) => q.eq("type", "delivery_note").eq("status", status))
      .collect()) {
      const s = await deliveryNoteDeadline(ctx, d, today);
      if (!s) continue;
      if (s.level === "escalation") await resolveNotifications(ctx, d._id, UST01_KINDS.warning);
      const kind = UST01_KINDS[s.level];
      const dedupeKey = `${kind}:${d._id}`;
      const existing = await ctx.db
        .query("notifications")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", dedupeKey))
        .first();
      if (existing && existing.resolvedAt === undefined) continue;
      await upsertNotification(ctx, {
        kind,
        severity: s.level === "escalation" ? "error" : "warning",
        title: title(d, s),
        link: documentPath(d.type, d._id),
        entity: { table: "salesDocuments", id: d._id },
        dedupeKey,
      });
      created++;
    }
  }
  // Notes invoiced or withdrawn since: close their to-dos.
  let resolved = 0;
  for (const n of await ctx.db
    .query("notifications")
    .withIndex("by_open", (q) => q.eq("resolvedAt", undefined))
    .collect()) {
    if (n.kind !== UST01_KINDS.warning && n.kind !== UST01_KINDS.escalation) continue;
    const d = n.entity?.table === "salesDocuments" ? await ctx.db.get(n.entity.id as SalesDoc["_id"]) : null;
    if (!d || (await deliveryNoteDeadline(ctx, d, today))) continue;
    await resolveNotifications(ctx, d._id, n.kind);
    resolved++;
  }
  return { created, resolved };
}
