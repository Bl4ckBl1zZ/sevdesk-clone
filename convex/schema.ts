import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vActor,
  vAuditorScope,
  vChannel,
  vContactKind,
  vContactRole,
  vContactStatus,
  vFileRef,
  vIntegrityFinding,
  vInviteRole,
  vMemberRole,
  vPaymentTerms,
  vPostalAddress,
  vPriceMode,
  vQualifiedCode,
  vSalesDocType,
  vTimeRounding,
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
    channelsByKind: v.record(
      v.string(),
      v.object({ inApp: v.boolean(), email: v.boolean(), ntfy: v.boolean(), digest: v.boolean() }),
    ),
  }),

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
  })
    .index("by_number", ["numberNormalized"])
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
  })
    .index("by_number", ["numberNormalized"])
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
  // contactId becomes v.id("contacts") when the contacts table arrives (F02, P1).
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
