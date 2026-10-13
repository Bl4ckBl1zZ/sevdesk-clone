import { v } from "convex/values";

/** Shared Convex validators for the embedded types of 03 §0.2. */

/** Canonical actor string `"<kind>:<id>"` (03 §0.1); format checked by the model layer (`actorSchema`). */
export const vActor = v.string();

export const vMemberRole = v.union(
  v.literal("owner"),
  v.literal("bookkeeper"),
  v.literal("viewer"),
  v.literal("auditor"),
);
export const vInviteRole = v.union(v.literal("bookkeeper"), v.literal("viewer"), v.literal("auditor"));

export const vChannel = v.union(
  v.literal("ui"),
  v.literal("api"),
  v.literal("mcp"),
  v.literal("portal"),
  v.literal("cron"),
  v.literal("import"),
  v.literal("system"),
);

export const vPostalAddress = v.object({
  name: v.string(),
  name2: v.optional(v.string()),
  department: v.optional(v.string()),
  street: v.string(),
  street2: v.optional(v.string()),
  postalCode: v.string(),
  city: v.string(),
  countryCode: v.string(),
  poBox: v.optional(v.string()),
});

export const vFileRef = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  bytes: v.number(),
  mime: v.string(),
  name: v.string(),
});

export const vPaymentTerms = v.object({
  dueDays: v.number(),
  skontoPercentBp: v.optional(v.number()),
  skontoDays: v.optional(v.number()),
  text: v.optional(v.string()),
});

export const vTimeRounding = v.object({
  incrementMinutes: v.union(
    v.literal(0),
    v.literal(1),
    v.literal(5),
    v.literal(6),
    v.literal(10),
    v.literal(15),
    v.literal(30),
    v.literal(60),
  ),
  mode: v.union(v.literal("up"), v.literal("nearest")),
  minimumMinutes: v.optional(v.number()),
});

export const vSalesDocType = v.union(
  v.literal("quote"),
  v.literal("order_confirmation"),
  v.literal("delivery_note"),
  v.literal("proforma"),
  v.literal("invoice"),
  v.literal("advance_invoice"),
  v.literal("partial_invoice"),
  v.literal("final_invoice"),
  v.literal("cancellation"),
  v.literal("correction"),
  v.literal("self_billing"),
  v.literal("reminder"),
);

export const vAuditorScope = v.object({
  organisation: v.optional(v.string()),
  purpose: v.string(),
  fiscalYears: v.array(v.number()),
});

export const vIntegrityFinding = v.object({
  kind: v.string(),
  severity: v.union(v.literal("warning"), v.literal("error")),
  detail: v.string(),
  entity: v.optional(v.object({ table: v.string(), id: v.string() })),
  firstBrokenSeq: v.optional(v.number()),
});

/** The actor context passed from a trusted action to an internal mutation (never from a client). */
export const vActorContext = v.object({
  actor: vActor,
  role: v.optional(vMemberRole),
  label: v.optional(v.string()),
  channel: vChannel,
  sessionId: v.optional(v.string()),
  client: v.optional(v.object({ name: v.string(), version: v.string() })),
  scopes: v.optional(v.array(v.string())),
});

// ── F08 journal (03 §8) ───────────────────────────────────────────────────────────────────────────────

export const vChart = v.union(v.literal("SKR03"), v.literal("SKR04"));

/** 03 §0.2 `FxRate` (MISC-08). */
export const vFxRate = v.object({
  rate: v.string(),
  source: v.union(v.literal("bmf_monthly"), v.literal("ecb_daily"), v.literal("manual"), v.literal("transaction")),
  sourceText: v.optional(v.string()),
  date: v.string(),
});

/** 03 §8 `journalEntries.lines[]`; `contactId` references the F02 contact (OPOS, DATEV personal accounts). */
export const vJournalLine = v.object({
  account: v.string(),
  role: v.optional(v.string()),
  debitCents: v.number(),
  creditCents: v.number(),
  taxKey: v.optional(v.string()),
  costCenterId: v.optional(v.string()),
  contactId: v.optional(v.id("contacts")),
  taxPointDate: v.optional(v.string()),
  taxPeriod: v.optional(v.string()),
  currency: v.optional(v.string()),
  amountFx: v.optional(v.number()),
  fxRate: v.optional(vFxRate),
});

