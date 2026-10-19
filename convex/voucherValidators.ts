import { defineTable } from "convex/server";
import { v } from "convex/values";
import { vActor, vFileRef, vFxRate, vPriceMode, vSupplyDate } from "./validators";

/**
 * Purchase vouchers and inbox (03 §6, F06 P2). Validators and table definitions live here, apart from schema.ts,
 * so the voucher slice stays separate (schema.ts spreads `voucherTables`). Deviations from 03 §6 are listed in
 * 03 §12 „F06 P2 voucher core 2026-10-19“.
 */

export const vVoucherDirection = v.union(v.literal("expense"), v.literal("income"));
export const vVoucherKind = v.union(
  v.literal("standard"),
  v.literal("bewirtung"),
  v.literal("eigenbeleg"),
  v.literal("asset"),
  v.literal("tax_payment"),
  v.literal("private"),
);
export const vVoucherStatus = v.union(
  v.literal("draft"),
  v.literal("open"),
  v.literal("scheduled"),
  v.literal("partially_paid"),
  v.literal("paid"),
  v.literal("cancelled"),
);
export const vVoucherTaxRule = v.union(
  v.literal("input_vat_deductible"),
  v.literal("no_input_vat"),
  v.literal("reverse_charge_13b_de"),
  v.literal("reverse_charge_eu"),
  v.literal("reverse_charge_non_eu"),
  v.literal("intra_community_acquisition"),
  v.literal("import_vat"),
  v.literal("kleinunternehmer_supplier"),
  v.literal("output_vat"),
  v.literal("exempt_income"),
  v.literal("not_taxable"),
);
export const vAssetDecision = v.union(v.literal("gwg"), v.literal("pool"), v.literal("asset"), v.literal("none"));
export const vTaxPaymentSubtype = v.union(
  v.literal("ust_prepayment"),
  v.literal("sondervorauszahlung"),
  v.literal("ust_annual"),
  v.literal("gewerbesteuer"),
  v.literal("est_private"),
  v.literal("kst"),
);
export const vCaptureChannel = v.union(
  v.literal("upload"),
  v.literal("email"),
  v.literal("app"),
  v.literal("api"),
  v.literal("mcp"),
);
export const vVoucherPaymentMethod = v.union(
  v.literal("bank"),
  v.literal("card_pending"),
  v.literal("cash"),
  v.literal("private"),
);

const vTotalsByRate = v.object({ rateBp: v.number(), netCents: v.number(), vatCents: v.number() });

export const vVoucherTotals = v.object({
  netCents: v.number(),
  vatCents: v.number(),
  grossCents: v.number(),
  selfAssessedVatCents: v.number(),
  byRate: v.array(vTotalsByRate),
});
export const vVoucherTotalsEur = v.object({
  netCents: v.number(),
  vatCents: v.number(),
  grossCents: v.number(),
  selfAssessedVatCents: v.number(),
});
/** The Belegsumme / VAT breakdown printed on the document (EC-VOU-03), checked against the lines at booking. */
export const vStatedTotals = v.object({
  grossCents: v.optional(v.number()),
  byRate: v.optional(v.array(vTotalsByRate)),
});

/** 03 §6 `vouchers.originalFiles[]` (GOBD-07/08, VOU-120…122). */
export const vOriginalFile = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  bytes: v.number(),
  mime: v.string(),
  name: v.string(),
  pages: v.optional(v.number()),
  role: v.union(v.literal("original"), v.literal("extracted_xml"), v.literal("embedded_attachment"), v.literal("eml")),
  capturedAt: v.number(),
  clientCapturedAt: v.optional(v.number()),
  capturedBy: vActor,
  capturedVia: vCaptureChannel,
  replacedBy: v.optional(v.number()),
  replaceReason: v.optional(v.string()),
});

export const vRendition = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  mime: v.string(),
  ofFileIndex: v.number(),
  kind: v.union(
    v.literal("thumbnail"),
    v.literal("crop_deskew"),
    v.literal("heic_jpeg"),
    v.literal("combined_pdf"),
    v.literal("html_pdf"),
    v.literal("visualisation"),
  ),
  createdAt: v.number(),
});

export const vBewirtungInput = v.object({
  occasionType: v.union(v.literal("geschaeftlich"), v.literal("arbeitnehmer")),
  occasion: v.string(),
  participants: v.array(v.string()),
  host: v.string(),
  place: v.string(),
  date: v.string(),
  tipCents: v.optional(v.number()),
  tseConfirmed: v.boolean(),
  hostOnInvoiceConfirmed: v.optional(v.boolean()),
});
export const vBewirtung = v.object({
  ...vBewirtungInput.fields,
  approvedAt: v.optional(v.number()),
  approvedBy: v.optional(vActor),
  eigenbelegFile: v.optional(vFileRef),
  versions: v.array(
    v.object({
      data: vBewirtungInput,
      eigenbelegFile: vFileRef,
      approvedAt: v.number(),
      supersededAt: v.number(),
      reason: v.string(),
    }),
  ),
});

