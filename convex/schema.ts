import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vBankSourceKind,
  vBankSourceRef,
  vBankTransactionSource,
  vBankTransactionStatus,
  vStatementFormat,
} from "./bankValidators";
import { vMatchProvenance, vPaymentDifference, vPaymentSource, vPaymentTarget } from "./paymentValidators";
import {
  vActor,
  vAuditorScope,
  vChannel,
  vChart,
  vContactKind,
  vContactRole,
  vContactStatus,
  vDiscount,
  vDocumentTotals,
  vEinvoiceFormat,
  vEr03Decision,
  vFileRef,
  vFxRate,
  vIntegrityFinding,
  vInviteRole,
  vJournalLine,
  vJournalSourceKind,
  vMemberRole,
  vPaymentStatus,
  vPaymentTerms,
  vPostalAddress,
  vPriceMode,
  vQualifiedCode,
  vSalesDocStatus,
  vSalesDocType,
  vSendChannel,
  vSupplyDate,
  vTaxCase,
  vTimeRounding,
  vVatCategory,
  vVatCheckStatus,
} from "./validators";

/**
 * Convex schema — P0 tables from docs/spec/03-data-model.md (the single source of truth; field names are
 * 03's). Better Auth's own tables (user, session, account, verification, passkey, twoFactor, jwks, …) live in
 * the Local Install component `convex/betterAuth/` and are not part of this schema.
 */

// ── 03 §1 companyProfile (singleton) ──────────────────────────────────────────────────────────────────
const companyProfile = defineTable({
  legalForm: v.union(
    v.literal("einzelunternehmen"),
    v.literal("freiberufler"),
    v.literal("ek"),
    v.literal("gbr"),
    v.literal("egbr"),
    v.literal("ohg"),
    v.literal("kg"),
    v.literal("gmbh_co_kg"),
    v.literal("gmbh"),
    v.literal("ug"),
    v.literal("ag"),
    v.literal("partg"),
    v.literal("other"),
  ),
  name: v.string(),
  tradeName: v.optional(v.string()),
  address: vPostalAddress,
  seat: v.optional(v.string()),
  contact: v.object({ name: v.string(), phone: v.string(), email: v.string(), website: v.optional(v.string()) }),
  register: v.optional(
    v.object({
      court: v.string(),
      type: v.union(
        v.literal("HRA"),
        v.literal("HRB"),
        v.literal("PR"),
        v.literal("GnR"),
        v.literal("VR"),
        v.literal("GsR"),
      ),
      number: v.string(),
    }),
  ),
  representatives: v.array(v.object({ name: v.string(), role: v.optional(v.literal("chair")) })),
  generalPartner: v.optional(
    v.object({
      name: v.string(),
      seat: v.string(),
      registerCourt: v.string(),
      registerNumber: v.string(),
      managingDirectors: v.array(v.string()),
    }),
  ),
  hasSupervisoryBoard: v.optional(v.boolean()),
  supervisoryBoardChair: v.optional(v.string()),
  noNaturalPersonLiable: v.optional(v.boolean()),
  shareCapital: v.optional(v.object({ amountCents: v.number(), outstandingCents: v.optional(v.number()) })),
  taxNumber: v.optional(v.string()),
  taxNumberState: v.optional(v.string()),
  vatId: v.optional(v.string()),
  taxOffice: v.optional(v.string()),
  kleinunternehmer: v.array(v.object({ validFrom: v.string(), isKU: v.boolean(), waiverDate: v.optional(v.string()) })),
  taxationMethod: v.array(
    v.object({
      validFrom: v.string(),
      method: v.union(v.literal("soll"), v.literal("ist")),
      financeOfficeApproval: v.optional(v.object({ date: v.string(), reference: v.string() })),
    }),
  ),
  ustvaPeriod: v.array(
    v.object({
      year: v.number(),
      period: v.union(v.literal("monthly"), v.literal("quarterly"), v.literal("annual_only")),
      dauerfrist: v.boolean(),
    }),
  ),
  profitMethod: v.array(
    v.object({ validFromFiscalYear: v.number(), method: v.union(v.literal("euer"), v.literal("bilanz")) }),
  ),
  euerExemptionConfirmedAt: v.optional(v.number()),
  chartOfAccounts: v.array(
    v.object({
      validFromFiscalYear: v.number(),
      chart: v.union(v.literal("SKR03"), v.literal("SKR04")),
      accountMappingStorageId: v.optional(v.id("_storage")),
    }),
  ),
  fiscalYearStartMonth: v.number(),
  bookkeepingStartDate: v.optional(v.string()),
  foundedOn: v.optional(v.string()),
  priorYearTotalTurnoverCents: v.array(v.object({ year: v.number(), amountCents: v.number() })),
  electronicAddress: v.object({
    scheme: v.union(v.literal("EM"), v.literal("0204"), v.literal("9930")),
    value: v.string(),
  }),
  creditorId: v.optional(v.string()),
  datev: v.object({
    consultantNumber: v.optional(v.number()),
    clientNumber: v.optional(v.number()),
    accountLength: v.number(),
    formatVersion: v.optional(v.union(v.literal(12), v.literal(13))),
    personalAccounts: v.boolean(),
    collectiveDebtorAccount: v.optional(v.string()),
  }),
  serverLocation: v.object({ countryCode: v.string(), provider: v.optional(v.string()), confirmedAt: v.number() }),
  accessConcept: v.object({
    baseDomain: v.string(),
    network: v.literal("tailnet"),
    tailnetName: v.optional(v.string()),
    confirmedAt: v.number(),
  }),
  lastRestoreDrillOn: v.optional(v.string()),
  logoStorageId: v.optional(v.id("_storage")),
  defaults: v.object({
    paymentTerms: vPaymentTerms,
    priceMode: v.union(v.literal("net"), v.literal("gross")),
    language: v.union(v.literal("de"), v.literal("en")),
    backdateWindowDays: v.number(),
    quoteValidityDays: v.number(),
    quoteRevisionNumbering: v.union(v.literal("suffix"), v.literal("new_number")),
    catchUpAutoMax: v.number(),
    paymentReferencePrefix: v.optional(v.string()),
    fxRateSource: v.union(v.literal("bmf_monthly"), v.literal("ecb_daily")),
    discountOnCustomerPrices: v.boolean(),
    stockOnInvoiceWithoutDeliveryNote: v.boolean(),
    preventNegativeStock: v.boolean(),
    standardAttachments: v.array(v.object({ docType: vSalesDocType, file: vFileRef })),
    time: v.optional(
      v.object({
        hourlyRateMicros: v.optional(v.number()),
        rounding: vTimeRounding,
        unitCode: v.union(v.literal("HUR"), v.literal("MIN")),
      }),
    ),
  }),
  receivables: v.object({
    agingBucketEdgesDays: v.array(v.number()),
    postalDeliveryDays: v.number(),
    // F05 §6.6 „Mahnungen automatisch erstellen“ (absent = on): the daily dunning.run creates drafts.
    autoCreateReminders: v.optional(v.boolean()),
    autoFinalizeReminders: v.boolean(),
    bankDataMaxAgeDays: v.number(),
    defaultStartViaReminder: v.union(v.literal("after_printed_deadline"), v.literal("zugang_plus_1")),
    reopenGraceDays: v.number(),
    allocationOrder: v.union(v.literal("principal_first"), v.literal("bgb_367")),
  }),
  matching: v.object({ autoApplyBp: v.number(), safeBp: v.number(), suggestBp: v.number() }),
  // `portal` (F10 POR-003…) is reserved while F10 is deferred and is added with F10.
  assetPolicy: v.array(
    v.object({
      fiscalYear: v.number(),
      mode250to1000: v.union(v.literal("gwg"), v.literal("pool")),
      erinnerungswert: v.boolean(),
    }),
  ),
  setupCompletedAt: v.optional(v.number()),
  version: v.number(),
});

