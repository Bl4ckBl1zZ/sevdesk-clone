import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vActor, vChannel, vTimeRounding } from "./validators";

/**
 * F11 projects and time tracking (03 §9) and the F03 stock movements (03 §3, P4). Tables are spread into the schema
 * like `voucherTables`. Deviations from 03 §9 (F11 §9 Q3 data-model additions, reported to the lead):
 *  - `timeEntries.draftDocumentId` (the invoice draft an `in_draft` entry belongs to; E-PRJ-10 message, PRJ-012 sync)
 *  - `timeEntries.invoicedDocumentId` (the finalised invoice of `invoicedLineId`, for the Storno offer E-PRJ-25)
 *  - `projects.numberNormalized`, `projects.searchText` (lookups like products)
 *  - `products.stock.belowReorderSince` (PRD-096 „one notification until the stock rises above it again“)
 *  - `timeEntries.offlineOpIds`, `runningTimer.offlineOpId` (PRJ-018 idempotent replay of the offline queue)
 */

export const vProjectStatus = v.union(v.literal("active"), v.literal("done"), v.literal("archived"));
export const vBillingMode = v.union(v.literal("hourly"), v.literal("fixed"), v.literal("non_billable"));
export const vTimeEntryStatus = v.union(v.literal("open"), v.literal("in_draft"), v.literal("invoiced"));
export const vTimeEntrySource = v.union(
  v.literal("timer"),
  v.literal("manual"),
  v.literal("mcp"),
  v.literal("api"),
  v.literal("offline"),
);
export const vStockReason = v.union(
  v.literal("delivery_note"),
  v.literal("manual_in"),
  v.literal("manual_out"),
  v.literal("correction"),
);
export const vProductStock = v.object({
  enabled: v.boolean(),
  quantityMilli: v.number(),
  reorderLevelMilli: v.optional(v.number()),
  belowReorderSince: v.optional(v.number()),
});

export const projectTables = {
  // 03 §9 projects (PRJ-001): mutable master data (audited); only archived once entries or documents exist.
  projects: defineTable({
    number: v.string(),
    numberNormalized: v.string(),
    name: v.string(),
    searchText: v.string(),
    description: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    status: vProjectStatus,
    billingMode: vBillingMode,
    hourlyRateMicros: v.optional(v.number()),
    internalCostRateMicros: v.optional(v.number()),
    currency: v.string(),
    budget: v.optional(v.object({ kind: v.union(v.literal("hours"), v.literal("amount")), value: v.number() })),
    budgetAlerts: v.array(
      v.object({ thresholdBp: v.union(v.literal(8000), v.literal(10000)), notifiedAt: v.optional(v.number()) }),
    ),
    startDate: v.optional(v.string()),
    endDate: v.optional(v.string()),
    defaultProductId: v.optional(v.id("products")),
    costCenterId: v.optional(v.id("costCenters")),
    rounding: v.optional(vTimeRounding),
    attachTimesheetDefault: v.optional(v.boolean()),
    createdAt: v.number(),
    actor: vActor,
  })
    .index("by_number", ["numberNormalized"])
    .index("by_status", ["status", "name"])
    .index("by_contact", ["contactId"])
    .searchIndex("search", { searchField: "searchText", filterFields: ["status"] }),

  // 03 §9 timeEntries (F11 §4.1): guarded — open: editable (audited); in_draft: locked; invoiced: frozen (GOBD-06).
  timeEntries: defineTable({
    projectId: v.optional(v.id("projects")),
    contactId: v.optional(v.id("contacts")),
    date: v.string(),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    durationMinutes: v.number(),
    roundedMinutes: v.optional(v.number()),
    description: v.string(),
    productId: v.optional(v.id("products")),
    hourlyRateMicros: v.number(),
    currency: v.string(),
    billable: v.boolean(),
    status: vTimeEntryStatus,
    draftDocumentId: v.optional(v.id("salesDocuments")),
    invoicedLineId: v.optional(v.id("documentLines")),
    invoicedDocumentId: v.optional(v.id("salesDocuments")),
    invoicedLineHistory: v.array(v.id("documentLines")),
    source: vTimeEntrySource,
    incomplete: v.optional(v.boolean()),
    conflict: v.optional(v.boolean()),
    flaggedForReview: v.optional(v.boolean()),
    /** PRJ-018: IDs of the queued offline operations that produced the entry (replay is idempotent). */
    offlineOpIds: v.optional(v.array(v.string())),
    lockedAt: v.optional(v.number()),
    retentionClass: v.union(v.literal("vouchers8"), v.literal("none")),
    retentionUntil: v.optional(v.string()),
    actor: vActor,
  })
    .index("by_date", ["date"])
    .index("by_project", ["projectId", "date"])
    .index("by_contact", ["contactId", "date"])
    .index("by_status", ["status", "date"])
    .index("by_draft", ["draftDocumentId"])
    .index("by_invoice", ["invoicedDocumentId"])
    .index("by_product", ["productId"]),

  // 03 §9 runningTimer: singleton (at most one row, PRJ-005); unprotected (03 §11), audited.
  runningTimer: defineTable({
    startedAt: v.number(),
    projectId: v.optional(v.id("projects")),
    contactId: v.optional(v.id("contacts")),
    description: v.optional(v.string()),
    productId: v.optional(v.id("products")),
    billable: v.optional(v.boolean()),
    startedVia: vChannel,
    deviceId: v.optional(v.string()),
    warnedAt: v.optional(v.number()),
    /** PRJ-018: the queued offline start that created the timer. */
    offlineOpId: v.optional(v.string()),
  }),

  // 03 §3 stockMovements (PRD-090…097): append-only; corrections are new movements (GOBD-06).
  stockMovements: defineTable({
    productId: v.id("products"),
    quantityMilli: v.number(),
    reason: vStockReason,
    text: v.optional(v.string()),
    documentId: v.optional(v.id("salesDocuments")),
    /** The movement a `correction` reverses (PRD-092). */
    reversesId: v.optional(v.id("stockMovements")),
    at: v.number(),
    actor: vActor,
  })
    .index("by_product", ["productId", "at"])
    .index("by_document", ["documentId"]),
};
