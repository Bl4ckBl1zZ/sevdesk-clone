import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vActor,
  vAuditorScope,
  vChannel,
  vChart,
  vFileRef,
  vIntegrityFinding,
  vInviteRole,
  vJournalLine,
  vJournalSourceKind,
  vMemberRole,
  vPaymentTerms,
  vPostalAddress,
  vSalesDocType,
  vTimeRounding,
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
    contactId: v.optional(v.string()),
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
    contactId: v.optional(v.string()),
    counterpartyName: v.string(),
    grossCents: v.number(),
    openCents: v.number(),
    taxedAs: v.union(v.literal("soll"), v.literal("ist")),
    notDueVat: v.optional(v.array(v.object({ rateBp: v.number(), vatCents: v.number() }))),
    openAmountCents: v.number(),
    recordedAt: v.number(),
    lockedAt: v.optional(v.number()),
    actor: vActor,
  })
    .index("by_fiscalYear", ["fiscalYear", "number"])
    .index("by_contact", ["contactId"]),

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