export default defineSchema({
  companyProfile,

  // 03 §1 — append-only (🔒)
  companyProfileVersions: defineTable({
    version: v.number(),
    profile: v.string(),
    diff: v.object({ before: v.optional(v.any()), after: v.optional(v.any()) }),
    validFrom: v.number(),
    actor: vActor,
    reason: v.optional(v.string()),
    auditSeq: v.number(),
  }).index("by_version", ["version"]),

  // 03 §1 bankAccounts (P0: manual invoice accounts, F01 SET-050…054; feed/fx/statement fields arrive with F07)
  bankAccounts: defineTable({
    kind: v.union(v.literal("bank"), v.literal("clearing"), v.literal("paypal")),
    name: v.string(),
    currency: v.string(),
    iban: v.optional(v.string()),
    bic: v.optional(v.string()),
    accountHolder: v.string(),
    bankDetails: v.optional(
      v.object({
        bankCountry: v.optional(v.string()),
        accountNo: v.optional(v.string()),
        sortCode: v.optional(v.string()),
        routingNumber: v.optional(v.string()),
        schemes: v.optional(v.array(v.string())),
      }),
    ),
    ledgerAccount: v.string(),
    showOnInvoices: v.boolean(),
    isDefaultForInvoices: v.boolean(),
    autoApplyMatches: v.boolean(),
    openingBalance: v.optional(v.object({ date: v.string(), amountCents: v.number() })),
    archivedAt: v.optional(v.number()),
  })
    .index("by_ledgerAccount", ["ledgerAccount"])
    .index("by_currency_default", ["currency", "isDefaultForInvoices"])
    .index("by_iban", ["iban"]),

  // ── 03 §7 banking (F07 P1: statement import; the Enable Banking feed tables follow in P2) ────────────────
  // bankTransactions 🔒 — booked rows only, immutable except the BNK-122 whitelist (src/domain/audit/immutability.ts)
  bankTransactions: defineTable({
    accountId: v.id("bankAccounts"),
    bookingDate: v.string(),
    valueDate: v.optional(v.string()),
    amountCents: v.number(),
    currency: v.string(),
    amountEurCents: v.optional(v.number()),
    fxRate: v.optional(vFxRate),
    counterpartyName: v.optional(v.string()),
    counterpartyIban: v.optional(v.string()),
    counterpartyBic: v.optional(v.string()),
    counterpartySource: v.optional(v.union(v.literal("provider"), v.literal("description"), v.literal("statement"))),
    purpose: v.string(),
    reference: v.optional(v.string()),
    endToEndId: v.optional(v.string()),
    mandateRef: v.optional(v.string()),
    creditorId: v.optional(v.string()),
    bankRef: v.optional(v.string()),
    source: vBankTransactionSource,
    sources: v.array(vBankSourceRef),
    dedupeKey: v.string(),
    contentHash: v.string(),
    importId: v.optional(v.id("bankImports")),
    status: vBankTransactionStatus,
    ignoredReason: v.optional(
      v.union(
        v.literal("duplicate_of_file_import"),
        v.literal("neutralised_pair"),
        v.literal("test_or_zero"),
        v.literal("import_rolled_back"),
      ),
    ),
    ignoredLinkId: v.optional(v.id("bankTransactions")),
    reversalOfId: v.optional(v.id("bankTransactions")),
    /** The source flagged the row as a bank counter-entry (CAMT `RvslInd`, MT940 `RC/RD`; BNK-121). */
    reversal: v.optional(v.boolean()),
    /** BNK-061: the other leg of a Geldtransit pair. */
    transferPeerId: v.optional(v.id("bankTransactions")),
    allocatedCents: v.number(),
    recordedAt: v.number(),
    bookedAt: v.optional(v.number()),
    lockedAt: v.optional(v.number()),
  })
    .index("by_dedupeKey", ["dedupeKey"])
    .index("by_account_contentHash", ["accountId", "contentHash"])
    .index("by_account_bookingDate", ["accountId", "bookingDate"])
    .index("by_status", ["status", "bookingDate"])
    .index("by_account_status", ["accountId", "status", "bookingDate"])
    .index("by_account_entryReference", ["accountId", "source.entryReference"])
    .index("by_import", ["importId"]),

  // bankTransactionRevisions 🔒 — append-only raw rows per delivery (BNK-113); applied:false = differing re-delivery
  bankTransactionRevisions: defineTable({
    transactionId: v.id("bankTransactions"),
    sourceKind: v.string(),
    rawSha256: v.string(),
    rawJson: v.string(),
    fetchedAt: v.number(),
    applied: v.boolean(),
    importId: v.optional(v.id("bankImports")),
    line: v.optional(v.number()),
    changedFields: v.optional(v.array(v.string())),
  }).index("by_transaction", ["transactionId", "rawSha256"]),

  // bankImports — one row per statement file import (BNK-030/034/036)
  bankImports: defineTable({
    accountId: v.id("bankAccounts"),
    source: vBankSourceKind,
    fileStorageId: v.optional(v.id("_storage")),
    fileSha256: v.optional(v.string()),
    fileName: v.optional(v.string()),
    periodFrom: v.string(),
    periodTo: v.string(),
    openingBalanceCents: v.optional(v.number()),
    closingBalanceCents: v.optional(v.number()),
    continuityOk: v.optional(v.boolean()),
    counts: v.object({
      total: v.number(),
      inserted: v.number(),
      duplicates: v.number(),
      mergedCrossSource: v.number(),
      possibleDuplicates: v.number(),
      conflicts: v.number(),
      rejected: v.number(),
    }),
    statementId: v.optional(v.id("bankStatements")),
    /** Rows the file delivered (new, merged, duplicate or conflicting) — the live reconciliation base (BNK-030). */
    rowIds: v.optional(v.array(v.id("bankTransactions"))),
    rolledBackAt: v.optional(v.number()),
    at: v.number(),
    actor: vActor,
  })
    .index("by_account", ["accountId", "at"])
    .index("by_fileSha256", ["fileSha256"]),

  // bankStatements 🔒 — the official Kontoauszug per currency account and period (BNK-030, GOBD-07/20)
  bankStatements: defineTable({
    accountId: v.id("bankAccounts"),
    periodFrom: v.string(),
    periodTo: v.string(),
    periodStartUtc: v.number(),
    periodEndUtc: v.number(),
    format: vStatementFormat,
    statementRef: v.optional(v.string()),
    pdf: v.optional(vFileRef),
    camt: v.optional(vFileRef),
    other: v.optional(v.array(vFileRef)),
    openingBalanceCents: v.optional(v.number()),
    closingBalanceCents: v.optional(v.number()),
    importId: v.optional(v.id("bankImports")),
    reconciled: v.boolean(),
    differences: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("missing"), v.literal("extra"), v.literal("amount")),
          detail: v.string(),
          transactionId: v.optional(v.id("bankTransactions")),
          amountCents: v.optional(v.number()),
        }),
      ),
    ),
    continuity: v.optional(
      v.object({ status: v.string(), message: v.optional(v.string()), diffCents: v.optional(v.number()) }),
    ),
    rolledBack: v.optional(v.boolean()),
    uploadedAt: v.number(),
    retentionUntil: v.string(),
  }).index("by_account_period", ["accountId", "periodFrom"]),

  // possibleDuplicates — review list „Mögliche Dubletten“ (BNK-034/110, RI-29); not protected, audited
  possibleDuplicates: defineTable({
    accountId: v.id("bankAccounts"),
    candidate: v.any(),
    existingIds: v.array(v.id("bankTransactions")),
    importId: v.optional(v.id("bankImports")),
    reason: v.string(),
    status: v.union(v.literal("open"), v.literal("same"), v.literal("separate")),
    resolvedAt: v.optional(v.number()),
    resolvedTransactionId: v.optional(v.id("bankTransactions")),
    actor: v.optional(vActor),
    createdAt: v.number(),
  }).index("by_account_status", ["accountId", "status"]),

  // cashTransfers 🔒 — „Bargeld eingezahlt / entnommen“ and ATM withdrawals into the till (CSH-024/025/027)
  cashTransfers: defineTable({
    date: v.string(),
    kind: v.union(v.literal("deposit_to_bank"), v.literal("private_withdrawal"), v.literal("bank_withdrawal_to_cash")),
    amountCents: v.number(),
    bankAccountId: v.optional(v.id("bankAccounts")),
    bankTransactionId: v.optional(v.id("bankTransactions")),
    note: v.optional(v.string()),
    backdateReason: v.optional(v.string()),
    shareholder: v.optional(v.object({ name: v.string(), note: v.string() })),
    eigenbelegFile: v.optional(vFileRef),
    journalEntryIds: v.array(v.id("journalEntries")),
    reversalOfId: v.optional(v.id("cashTransfers")),
    reason: v.optional(v.string()),
    recordedAt: v.number(),
    actor: vActor,
  })
    .index("by_date", ["date"])
    .index("by_bankTransaction", ["bankTransactionId"])
    .index("by_reversalOf", ["reversalOfId"]),

  // 03 §1 numberRanges / numberCounters (P0: configuration; assignment in the finalisation transaction is P1)
  numberRanges: defineTable({
    docTypes: v.array(v.string()),
    name: v.string(),
    format: v.string(),
    resetPolicy: v.union(v.literal("never"), v.literal("yearly"), v.literal("monthly")),
    startValue: v.number(),
    active: v.boolean(),
    isDefault: v.boolean(),
  }),
  numberCounters: defineTable({
    rangeId: v.id("numberRanges"),
    periodKey: v.string(),
    next: v.number(),
  }).index("by_range_period", ["rangeId", "periodKey"]),

  // 03 §1 numberRegister 🔒 (UST-06, GOBD-02): every issued number; uniqueness via by_normalized (SET-060/064).
  // `documentId` is the issuing record (sales document, contact, product, asset, voucher) — typed as a string
  // until those tables exist (P1+). `periodKey`/`counter` feed SET-059 and the gap report (SET-063).
  numberRegister: defineTable({
    number: v.string(),
    normalized: v.string(),
    rangeId: v.optional(v.id("numberRanges")),
    docType: v.string(),
    documentId: v.optional(v.string()),
    periodKey: v.optional(v.string()),
    counter: v.optional(v.number()),
    assignedAt: v.number(),
    status: v.union(v.literal("issued"), v.literal("cancelled_by_storno"), v.literal("corrected")),
    imported: v.optional(v.literal(true)),
  })
    .index("by_normalized", ["normalized"])
    .index("by_range", ["rangeId", "periodKey"]),

  // 03 §1 layouts / layoutVersions 🔒 (append-only; documents reference a version, GOBD-06)
  layouts: defineTable({
    name: v.string(),
    // Set in the same transaction that creates the layout (the first version needs the layout id); never unset
    // outside it.
    currentVersionId: v.optional(v.id("layoutVersions")),
    isDefaultFor: v.array(vSalesDocType),
  }),
  layoutVersions: defineTable({
    layoutId: v.id("layouts"),
    version: v.number(),
    config: v.object({
      template: v.union(v.literal("classic"), v.literal("modern"), v.literal("minimal")),
      accentColor: v.string(),
      font: v.union(v.literal("inter"), v.literal("noto"), v.literal("source-serif")),
      logoPosition: v.union(v.literal("left"), v.literal("right")),
      letterheadStorageId: v.optional(v.id("_storage")),
      letterheadPage2StorageId: v.optional(v.id("_storage")),
      printOptions: v.object({
        foldMarks: v.boolean(),
        pageNumbers: v.boolean(),
        senderLine: v.boolean(),
        vatPerLine: v.boolean(),
        productNumbers: v.boolean(),
        epcQr: v.boolean(),
        portalQr: v.boolean(),
        lineDescriptions: v.boolean(),
        grossLineTotals: v.boolean(),
        allInvoiceAccountsInFooter: v.boolean(),
        footerInLetterhead: v.union(v.null(), v.object({ confirmedAt: v.number(), items: v.array(v.string()) })),
      }),
    }),
    createdAt: v.number(),
  }).index("by_layout_version", ["layoutId", "version"]),

  // 03 §1 templates and lookups (F01 SET-080…097). Mutable settings; every write is audited.
  textTemplates: defineTable({
    kind: v.union(v.literal("document_head"), v.literal("document_foot"), v.literal("message_text")),
    docTypes: v.array(vSalesDocType),
    name: v.string(),
    /** message_text only: subject line of the copyable e-mail text (F04 SND-19). */
    subject: v.optional(v.string()),
    body: v.string(),
    isDefault: v.boolean(),
    language: v.union(v.literal("de"), v.literal("en")),
    level: v.optional(v.number()),
  }).index("by_kind", ["kind", "language"]),
  units: defineTable({
    code: v.string(),
    label: v.object({ de: v.string(), en: v.string() }),
    isSystem: v.boolean(),
    archivedAt: v.optional(v.number()),
  }).index("by_code", ["code"]),
  paymentMethods: defineTable({
    name: v.string(),
    text: v.string(),
    kind: v.union(
      v.literal("transfer"),
      v.literal("sepa_debit"),
      v.literal("cash"),
      v.literal("paypal"),
      v.literal("card"),
      v.literal("other"),
    ),
    isDefault: v.boolean(),
    /** SET-092: sepa_debit stays inactive until a creditor ID exists. */
    active: v.boolean(),
  }),
  tags: defineTable({ name: v.string(), color: v.optional(v.string()) }),
  customFieldDefs: defineTable({
    entity: v.union(v.literal("contact"), v.literal("product"), v.literal("document")),
    key: v.string(),
    label: v.string(),
    type: v.union(v.literal("text"), v.literal("number"), v.literal("date"), v.literal("select"), v.literal("boolean")),
    options: v.optional(v.array(v.string())),
    printOnDocuments: v.boolean(),
    required: v.optional(v.boolean()),
    position: v.number(),
    archivedAt: v.optional(v.number()),
  }).index("by_entity", ["entity", "key"]),
  costCenters: defineTable({
    number: v.string(),
    name: v.string(),
    isDefault: v.boolean(),
    archivedAt: v.optional(v.number()),
  }).index("by_number", ["number"]),

  // 03 §10 notificationSettings (singleton; P0: the owner notification address, F01 SET-009a)
  notificationSettings: defineTable({
    email: v.optional(v.object({ address: v.string(), digest: v.boolean() })),
    /** F12 NTF-004: ntfy server, topic, encrypted access token, „Details senden", consecutive failures (E-NTF-01). */
    ntfy: v.optional(
      v.object({
        serverUrl: v.string(),
        topic: v.string(),
        encryptedToken: v.optional(v.string()),
        sendDetails: v.boolean(),
        failures: v.optional(v.number()),
      }),
    ),
    channelsByKind: v.record(
      v.string(),
      v.object({ inApp: v.boolean(), email: v.boolean(), ntfy: v.boolean(), digest: v.boolean() }),
    ),
  }),

  // F12 PRV-016 / F01 SET-109/114: the owner's AVV (Auftragsverarbeitungsvertrag) confirmation per external service.
  serviceConfirmations: defineTable({
    serviceId: v.string(),
    confirmedAt: v.number(),
    confirmedBy: vActor,
    note: v.optional(v.string()),
  }).index("by_service", ["serviceId"]),

  // 03 §1 Templates and lookups — integrations (only the parts P0 uses: cloudflare_email, r2_checkpoint)
  integrations: defineTable({
    kind: v.union(
      v.literal("cloudflare_email"),
      v.literal("r2_checkpoint"),
      v.literal("r2_inbox"),
      v.literal("claude"),
      v.literal("peppol"),
      v.literal("tsa"),
      v.literal("stripe"),
      v.literal("mollie"),
      v.literal("paypal"),
    ),
    config: v.record(v.string(), v.any()),
    encryptedSecrets: v.optional(v.string()),
    enabled: v.boolean(),
    lastTestAt: v.optional(v.number()),
    lastTestOk: v.optional(v.boolean()),
    lastTestDetail: v.optional(v.string()),
    dpaConfirmedAt: v.optional(v.number()),
    region: v.optional(v.string()),
  }).index("by_kind", ["kind"]),

  // 03 §2 contacts (F02). `numberNormalized` (trim + upper case) backs the case-insensitive uniqueness of CON-003
  // (03 delta: `by_number` indexes the normalised number); `searchText` is the folded token string (CON-172).
  contacts: defineTable({
    kind: vContactKind,
    parentId: v.optional(v.id("contacts")),
    number: v.string(),
    numberNormalized: v.string(),
    roles: v.array(vContactRole),
    status: vContactStatus,
    mergedIntoId: v.optional(v.id("contacts")),
    organizationName: v.optional(v.string()),
    organizationName2: v.optional(v.string()),
    salutation: v.optional(v.union(v.literal("herr"), v.literal("frau"), v.literal("divers"), v.literal("none"))),
    academicTitle: v.optional(v.string()),
    firstName: v.optional(v.string()),
    lastName: v.optional(v.string()),
    position: v.optional(v.string()),
    birthday: v.optional(v.string()),
    displayName: v.string(),
    searchText: v.string(),
    isConsumer: v.boolean(),
    isPublicAuthority: v.boolean(),
    vatId: v.optional(v.string()),
    vatIdStatus: v.optional(
      v.object({
        lastCheckId: v.id("vatIdChecks"),
        status: vVatCheckStatus,
        qualified: v.boolean(),
        checkedAt: v.number(),
      }),
    ),
    taxNumber: v.optional(v.string()),
    /** BT-47 register number, e.g. "HRB 4711 B" (03/F02 delta, F04 INV-29: BR-AE-02 fallback for §13b). */
    registerNumber: v.optional(v.string()),
    buyerReference: v.optional(v.string()),
    electronicAddress: v.optional(
      v.object({ scheme: v.union(v.literal("EM"), v.literal("0204"), v.literal("9930")), value: v.string() }),
    ),
    defaultTaxCase: v.optional(v.string()),
    reverseCharge13bCertificates: v.array(
      v.object({
        file: v.optional(vFileRef),
        validUntil: v.string(),
        addedAt: v.number(),
        replacedAt: v.optional(v.number()),
      }),
    ),
    einvoice: v.object({
      preferredFormat: v.union(
        v.literal("auto"),
        v.literal("zugferd"),
        v.literal("xrechnung_cii"),
        v.literal("xrechnung_ubl"),
        v.literal("pdf"),
      ),
      pdfConsents: v.array(
        v.object({
          givenAt: v.string(),
          source: v.union(v.literal("email"), v.literal("contract"), v.literal("tacit"), v.literal("portal")),
          note: v.optional(v.string()),
          file: v.optional(vFileRef),
          revokedAt: v.optional(v.string()),
          recordedAt: v.number(),
        }),
      ),
    }),
    language: v.union(v.literal("de"), v.literal("en")),
    currency: v.string(),
    paymentTerms: v.optional(vPaymentTerms),
    defaultDiscountBp: v.optional(v.number()),
    paymentMethodId: v.optional(v.id("paymentMethods")),
    debtorAccount: v.optional(v.string()),
    creditorAccount: v.optional(v.string()),
    useCollectiveDebtor: v.optional(v.boolean()),
    iban: v.optional(v.string()),
    bic: v.optional(v.string()),
    /** F05 DUN-002 / PAY-053 (03 §2 `dunning`): policy, „Nicht mahnen“, „Zahlungstermin kalendermäßig vereinbart“. */
    dunning: v.optional(
      v.object({
        policyId: v.optional(v.id("dunningPolicies")),
        blocked: v.optional(v.boolean()),
        blockedReason: v.optional(v.string()),
        calendarDueDateAgreed: v.optional(v.boolean()),
      }),
    ),
    tags: v.array(v.id("tags")),
    customFields: v.record(v.string(), v.any()),
    notes: v.optional(v.string()),
    dsgvo: v.optional(
      v.object({
        restrictedAt: v.optional(v.number()),
        deletionRequestedAt: v.optional(v.number()),
        scheduledPurgeAt: v.optional(v.string()),
      }),
    ),
    version: v.number(),
    /** Technical sync stamp for `updated_since` (05 §3): every change of the contact or its addresses/channels. */
    updatedAt: v.optional(v.number()),
  })
    .index("by_number", ["numberNormalized"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_vatId", ["vatId"])
    .index("by_status_name", ["status", "displayName"])
    .index("by_mergedInto", ["mergedIntoId"])
    .index("by_parent", ["parentId"])
    .index("by_debtorAccount", ["debtorAccount"])
    .index("by_creditorAccount", ["creditorAccount"])
    .index("by_iban", ["iban"])
    .searchIndex("search", { searchField: "searchText", filterFields: ["status", "kind"] }),

  // 03 §2 contact sub-records (mutable; personal values are encrypted in audit diffs, F02 §5.12).
  contactAddresses: defineTable({
    contactId: v.id("contacts"),
    type: v.union(v.literal("billing"), v.literal("delivery"), v.literal("other")),
    address: vPostalAddress,
    isDefault: v.boolean(),
    archivedAt: v.optional(v.number()),
  }).index("by_contact", ["contactId", "type"]),
  // `e164` (03 delta): the parseable E.164 form of phone numbers stored next to the entered value (CON-032).
  contactChannels: defineTable({
    contactId: v.id("contacts"),
    type: v.union(v.literal("email"), v.literal("phone"), v.literal("mobile"), v.literal("fax"), v.literal("web")),
    value: v.string(),
    e164: v.optional(v.string()),
    label: v.optional(v.string()),
    isInvoiceEmail: v.boolean(),
    isPrimary: v.boolean(),
  })
    .index("by_contact", ["contactId", "type"])
    .index("by_type_value", ["type", "value"]),
  contactActivities: defineTable({
    contactId: v.id("contacts"),
    kind: v.union(v.literal("note"), v.literal("call"), v.literal("meeting"), v.literal("task")),
    text: v.optional(v.string()),
    dueAt: v.optional(v.number()),
    doneAt: v.optional(v.number()),
    // documentId?: Id<"salesDocuments"> arrives with F04.
    attachments: v.array(vFileRef),
    actor: vActor,
    editedAt: v.optional(v.number()),
  }).index("by_contact", ["contactId"]),

  // 03 §2 vatIdChecks 🔒 (append-only evidence, MISC-04). `fingerprint` (03 delta) = ID + name + address of the
  // request for the 24-hour reuse (CON-058); `message` = the German result text of the history (CON-061).
  vatIdChecks: defineTable({
    contactId: v.optional(v.id("contacts")),
    vatId: v.string(),
    provider: v.union(v.literal("bzst_evatr"), v.literal("eu_vies")),
    request: v.any(),
    response: v.any(),
    status: vVatCheckStatus,
    qualified: v.optional(
      v.object({ name: vQualifiedCode, street: vQualifiedCode, postalCode: vQualifiedCode, city: vQualifiedCode }),
    ),
    providerRequestId: v.optional(v.string()),
    checkedAt: v.number(),
    retentionUntil: v.string(),
    fingerprint: v.optional(v.string()),
    message: v.optional(v.string()),
  })
    .index("by_contact", ["contactId", "checkedAt"])
    .index("by_vatId", ["vatId", "checkedAt"]),

  // 03 §2 dismissedDuplicates (CON-131) and contactMerges (CON-132/134). `restore` (03 delta) keeps the winner's
  // overwritten field values and the loser's previous status so the undo restores exactly the recorded state.
  dismissedDuplicates: defineTable({ a: v.id("contacts"), b: v.id("contacts"), at: v.number(), actor: vActor }).index(
    "by_pair",
    ["a", "b"],
  ),
  contactMerges: defineTable({
    winnerId: v.id("contacts"),
    loserId: v.id("contacts"),
    moved: v.array(v.object({ table: v.string(), id: v.string() })),
    fieldChoices: v.record(v.string(), v.union(v.literal("winner"), v.literal("loser"))),
    restore: v.object({
      winner: v.record(v.string(), v.any()),
      loserStatus: vContactStatus,
    }),
    at: v.number(),
    actor: vActor,
    undoneAt: v.optional(v.number()),
  })
    .index("by_winner", ["winnerId"])
    .index("by_loser", ["loserId"]),

  // 03 §3 products (F03). `numberNormalized` (03 delta, PRD-002 case-insensitive uniqueness incl. archived) and
  // `searchText` (03 delta: one Convex search field for "name + number").
  products: defineTable({
    number: v.string(),
    numberNormalized: v.string(),
    name: v.string(),
    searchText: v.string(),
    description: v.optional(v.string()),
    internalNote: v.optional(v.string()),
    type: v.union(v.literal("service"), v.literal("good")),
    unitCode: v.string(),
    gtin: v.optional(v.string()),
    priceMode: vPriceMode,
    unitPriceMicros: v.number(),
    scheduledPrice: v.optional(v.object({ validFrom: v.string(), priceMode: vPriceMode, unitPriceMicros: v.number() })),
    purchasePriceMicros: v.optional(v.number()),
    vatRateKey: v.string(),
    exemptionReasonCode: v.optional(v.string()),
    placeOfSupplyRule: v.optional(v.string()),
    reverseCharge13b: v.optional(v.string()),
    revenueAccountOverride: v.optional(v.string()),
    laborCostShareBp: v.optional(v.number()),
    categoryId: v.optional(v.id("productCategories")),
    extraUnits: v.array(v.object({ unitCode: v.string(), factorMilli: v.number() })),
    tags: v.array(v.id("tags")),
    customFields: v.record(v.string(), v.any()),
    active: v.boolean(),
    version: v.number(),
    /** Technical sync stamp for `updated_since` (05 §3): every change of the product or its customer prices. */
    updatedAt: v.optional(v.number()),
  })
    .index("by_number", ["numberNormalized"])
    .index("by_updatedAt", ["updatedAt"])
    .index("by_active_name", ["active", "name"])
    .index("by_category", ["categoryId"])
    .searchIndex("search", { searchField: "searchText", filterFields: ["active", "type"] }),
  productCategories: defineTable({
    name: v.string(),
    parentId: v.optional(v.id("productCategories")),
  }).index("by_parent", ["parentId"]),
  customerPrices: defineTable({
    productId: v.id("products"),
    contactId: v.id("contacts"),
    unitPriceMicros: v.number(),
    priceMode: vPriceMode,
    validFrom: v.optional(v.string()),
  })
    .index("by_product_contact_validFrom", ["productId", "contactId", "validFrom"])
    .index("by_contact", ["contactId"]),

  // 03 §2 contactKeys — crypto-shredding of personal values in audit diffs.
  // contactId stays a string: it is the audit entity id of the contact (appendAudit is generic over tables) and the
  // key row must outlive a hard-deleted draft contact (03 §13 consolidation log).
  contactKeys: defineTable({
    contactId: v.string(),
    wrappedKey: v.optional(v.string()),
    createdAt: v.number(),
    shreddedAt: v.optional(v.number()),
  }).index("by_contact", ["contactId"]),

  // 03 §10 auditLog 🔒 — append-only, hash-chained
  auditLog: defineTable({
    seq: v.number(),
    prevHash: v.string(),
    hash: v.string(),
    at: v.number(),
    actor: vActor,
    actorRole: v.optional(vMemberRole),
    actorLabel: v.optional(v.string()),
    client: v.optional(v.object({ name: v.string(), version: v.string() })),
    channel: vChannel,
    ip: v.optional(v.string()),
    userAgent: v.optional(v.string()),
    requestId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    action: v.string(),
    entity: v.object({ table: v.string(), id: v.string(), label: v.optional(v.string()) }),
    diff: v.optional(v.object({ before: v.optional(v.any()), after: v.optional(v.any()) })),
    diffBlob: v.optional(v.object({ storageId: v.id("_storage"), sha256: v.string() })),
    reason: v.optional(v.string()),
  })
    .index("by_seq", ["seq"])
    .index("by_entity", ["entity.table", "entity.id"])
    .index("by_actor_at", ["actor", "at"]),

  // 03 §10 integrityCheckpoints 🔒
  integrityCheckpoints: defineTable({
    date: v.string(),
    lastSeq: v.number(),
    lastHash: v.string(),
    counts: v.record(v.string(), v.number()),
    artifactsCount: v.number(),
    journalSeq: v.number(),
    appVersion: v.string(),
    schemaVersion: v.string(),
    prevCheckpointHash: v.string(),
    jws: v.string(),
    kid: v.string(),
    tsaToken: v.optional(v.string()),
    exportedTo: v.optional(v.string()),
    uploadStatus: v.union(v.literal("pending"), v.literal("uploaded"), v.literal("failed")),
    at: v.number(),
  })
    .index("by_date", ["date"])
    .index("by_at", ["at"]),

  // 03 §10 integrityRuns
  integrityRuns: defineTable({
    at: v.number(),
    ok: v.boolean(),
    scope: v.union(v.literal("incremental"), v.literal("full"), v.literal("startup")),
    lastVerifiedSeq: v.number(),
    findings: v.array(vIntegrityFinding),
    acknowledgedAt: v.optional(v.number()),
    acknowledgedNote: v.optional(v.string()),
    acknowledgedBy: v.optional(vActor),
  }).index("by_at", ["at"]),

  // F12 AUD-024 verfahrensdokuInputs — the owner's structured inputs (singleton, audited)
  verfahrensdokuInputs: defineTable({ values: v.record(v.string(), v.string()), updatedAt: v.number() }),
  // F12 AUD-025 verfahrensdokuVersions 🔒 — released versions; only supersededAt/retentionUntil are set once
  // (P1: Markdown file with SHA-256 instead of PDF/A, see the report)
  verfahrensdokuVersions: defineTable({
    version: v.number(),
    validFrom: v.string(),
    releasedAt: v.number(),
    releasedBy: vActor,
    sourceJson: v.string(),
    file: vFileRef,
    supersededAt: v.optional(v.number()),
    retentionUntil: v.optional(v.string()),
    watchSnapshot: v.record(v.string(), v.string()),
  }).index("by_version", ["version"]),

  // F12 AUD-019 clockReadings — technical rolling log (7 days) of the 10-minute clock check; not business data.
  clockReadings: defineTable({
    at: v.number(),
    offsetMs: v.union(v.number(), v.null()),
    reference: v.string(),
    status: v.union(v.literal("ok"), v.literal("warning"), v.literal("error"), v.literal("unknown")),
    detail: v.string(),
  }).index("by_at", ["at"]),

  // 03 §10 apiKeys (the key itself is stored as SHA-256 only; prefix = public key id in api-key:/mcp: actors)
  // 03 §10 restoreDrills 🔒 (AUD-027, SEC-05): every restore drill and production restore is recorded, append-only.
  restoreDrills: defineTable({
    date: v.string(),
    backupObject: v.string(),
    targetEnvironment: v.string(),
    integrityOk: v.boolean(),
    headMatchesCheckpoint: v.boolean(),
    notes: v.optional(v.string()),
    kind: v.union(v.literal("drill"), v.literal("production_restore")),
    restoredHeadSeq: v.optional(v.number()),
    gapToCheckpoint: v.optional(v.number()),
    actor: vActor,
    at: v.number(),
  }).index("by_date", ["date"]),

  apiKeys: defineTable({
    name: v.string(),
    prefix: v.string(),
    last4: v.string(),
    hash: v.string(),
    scopes: v.array(v.string()),
    channel: v.union(v.literal("api"), v.literal("mcp"), v.literal("both")),
    createdAt: v.number(),
    createdBy: vActor,
    lastUsedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    rateLimitPerMinute: v.optional(v.number()),
  })
    .index("by_prefix", ["prefix"])
    .index("by_hash", ["hash"]),

  // 03 §10 idempotencyKeys (05 §3, technical, 24 h): one row per (API key, Idempotency-Key). `status` 0 = the first
  // request is still running; the stored response is replayed for the same request hash.
  idempotencyKeys: defineTable({
    apiKeyId: v.string(),
    key: v.string(),
    requestHash: v.string(),
    status: v.number(),
    responseBody: v.string(),
    expiresAt: v.number(),
  })
    .index("by_apiKey_key", ["apiKeyId", "key"])
    .index("by_expiresAt", ["expiresAt"]),

  // 03 §10 apiRequestLog (05 §7 access log, technical, 90 days): one row per REST/MCP request — no bodies, no IP.
  apiRequestLog: defineTable({
    apiKeyId: v.string(),
    channel: v.union(v.literal("api"), v.literal("mcp")),
    method: v.string(),
    /** REST path template (`/contacts/{id}`) or MCP method/tool (`tools/call contact_get`). */
    target: v.string(),
    status: v.number(),
    durationMs: v.number(),
    requestId: v.string(),
    code: v.optional(v.string()),
    client: v.optional(v.object({ name: v.string(), version: v.string() })),
    at: v.number(),
  })
    .index("by_apiKey_at", ["apiKeyId", "at"])
    .index("by_at", ["at"]),

  // 03 §10 confirmTokens (06 §2.3, technical, 10 min): only the SHA-256 of the token is stored.
  confirmTokens: defineTable({
    tokenHash: v.string(),
    apiKeyId: v.string(),
    intent: v.string(),
    paramsHash: v.string(),
    entities: v.array(v.object({ table: v.string(), id: v.string(), version: v.union(v.number(), v.null()) })),
    expiresAt: v.number(),
    usedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),

  // 03 §10 members / invites (02 §4.3)
  members: defineTable({
    authUserId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    role: vMemberRole,
    expiresAt: v.optional(v.number()),
    auditor: v.optional(
      v.object({
        organisation: v.optional(v.string()),
        purpose: v.string(),
        fiscalYears: v.array(v.number()),
        extensions: v.array(v.object({ at: v.number(), expiresAt: v.number(), reason: v.string() })),
        firstAccessAt: v.optional(v.number()),
        lastAccessAt: v.optional(v.number()),
      }),
    ),
    totpEnabled: v.boolean(),
    invitedBy: v.optional(vActor),
    inviteId: v.optional(v.id("invites")),
    createdAt: v.number(),
    disabledAt: v.optional(v.number()),
    disabledReason: v.optional(v.string()),
  })
    .index("by_authUserId", ["authUserId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"]),

  invites: defineTable({
    email: v.string(),
    role: vInviteRole,
    memberExpiresAt: v.optional(v.number()),
    auditor: v.optional(vAuditorScope),
    expiresAt: v.number(),
    createdBy: vActor,
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
    mailOutcome: v.optional(v.union(v.literal("ok"), v.literal("failed"))),
    acceptedAt: v.optional(v.number()),
    acceptedUserId: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
  }).index("by_email", ["email"]),

  // ── 03 §5 payments and receivables (F05 P1, F07 matching) ───────────────────────────────────────────
  // payments 🔒 — one row per allocation (target); a combined payment shares `allocationGroupId`. Written only by
  // convex/model/payments.ts in the same transaction as its journal entries, the target's open amount/status and the
  // bank allocation (PAY-016). Corrected by a reversal row, never edited (PAY-040); after insert only `reversedById`,
  // `lockedAt`, `reconciledTransactionId`, `receiptFile` (once) and `journalEntryIds` (append) change.
  payments: defineTable({
    target: vPaymentTarget,
    /** Denormalised: the contact of the target (contactCredit: the target id) — per-customer views (PAY-004). */
    contactId: v.optional(v.id("contacts")),
    /** Display cache: number of the target document. */
    number: v.optional(v.string()),
    date: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    eurAmountCents: v.optional(v.number()),
    source: vPaymentSource,
    /** Denormalised from `source` (bank) for the transaction index (BNK-047 unmatch, EC-PAY-24). */
    bankTransactionId: v.optional(v.id("bankTransactions")),
    differences: v.array(vPaymentDifference),
    allocationGroupId: v.optional(v.string()),
    journalEntryIds: v.array(v.id("journalEntries")),
    reversalOfId: v.optional(v.id("payments")),
    reversedById: v.optional(v.id("payments")),
    reason: v.optional(v.string()),
    reconciledTransactionId: v.optional(v.id("bankTransactions")),
    backdateReason: v.optional(v.string()),
    note: v.optional(v.string()),
    receiptFile: v.optional(vFileRef),
    /** Bank match provenance (BNK-042/043): score, reason chips, auto-applied. */
    match: v.optional(vMatchProvenance),
    actor: vActor,
    recordedAt: v.number(),
    lockedAt: v.optional(v.number()),
  })
    .index("by_target", ["target.kind", "target.id"])
    .index("by_contact", ["contactId"])
    .index("by_bankTransaction", ["bankTransactionId"])
    .index("by_reconciled", ["reconciledTransactionId"])
    .index("by_allocationGroup", ["allocationGroupId"])
    .index("by_date", ["date"]),

  // matchRejections — „Ablehnen“ on a suggestion (BNK-046): the pair is not suggested again. Not protected, audited.
  matchRejections: defineTable({
    transactionId: v.id("bankTransactions"),
    target: v.object({ kind: v.string(), id: v.string() }),
    at: v.number(),
    actor: vActor,
  }).index("by_transaction", ["transactionId"]),

  // contactAliases — learned on a confirmed match (BNK-048): normalised counterparty name token and IBAN.
  contactAliases: defineTable({
    contactId: v.id("contacts"),
    token: v.string(),
    iban: v.optional(v.string()),
    source: v.union(v.literal("match_confirmed"), v.literal("manual")),
    createdAt: v.number(),
  })
    .index("by_token", ["token"])
    .index("by_contact", ["contactId"]),

  // ── 03 §8 bookkeeping (F08, P1) ──────────────────────────────────────────────────────────────────────
  // journalEntries 🔒 — the single double-entry journal; append-only, written only by convex/model/journal.ts
  // (ACC-002); `seq` gapless, assigned in the posting transaction (GOBD-05); corrections by reversal (ACC-004).
  journalEntries: defineTable({
    seq: v.number(),
    date: v.string(),
    period: v.string(),
    originalDate: v.optional(v.string()),
    latePosting: v.optional(v.object({ reason: v.string() })),
    lines: v.array(vJournalLine),
    text: v.string(),
    longText: v.optional(v.string()),
    source: v.object({ kind: vJournalSourceKind, id: v.string() }),
    attachments: v.optional(v.array(vFileRef)),
    ruleVersion: v.string(),
    roleMappingVersion: v.string(),
    explanation: v.string(),
    reversalOfId: v.optional(v.id("journalEntries")),
    recordedAt: v.number(),
    lockedAt: v.optional(v.number()),
    actor: vActor,
  })
    .index("by_seq", ["seq"])
    .index("by_period", ["period", "seq"])
    .index("by_source", ["source.kind", "source.id"])
    .index("by_reversalOf", ["reversalOfId"]),

  // journalLines 🔒 — derived read model (03 §8 "by_account via lines read model"): one row per entry line, written
  // in the same transaction as its entry, never changed. Not audited separately: RI-12 checks that it mirrors the
  // audited entries. Serves account balances, the Kontenblatt and the cash never-negative check (CSH-026).
  journalLines: defineTable({
    entryId: v.id("journalEntries"),
    lineIndex: v.number(),
    seq: v.number(),
    date: v.string(),
    period: v.string(),
    account: v.string(),
    role: v.optional(v.string()),
    debitCents: v.number(),
    creditCents: v.number(),
    contactId: v.optional(v.id("contacts")),
  })
    .index("by_account_date_seq", ["account", "date", "seq"])
    .index("by_entry", ["entryId", "lineIndex"])
    .index("by_date", ["date", "seq"])
    .index("by_contact", ["contactId", "date"]),

  // accountRoleMappings 🔒 — owner overrides of the shipped mapping (rule data roles-2026.2 in
  // src/domain/rules/accounting); append-only versions, resolution = latest validFrom ≤ posting date (ACC-008).
  accountRoleMappings: defineTable({
    chart: vChart,
    role: v.string(),
    account: v.string(),
    validFrom: v.string(),
    mappingVersion: v.string(),
    source: v.union(v.literal("seed"), v.literal("override")),
    sourceText: v.optional(v.string()),
    confirmedByAdvisorOn: v.optional(v.string()),
  }).index("by_chart_role_validFrom", ["chart", "role", "validFrom"]),

  // periods (03 §8) — Festschreibung per month; the lock itself is P2 (ACC-015). P1 posting already honours it
  // (ACC-006): user-dated postings into a locked/locking month are refused, external ones move forward.
  periods: defineTable({
    period: v.string(),
    status: v.union(v.literal("open"), v.literal("locking"), v.literal("locked")),
    lockedAt: v.optional(v.number()),
    lockedBy: v.optional(vActor),
    reason: v.optional(
      v.union(
        v.literal("ustva_submitted"),
        v.literal("zm_submitted"),
        v.literal("euer_submitted"),
        v.literal("manual"),
        v.literal("datev_export"),
        v.literal("year_close"),
      ),
    ),
  }).index("by_period", ["period"]),

  // openingItems 🔒 — open receivables carried into the books by the opening balance (ACC-013, P1 subset): the
  // original document reference and VAT split (Ist) so later payments (target kind "opening_item") clear them.
  openingItems: defineTable({
    fiscalYear: v.number(),
    kind: v.literal("receivable"),
    number: v.string(),
    documentDate: v.string(),
    dueDate: v.optional(v.string()),
    contactId: v.optional(v.id("contacts")),
    counterpartyName: v.string(),
    grossCents: v.number(),
    openCents: v.number(),
    taxedAs: v.union(v.literal("soll"), v.literal("ist")),
    notDueVat: v.optional(v.array(v.object({ rateBp: v.number(), vatCents: v.number() }))),
    openAmountCents: v.number(),
    recordedAt: v.number(),
    lockedAt: v.optional(v.number()),
    actor: vActor,
    /** The archived sevdesk invoice this receivable carries (F09 IMP-007); set at insert, never changed. */
    documentId: v.optional(v.id("salesDocuments")),
  })
    .index("by_fiscalYear", ["fiscalYear", "number"])
    .index("by_contact", ["contactId"])
    .index("by_document", ["documentId"]),

  // ── 03 §6 dunning (F05 §3.7–§3.10, §4.4–§4.6) ─────────────────────────────────────────────────────────────
  // Policies are settings (mutable, audited); cases are mutable bookkeeping of one invoice; runs are append-only
  // (DUN-037). The app never sends reminders (B2): no e-mail template, no send switch.
  dunningPolicies: defineTable({
    name: v.string(),
    isDefault: v.boolean(),
    appliesTo: v.object({ consumer: v.boolean(), business: v.boolean() }),
    steps: v.array(
      v.object({
        level: v.number(),
        daysAfter: v.number(),
        title: v.string(),
        feeCents: v.number(),
        addInterest: v.boolean(),
        addFlatFee40: v.boolean(),
        newDueDays: v.number(),
        textTemplateId: v.optional(v.id("textTemplates")),
        autoFinalize: v.boolean(),
      }),
    ),
    dueSoonDays: v.optional(v.number()),
    dueSoonTodo: v.boolean(),
    minOpenAmountCents: v.number(),
    pauseOnPartialPaymentDays: v.number(),
    stopAfterLastLevel: v.boolean(),
    archivedAt: v.optional(v.number()),
    version: v.number(),
  }),
  dunningCases: defineTable({
    invoiceId: v.id("salesDocuments"),
    policyId: v.optional(v.id("dunningPolicies")),
    currentLevel: v.number(),
    status: v.union(v.literal("active"), v.literal("paused"), v.literal("closed"), v.literal("handed_over")),
    pausedUntil: v.optional(v.string()),
    pausedReason: v.optional(v.string()),
    disputed: v.optional(v.object({ at: v.number(), reason: v.string() })),
    handedOver: v.optional(v.object({ at: v.number(), partner: v.string() })),
    defaultStartDate: v.optional(v.string()),
    defaultRoute: v.optional(v.union(v.literal("calendar"), v.literal("reminder"), v.literal("30_days"))),
    flatFeeCharged: v.boolean(),
    /** The reminder that first claimed the 40 € (EC-DUN-02 message, DUN-009 reset). */
    flatFeeReminderId: v.optional(v.id("salesDocuments")),
    reminders: v.array(v.id("salesDocuments")),
    nextActionDate: v.optional(v.string()),
    limitationDate: v.string(),
    /** DUN-035: reopened by a reversal — automation waits until this day. */
    graceUntil: v.optional(v.string()),
    /** DUN-055: reminders whose `todo_mark_sent` was logged (once each). */
    todoLogged: v.optional(v.array(v.id("salesDocuments"))),
  }).index("by_invoice", ["invoiceId"]),
  dunningRuns: defineTable({
    date: v.string(),
    mode: v.union(v.literal("auto"), v.literal("manual")),
    evaluated: v.number(),
    actions: v.array(
      v.object({
        invoiceId: v.id("salesDocuments"),
        action: v.union(
          v.literal("create_draft"),
          v.literal("finalize"),
          v.literal("skip"),
          v.literal("todo_mark_sent"),
        ),
        level: v.optional(v.number()),
        skipReason: v.optional(v.string()),
        reminderId: v.optional(v.id("salesDocuments")),
        error: v.optional(v.string()),
      }),
    ),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    actor: vActor,
  }).index("by_date", ["date"]),

  // 03 §4 salesDocuments 🔒 (F04). P1 invoices core: the fields plain invoices use; quotes/advances/Storno/
  // corrections/reminders add theirs with their slices (the matrix row in src/domain/audit/immutability.ts already
  // covers the 03 §11 whitelist). Drafts carry the live contact; finalisation freezes the snapshot (DOC-22/27).
  salesDocuments: defineTable({
    type: vSalesDocType,
    status: vSalesDocStatus,
    paymentStatus: v.optional(vPaymentStatus),
    number: v.optional(v.string()),
    numberRangeId: v.optional(v.id("numberRanges")),
    contactId: v.optional(v.id("contacts")),
    /** Display cache for lists/search (contact name at the last draft save; the snapshot holds the frozen buyer). */
    contactName: v.optional(v.string()),
    billingAddressId: v.optional(v.id("contactAddresses")),
    billingAddress: v.optional(vPostalAddress),
    deliveryAddress: v.optional(vPostalAddress),
    documentDate: v.optional(v.string()),
    supplyDate: v.optional(vSupplyDate),
    supplyDateMode: v.union(v.literal("explicit"), v.literal("document_date")),
    dueDate: v.optional(v.string()),
    currency: v.string(),
    fxRateToEur: v.optional(vFxRate),
    priceMode: vPriceMode,
    taxCase: vTaxCase,
    taxCaseOverridden: v.optional(v.object({ reason: v.string(), derived: v.optional(vTaxCase) })),
    subject: v.optional(v.string()),
    headText: v.optional(v.string()),
    footText: v.optional(v.string()),
    buyerReference: v.optional(v.string()),
    orderReference: v.optional(v.string()),
    contractReference: v.optional(v.string()),
    paymentTerms: vPaymentTerms,
    paymentMethodId: v.optional(v.id("paymentMethods")),
    bankAccountId: v.optional(v.id("bankAccounts")),
    showEpcQr: v.boolean(),
    propertyRelated: v.optional(v.boolean()),
    kleinbetrag: v.optional(v.boolean()),
    constructionWork: v.optional(v.boolean()),
    /** UST-24: margin scheme / travel service declared (always blocked at finalisation). */
    marginScheme: v.optional(v.boolean()),
    documentDiscount: v.optional(
      v.object({
        kind: v.union(v.literal("percent"), v.literal("amount")),
        valueBp: v.optional(v.number()),
        amountCents: v.optional(v.number()),
        isSurcharge: v.boolean(),
        reason: v.optional(v.string()),
      }),
    ),
    language: v.union(v.literal("de"), v.literal("en")),
    layoutId: v.optional(v.id("layouts")),
    einvoice: v.object({
      /** Chosen format; absent on drafts = the §4.6.3 default. Set at finalisation. */
      format: v.optional(vEinvoiceFormat),
      decision: v.optional(vEr03Decision),
      decidedAt: v.optional(v.number()),
      /** INV-20 preview validation result (`skipped` only with IS_TEST and no sidecar). */
      validation: v.optional(v.union(v.literal("passed"), v.literal("skipped"), v.literal("not_required"))),
    }),
    /** Overrides released at finalisation with an audited reason (EC-044 VAT-ID check, CON-071 §13b). */
    overrides: v.optional(
      v.object({
        vatCheck: v.optional(v.object({ reason: v.string() })),
        rc13bCertificate: v.optional(v.object({ reason: v.string() })),
      }),
    ),
    totals: vDocumentTotals,
    openAmountCents: v.optional(v.number()),
    // ── receivables (F05 §3.7–§3.10) ──
    /** Reminders (type `reminder`): the dunned invoice, level and the frozen claim (DUN-004/005). */
    reminder: v.optional(
      v.object({
        invoiceId: v.id("salesDocuments"),
        level: v.number(),
        title: v.string(),
        feeCents: v.number(),
        interestCents: v.number(),
        flatFee40Cents: v.number(),
        newDueDate: v.string(),
        newDueDays: v.number(),
        totalCents: v.number(),
        openAmountCents: v.number(),
        interestSegments: v.optional(
          v.array(
            v.object({
              from: v.string(),
              to: v.string(),
              days: v.number(),
              principalCents: v.number(),
              rateBp: v.number(),
              amountCents: v.number(),
            }),
          ),
        ),
        defaultStartDate: v.optional(v.string()),
        /** Manual amounts kept on the draft (DUN-008); recomputed values apply where absent. */
        manual: v.optional(
          v.object({
            feeCents: v.optional(v.number()),
            interestCents: v.optional(v.number()),
            interestReason: v.optional(v.string()),
            includeFlatFee: v.optional(v.boolean()),
            newDueDate: v.optional(v.string()),
          }),
        ),
        createdByRun: v.optional(v.boolean()),
      }),
    ),
    /** „Nicht mahnen“ on the invoice (DUN-002). */
    dunningBlocked: v.optional(v.object({ reason: v.string(), at: v.number() })),
    /** „Bestritten“ (DUN-034). */
    disputed: v.optional(v.object({ at: v.number(), reason: v.string() })),
    /** `invoice.overdue` / due-soon to-do emitted once (PAY-044, DUN-053). */
    overdueNotifiedAt: v.optional(v.number()),
    zugang: v.optional(
      v.object({
        date: v.string(),
        basis: v.union(vSendChannel, v.literal("manual")),
        reason: v.optional(v.string()),
      }),
    ),
    snapshotId: v.optional(v.id("documentSnapshots")),
    artifactStatus: v.optional(v.union(v.literal("pending"), v.literal("ready"), v.literal("blocked"))),
    artifactAttempts: v.optional(v.number()),
    artifactError: v.optional(v.string()),
    finalizedAt: v.optional(v.number()),
    finalizedBy: v.optional(vActor),
    /** OCC version the document was finalised from (§4.6.4 idempotent replay). */
    finalizedFromVersion: v.optional(v.number()),
    backdateReason: v.optional(v.string()),
    sentAt: v.optional(v.number()),
    sentOn: v.optional(v.string()),
    firstExportedAt: v.optional(v.number()),
    lockedAt: v.optional(v.number()),
    retentionClass: v.union(v.literal("vouchers8"), v.literal("letters6")),
    retentionUntil: v.optional(v.string()),
    /** UVA-07/TAX-017: OSS-relevant net in EUR (§ 3c Abs. 4 UStG), set at finalisation of invoice-family documents. */
    ossNetEurCents: v.optional(v.number()),
    tags: v.array(v.id("tags")),
    customFields: v.record(v.string(), v.any()),
    internalNote: v.optional(v.string()),
    /** DOC-53: cost centre of the document (DATEV KOST1 default for its lines). */
    costCenterId: v.optional(v.id("costCenters")),
    /** DOC-18: ≤ 10 attachments, frozen at finalisation (`includeInExport` SND-16, `embedInXml` BG-24). */
    attachments: v.optional(
      v.array(v.object({ file: vFileRef, embedInXml: v.boolean(), includeInExport: v.boolean() })),
    ),
    /** INV-30: proofs appended after finalisation; append-only, not part of the snapshot. */
    evidence: v.optional(
      v.array(
        v.object({
          file: vFileRef,
          kind: v.union(
            v.literal("gelangensbestaetigung"),
            v.literal("cmr"),
            v.literal("ausfuhrnachweis"),
            v.literal("other"),
          ),
          note: v.optional(v.string()),
          addedAt: v.number(),
          actor: vActor,
        }),
      ),
    ),
    // ── quotes, order confirmations, delivery notes, proforma and conversions (F04 §3.2 QUO, §4.3) ─────────────
    /** Quotes: 1, 2, … (QUO-06); not the OCC counter `version`. */
    revision: v.optional(v.number()),
    /** Quotes (QUO-01): set at finalisation (default document date + `quoteValidityDays`). */
    validUntil: v.optional(v.string()),
    /** Quotes and order confirmations (QUO-01, QUO-08). */
    deliveryTerms: v.optional(v.string()),
    /** Delivery notes (QUO-09): print prices and totals; lines keep their prices either way. */
    showPrices: v.optional(v.boolean()),
    /** Conversion source (quote → order → invoice) or previous quote version (QUO-06, DOC-33). */
    originId: v.optional(v.id("salesDocuments")),
    /** Many-to-one conversions: the delivery notes of a collective invoice (QUO-11). */
    sourceDocumentIds: v.optional(v.array(v.id("salesDocuments"))),
    /** The first document of the chain (DOC-34); absent on the root itself. */
    chainRootId: v.optional(v.id("salesDocuments")),
    /** Quotes/orders: derived invoicing progress cache (§4.3.3), recomputed, never edited. */
    coverage: v.optional(
      v.object({
        prepaidByGroup: v.array(
          v.object({ category: vVatCategory, rateBp: v.number(), netCents: v.number(), vatCents: v.number() }),
        ),
        coveredBp: v.number(),
      }),
    ),
    /** QUO-05 „Angenommen“ (set once): recording instant, business date, by whom, channel, accepted snapshot hash. */
    acceptance: v.optional(
      v.object({
        at: v.number(),
        date: v.string(),
        byName: v.string(),
        channel: v.union(v.literal("manual"), v.literal("portal"), v.literal("email"), v.literal("phone")),
        note: v.optional(v.string()),
        snapshotHash: v.string(),
      }),
    ),
    /** QUO-05 „Abgelehnt“ (set once; a later rejection after reopening is recorded in the audit log only). */
    rejection: v.optional(
      v.object({
        at: v.number(),
        date: v.string(),
        reason: v.optional(v.string()),
        channel: v.union(v.literal("manual"), v.literal("portal")),
      }),
    ),
    /** Delivery note „Erhalten“ (§4.2.3). */
    received: v.optional(v.object({ date: v.string(), byName: v.string() })),
    // ── advance/partial/final chains, Storno and corrections (F04 §4.7/§4.8, INV-03…15) ──────────────────────
    /** Standalone advance chain (no quote/order in the app): the customer's order the chain refers to (INV-03). */
    chainOrder: v.optional(v.object({ number: v.string(), date: v.string() })),
    /** Storno / Rechnungskorrektur / Rechnungsberichtigung → the original (BT-25/26). */
    correctsId: v.optional(v.id("salesDocuments")),
    /** `correction` only: Rechnungskorrektur (381) or Rechnungsberichtigung (384). */
    correctionKind: v.optional(v.union(v.literal("credit"), v.literal("rectification"))),
    /** Rechnungsberichtigung: the corrected items (keys, INV-13). */
    rectifiedFields: v.optional(v.array(v.string())),
    /** Final invoice: one row per deducted advance with the received amounts (INV-06/07/09, RI-08). */
    deductions: v.optional(
      v.array(
        v.object({
          advanceId: v.id("salesDocuments"),
          advanceNumber: v.string(),
          advanceDate: v.string(),
          byGroup: v.array(
            v.object({
              category: vVatCategory,
              rateBp: v.number(),
              netCents: v.number(),
              vatCents: v.number(),
              grossCents: v.number(),
            }),
          ),
          deductedGrossCents: v.number(),
          partiallyPaid: v.boolean(),
        }),
      ),
    ),
    /** Advance/partial: the final invoice that deducted it (set by the final's finalisation, cleared by its Storno). */
    deductedInId: v.optional(v.id("salesDocuments")),
    /** Credit correction: the part absorbed by the original's open amount at finalisation (§4.2.5, INV-15). */
    creditAppliedCents: v.optional(v.number()),
    /** Withdrawal of a quote/order/delivery note/proforma (QUO-15) or Storno: when, why, by which document. */
    cancellation: v.optional(
      v.object({ at: v.number(), reason: v.string(), byDocumentId: v.optional(v.id("salesDocuments")) }),
    ),
    // ── recurring invoices (F04 §3.4, REC-05) ──────────────────────────────────────────────────────────────
    /** The template this invoice was generated from (detail page „Erzeugte Rechnungen“, REST filter). */
    recurringTemplateId: v.optional(v.id("recurringTemplates")),
    /** REC-05 idempotency key (templateId, occurrence date) — unique, enforced in convex/model/recurring.ts. */
    recurringOccurrence: v.optional(v.object({ templateId: v.id("recurringTemplates"), date: v.string() })),
    // ── archived imports (F09 IMP-003, EC-190) ──
    /** Read-only archive record with the original PDF as artifact; never re-rendered, no snapshot. */
    imported: v.optional(v.literal(true)),
    origin: v.optional(
      v.object({
        source: v.union(v.literal("sevdesk_export"), v.literal("lexoffice_csv"), v.literal("generic_csv")),
        externalId: v.string(),
        importId: v.id("imports"),
        /**
         * F09 E-IMP-10 / EC-204: dated on/after the Buchungsbeginn and posted at import like an own finalised document
         * (its receivable is the journal entry, not an F08 opening item; payments settle it directly). Set at insert.
         */
        posted: v.optional(v.literal(true)),
      }),
    ),
    createdBy: vActor,
    channel: vChannel,
    version: v.number(),
  })
    .index("by_origin", ["origin.source", "origin.externalId"])
    .index("by_recurringOccurrence", ["recurringOccurrence.templateId", "recurringOccurrence.date"])
    .index("by_type_status_date", ["type", "status", "documentDate"])
    .index("by_chainRoot", ["chainRootId"])
    .index("by_correctsId", ["correctsId"])
    .index("by_contact", ["contactId", "type"])
    .index("by_number", ["number"])
    .index("by_artifactStatus", ["artifactStatus"])
    .index("by_firstExportedAt", ["status", "firstExportedAt"])
    .index("by_paymentStatus_due", ["paymentStatus", "dueDate"])
    .index("by_reminderInvoice", ["reminder.invoiceId"])
    .searchIndex("search", { searchField: "contactName", filterFields: ["type", "status"] }),

  // 03 §4 documentLines 🔒 (frozen with the parent; the guarded db passes the parent status to the matrix).
  documentLines: defineTable({
    documentId: v.id("salesDocuments"),
    position: v.number(),
    kind: v.union(v.literal("item"), v.literal("heading"), v.literal("text"), v.literal("subtotal")),
    productId: v.optional(v.id("products")),
    productType: v.optional(v.union(v.literal("good"), v.literal("service"))),
    productSyncedVersion: v.optional(v.number()),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    quantityMilli: v.optional(v.number()),
    unitCode: v.optional(v.string()),
    unitPriceMicros: v.optional(v.number()),
    discount: v.optional(vDiscount),
    vatRateKey: v.optional(v.string()),
    vatCategoryOverride: v.optional(vVatCategory),
    vatCategory: v.optional(vVatCategory),
    vatRateBp: v.optional(v.number()),
    exemptionReasonCode: v.optional(v.string()),
    exemptionReasonText: v.optional(v.string()),
    placeOfSupplyRule: v.optional(v.string()),
    reverseCharge13b: v.optional(v.string()),
    linePeriod: v.optional(v.object({ from: v.string(), to: v.string() })),
    lineNetCents: v.optional(v.number()),
    isLaborCost: v.optional(v.boolean()),
    revenueAccount: v.optional(v.string()),
    /** DOC-53: line cost centre (DATEV KOST1). */
    costCenterId: v.optional(v.id("costCenters")),
    itemNumber: v.optional(v.string()),
    /** Quotes only (DOC-04, QUO-02): excluded from totals and VAT. */
    optional: v.optional(v.boolean()),
    /** The quote/order/delivery-note line this line was converted from (§4.3.3). */
    sourceLineId: v.optional(v.id("documentLines")),
    invoicedQtyMilli: v.optional(v.number()),
    deliveredQtyMilli: v.optional(v.number()),
    /** Imported archive document rebuilt from a list row: one summary line per VAT rate (F09 IMP-020). */
    fromSummary: v.optional(v.literal(true)),
  })
    .index("by_document", ["documentId", "position"])
    .index("by_product", ["productId"]),

  // 03 §4 documentSnapshots 🔒 (append-only, DOC-27, RI-01)
  documentSnapshots: defineTable({
    documentId: v.id("salesDocuments"),
    json: v.string(),
    snapshotHash: v.string(),
    ruleVersions: v.record(v.string(), v.string()),
    layoutVersionId: v.string(),
    createdAt: v.number(),
  }).index("by_document", ["documentId"]),

  // 03 §4 documentArtifacts 🔒 (append-only, DOC-28/32, SND-02). `variant` also marks the "Kopie" of a hybrid PDF.
  documentArtifacts: defineTable({
    documentId: v.optional(v.id("salesDocuments")),
    kind: v.union(
      v.literal("pdf"),
      v.literal("zugferd_pdf"),
      v.literal("xrechnung_xml"),
      v.literal("validation_report_kosit"),
      v.literal("validation_report_mustang"),
    ),
    variant: v.optional(v.union(v.literal("original"), v.literal("copy"), v.literal("reading"))),
    storageId: v.id("_storage"),
    sha256: v.string(),
    bytes: v.number(),
    mime: v.string(),
    name: v.string(),
    tool: v.optional(v.object({ name: v.string(), version: v.string(), config: v.optional(v.string()) })),
    createdAt: v.number(),
    retentionUntil: v.string(),
  }).index("by_document", ["documentId", "kind"]),

  // 03 §4 sendLog 🔒 (append-only dispatch record, SND-07/18/22; the app never sends)
  sendLog: defineTable({
    documentId: v.optional(v.id("salesDocuments")),
    purpose: v.union(
      v.literal("document"),
      v.literal("reminder_void_notice"),
      v.literal("supplier_correction_request"),
    ),
    kind: v.union(v.literal("mark_sent"), v.literal("retraction")),
    retractsId: v.optional(v.id("sendLog")),
    sentOn: v.string(),
    channel: vSendChannel,
    note: v.optional(v.string()),
    artifacts: v.array(v.object({ artifactId: v.id("documentArtifacts"), sha256: v.string() })),
    einvoiceHandedOverElectronically: v.optional(v.boolean()),
    at: v.number(),
    actor: vActor,
  }).index("by_document_at", ["documentId", "at"]),

  // 03 §10 notifications (in-app to-dos; unprotected, audited). `resolvedAt` (03 delta): closed by the resolving
  // act (SND-21: the sent mark, a Storno or a withdrawal) — open to-dos have no `resolvedAt`.
  // 03 §10 jobs (F09 EXP-026, F04 SND-20): background exports with progress, cancel and a 30-day result file.
  jobs: defineTable({
    kind: v.union(
      v.literal("csv_export"),
      v.literal("bulk_export"),
      v.literal("bulk_mark_sent"),
      v.literal("pdf_zip"),
      v.literal("datev_export"),
      v.literal("gdpdu_export"),
      v.literal("full_export"),
      v.literal("verfahrensdoku_pdf"),
    ),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    progress: v.object({ done: v.number(), total: v.number() }),
    /** Kind-specific parameters (validated by the starting mutation). */
    params: v.any(),
    label: v.string(),
    resultStorageId: v.optional(v.id("_storage")),
    resultName: v.optional(v.string()),
    resultSha256: v.optional(v.string()),
    resultBytes: v.optional(v.number()),
    /** Documents skipped by bulk jobs with the German reason (SND-20). */
    skipped: v.optional(v.array(v.object({ id: v.string(), label: v.string(), reason: v.string() }))),
    error: v.optional(v.string()),
    actor: vActor,
    /** The creator's actor context (channel, role, label) so the export audit entry is attributed to it (EXP-026). */
    by: v.object({
      actor: vActor,
      channel: vChannel,
      role: v.optional(vMemberRole),
      label: v.optional(v.string()),
      requestId: v.optional(v.string()),
    }),
    createdAt: v.number(),
    finishedAt: v.optional(v.number()),
    /** Result download until (createdAt + 30 days); the file is removed afterwards. */
    expiresAt: v.optional(v.number()),
  })
    .index("by_actor", ["actor", "createdAt"])
    .index("by_status", ["status", "createdAt"]),

  notifications: defineTable({
    kind: v.string(),
    severity: v.union(v.literal("info"), v.literal("warning"), v.literal("error"), v.literal("critical")),
    title: v.string(),
    body: v.optional(v.string()),
    link: v.optional(v.string()),
    entity: v.optional(v.object({ table: v.string(), id: v.string() })),
    dedupeKey: v.string(),
    count: v.number(),
    escalatedAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_open", ["resolvedAt", "createdAt"])
    .index("by_entity", ["entity.table", "entity.id"]),

  // 03 §4 recurringTemplates (F04 §3.4 REC-01…16). Mutable configuration (audited); "Beendet" is derived (REC-03).
  recurringTemplates: defineTable({
    name: v.string(),
    /** UI "Pausiert" = inactive (F04 §4.2.10). */
    status: v.union(v.literal("active"), v.literal("inactive")),
    /** The invoice draft content without dates — validated with `templateDraftSchema` on every write. */
    draft: v.any(),
    /** Display/index cache of `draft.contactId`. */
    contactId: v.optional(v.id("contacts")),
    contactName: v.optional(v.string()),
    /** BT-12 of every generated invoice (REC-09); absent → the template name. */
    contractReference: v.optional(v.string()),
    schedule: v.object({
      interval: v.union(
        v.literal("P7D"),
        v.literal("P14D"),
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
      maxCount: v.optional(v.number()),
      billing: v.union(v.literal("in_advance"), v.literal("in_arrears")),
      periodTextEnabled: v.boolean(),
    }),
    /** REC-16: finalise only, never export or send. */
    automation: v.object({ finalize: v.boolean() }),
    /** REC-14: the UI confirmation of the first activation; automation is effective only once confirmed. */
    automationConfirmedAt: v.optional(v.number()),
    automationConfirmedBy: v.optional(vActor),
    /** REC-10 „überspringen“ (audited). */
    skippedOccurrences: v.array(v.object({ date: v.string(), at: v.number(), actor: vActor })),
    generatedCount: v.number(),
    lastGeneratedId: v.optional(v.id("salesDocuments")),
    /** Display cache of the next invoice's totals at the last save/run (list column „Betrag“). */
    amount: v.optional(v.object({ netCents: v.number(), grossCents: v.number(), currency: v.string() })),
    /** REC-01: a template with generated invoices is archived instead of deleted. */
    archivedAt: v.optional(v.number()),
    createdBy: vActor,
    version: v.number(),
  })
    .index("by_status", ["status"])
    .index("by_contact", ["contactId"]),

  // ── 03 §10 imports (F09 §4.3: sevdesk file exports only, no API) ─────────────────────────────────────────
  // One row per import project: uploaded files with detection metadata, mapping, resolutions, the stored preview
  // and its hash (commit only with the current preview, IMP-023), the run log. Source files stay as migration
  // evidence (IMP-024, `retentionUntil` ≥ 10 years) once committed; discard removes them before a commit.
  imports: defineTable({
    source: v.union(v.literal("sevdesk_export"), v.literal("lexoffice_csv"), v.literal("generic_csv")),
    files: v.array(
      v.object({
        /** Stable file id inside the import (rows reference `<id>:<line>`). */
        id: v.string(),
        storageId: v.id("_storage"),
        sha256: v.string(),
        bytes: v.number(),
        mime: v.string(),
        name: v.string(),
        detectedKind: v.string(),
        /** Current kind (the owner may correct the detection, IMP-016). */
        kind: v.string(),
        encoding: v.optional(v.string()),
        delimiter: v.optional(v.string()),
        headers: v.optional(v.array(v.string())),
        /** First rows for the mapping grid (IMP-017). */
        samples: v.optional(v.array(v.array(v.string()))),
        rows: v.optional(v.number()),
        ignored: v.optional(v.boolean()),
        readError: v.optional(v.string()),
        /** IMP-016: id of the uploaded ZIP this file was unpacked from (`name` is then the path inside it). */
        container: v.optional(v.string()),
        /** IMP-016: on a ZIP — files unpacked from it and skipped OS metadata (the ZIP itself is kept, not parsed). */
        unpacked: v.optional(v.object({ files: v.number(), ignored: v.array(v.string()) })),
      }),
    ),
    status: v.union(
      v.literal("uploaded"),
      v.literal("previewed"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("discarded"),
    ),
    /** Incremented on every change of files, mapping or resolutions; a preview is saved only for the revision it read. */
    revision: v.number(),
    previewHash: v.optional(v.string()),
    preview: v.optional(v.any()),
    mapping: v.optional(
      v.record(
        v.string(),
        v.object({
          columns: v.record(v.string(), v.string()),
          numberFormat: v.optional(v.union(v.literal("de"), v.literal("en"))),
          dateFormat: v.optional(v.union(v.literal("dmy"), v.literal("mdy"))),
        }),
      ),
    ),
    resolutions: v.optional(
      v.object({
        excluded: v.optional(v.array(v.string())),
        pdfAssignments: v.optional(v.record(v.string(), v.string())),
        openAmounts: v.optional(v.record(v.string(), v.number())),
        /** E-IMP-10: post documents dated on/after the Buchungsbeginn at commit (EC-204). */
        postBookedPeriod: v.optional(v.boolean()),
        /** EC-203 / E-IMP-37: gross from the PDF per document key, with the owner's reason. */
        correctedTotals: v.optional(v.record(v.string(), v.object({ grossCents: v.number(), reason: v.string() }))),
      }),
    ),
    /** Owner decisions recorded at commit start (number ranges, missing-PDF reason, opening items). */
    decisions: v.optional(v.any()),
    stats: v.record(v.string(), v.number()),
    log: v.array(v.string()),
    error: v.optional(v.string()),
    importerVersion: v.string(),
    startedAt: v.number(),
    finishedAt: v.optional(v.number()),
    committedAt: v.optional(v.number()),
    committedBy: v.optional(vActor),
    retentionUntil: v.optional(v.string()),
    /** IMP-024: the archived import protocol PDF (set once after the commit; retention = `retentionUntil`). */
    protocolFile: v.optional(vFileRef),
    actor: vActor,
  }).index("by_status", ["status"]),

  // F09 IMP-017: saved column mappings (shipped `sevdesk-*` presets live in code, flagged unsure).
  importMappingPresets: defineTable({
    source: v.string(),
    fileKind: v.string(),
    name: v.string(),
    columns: v.record(v.string(), v.string()),
    shipped: v.boolean(),
    unsure: v.boolean(),
    createdAt: v.number(),
    actor: v.optional(vActor),
  }).index("by_kind", ["source", "fileKind"]),

  // F09 IMP-006 🔒 append-only: idempotent re-runs — (externalType, externalId) is unique by convention (model).
  importedRecords: defineTable({
    importId: v.id("imports"),
    externalType: v.string(),
    externalId: v.string(),
    table: v.string(),
    localId: v.string(),
  })
    .index("by_external", ["externalType", "externalId"])
    .index("by_import", ["importId"]),

  // Dev/test only (not in 03): the in-memory auth-mail transport (AUTH_MAIL_SENDER=memory) stores mails here so
  // integration and E2E tests can read sign-in codes (07 §3.2). Never written with the Cloudflare transport.
  devMailbox: defineTable({
    to: v.string(),
    subject: v.string(),
    text: v.string(),
    kind: v.string(),
    at: v.number(),
  }).index("by_to", ["to", "at"]),
});