export const vEigenbelegInput = v.object({
  reason: v.union(v.literal("lost"), v.literal("not_obtainable"), v.literal("other")),
  reasonText: v.optional(v.string()),
  recipient: v.string(),
  purpose: v.string(),
});
export const vEigenbeleg = v.object({
  ...vEigenbelegInput.fields,
  approvedAt: v.optional(v.number()),
  approvedBy: v.optional(vActor),
  file: v.optional(vFileRef),
});

export const vTaxPayment = v.object({
  subtype: vTaxPaymentSubtype,
  period: v.optional(v.string()),
  // `taxFilings` does not exist yet (F08 TAX-*): the id is kept as a string until then.
  filingId: v.optional(v.string()),
});

/** One voucher line as entered (UI/REST/MCP); the model computes VAT/gross per price mode (VOU-002). */
export const vVoucherLineInput = v.object({
  account: v.string(),
  description: v.optional(v.string()),
  quantityMilli: v.optional(v.number()),
  /** Net (price mode net) or gross (price mode gross) amount in document currency. */
  amountCents: v.number(),
  vatRateBp: v.number(),
  /** VAT as printed on the document (±1 cent tolerated, EC-VOU-04); computed when absent. */
  vatCents: v.optional(v.number()),
  nonDeductibleShareBp: v.optional(v.number()),
  assetDecision: v.optional(vAssetDecision),
  costCenterId: v.optional(v.string()),
});

/** The editable header of a voucher draft (VOU-001). */
export const vVoucherDraftInput = v.object({
  direction: v.optional(vVoucherDirection),
  kind: v.optional(vVoucherKind),
  supplierContactId: v.optional(v.id("contacts")),
  supplierName: v.optional(v.string()),
  supplierVatId: v.optional(v.string()),
  supplierTaxNumber: v.optional(v.string()),
  supplierAddress: v.optional(v.string()),
  supplierIban: v.optional(v.string()),
  documentNumber: v.optional(v.string()),
  documentDate: v.optional(v.string()),
  supplyDate: v.optional(vSupplyDate),
  dueDate: v.optional(v.string()),
  currency: v.optional(v.string()),
  fxRateToEur: v.optional(vFxRate),
  priceMode: v.optional(vPriceMode),
  taxRule: v.optional(vVoucherTaxRule),
  lines: v.optional(v.array(vVoucherLineInput)),
  statedTotals: v.optional(vStatedTotals),
  skontoTerms: v.optional(v.object({ percentBp: v.number(), days: v.number(), baseCents: v.optional(v.number()) })),
  taxPayment: v.optional(vTaxPayment),
  creditNoteOfId: v.optional(v.id("vouchers")),
  recurringPayment: v.optional(v.boolean()),
  costCenterId: v.optional(v.string()),
  projectId: v.optional(v.string()),
  internalNote: v.optional(v.string()),
  bewirtung: v.optional(vBewirtungInput),
  eigenbeleg: v.optional(vEigenbelegInput),
});

/** „Bezahlt mit“ at booking or later (VOU-136…138). */
export const vVoucherPaymentInput = v.object({
  method: vVoucherPaymentMethod,
  date: v.optional(v.string()),
  amountCents: v.optional(v.number()),
  backdateReason: v.optional(v.string()),
  note: v.optional(v.string()),
});

/** Template of a recurring voucher (03 §6 `recurringVouchers.template`, VOU-064) — a draft header with lines. */
export const vRecurringTemplate = v.object({
  direction: vVoucherDirection,
  kind: vVoucherKind,
  supplierContactId: v.optional(v.id("contacts")),
  supplierName: v.optional(v.string()),
  supplierVatId: v.optional(v.string()),
  documentNumber: v.optional(v.string()),
  currency: v.string(),
  priceMode: vPriceMode,
  taxRule: vVoucherTaxRule,
  lines: v.array(vVoucherLineInput),
  internalNote: v.optional(v.string()),
});

