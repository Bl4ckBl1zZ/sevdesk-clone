/**
 * Prefixed public IDs (05 §3 „IDs"): `con_<convexId>` etc. Encoded from the Convex document ID, so they are stable;
 * a value with the wrong prefix is treated as „not found" (never as another table's record).
 */
export const ID_PREFIXES = {
  contacts: "con_",
  contactAddresses: "adr_",
  contactChannels: "chn_",
  contactActivities: "act_",
  vatIdChecks: "vck_",
  products: "prd_",
  customerPrices: "cpr_",
  productCategories: "pcat_",
  tags: "tag_",
  paymentMethods: "pmt_",
  numberRanges: "nrg_",
  layouts: "lay_",
  layoutVersions: "lyv_",
  textTemplates: "tpl_",
  customFieldDefs: "cfd_",
  costCenters: "cc_",
  bankAccounts: "bac_",
  contactMerges: "mrg_",
  // Sales documents (05 §4.3): one table, a prefix per REST resource.
  invoices: "inv_",
  corrections: "cor_",
  // F05/F07 (05 §3 „IDs“): payments, bank transactions, cash transfers, opening items of the opening balance.
  payments: "pay_",
  bankTransactions: "btx_",
  cashTransfers: "csh_",
  openingItems: "opi_",
  // F04 §3.4 recurring invoice templates (05 §3 „IDs“: `rec_`).
  recurringTemplates: "rec_",
  // F05 dunning (05 §4.4): reminders live in salesDocuments (`rem_`), policies, runs; artifacts and send-log rows
  // of the reminder export/mark-sent routes.
  reminders: "rem_",
  dunningPolicies: "dpo_",
  dunningRuns: "drn_",
  documentArtifacts: "art_",
  sendLog: "snd_",
  // F06 purchase vouchers (05 §3 „IDs“: `vou_`) and receipt-inbox items (`inb_`).
  vouchers: "vou_",
  inboxItems: "inb_",
  // F06 VOU-064 recurring voucher templates (`/recurring-vouchers`; 05 §3 had no prefix, `rec_` is F04's).
  recurringVouchers: "rvo_",
  // F07 BNK-050 matching rules (`/matching-rules`; 05 §3 had no prefix).
  matchingRules: "mrl_",
  // F11 projects and time entries (05 §3 „IDs“: `prj_`, `tim_`).
  projects: "prj_",
  timeEntries: "tim_",
  // F09 exports (05 §3 „IDs“: `job_`; `dvx_` DATEV export history and `gdx_` GDPdU packages had no prefix).
  jobs: "job_",
  datevExports: "dvx_",
  gdpduExports: "gdx_",
} as const;

export type IdTable = keyof typeof ID_PREFIXES;

/** Convex IDs are lower-case base32-like strings (convex-test ids end in the camel-case table name). */
const RAW_ID_RE = /^[0-9a-zA-Z]{16,64}$/;

export function encodeId(table: IdTable, id: string): string {
  return `${ID_PREFIXES[table]}${id}`;
}

export function encodeOptionalId(table: IdTable, id: string | undefined | null): string | null {
  return id ? encodeId(table, id) : null;
}

/** `con_abc…` → `abc…`; null if the prefix or the shape does not match. */
export function decodeId(table: IdTable, value: string): string | null {
  const prefix = ID_PREFIXES[table];
  if (!value.startsWith(prefix)) return null;
  const raw = value.slice(prefix.length);
  return RAW_ID_RE.test(raw) ? raw : null;
}

// ── sales documents (F04 §4.1: one table, one prefix per resource) ──────────────────────────────────────
/** REST prefix of a sales document by type: `/quotes` · `quo_`, `/order-confirmations` · `ord_`, … (F04 §4.1). */
export const DOCUMENT_ID_PREFIXES = {
  quote: "quo_",
  order_confirmation: "ord_",
  delivery_note: "dln_",
  proforma: "inv_",
  invoice: "inv_",
  advance_invoice: "inv_",
  partial_invoice: "inv_",
  final_invoice: "inv_",
  cancellation: "inv_",
  correction: "cor_",
  self_billing: "sbc_",
  reminder: "rem_",
} as const;

export type DocumentIdType = keyof typeof DOCUMENT_ID_PREFIXES;

export function encodeDocumentId(type: DocumentIdType, id: string): string {
  return `${DOCUMENT_ID_PREFIXES[type]}${id}`;
}

/** `quo_abc…` → `abc…` when the prefix belongs to `type`; null otherwise (answered as 404). */
export function decodeDocumentId(type: DocumentIdType, value: string): string | null {
  const prefix = DOCUMENT_ID_PREFIXES[type];
  if (!value.startsWith(prefix)) return null;
  const raw = value.slice(prefix.length);
  return RAW_ID_RE.test(raw) ? raw : null;
}