/** 03 §8 `journalEntries.source.kind`. */
export const vJournalSourceKind = v.union(
  v.literal("salesDocument"),
  v.literal("voucher"),
  v.literal("payment"),
  v.literal("bankTransaction"),
  v.literal("cashTransfer"),
  v.literal("asset_depreciation"),
  v.literal("manual"),
  v.literal("opening_balance"),
  v.literal("tax"),
  v.literal("fx"),
  v.literal("period_close"),
);

// ── contacts and products (03 §2, §3) ────────────────────────────────────────────────────────────────────
export const vContactKind = v.union(v.literal("organization"), v.literal("person"));
export const vContactRole = v.union(
  v.literal("customer"),
  v.literal("supplier"),
  v.literal("partner"),
  v.literal("prospect"),
);
export const vContactStatus = v.union(v.literal("lead"), v.literal("active"), v.literal("archived"));
export const vVatCheckStatus = v.union(v.literal("valid"), v.literal("invalid"), v.literal("unavailable"));
export const vQualifiedCode = v.union(v.literal("A"), v.literal("B"), v.literal("C"), v.literal("D"));
export const vPriceMode = v.union(v.literal("net"), v.literal("gross"));

// ── F04 sales documents (03 §0.2, §4) ─────────────────────────────────────────────────────────────────
export const vSupplyDate = v.union(
  v.object({ kind: v.literal("date"), date: v.string() }),
  v.object({ kind: v.literal("period"), from: v.string(), to: v.string() }),
  v.object({ kind: v.literal("month"), month: v.string() }),
);
export const vVatCategory = v.union(
  v.literal("S"),
  v.literal("Z"),
  v.literal("E"),
  v.literal("AE"),
  v.literal("K"),
  v.literal("G"),
  v.literal("O"),
  v.literal("KU"),
);
export const vTaxCase = v.union(
  v.literal("domestic"),
  v.literal("kleinunternehmer"),
  v.literal("eu_b2b_service"),
  v.literal("intra_community_supply"),
  v.literal("export"),
  v.literal("not_taxable_domestic"),
  v.literal("reverse_charge_13b"),
  v.literal("exempt_4"),
  v.literal("unknown_imported"),
);
export const vEinvoiceFormat = v.union(
  v.literal("zugferd_en16931"),
  v.literal("zugferd_xrechnung"),
  v.literal("xrechnung_cii"),
  v.literal("xrechnung_ubl"),
  v.literal("none"),
);
export const vEr03Decision = v.union(
  v.literal("MUST_E"),
  v.literal("PDF_NEEDS_CONSENT"),
  v.literal("MAY_PAPER_OR_PDF"),
  v.literal("NOT_REQUIRED"),
);
export const vSalesDocStatus = v.union(
  v.literal("draft"),
  v.literal("finalized"),
  v.literal("sent"),
  v.literal("cancelled"),
  v.literal("accepted"),
  v.literal("rejected"),
  v.literal("expired"),
  v.literal("superseded"),
  v.literal("partially_invoiced"),
  v.literal("invoiced"),
  v.literal("withdrawn"),
);
export const vPaymentStatus = v.union(
  v.literal("open"),
  v.literal("partially_paid"),
  v.literal("paid"),
  v.literal("credited"),
  v.literal("written_off"),
);
export const vSendChannel = v.union(
  v.literal("email_manual"),
  v.literal("post"),
  v.literal("hand"),
  v.literal("upload_portal"),
  v.literal("other"),
);
export const vDiscount = v.object({
  kind: v.union(v.literal("percent"), v.literal("amount")),
  valueBp: v.optional(v.number()),
  amountCents: v.optional(v.number()),
});
export const vVatGroupTotals = v.object({
  category: vVatCategory,
  rateBp: v.number(),
  netCents: v.number(),
  vatCents: v.number(),
  enteredGrossCents: v.optional(v.number()),
  grossDeviationCents: v.optional(v.number()),
});
export const vDocumentTotals = v.object({
  netCents: v.number(),
  vatCents: v.number(),
  grossCents: v.number(),
  advancesDeductedGrossCents: v.number(),
  payableCents: v.number(),
  byGroup: v.array(vVatGroupTotals),
  vatEurCents: v.optional(v.number()),
  laborNetCents: v.optional(v.number()),
});