export const voucherTables = {
  // vouchers 🔒 (03 §6, §11): frozen when locked or cancelled; drafts are deletable (audited with content).
  vouchers: defineTable({
    direction: vVoucherDirection,
    kind: vVoucherKind,
    status: vVoucherStatus,
    supplierContactId: v.optional(v.id("contacts")),
    supplierName: v.optional(v.string()),
    supplierVatId: v.optional(v.string()),
    supplierTaxNumber: v.optional(v.string()),
    supplierAddress: v.optional(v.string()),
    supplierIban: v.optional(v.string()),
    documentNumber: v.optional(v.string()),
    internalNumber: v.optional(v.string()),
    documentDate: v.optional(v.string()),
    supplyDate: v.optional(vSupplyDate),
    dueDate: v.optional(v.string()),
    receivedAt: v.number(),
    currency: v.string(),
    fxRateToEur: v.optional(vFxRate),
    priceMode: vPriceMode,
    taxRule: vVoucherTaxRule,
    totals: vVoucherTotals,
    totalsEur: v.optional(vVoucherTotalsEur),
    statedTotals: v.optional(vStatedTotals),
    openAmountCents: v.number(),
    payee: v.optional(v.object({ name: v.string(), iban: v.string(), bic: v.optional(v.string()) })),
    skontoTerms: v.optional(v.object({ percentBp: v.number(), days: v.number(), baseCents: v.optional(v.number()) })),
    originalFiles: v.array(vOriginalFile),
    renditions: v.array(vRendition),
    checkedComplete: v.optional(v.object({ at: v.number(), actor: vActor })),
    einvoice: v.optional(
      v.object({
        syntax: v.union(v.literal("ubl"), v.literal("cii")),
        profile: v.optional(v.string()),
        xmlStorageId: v.id("_storage"),
        xmlSha256: v.string(),
        notEInvoice: v.optional(v.boolean()),
        validation: v.object({
          acceptable: v.boolean(),
          category: v.optional(
            v.union(v.literal("ok"), v.literal("format"), v.literal("business_rule"), v.literal("content")),
          ),
          reportStorageId: v.id("_storage"),
          tool: v.string(),
          at: v.number(),
        }),
      }),
    ),
    inputVatAtRisk: v.optional(v.array(v.string())),
    /** ⚑ warnings acknowledged at booking (codes, VOU-007). */
    acknowledgedWarnings: v.optional(v.array(v.string())),
    creditNoteOfId: v.optional(v.id("vouchers")),
    ocr: v.optional(v.object({ model: v.string(), confidence: v.number(), raw: v.any(), at: v.number() })),
    bewirtung: v.optional(vBewirtung),
    eigenbeleg: v.optional(vEigenbeleg),
    taxPayment: v.optional(vTaxPayment),
    recurringPayment: v.optional(v.boolean()),
    rebillable: v.optional(v.object({ markupBp: v.number(), revenueAccount: v.optional(v.string()) })),
    rebilledLineId: v.optional(v.id("documentLines")),
    duplicateOfId: v.optional(v.id("vouchers")),
    duplicateDismissals: v.array(v.id("vouchers")),
    recurringVoucherId: v.optional(v.id("recurringVouchers")),
    inboxItemId: v.optional(v.id("inboxItems")),
    costCenterId: v.optional(v.string()),
    // `projects` arrives with F11 (P4): kept as a string until then.
    projectId: v.optional(v.string()),
    tags: v.array(v.id("tags")),
    internalNote: v.optional(v.string()),
    /** Booking/correction entries of the voucher (journal source `voucher`); grows with corrections. */
    journalEntryIds: v.array(v.id("journalEntries")),
    imported: v.optional(v.literal(true)),
    origin: v.optional(
      v.object({ source: v.literal("sevdesk_export"), externalId: v.string(), importId: v.id("imports") }),
    ),
    recordedAt: v.number(),
    bookedAt: v.optional(v.number()),
    lockedAt: v.optional(v.number()),
    cancelledAt: v.optional(v.number()),
    cancelReason: v.optional(v.string()),
    retentionClass: v.literal("vouchers8"),
    retentionUntil: v.optional(v.string()),
    actor: vActor,
    version: v.number(),
  })
    .index("by_internalNumber", ["internalNumber"])
    .index("by_status_date", ["status", "documentDate"])
    .index("by_supplier_documentNumber", ["supplierContactId", "documentNumber"])
    .index("by_status_due", ["status", "dueDate"])
    .index("by_documentDate", ["documentDate"])
    .index("by_recurring", ["recurringVoucherId", "documentDate"]),

  // voucherLines 🔒 frozen with the parent (03 §6).
  voucherLines: defineTable({
    voucherId: v.id("vouchers"),
    position: v.number(),
    account: v.string(),
    description: v.optional(v.string()),
    quantityMilli: v.optional(v.number()),
    netCents: v.number(),
    vatRateBp: v.number(),
    vatCents: v.number(),
    grossCents: v.number(),
    selfAssessedVatCents: v.optional(v.number()),
    netEurCents: v.optional(v.number()),
    vatEurCents: v.optional(v.number()),
    nonDeductibleShareBp: v.optional(v.number()),
    assetDecision: v.optional(vAssetDecision),
    // `assets`/`projects` arrive with F08 AST-*/F11: kept as strings until then.
    assetId: v.optional(v.string()),
    costCenterId: v.optional(v.string()),
    projectId: v.optional(v.string()),
  }).index("by_voucher", ["voucherId", "position"]),

  // Lookup sha256 → voucher for the identical-file duplicate check (VOU-050; Convex cannot index array elements).
  voucherFileHashes: defineTable({
    sha256: v.string(),
    voucherId: v.id("vouchers"),
    fileIndex: v.number(),
  })
    .index("by_sha256", ["sha256"])
    .index("by_voucher", ["voucherId"]),

  // inboxItems (03 §6): shape only in the voucher core — capture, e-mail-in and classification (INB-*) plug in here.
  inboxItems: defineTable({
    source: vCaptureChannel,
    receivedAt: v.number(),
    clientCapturedAt: v.optional(v.number()),
    from: v.optional(v.string()),
    subject: v.optional(v.string()),
    messageId: v.optional(v.string()),
    r2: v.optional(v.object({ bucket: v.string(), objectKey: v.string(), etag: v.optional(v.string()) })),
    duplicateOfInboxItemId: v.optional(v.id("inboxItems")),
    files: v.array(
      v.object({
        storageId: v.id("_storage"),
        sha256: v.string(),
        name: v.string(),
        mime: v.string(),
        bytes: v.number(),
      }),
    ),
    classification: v.optional(
      v.union(v.literal("xrechnung"), v.literal("zugferd"), v.literal("pdf"), v.literal("image"), v.literal("other")),
    ),
    einvoiceProfile: v.optional(v.string()),
    confidence: v.optional(v.number()),
    flags: v.optional(v.array(v.string())),
    status: v.union(
      v.literal("new"),
      v.literal("processing"),
      v.literal("needs_review"),
      v.literal("converted"),
      v.literal("rejected"),
      v.literal("duplicate"),
    ),
    rejectReason: v.optional(
      v.union(
        v.literal("no_business_document"),
        v.literal("not_addressed_to_us"),
        v.literal("faulty_invoice_correction_requested"),
        v.literal("other"),
      ),
    ),
    rejectText: v.optional(v.string()),
    attempts: v.number(),
    nextAttemptAt: v.optional(v.number()),
    retentionUntil: v.optional(v.string()),
    voucherId: v.optional(v.id("vouchers")),
    error: v.optional(v.string()),
  })
    .index("by_status_receivedAt", ["status", "receivedAt"])
    .index("by_messageId", ["messageId"])
    .index("by_r2Object", ["r2.bucket", "r2.objectKey"]),

  // supplierProfiles (03 §6): learned account/tax rule per supplier key (VOU-040…042). Unprotected, audited.
  supplierProfiles: defineTable({
    key: v.string(),
    contactId: v.optional(v.id("contacts")),
    lastAccount: v.optional(v.string()),
    lastTaxRule: v.optional(v.string()),
    lastCostCenterId: v.optional(v.string()),
    uses: v.number(),
    /** Consecutive bookings on `lastAccount` (VOU-041 confidence 0.95 from 5×). */
    accountStreak: v.number(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // recurringVouchers (03 §6, VOU-064): mutable configuration (audited); the cron generates the vouchers.
  recurringVouchers: defineTable({
    name: v.string(),
    template: vRecurringTemplate,
    interval: v.union(
      v.literal("P1W"),
      v.literal("P2W"),
      v.literal("P1M"),
      v.literal("P2M"),
      v.literal("P3M"),
      v.literal("P6M"),
      v.literal("P1Y"),
      v.literal("P2Y"),
      v.literal("P3Y"),
      v.literal("P4Y"),
      v.literal("P5Y"),
    ),
    firstDate: v.string(),
    nextDate: v.string(),
    endDate: v.optional(v.string()),
    active: v.boolean(),
    createAs: v.union(v.literal("open"), v.literal("draft")),
    expectedMandateRef: v.optional(v.string()),
    expectedIban: v.optional(v.string()),
    referenceFile: v.optional(vFileRef),
    recurringPayment: v.optional(v.boolean()),
    lastGeneratedIds: v.array(v.id("vouchers")),
    actor: vActor,
    version: v.number(),
  }).index("by_active_next", ["active", "nextDate"]),

  // receiptWaivers — „Beleg nicht erforderlich“ on a bank transaction (VOU-110). Unprotected, audited.
  receiptWaivers: defineTable({
    bankTransactionId: v.id("bankTransactions"),
    reason: v.string(),
    actor: vActor,
    at: v.number(),
  }).index("by_transaction", ["bankTransactionId"]),
};
