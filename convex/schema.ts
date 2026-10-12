import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  vActor,
  vAuditorScope,
  vChannel,
  vFileRef,
  vIntegrityFinding,
  vInviteRole,
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
