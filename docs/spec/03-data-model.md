# 03 — Data Model (Convex schema)

> **Status:** v1.1 · 2026-10-12 (consolidation pass: all data-model deltas of F01–F12 merged; see [§12](#12-consolidation-log)). Conventions from [02-architecture.md §5](02-architecture.md#5-data-conventions): money in `*Cents` integers, unit prices in `*Micros` (1/10,000), quantities in `*Milli` (1/1,000), rates and percentages in basis points (`*Bp`), FX rates as decimal strings, business dates as `"YYYY-MM-DD"`, instants as epoch ms (UTC).
>
> The notation below is TypeScript-like pseudo-schema. The real `convex/schema.ts` is generated from it in P0. Every table implicitly has `_id` and `_creationTime`. **Protected** tables (marked 🔒) are subject to the immutability triggers (GOBD-06): after `status` leaves `draft` (or after `lockedAt` is set, or from insert for append-only tables), only the fields whitelisted in [§11](#11-immutability-matrix-enforced-by-convexfunctionsts-triggers--model-layer) may change, through model functions.
>
> **This file is the single source of truth for the schema.** Feature specs (F01–F12) may describe behaviour, but table/field/enum names are the ones defined here. Where a feature spec uses a different name, this file wins and the difference is listed in §12.

**Contents:** [0. Common embedded types](#0-common-embedded-types) · [1. Company and settings](#1-company-and-settings) · [2. Contacts](#2-contacts) · [3. Products](#3-products) · [4. Sales documents](#4-sales-documents) · [5. Payments and receivables](#5-payments-and-receivables) · [6. Purchases (Belege) and inbox](#6-purchases-belege-and-inbox) · [7. Banking and cash](#7-banking-and-cash) · [8. Bookkeeping, assets, tax](#8-bookkeeping-assets-tax) · [9. Projects and time](#9-projects-and-time-p4) · [10. Platform](#10-platform) · [11. Immutability matrix](#11-immutability-matrix-enforced-by-convexfunctionsts-triggers--model-layer) · [12. Consolidation log](#12-consolidation-log)

## 0. Common embedded types

### 0.1 Actor identifiers

Every write, audit entry and attributed field (`actor`, `createdBy`, `finalizedBy`, `lockedBy`, …) stores the **canonical actor string** `"<kind>:<id>"`:

| Kind | `<id>` | Example | Source |
|---|---|---|---|
| `user` | the Better Auth user id (JWT `sub`; component table `user`) | `user:k57f3…` | signed-in UI / Server Actions; the member's role at that moment goes to `auditLog.actorRole` (`owner \| bookkeeper \| viewer \| auditor`) |
| `api-key` | the key's public ID (`apiKeys.prefix`) | `api-key:key_abc123` | REST (`channel: "api"`) |
| `mcp` | public ID (`apiKeys.prefix`) of the key used by the MCP client | `mcp:key_abc123` | MCP (`channel: "mcp"`) |
| `system` | registered job/cron name from 02 §7, prefixed `cron.` for scheduled jobs | `system:cron.receivables.refreshOverdue`, `system:cron.dunning.run`, `system:cron.recurring.generate`, `system:ku-monitor`, `system:migration.<name>`, `system:restore`, `system:auth` | internal jobs |
| `portal` | *reserved* — `portalTokens._id` once the customer portal (F10) returns | `portal:ptk_9f2…` | **never minted while F10 is deferred** |

Rules: the string is produced only by the wrappers in `convex/functions.ts` from the verified JWT (Better Auth provider for `user:`, server-JWT provider for `api-key:`/`mcp:`, 02 §4.4) or the job registry; it is never taken from client input. Roles are **not** actor kinds: `owner`, `bookkeeper`, `viewer` and `auditor` are values of `members.role`, recorded per entry in `auditLog.actorRole`. Display data (user e-mail/name, key name, MCP client name/version) is stored separately (`auditLog.actorLabel`, `auditLog.client`) so the identifier stays stable when a key or member is renamed. Validation regex: `^(user|api-key|mcp|portal|system):[A-Za-z0-9._\-]+$`. Former spellings `owner:owner` and `auditor:<grantId>` are invalid (platform update 2026-10-12, §12).

### 0.2 Types

```ts
type ActorKind = "user" | "api-key" | "mcp" | "system" | "portal" /* reserved, F10 deferred */;
type MemberRole = "owner" | "bookkeeper" | "viewer" | "auditor";          // §10 members; not an actor kind
type Actor = `${ActorKind}:${string}`;                     // §0.1
type Channel = "ui" | "api" | "mcp" | "portal" | "cron" | "import" | "system";

type PostalAddress = {
  name: string; name2?: string; department?: string;      // BT-44/45-ish
  street: string; street2?: string; postalCode: string; city: string;
  countryCode: string;                                    // ISO 3166-1 alpha-2 (incl. "XI")
  poBox?: string;
};

type VatCategory =                                         // UNCL5305 + internal
  | "S"     // standard or reduced rate (rate distinguishes 19/7)
  | "Z"     // zero rate (PV §12 Abs. 3)
  | "E"     // exempt (needs exemptionReasonCode + text)
  | "AE"    // reverse charge (§13b domestic or EU B2B service)
  | "K"     // intra-Community supply
  | "G"     // export outside EU
  | "O"     // not subject to German VAT (§3a Abs. 2 to non-EU etc.)
  | "KU";   // Kleinunternehmer (internal; maps to E + VATEX/text in XML)

type TaxCase =                                             // document-level, drives texts and allowed categories
  | "domestic" | "kleinunternehmer" | "eu_b2b_service" | "intra_community_supply"
  | "export" | "not_taxable_domestic" | "reverse_charge_13b" | "exempt_4"
  | "unknown_imported";                                    // archived sevdesk imports with unmappable/OSS rules only (F09 IMP-010); never selectable for new documents

type VatRateKey = string;          // validated against rule table `vatRateKeys` (src/domain/rules); v1 rows:
                                   // "standard" | "reduced" | "restaurant_food" | "zero" | "exempt"  (F03 PRD-020)

type PlaceOfSupplyRule =           // services only (F03 PRD-009, F04 App. C, EC-046); default "general"
  | "general"                      // §3a Abs. 2 for businesses / §3a Abs. 1 for consumers
  | "property"                     // §3a Abs. 3 Nr. 1
  | "event_admission"              // §3a Abs. 3 Nr. 5
  | "restaurant"                   // §3a Abs. 3 Nr. 3b
  | "short_term_vehicle_rental"    // §3a Abs. 3 Nr. 2
  | "passenger_transport"          // §3b
  | "catalogue_3a4"                // §3a Abs. 4 catalogue services (non-EU consumers)
  | "electronic";                  // §3a Abs. 5 (B2C TBE services)

type Rc13bType = string;           // §13b Abs. 2 service/goods type, validated against rule table `rc13bTypes`
                                   // (paragraph number and note text live in the rule row); v1 rows:
                                   // "construction" (Nr. 4) | "cleaning" (Nr. 8) | "scrap" (Nr. 7) | "metals" (Nr. 11)
                                   // | "electronics" (Nr. 10) | "gold" (Nr. 9) | "emission_allowances" (Nr. 6)
                                   // | "energy_reseller" (Nr. 5b) | "telecom_reseller" (Nr. 12) | "property" (Nr. 3)

type SupplyDate =
  | { kind: "date"; date: string }
  | { kind: "period"; from: string; to: string }
  | { kind: "month"; month: string /* YYYY-MM */ };

type PaymentTerms = { dueDays: number; skontoPercentBp?: number; skontoDays?: number; text?: string };

type FxRate = {                    // shared by documents, vouchers, payments, bank transactions, journal lines (MISC-08)
  rate: string;                    // decimal string "1 EUR = x FC", ≤ 6 decimals; never a float in arithmetic
  source: "bmf_monthly" | "ecb_daily" | "manual" | "transaction";   // "transaction" = implicit in a bank leg / actual debit
  sourceText?: string;             // e.g. "BMF-Umrechnungskurse Oktober 2026", "Revolut exchange leg"
  date: string;                    // supply month (BMF) / document or completion date (ECB, transaction)
};

type FileRef = { storageId: Id<"_storage">; sha256: string; bytes: number; mime: string; name: string };

type RetentionClass = "books10" | "vouchers8" | "letters6" | "none";

type TimeRounding = { incrementMinutes: 0 | 1 | 5 | 6 | 10 | 15 | 30 | 60; mode: "up" | "nearest"; minimumMinutes?: number };   // F11 PRJ-009; 0 = none
```

## 1. Company and settings

### `companyProfile` (singleton; every change appends a row to `companyProfileVersions`)
```ts
{
  legalForm: "einzelunternehmen" | "freiberufler" | "ek" | "gbr" | "egbr" | "ohg" | "kg" | "gmbh_co_kg"
           | "gmbh" | "ug" | "ag" | "partg" | "other";
  name: string;                     // legal name (Firma)
  tradeName?: string;
  address: PostalAddress;
  seat?: string;                    // Sitz, if different from address.city (MAIL-03)
  contact: { name: string; phone: string; email: string; website?: string };   // BT-41..43
  register?: { court: string; type: "HRA" | "HRB" | "PR" | "GnR" | "VR" | "GsR"; number: string };   // GsR = Gesellschaftsregister (eGbR)
  representatives: { name: string; role?: "chair" }[];   // Geschäftsführer / Vorstand / Gesellschafter; print label by legalForm (§35a GmbHG, §80 AktG)
  generalPartner?: { name: string; seat: string; registerCourt: string; registerNumber: string;
                     managingDirectors: string[] };     // GmbH & Co. KG (§125a/§177a HGB)
  hasSupervisoryBoard?: boolean; supervisoryBoardChair?: string;
  noNaturalPersonLiable?: boolean;  // MAIL-03 (OHG/KG without natural person)
  shareCapital?: { amountCents: number; outstandingCents?: number };
  taxNumber?: string;               // stored normalised (13-digit ELSTER) + display
  taxNumberState?: string;          // Bundesland code used to normalise a regional Steuernummer (UST-04)
  vatId?: string;                   // DE + 9
  taxOffice?: string;
  kleinunternehmer: { validFrom: string; isKU: boolean; waiverDate?: string }[];   // KU-01/04, date-effective
  taxationMethod: { validFrom: string; method: "soll" | "ist";
                    financeOfficeApproval?: { date: string; reference: string } }[];  // UVA-06, ACC-022, EC-115
  ustvaPeriod: { year: number; period: "monthly" | "quarterly" | "annual_only"; dauerfrist: boolean }[];
  profitMethod: { validFromFiscalYear: number; method: "euer" | "bilanz" }[];      // AO-01; date-effective (LEGAL-OPEN: F01 Q2)
  euerExemptionConfirmedAt?: number;                                              // §241a HGB confirmation for `ek` (SET-039)
  chartOfAccounts: { validFromFiscalYear: number; chart: "SKR03" | "SKR04";   // wizard default SKR03 (F01 SET-041)
                     accountMappingStorageId?: Id<"_storage"> }[];                // EC-116: switch only at a fiscal-year start
  fiscalYearStartMonth: number;     // 1..12
  bookkeepingStartDate?: string;    // "Buchungsbeginn" (ACC-014); events before it produce no journal entries; frozen after the first posting
  foundedOn?: string;               // Neugründer logic (UVA-01), KU founding year
  priorYearTotalTurnoverCents: { year: number; amountCents: number }[];   // ER-03 800k test, KU test
  electronicAddress: { scheme: "EM" | "0204" | "9930"; value: string };   // BT-34
  creditorId?: string;              // SEPA Gläubiger-ID
  datev: { consultantNumber?: number; clientNumber?: number; accountLength: number;
           formatVersion?: 12 | 13; personalAccounts: boolean; collectiveDebtorAccount?: string };   // DATEV-02, ACC-010, CON-103
  serverLocation: { countryCode: string; provider?: string; confirmedAt: number };  // AO-06
  accessConcept: { baseDomain: string /* BASE_DOMAIN, e.g. "buero.example.de" */; network: "tailnet";
                  tailnetName?: string; confirmedAt: number };   // SET-007, SEC-07 (login + tailnet, 02 §4); printed in the Zugriffskonzept
  lastRestoreDrillOn?: string;      // SEC-05 reminder (mirror of the latest restoreDrills row)
  logoStorageId?: Id<"_storage">;
  defaults: {
    paymentTerms: PaymentTerms; priceMode: "net" | "gross"; language: "de" | "en";
    backdateWindowDays: number; quoteValidityDays: number;
    quoteRevisionNumbering: "suffix" | "new_number";      // QUO-06 (default suffix "-V{n}")
    catchUpAutoMax: number;                               // REC-06 (default 3)
    paymentReferencePrefix?: string;                      // DOC-51, e.g. "RE " (EPC remittance = prefix + number)
    fxRateSource: "bmf_monthly" | "ecb_daily";            // DOC-15 / App. E.6 default
    discountOnCustomerPrices: boolean;                    // PRD-034 (default false)
    stockOnInvoiceWithoutDeliveryNote: boolean;           // PRD-093 (default false)
    preventNegativeStock: boolean;                        // PRD-095 (default false)
    standardAttachments: { docType: SalesDocType; file: FileRef }[];   // SET-088 (e.g. AGB PDF)
    time?: { hourlyRateMicros?: number; rounding: TimeRounding; unitCode: "HUR" | "MIN" };   // F11 PRJ-008/009/011
  };
  receivables: {                                          // F05 settings (Einstellungen › Mahnwesen)
    agingBucketEdgesDays: number[];                       // PAY-002 (default [30, 60, 90])
    postalDeliveryDays: number;                           // PAY-052 Zugang assumption for channels post/other (default 3; F05 calls it zugangPostDays)
    autoFinalizeReminders: boolean;                       // DUN-057 (default false); reminders are never sent by the app
    bankDataMaxAgeDays: number;                           // DUN-033 auto-finalisation only with fresh bank data (default 7)
    defaultStartViaReminder: "after_printed_deadline" | "zugang_plus_1";   // PAY-053 route (b); default after_printed_deadline (⚖ LEGAL-OPEN F05 Q-01)
    reopenGraceDays: number;                              // DUN-035 (default 7)
    allocationOrder: "principal_first" | "bgb_367";       // DUN-027
  };
  matching: { autoApplyBp: number; safeBp: number; suggestBp: number };   // F07 BNK-043 (9800 / 9500 / 4000)
  portal?: { imprintUrl: string; privacyUrl: string; withdrawalPolicyTemplateId?: Id<"textTemplates">;
             quoteExpiryDaysAfterValidUntil: number; invoiceExpiryDaysAfterPaid: number;
             sepaPreNotificationDays: number; pain008Version: "001.08" | "001.02" };   // F10 POR-003/012/022/023/031 — reserved: unset and not editable while F10 is deferred
  assetPolicy: { fiscalYear: number; mode250to1000: "gwg" | "pool"; erinnerungswert: boolean }[];   // F08 AST-004/008 (uniform per year)
  setupCompletedAt?: number;
  version: number;
}
```

### `companyProfileVersions` 🔒 (append-only, GOBD-06)
```ts
{ version: number; profile: string /* canonical JSON of the full companyProfile at this version */;
  diff: { before?: unknown; after?: unknown }; validFrom: number /* instant */; actor: Actor; reason?: string;
  auditSeq: number }
// index by_version (unique by convention). Documents resolve seller data from their snapshot, never from here.
// Written in the same transaction as the audited companyProfile change; the row has no audit entry of its own,
// RI-15 instead checks that `auditSeq` points at a companyProfile entry whose diff sets this `version`.
```

### `bankAccounts`
```ts
{ kind: "bank" | "clearing" | "paypal";   // bank = one currency account (e.g. a Revolut pocket), fed by statement import and optionally the Enable Banking feed (F07 BNK-001)
  name: string; currency: string;   // ISO 4217; foreign-currency account (Fremdwährungskonto) ⇔ currency ≠ "EUR" (derived, not stored)
  iban?: string; bic?: string; accountHolder: string;   // holder name = payee name (VoP, MISC-01)
  bankDetails?: { bankCountry?: string; accountNo?: string; sortCode?: string; routingNumber?: string;
                  schemes?: string[] };                 // pockets without IBAN (GBP/USD local schemes), SET-050a
  ledgerAccount: string;            // SKR account e.g. 1200/1800 — unique across bankAccounts and the `cash` role account (BNK-001)
  showOnInvoices: boolean; isDefaultForInvoices: boolean;   // default unique per currency (SET-050b, SET-051)
  autoApplyMatches: boolean;        // BNK-043 per-account toggle (default true)
  feed?: { connectionId: Id<"bankConnections">;
           identificationHash?: string;               // stable account hash from Enable Banking; re-mapping key after renewal (BNK-104)
           providerAccountUid?: string;               // session-specific uid, replaced on every consent
           lastPolledAt?: number; backoffUntil?: number;   // 429 → +6 h (BNK-106)
           unattendedFetches: { day: string /* YYYY-MM-DD Europe/Berlin */; transactions: number; balances: number } };   // ≤ 4 per 24 h (BNK-106)
  fxCost?: { balanceMinor: number; costEurCents: number; updatedAt: number };   // moving-average EUR cost of a foreign pocket (BNK-028, F08 §4.2.7);
                                    // avg rate = costEurCents / balanceMinor, computed in BigInt by the domain
  statementFormat?: { type: "camt053" | "mt940" | "revolut_csv" | "csv"; csvMapping?: Record<string, string>; csvMappingVersion?: number };
  feeSemantics?: { source: string; amountIncludesFee: boolean; confirmedAt: number; actor: Actor }[];   // per source format; owner-confirmed once if not provable by balance continuity (F08 E-ACC-32, F07 BNK-023)
  openingBalance?: { date: string; amountCents: number };
  archivedAt?: number }
// indexes: by_ledgerAccount (unique), by_currency_default, by_iban, by_feed_identificationHash
```

### `bankConnections` (Enable Banking PSD2 account information; one connection → several currency accounts; F07 BNK-100…117)
```ts
{ provider: "enable_banking"; environment: "production" | "sandbox";
  applicationId: string; encryptedPrivateKeyPem: string;     // application key (RS256 JWTs minted per request, never stored; BNK-013)
  aspsp?: { name: string; country: string };                 // e.g. { name: "Revolut", country: "LT" }
  redirectUrl: string;                                        // https://app.<BASE_DOMAIN>/einstellungen/bank/callback (BNK-115)
  pendingAuth?: { stateHash: string; expiresAt: number };     // single-use state nonce, 10 min (BNK-102)
  encryptedSessionId?: string; consentStartedAt?: number;
  validUntil?: number;                                        // consent end, ≤ 180 days (BNK-102/105)
  consentReminders: { daysBefore: 14 | 3 | 0; notifiedAt: number }[];   // BNK-105
  backfill?: { startedAt: number; finishedAt?: number; from: string; ok: boolean; error?: string };   // inside the callback (BNK-103)
  status: "not_configured" | "pending_consent" | "active" | "reauth_required" | "error" | "disconnected";
  lastError?: string; lastSuccessfulPollAt?: number;
  lastBalanceCheck?: { at: number; ok: boolean; diffs: { accountId: Id<"bankAccounts">; diffCents: number }[] };   // BNK-035
  evaluationConfirmation: { status: "pending" | "confirmed" | "quoted" | "declined"; recordedAt?: number;
                            note?: string; file?: FileRef };  // owner's written request to Enable Banking (BNK-116)
  createdAt: number }
// No Revolut Business API connection (Grow plan not available; future option only, F07 Q-10).
```

### `numberRanges` and `numberCounters`
```ts
numberRanges: { docTypes: (SalesDocType | "contact" | "product" | "asset" | "voucherInternal" | "project")[];
  name: string; format: string;     // tokens: {YYYY} {YY} {MM} {#…#} (1–10 #, zero-padded) e.g. "RE-{YYYY}-{#####}"
  resetPolicy: "never" | "yearly" | "monthly";   // yearly requires {YYYY} or {YY}; monthly requires a year token AND {MM} (UST-06, SET-057)
  startValue: number; active: boolean;
  isDefault: boolean }              // exactly one active default per numbered docType (SET-055)
numberCounters: { rangeId: Id<"numberRanges">; periodKey: string /* "" | "2026" | "2026-10" */; next: number }
  // index by_range_period (unique by convention, enforced in model)
```
Assignment moments: sales documents at finalisation (SET-061); purchase vouchers (`voucherInternal`) at **booking** (= voucher finalisation, F06 VOU-007); contacts, products, assets, projects at creation (SET-064). Product numbers may be entered manually: 1–50 printable characters, unique case-insensitive (PRD-002) — a different charset from invoice numbers (SET-056).

### `numberRegister` 🔒 (UST-06, GOBD-02)
```ts
{ number: string; normalized: string /* uppercase, trimmed */; rangeId?: Id<"numberRanges">; docType;
  documentId: Id<"salesDocuments">;
  assignedAt: number; status: "issued" | "cancelled_by_storno" | "corrected";
  imported?: true }                 // historical sevdesk number (F09 IMP-004, SET-065, EC-014); counts for uniqueness, not for the gap report start
// index by_normalized → uniqueness check inside the finalisation transaction
```

### Templates and lookups
```ts
textTemplates:   { kind: "document_head" | "document_foot" | "message_text";   // email_* kinds removed: the app never e-mails customers (02 §9);
                                                                // message_text = subject + body for "E-Mail-Text kopieren" (F04 SND-19), copied by the owner
                   docTypes: SalesDocType[]; name: string; body: string /* sanitized rich text with {{placeholders}} */;
                   isDefault: boolean /* ≤ 1 per (kind, docType, language) */; language: "de" | "en";
                   level?: number /* reminder level, F05 DUN-050 */ }
layouts:         { name: string; currentVersionId: Id<"layoutVersions"> /* optional in the schema only: set in the
                   same transaction that creates the layout and its first version (circular reference) */;
                   isDefaultFor: SalesDocType[] }
layoutVersions:  { layoutId; version: number; config: { template: "classic" | "modern" | "minimal";
                   accentColor: string; font: "inter" | "noto" | "source-serif"; logoPosition: "left" | "right";
                   letterheadStorageId?: Id<"_storage">; letterheadPage2StorageId?: Id<"_storage">;
                   printOptions: { foldMarks: boolean; pageNumbers: boolean; senderLine: boolean;
                                   vatPerLine: boolean; productNumbers: boolean; epcQr: boolean; portalQr: boolean;
                                   lineDescriptions: boolean; grossLineTotals: boolean; allInvoiceAccountsInFooter: boolean;
                                   footerInLetterhead: { confirmedAt: number; items: string[] } | null } };   // SET-075
                   createdAt: number }        // immutable; documents reference a version (GOBD-06.6)
units:           { code: string /* UN/ECE Rec 20/21, e.g. C62, HUR, DAY, KGM */; label: { de: string; en: string };
                   isSystem: boolean; archivedAt?: number }          // SET-090/091
paymentMethods:  { name: string; text: string; kind: "transfer" | "sepa_debit" | "cash" | "paypal" | "card" | "other"; isDefault: boolean }
tags:            { name: string; color?: string }
customFieldDefs: { entity: "contact" | "product" | "document"; key: string; label: string;
                   type: "text" | "number" | "date" | "select" | "boolean"; options?: string[]; printOnDocuments: boolean;
                   required?: boolean; position: number; archivedAt?: number }   // SET-095/096
costCenters:     { number: string; name: string; isDefault: boolean; archivedAt?: number }
// mailIdentities: removed (platform update 2026-10-12) — no SMTP; auth/owner mail uses Cloudflare Email Sending (02 §9)
integrations:    { kind: "cloudflare_email" | "r2_checkpoint" | "r2_inbox" | "claude" | "peppol" | "tsa"
                       | "stripe" | "mollie" | "paypal" /* F10 deferred: slots kept, hidden */;
                   config: Record<string, unknown>;   // non-secret only: bucket name, account id, sender address, jurisdiction, model …
                   encryptedSecrets?: string;          // only for secrets entered in the UI (Claude API key); Cloudflare/R2 credentials
                                                       // live in the Convex env and are never stored here (02 §4.5)
                   enabled: boolean; lastTestAt?: number; lastTestOk?: boolean; lastTestDetail?: string;
                   dpaConfirmedAt?: number /* DSGVO-04 AVV */; region?: string /* e.g. "eu" (R2 jurisdiction) */ }
                 // The DSGVO-04 external-services list is a computed view over integrations + bankConnections
                 // + notificationSettings.ntfy.
ruleOverrides:   { ruleSet: "basiszinssatz" | "taxRate" | "noteText" | "ustvaMapping" | "vatRateKeys" | "rc13bTypes";
                   rowId: string; validFrom: string; validTo?: string; value: unknown; source: string; addedAt: number }
                 // the code-shipped tables in src/domain/rules are authoritative; overrides let the owner add
                 // e.g. a new Basiszinssatz before a release ships. Both are versioned and audited.
```

## 2. Contacts

### `contacts`
```ts
{ kind: "organization" | "person";
  parentId?: Id<"contacts">;                 // person belonging to an organisation
  number: string;                            // customer/supplier number (shared range like sevdesk)
  roles: ("customer" | "supplier" | "partner" | "prospect")[];   // role = relationship type
  status: "lead" | "active" | "archived";    // status = lifecycle state (both kept; "lead" ≠ role "prospect")
  mergedIntoId?: Id<"contacts">;             // alias after merge (CON-133); loser is archived, never deleted; finalised records keep the loser's ID and are resolved through the alias, never rewritten
  organizationName?: string; organizationName2?: string;
  salutation?: "herr" | "frau" | "divers" | "none"; academicTitle?: string;
  firstName?: string; lastName?: string; position?: string; birthday?: string;
  displayName: string;                       // denormalised (org name or "Title First Last")
  searchText: string;                        // denormalised: displayName + number + e-mails (Convex search field)
  isConsumer: boolean;                       // B2C → gross prices, §286 note, ER-03 NOT_REQUIRED
  isPublicAuthority: boolean;                // B2G → Leitweg-ID mandatory (ER-20)
  vatId?: string; vatIdStatus?: { lastCheckId: Id<"vatIdChecks">; status: "valid" | "invalid" | "unavailable"; qualified: boolean; checkedAt: number };
  taxNumber?: string;
  buyerReference?: string;                   // BT-10 default (Leitweg-ID for B2G)
  electronicAddress?: { scheme: "EM" | "0204" | "9930"; value: string };   // BT-49
  defaultTaxCase?: TaxCase;                  // override of derivation (never "unknown_imported")
  reverseCharge13bCertificates: { file?: FileRef; validUntil: string; addedAt: number; replacedAt?: number }[];   // USt 1 TG history (UST-22, CON-070/072)
  selfBillingAgreement?: { agreedOn: string; scope: string; validFrom: string; validTo?: string; file?: FileRef };   // Gutschrift (INV-16, P3)
  einvoice: { preferredFormat: "zugferd" | "xrechnung_cii" | "xrechnung_ubl" | "pdf" | "auto";
              // maps to salesDocuments.einvoice.format: zugferd → zugferd_en16931, xrechnung_* → same, pdf → none (if ER-03 allows), auto → derived (CON-080)
              pdfConsents: { givenAt: string; source: "email" | "contract" | "tacit" | "portal"; note?: string;
                             file?: FileRef; revokedAt?: string; recordedAt: number }[] };   // MAIL-01 history (CON-081, POR-032)
  language: "de" | "en"; currency: string;
  paymentTerms?: PaymentTerms; defaultDiscountBp?: number;
  paymentMethodId?: Id<"paymentMethods">;    // CON-094
  debtorAccount?: string; creditorAccount?: string;     // DATEV personal accounts (10000–69999 / 70000–99999)
  useCollectiveDebtor?: boolean;             // CON-103 (uses companyProfile.datev.collectiveDebtorAccount)
  iban?: string; bic?: string;
  dunning?: { policyId?: Id<"dunningPolicies">; blocked?: boolean; blockedReason?: string;
              calendarDueDateAgreed?: boolean };          // DUN-002, PAY-053
  tags: Id<"tags">[]; customFields: Record<string, unknown>;
  notes?: string;
  dsgvo?: { restrictedAt?: number; deletionRequestedAt?: number; scheduledPurgeAt?: string };   // DSGVO-02
  version: number }
// indexes: by_number (unique), by_vatId, by_status_name, by_mergedInto, by_debtorAccount, by_creditorAccount;
//          search index "search" on searchText (filter fields: status, kind)
```

```ts
contactAddresses:   { contactId; type: "billing" | "delivery" | "other"; address: PostalAddress; isDefault: boolean;
                      archivedAt?: number }                                   // CON-024
contactChannels:    { contactId; type: "email" | "phone" | "mobile" | "fax" | "web";
                      value: string; label?: string; isInvoiceEmail: boolean; isPrimary: boolean }
contactActivities:  { contactId; kind: "note" | "call" | "meeting" | "task";   // manual only; derived timeline events are computed, not stored (CON-120)
                      text?: string; dueAt?: number; doneAt?: number; documentId?: Id<"salesDocuments">;
                      attachments: FileRef[]; actor: Actor; editedAt?: number }
vatIdChecks:  🔒    { contactId?; vatId: string; provider: "bzst_evatr" | "eu_vies";
                      request: unknown; response: unknown;
                      status: "valid" | "invalid" | "unavailable";            // CON-055 (replaces valid: boolean)
                      qualified?: { name: "A"|"B"|"C"|"D"; street: "A"|"B"|"C"|"D"; postalCode: "A"|"B"|"C"|"D"; city: "A"|"B"|"C"|"D" };
                      providerRequestId?: string; checkedAt: number; retentionUntil: string }   // MISC-04 evidence (10 y)
sepaMandates:       { contactId; reference: string /* ≤ 35 chars, unique */; signedOn: string; scheme: "CORE" | "B2B";
                      sequence: "FRST" | "RCUR" | "OOFF"; iban: string; bic?: string;
                      file?: FileRef; capturedVia: "portal" | "upload" | "manual";
                      lastUsedAt?: string;                                    // expiry after 36 months without collection (POR-021)
                      revokedAt?: number; revokedReason?: string /* e.g. "MD01" */ }
contactKeys:        { contactId: Id<"contacts">; wrappedKey?: string /* AES-256 data key wrapped with APP_ENCRYPTION_KEY */;
                      createdAt: number; shreddedAt?: number }
                    // crypto-shredding of personal values in audit diffs (F02 §5.12, DSGVO-02 vs GOBD-06): purge deletes
                    // wrappedKey and sets shreddedAt; the hash chain covers the ciphertext and still verifies.
                    // index by_contact (unique)
dismissedDuplicates: { a: Id<"contacts">; b: Id<"contacts"> /* a < b */; at: number; actor: Actor }   // CON-131
contactMerges:      { winnerId: Id<"contacts">; loserId: Id<"contacts">;
                      moved: { table: string; id: string }[];                 // drafts, addresses, channels, activities, prices, mandates…
                      fieldChoices: Record<string, "winner" | "loser">; at: number; actor: Actor;
                      undoneAt?: number }                                     // CON-132/134 (undo while no moved draft was finalised)
contactAliases:     { contactId: Id<"contacts">; token: string /* normalised counterparty name/description token */;
                      source: "match_confirmed" | "manual"; createdAt: number }   // F07 BNK-048; index by_token
```

## 3. Products

```ts
products: { number: string; name: string; description?: string;
  internalNote?: string;                     // never printed (PRD-001)
  type: "service" | "good";
  unitCode: string;                          // Rec 20/21
  gtin?: string;                             // BT-157, GS1 check digit (PRD-008)
  priceMode: "net" | "gross"; unitPriceMicros: number;   // stored in the mode it was entered; the other is derived
  scheduledPrice?: { validFrom: string; priceMode: "net" | "gross"; unitPriceMicros: number };   // PRD-031 (applied by cron at 00:00 Europe/Berlin)
  purchasePriceMicros?: number;
  vatRateKey: VatRateKey;                    // resolved to a rate by supply date (UST-15)
  exemptionReasonCode?: string;              // VATEX if exempt
  placeOfSupplyRule?: PlaceOfSupplyRule;     // services only; absent = "general" (PRD-009, EC-046)
  reverseCharge13b?: Rc13bType;              // §13b Abs. 2 type when sold to a business in DE (UST-22, App. C row 8, EC-047/049)
  revenueAccountOverride?: string;
  laborCostShareBp?: number;                 // §35a (MISC-07)
  categoryId?: Id<"productCategories">;
  stock?: { enabled: boolean; quantityMilli: number; reorderLevelMilli?: number };   // P4; goods only
  extraUnits: { unitCode: string; factorMilli: number }[];
  tags: Id<"tags">[]; customFields: Record<string, unknown>;
  active: boolean; version: number }
// indexes: by_number (unique case-insensitive, incl. archived), by_active_name; search index on name + number
productCategories: { name: string; parentId?: Id<"productCategories"> }
customerPrices:    { productId; contactId; unitPriceMicros: number; priceMode: "net" | "gross"; validFrom?: string }
                   // index by_product_contact_validFrom (unique, PRD-030)
stockMovements:    { productId; quantityMilli: number /* +/- */; reason: "delivery_note" | "manual_in" | "manual_out" | "correction";
                     text?: string /* mandatory for manual_* and correction (PRD-094) */;
                     documentId?: Id<"salesDocuments">; at: number; actor: Actor }   // P4, append-only
```

## 4. Sales documents

### `salesDocuments` 🔒
```ts
type SalesDocType =
  | "quote" | "order_confirmation" | "delivery_note" | "proforma"
  | "invoice" | "advance_invoice" | "partial_invoice" | "final_invoice"
  | "cancellation"        // Stornorechnung (full mirror)
  | "correction"          // Rechnungskorrektur (credit) or Rechnungsberichtigung (rectification), see correctionKind
  | "self_billing"        // umsatzsteuerliche Gutschrift (P3)
  | "reminder";           // Zahlungserinnerung / Mahnung

type SalesDocStatus =
  | "draft" | "finalized" | "sent" | "cancelled"                      // all types
  | "accepted" | "rejected" | "expired" | "superseded"                // quotes (delivery notes: "accepted" = UI "Erhalten")
  | "partially_invoiced" | "invoiced"                                 // quote, order_confirmation, delivery_note, proforma
  | "withdrawn";                                                      // consumer Widerruf via portal (F10 POR-013, P4): quote, order_confirmation

type PaymentStatus = "open" | "partially_paid" | "paid" | "credited" | "written_off";
```

**Allowed stored `status` per type** (state machines in `src/domain/documents/lifecycle.ts`, F04 §4.2):

| Type | Stored `status` values | `paymentStatus` |
|---|---|---|
| `invoice`, `advance_invoice`, `partial_invoice`, `final_invoice` | `draft`, `finalized`, `sent`, `cancelled` | yes |
| `self_billing` (P3) | `draft`, `finalized`, `sent`, `cancelled` (objection) | via the linked voucher |
| `cancellation` | `finalized`, `sent` (created finalised) | unset |
| `correction` | `draft`, `finalized`, `sent`, `cancelled` | credit: yes (refund owed); rectification: unset |
| `quote` | `draft`, `finalized`, `sent`, `accepted`, `rejected`, `expired`, `superseded`, `partially_invoiced`, `invoiced`, `cancelled`, `withdrawn` | unset |
| `order_confirmation` | `draft`, `finalized`, `sent`, `partially_invoiced`, `invoiced`, `cancelled`, `withdrawn` | unset |
| `delivery_note` | `draft`, `finalized`, `sent`, `accepted`, `invoiced`, `cancelled` | unset |
| `proforma` | `draft`, `finalized`, `sent`, `invoiced`, `cancelled` | unset |
| `reminder` | `draft`, `finalized`, `sent`, `cancelled` ("gegenstandslos", DUN-009) | unset |

`sent` is set only by the owner's manual mark ("Als versendet markieren", `sendLog.kind = "mark_sent"`); a `retraction` of the only effective mark returns `sent → finalized` when no later act (reminder, dunning step) depends on it (F04 SND-18). The app never transmits documents.

**`overdue` is never stored.** It is derived at read time by the pure function `displayStatus()` (F04 §4.2.9, DOC-55): `paymentStatus ∈ {open, partially_paid} ∧ dueDate < today (Europe/Berlin)`. The daily job `receivables.refreshOverdue` only emits `invoice.overdue` once per document (recording `overdueNotifiedAt`) and never writes `status`/`paymentStatus`. "Blocked" (E-Rechnung could not be produced) is `artifactStatus = "blocked"`, not a `status` value.

**`paymentStatus` derivation** (`derivePaymentStatus`, F05 §4.3, precedence top-down): `written_off` (open = 0 and the last settling amount is a write-off) → `credited` (open = 0 and Rechnungskorrekturen/offsets cover the payable without any cash allocation) → `paid` (open = 0) → `partially_paid` (0 < open < payable) → `open`.

```ts
{ type: SalesDocType;
  status: SalesDocStatus;                // allowed values per type: table above
  paymentStatus?: PaymentStatus;         // invoice family, credit corrections; never "overdue"
  number?: string;                       // set at finalisation only
  numberRangeId?: Id<"numberRanges">;
  revision?: number;                     // quotes: 1, 2, … (QUO-06); NOT the OCC counter `version`
  contactId: Id<"contacts">;             // as entered; resolve contacts.mergedIntoId for display, never rewritten
  billingAddressId?: Id<"contactAddresses">;
  billingAddress?: PostalAddress;        // draft copy of the address last confirmed (CON-023, EC-111); frozen in the snapshot
  deliveryAddress?: PostalAddress;
  documentDate?: string;                 // set at finalisation (UST-05); quotes may set at creation
  supplyDate?: SupplyDate;               // mandatory for invoices (UST-08)
  supplyDateMode: "explicit" | "document_date";   // draft option "Leistungsdatum = Rechnungsdatum", resolved to {kind:"date"} at finalisation (DOC-21)
  dueDate?: string; validUntil?: string; // quotes
  currency: string; fxRateToEur?: FxRate;   // mandatory at finalisation for non-EUR (DOC-15); source bmf_monthly | ecb_daily | manual
  priceMode: "net" | "gross";            // gross: "largest net that fits" per VAT group (App. E.3); deviation in totals.byGroup
  taxCase: TaxCase; taxCaseOverridden?: { reason: string };
  subject?: string; headText?: string; footText?: string;
  buyerReference?: string;               // BT-10
  orderReference?: string;               // BT-13
  contractReference?: string;            // BT-12
  deliveryTerms?: string;                // order confirmations (QUO-08)
  paymentTerms: PaymentTerms; paymentMethodId?: Id<"paymentMethods">; bankAccountId?: Id<"bankAccounts">;
  showEpcQr: boolean; portalEnabled: boolean;
  showPrices?: boolean;                  // delivery notes (QUO-09; default false: PDF hides prices/totals, lines keep them)
  propertyRelated?: boolean;             // §14b note for consumers (DOC-46; auto-set from placeOfSupplyRule = property)
  kleinbetrag?: boolean;                 // Kleinbetragsrechnung (DOC-44, UST-14)
  constructionWork?: boolean;            // "Bauleistung": TypeCode 875/877 (App. A.2, open question 9.1)
  attachTimesheet?: boolean;             // F11 PRJ-014 → documentArtifacts kind timesheet_pdf
  documentDiscount?: { kind: "percent" | "amount"; valueBp?: number; amountCents?: number /* gross amount in gross mode */;
                       isSurcharge: boolean; reason?: string };
  language: "de" | "en"; layoutId: Id<"layouts">;
  einvoice: { format: "zugferd_en16931" | "zugferd_xrechnung" | "xrechnung_cii" | "xrechnung_ubl" | "none";
              decision?: "MUST_E" | "MAY_PAPER_OR_PDF" | "PDF_NEEDS_CONSENT" | "NOT_REQUIRED"; decidedAt?: number };
  attachments: { file: FileRef; embedInXml: boolean /* BG-24 */; includeInExport: boolean }[];   // DOC-18; ≤ 10; frozen at finalisation
  evidence: { file: FileRef; kind: "gelangensbestaetigung" | "cmr" | "ausfuhrnachweis" | "other";
              note?: string; addedAt: number; actor: Actor }[];   // INV-30 post-finalisation proofs; append-only; not part of the snapshot
  // relations
  originId?: Id<"salesDocuments">;       // quote → order → invoice chain; quote revision → previous revision
  sourceDocumentIds?: Id<"salesDocuments">[];   // many-to-one conversions (collective invoice from delivery notes, QUO-11)
  chainRootId?: Id<"salesDocuments">;
  correctsId?: Id<"salesDocuments">;     // cancellation/correction → original (BT-25/26)
  correctionKind?: "credit" | "rectification";   // type "correction": Rechnungskorrektur (381) vs Rechnungsberichtigung (384); a Storno is type "cancellation"
  rectifiedFields?: string[];            // rectification: e.g. ["buyer.address"] → "Berichtigt: …" (INV-13)
  deductions?: {                         // final_invoice: one row per deducted advance/partial (INV-06/07/09, UST-41, RI-08)
    advanceId: Id<"salesDocuments">;
    advanceNumber: string; advanceDate: string;       // BG-3: BT-25 / BT-26
    byGroup: { category: VatCategory; rateBp: number; netCents: number; vatCents: number; grossCents: number }[];   // received amounts (App. E.4)
    deductedGrossCents: number;                       // Σ byGroup.grossCents
    partiallyPaid: boolean }[];                       // true = advance was reduced to the received amount by a mandatory Rechnungskorrektur before the final (F04 INV-07, 10 EC-071)
    // BT-113 = totals.advancesDeductedGrossCents = Σ deductedGrossCents; BT-115 = totals.payableCents.
    // No advance may have an open amount when the final is finalised: unpaid → Storno; partially paid → Rechnungskorrektur down to the received amount (no "not deducted" option).
  deductedInId?: Id<"salesDocuments">;   // on an advance/partial: the final invoice that deducted it (set at the final's finalisation; cleared by its Storno)
  partial?: { mode: "percent" | "net" | "gross"; valueBp?: number; amountCents?: number };
  coverage?: { prepaidByGroup: { category: VatCategory; rateBp: number; netCents: number; vatCents: number }[];
               coveredBp: number };      // quotes/orders: derived invoicing progress cache (F04 §4.3.3); recomputable
  recurringTemplateId?: Id<"recurringTemplates">;
  recurringOccurrence?: { templateId: Id<"recurringTemplates">; date: string };   // REC-05 idempotency key
  reminder?: { invoiceId: Id<"salesDocuments">; level: number; feeCents: number; interestCents: number;
               flatFee40Cents: number; newDueDate: string; interestSegments?: unknown };
  selfBillingVoucherId?: Id<"vouchers">; // self_billing: linked purchase voucher (INV-16)
  origin?: { source: "sevdesk_export" | "lexoffice_csv" | "generic_csv"; externalId: string; importId: Id<"imports"> };   // archived import (F09)
  imported?: true;                       // read-only archive record with the original PDF as artifact, never re-rendered (F09, EC-190)
  datevBelegnummer?: string;             // DATEV-safe alias for a legacy number with invalid characters (E-EXP-10; set once, audited)
  // cached totals (recomputed on every draft change; frozen at finalisation)
  totals: { netCents: number; vatCents: number; grossCents: number; advancesDeductedGrossCents: number;
            payableCents: number;
            byGroup: { category: VatCategory; rateBp: number; netCents: number; vatCents: number;
                       enteredGrossCents?: number;      // gross mode: Σ entered line gross of the group
                       grossDeviationCents?: number }[]; // gross mode: computed − entered (0 or −1) → warning gross_rounding_deviation (DOC-10)
            vatEurCents?: number;                       // foreign currency: BT-111 (App. E.6)
            laborNetCents?: number };                   // §35a subtotal (App. E.7)
  openAmountCents?: number;
  // receivables (F05)
  dunningBlocked?: { reason: string; at: number };      // "Nicht mahnen" on the invoice (DUN-002)
  disputed?: { at: number; reason: string };            // "Bestritten" (DUN-034)
  zugang?: { date: string; basis: "email_manual" | "post" | "hand" | "upload_portal" | "other" | "manual"; reason?: string /* mandatory for manual override */ };   // receipt (Zugang) from the first sent mark (PAY-052): post/other = sentOn + postalDeliveryDays
  overdueNotifiedAt?: number;                           // invoice.overdue emitted (PAY-044); derived status, not stored
  collection?: { runId: Id<"sepaCollectionRuns">; collectionDate: string };   // "Einzug beauftragt" (POR-023, P4)
  // lifecycle
  snapshotId?: Id<"documentSnapshots">;
  artifactStatus?: "pending" | "ready" | "blocked";
  finalizedAt?: number; finalizedBy?: Actor;
  backdateReason?: string;
  sentAt?: number; sentOn?: string;      // first "Als versendet markieren": instant + business date (F04 SND; no e-mail sending)
  firstExportedAt?: number;              // derived cache: first export (to-do "exportiert, nicht markiert", F04 SND-21)
  viewedAt?: number;                     // portal view (F10, deferred)
  acceptance?: { at: number; byName: string; channel: "manual" | "portal" | "email" | "phone"; note?: string;
                 signatureStorageId?: Id<"_storage">; ip?: string; ua?: string; portalTokenId?: Id<"portalTokens">;
                 selectedOptionalLineIds?: Id<"documentLines">[]; earlyPerformanceRequested?: boolean;
                 snapshotHash: string };                // QUO-05, POR-008, POR-012 (set once)
  rejection?: { at: number; reason?: string; channel: "manual" | "portal" };   // QUO-05, POR-010
  received?: { date: string; byName: string };          // delivery note "Erhalten" (F04 §4.2.3)
  cancellation?: { at: number; reason: string; byDocumentId?: Id<"salesDocuments"> };   // withdraw / Storno / void reminder
  objection?: { date: string; text: string };           // self_billing Widerspruch (INV-16)
  lockedAt?: number;                     // Festschreibung (period lock or explicit)
  retentionClass: RetentionClass; retentionUntil?: string;
  costCenterId?: Id<"costCenters">; projectId?: Id<"projects">;
  tags: Id<"tags">[]; customFields: Record<string, unknown>;
  internalNote?: string;
  createdBy: Actor; channel: Channel; version: number }
// indexes: by_type_status_date, by_contact, by_number, by_chainRoot, by_paymentStatus_due, by_correctsId,
//          by_recurringOccurrence (templateId, date) — unique by convention, enforced in model (REC-05),
//          by_origin (source, externalId); search index (number, subject, contact name)
```

### `documentLines` 🔒 (frozen with the parent)
```ts
{ documentId; position: number;
  kind: "item" | "heading" | "text" | "subtotal";
  productId?: Id<"products">;
  productSyncedVersion?: number;                       // product.version at insertion → "Produkt geändert" (PRD-071)
  sourceLineId?: Id<"documentLines">;                  // line it was converted from (quote/order/delivery note line, F04 §4.3.3)
  name?: string; description?: string;                 // sanitized rich text (bold/italic/lists)
  quantityMilli?: number; unitCode?: string;
  unitPriceMicros?: number;                            // net or gross per salesDocuments.priceMode
  discount?: { kind: "percent" | "amount"; valueBp?: number; amountCents?: number };
  vatRateKey?: VatRateKey;                             // source key; rate re-resolved while draft (PRD-022)
  vatCategory?: VatCategory; vatRateBp?: number; exemptionReasonCode?: string; exemptionReasonText?: string;
  placeOfSupplyRule?: PlaceOfSupplyRule;               // copied from the product (App. C)
  reverseCharge13b?: Rc13bType;                        // copied from the product (App. C)
  linePeriod?: { from: string; to: string };           // BG-26 (DOC-21, EC-024 rate-change split)
  lineNetCents?: number;                               // cached, EN 16931 rounding (gross mode: allocated per App. E.3 step 4)
  lineGrossCents?: number;                             // gross mode: entered line gross (App. E.3 step 1)
  optional?: boolean;                                  // quotes only
  isLaborCost?: boolean;                               // §35a
  revenueAccount?: string; costCenterId?: Id<"costCenters">;
  timeEntryIds?: Id<"timeEntries">[];
  timeRounding?: TimeRounding & { perGroup: boolean }; // rule used when billing time (F11 PRJ-009)
  itemNumber?: string /* BT-155 */; buyerItemNumber?: string;
  fromSummary?: true;                                  // imported archive document rebuilt from a list row: one summary line per VAT rate (F09 IMP-020)
  // derived progress caches on quote/order lines (not part of the snapshot; recomputed from sourceLineId links)
  invoicedQtyMilli?: number; deliveredQtyMilli?: number }
```

### `documentSnapshots` 🔒, `documentArtifacts` 🔒, `sendLog` 🔒
```ts
documentSnapshots: { documentId; json: string /* canonical JSON of the full EN 16931 + render model */;
                     snapshotHash: string; ruleVersions: Record<string, string>; layoutVersionId; createdAt: number }
documentArtifacts: { documentId?: Id<"salesDocuments">; inboxItemId?: Id<"inboxItems">;   // exactly one; inboxItemId only for supplier correction letters (F06 INB-046)
                     kind: "pdf" | "zugferd_pdf" | "xrechnung_xml" | "validation_report_kosit"
                     | "validation_report_mustang" | "acceptance_pdf" | "timesheet_pdf" | "supplier_correction_letter" | "void_notice";   // no "eml" (no e-mail sending)
                     variant?: "original" | "copy" | "reading";   // pdf only: archived original / "Kopie" stamp / XRechnung "Lesefassung" (DOC-32, SND-02, MAIL-02); absent = original
                     storageId: Id<"_storage">; sha256: string; bytes: number; mime: string;
                     tool?: { name: string /* incl. "sevdesk-import" */; version: string; config?: string }; createdAt: number;
                     retentionUntil: string }
sendLog:           { documentId?: Id<"salesDocuments">; voucherId?: Id<"vouchers">; inboxItemId?: Id<"inboxItems">;   // exactly one
                     // append-only dispatch record: the app never sends; the owner exports and marks as sent (F04 SND, F05 DUN, F06 INB-046)
                     purpose: "document" | "reminder_void_notice" | "supplier_correction_request";
                     kind: "mark_sent" | "retraction"; retractsId?: Id<"sendLog">;   // retraction: reason in note (mandatory)
                     sentOn: string;                             // business date, ≤ today, ≥ finalisation date (Europe/Berlin)
                     channel: "email_manual" | "post" | "hand" | "upload_portal" | "other";   // upload_portal e.g. ZRE/OZG-RE for XRechnung
                     note?: string;                              // mandatory for channel "other" and for retractions
                     artifacts: { artifactId: Id<"documentArtifacts">; sha256: string }[];   // what was handed over = archived artifacts (RI-19)
                     einvoiceHandedOverElectronically?: boolean; // MUST_E evidence (ER-03, MAIL-04)
                     at: number; actor: Actor }
// indexes: by_document_at, by_voucher, by_inboxItem. Every export additionally writes an audit entry "document.export" (artifact IDs + sha256).
```

### Recurring, dunning, portal
```ts
recurringTemplates: { name: string; status: "active" | "inactive";   // UI "Pausiert" = inactive; "Beendet" derived (endDate passed or generatedCount = maxCount)
  draft: Omit<SalesDocDraft, "number" | "documentDate">;   // contact, lines, texts, terms…
  contractReference?: string;                              // BT-12 of every generated invoice (REC-09)
  schedule: { interval: "P7D" | "P14D" | "P1M" | "P2M" | "P3M" | "P6M" | "P1Y" | "P2Y" | "P3Y" | "P4Y" | "P5Y";
              firstDate: string; nextDate: string; endDate?: string; maxCount?: number;
              billing: "in_advance" | "in_arrears"; periodTextEnabled: boolean };
  automation: { finalize: boolean };   // never sends; a generated invoice creates the to-do "Exportieren und versenden" (F04 REC)
  autoCharge?: { method: "stripe_card" | "stripe_sepa" | "own_sepa"; customerRef?: string;
                 paymentMethodRef?: string; mandateId?: Id<"sepaMandates"> };   // F10 POR-025 (P4)
  skippedOccurrences: { date: string; at: number; actor: Actor }[];   // REC-10 "überspringen" (audited)
  generatedCount: number; lastGeneratedId?: Id<"salesDocuments"> }

dunningPolicies: { name: string; isDefault: boolean; appliesTo: { consumer: boolean; business: boolean };
  steps: { level: number; daysAfter: number /* level 1: after due date; later: after the previous reminder's Zugang (DUN-054) */; title: string; feeCents: number; addInterest: boolean;
           addFlatFee40: boolean /* B2B only, once per claim (MAHN-03) */; newDueDays: number;
           textTemplateId?: Id<"textTemplates">; autoFinalize: boolean }[];   // never sends; escalation counts from the previous reminder's sentOn/Zugang (F05)
  dueSoonDays?: number; dueSoonTodo: boolean;   // "Bald fällig" list/to-do, no document (DUN-053)
  minOpenAmountCents: number;            // DUN-001 (default 500)
  pauseOnPartialPaymentDays: number;     // DUN-034 (default 14)
  stopAfterLastLevel: boolean }
dunningCases: { invoiceId; policyId; currentLevel: number;
                status: "active" | "paused" | "closed" | "handed_over";     // F05 §4.4
                pausedUntil?: string; pausedReason?: string;
                disputed?: { at: number; reason: string };
                handedOver?: { at: number; partner: string };
                defaultStartDate?: string; defaultRoute?: "calendar" | "reminder" | "30_days";   // PAY-053
                flatFeeCharged: boolean; reminders: Id<"salesDocuments">[]; nextActionDate?: string;
                limitationDate: string /* §195/199 BGB */ }
dunningRuns: { date: string; mode: "auto" | "manual"; evaluated: number;
               actions: { invoiceId: Id<"salesDocuments">; action: "create_draft" | "finalize" | "skip" | "todo_mark_sent";
                          skipReason?: string; reminderId?: Id<"salesDocuments">; error?: string }[];
               startedAt: number; finishedAt?: number; actor: Actor }   // DUN-037 (append-only)

// portalTokens and withdrawals are RESERVED: the tables exist in the schema for F10 but no function writes them while F10 is deferred (tailnet-only, ADR-016)
portalTokens: { tokenHash: string /* SHA-256, lookup */; tokenCiphertext: string /* AES-256-GCM, APP_ENCRYPTION_KEY (POR-002) */;
                chainRootId: Id<"salesDocuments">;
                status: "active" | "revoked";    // "expired" is computed from expiresAt
                createdAt: number; expiresAt?: number;
                revokedAt?: number; rotatedToId?: Id<"portalTokens">; lastViewedAt?: number; viewCount: number }
withdrawals: 🔒 { chainRootId: Id<"salesDocuments">; contractDocumentId: Id<"salesDocuments">;   // consumer Widerruf (F10 POR-011)
                  portalTokenId: Id<"portalTokens">; at: number; name: string; contractRef: string; email?: string;
                  ip: string; ua: string;
                  acknowledgement: { file: FileRef; sentAt?: number; sendLogId?: Id<"sendLog"> };
                  handledAt?: number; resolution?: { correctionIds: Id<"salesDocuments">[]; refundPaymentIds: Id<"payments">[]; note?: string } }
```

## 5. Payments and receivables

One `payments` row per **allocation** (target). A combined payment (Sammelzahlung) is several rows sharing `allocationGroupId`. Every payment row and its journal entries, `allocations` rows, the target's `openAmountCents`/`paymentStatus`, the dunning case, the audit entry and the webhook outbox event are written in one transaction (PAY-016).

```ts
payments: 🔒 { target: { kind: "salesDocument" | "voucher" | "contactCredit"; id: string };   // contactCredit: id = contactId (PAY-031)
  date: string; amountCents: number; currency: string;
  eurAmountCents?: number;                // foreign currency: EUR actually received/paid (PAY-018)
  fxRate?: FxRate;
  source: { kind: "bank"; transactionId: Id<"bankTransactions"> }
        | { kind: "cash" }                 // "Bar bezahlt" (F07 CSH-021/022): posts against role `cash`; never-negative check CSH-026
        | { kind: "private" }              // voucher "privat bezahlt" (F07 CSH-023): Privateinlage / Verrechnungskonto Gesellschafter
        | { kind: "clearing"; accountId: Id<"bankAccounts"> } | { kind: "provider"; provider: string; ref: string }
        | { kind: "credit" }               // applying a credit balance (pair with a negative contactCredit row, PAY-032)
        | { kind: "adjustment" };          // write-off without cash (PAY-025)
  differences: { reason: "skonto" | "bank_fees" | "dunning_fees" | "default_interest" | "write_off" | "other"
                       | "partial" | "collective";   // partial/collective: imported sevdesk data only (PAY-028)
                 subReason?: "insolvency" | "uncollectible" | "statute_barred" | "waiver";   // write_off
                 amountCents: number;      // + = settles more than the cash (underpayment accepted); − = cash exceeds claim
                 account?: string;         // "other": ledger account chosen
                 text?: string;            // "other": reason ≥ 5 chars
                 vatCorrection?: { rateBp: number; netCents: number; vatCents: number }[] }[];   // UST-32
  allocationGroupId?: string;             // Sammelzahlung grouping (PAY-013)
  journalEntryIds: Id<"journalEntries">[];
  reversalOfId?: Id<"payments">;          // on the reversal row (negated amounts, PAY-040)
  reversedById?: Id<"payments">;          // on the original; payments are corrected by a reversal, never edited
  reason?: string;                        // mandatory on reversals (≥ 5 chars)
  reconciledTransactionId?: Id<"bankTransactions">;   // clearing payment later matched to a bank transaction (PAY-047; set once)
  backdateReason?: string;                // cash: mandatory when the date is > 10 days in the past (CSH-021)
  note?: string;
  receiptFile?: FileRef;                  // Quittung PDF for a cash payment, archived on first generation (CSH-028; set once)
  actor: Actor; recordedAt: number; lockedAt?: number }
// indexes: by_target, by_source_transaction, by_allocationGroup, by_date
```
Invariant per row: `amountCents + Σ differences.amountCents` = reduction of the target's open amount (RI-09). Overpayments become a `contactCredit` row (PAY-030), never a silent over-allocation.

### Online payments (F10, P4)
```ts
providerEvents: 🔒 { provider: "stripe" | "mollie" | "paypal"; eventId: string; type: string;
                     rawSha256: string; payloadStorageId: Id<"_storage">; receivedAt: number;
                     processedAt?: number; processingError?: string }
                     // index by_provider_event (unique, POR-017)
providerPayments:  { provider: "stripe" | "mollie" | "paypal"; ref: string /* session / payment / order id */;
                     documentId: Id<"salesDocuments">; portalTokenId?: Id<"portalTokens">;
                     idempotencyKey: string /* docId:openAmount:version */; amountCents: number; currency: string;
                     methods: string[];
                     state: "created" | "pending" | "succeeded" | "failed" | "refunded" | "disputed";   // "Zahlung in Bearbeitung" = pending
                     paymentId?: Id<"payments">; feeCents?: number; payoutRef?: string;
                     attempt?: { autoCharge: boolean; n: number; nextRetryOn?: string };   // POR-025 retries +3 / +7 days
                     updatedAt: number }
                     // index by_provider_ref (unique), by_document
sepaCollectionRuns: 🔒 { collectionDate: string; createdAt: number; actor: Actor;
                         items: { documentId: Id<"salesDocuments">; mandateId: Id<"sepaMandates">; amountCents: number;
                                  sequence: "FRST" | "RCUR" | "OOFF"; returned?: { at: number; reasonCode: string; paymentId?: Id<"payments"> } }[];
                         file: FileRef; painVersion: string; xsdValid: boolean;
                         status: "generated" | "submitted" | "credited" | "partially_returned";
                         submittedAt?: number; creditTransactionId?: Id<"bankTransactions"> }   // POR-023/024
```

## 6. Purchases (Belege) and inbox

```ts
vouchers: 🔒 { direction: "expense" | "income";
  kind: "standard" | "bewirtung" | "eigenbeleg" | "asset" | "tax_payment" | "private";
  status: "draft" | "open" | "scheduled" | "partially_paid" | "paid" | "cancelled";   // "open" onwards = booked (F06 §4.2)
  supplierContactId?: Id<"contacts">; supplierName?: string; supplierVatId?: string;
  documentNumber?: string;               // the supplier's number (free text)
  internalNumber?: string;               // our gapless Belegnummer from the voucherInternal range (GOBD-05),
                                         // assigned atomically at booking ("Buchen" = finalise, VOU-007); drafts have none
  documentDate: string; supplyDate?: SupplyDate; dueDate?: string; receivedAt: number;
  currency: string; fxRateToEur?: FxRate;   // VOU-028: ecb_daily | bmf_monthly | manual | transaction (actual bank debit)
  priceMode: "net" | "gross";
  taxRule: "input_vat_deductible" | "no_input_vat" | "reverse_charge_13b_de" | "reverse_charge_eu"
         | "reverse_charge_non_eu" | "intra_community_acquisition" | "import_vat" | "kleinunternehmer_supplier"
         | "output_vat" | "exempt_income" | "not_taxable";   // last three: income vouchers (VOU-010)
  totals: { netCents: number; vatCents: number; grossCents: number; selfAssessedVatCents: number;
            byRate: { rateBp: number; netCents: number; vatCents: number }[] };   // document currency
  totalsEur?: { netCents: number; vatCents: number; grossCents: number; selfAssessedVatCents: number };   // non-EUR (VOU-028; Σ lines)
  openAmountCents: number;
  payee?: { name: string; iban: string; bic?: string };          // BT-84 payee (INB-043)
  skontoTerms?: { percentBp: number; days: number; baseCents?: number };   // BT-20
  originalFiles: { storageId: Id<"_storage">; sha256: string; bytes: number; mime: string; name: string; pages?: number;
                   role: "original" | "extracted_xml" | "embedded_attachment" | "eml";
                   capturedAt: number; clientCapturedAt?: number; capturedBy: Actor;
                   capturedVia: "upload" | "email" | "app" | "api" | "mcp"; replacedBy?: number }[];   // GOBD-07/08, VOU-120…122
  renditions: { storageId: Id<"_storage">; sha256: string; mime: string; ofFileIndex: number;
                kind: "thumbnail" | "crop_deskew" | "heic_jpeg" | "combined_pdf" | "html_pdf" | "visualisation"; createdAt: number }[];   // VOU-121
  checkedComplete?: { at: number; actor: Actor };                // "Vollständig geprüft" (VOU-123)
  einvoice?: { syntax: "ubl" | "cii"; profile?: string; xmlStorageId: Id<"_storage">; xmlSha256: string;
               notEInvoice?: boolean;                            // MINIMUM / BASIC-WL (INB-023)
               validation: { acceptable: boolean; category?: "ok" | "format" | "business_rule" | "content";
                             reportStorageId: Id<"_storage">; tool: string; at: number } };   // ER-02, INB-024
  inputVatAtRisk?: string[];                                     // missing §14 Abs. 4 items (VOU-006, EC-VOU-07)
  creditNoteOfId?: Id<"vouchers">;                               // supplier credit note → original (VOU-012)
  ocr?: { model: string; confidence: number; raw: unknown; at: number };
  bewirtung?: { occasionType: "geschaeftlich" | "arbeitnehmer"; occasion: string; participants: string[]; host: string;
                place: string; date: string; tipCents?: number;
                tseConfirmed: boolean; hostOnInvoiceConfirmed?: boolean /* gross > 250 € */;
                approvedAt?: number; eigenbelegFile?: FileRef;
                versions: { eigenbelegFile: FileRef; approvedAt: number; supersededAt: number; reason: string }[] };   // MISC-05, VOU-060…062
  eigenbeleg?: { reason: "lost" | "not_obtainable" | "other"; reasonText?: string; recipient: string; purpose: string;
                 approvedAt?: number; file?: FileRef };          // VOU-063 (approval freezes it)
  taxPayment?: { subtype: "ust_prepayment" | "sondervorauszahlung" | "ust_annual" | "gewerbesteuer"
                        | "est_private" | "kst"; period?: string; filingId?: Id<"taxFilings"> };   // F08 TAX-018
  recurringPayment?: boolean;            // "regelmäßig wiederkehrend" → §11 EStG 10-day rule (F08 TAX-016)
  rebillable?: { markupBp: number; revenueAccount?: string };    // "weiterberechenbar" (F11 PRJ-020)
  rebilledLineId?: Id<"documentLines">;  // set once when re-billed
  duplicateOfId?: Id<"vouchers">;
  duplicateDismissals: Id<"vouchers">[]; // "Keine Dublette" pairs (VOU-053)
  recurringVoucherId?: Id<"recurringVouchers">;
  costCenterId?: Id<"costCenters">; projectId?: Id<"projects">; tags: Id<"tags">[];
  internalNote?: string;
  imported?: true; origin?: { source: "sevdesk_export"; externalId: string; importId: Id<"imports"> };   // archive record from the sevdesk export (F09 IMP-025)
  recordedAt: number; bookedAt?: number; lockedAt?: number;
  retentionClass: "vouchers8"; retentionUntil?: string; actor: Actor; version: number }
// indexes: by_internalNumber (unique when set), by_supplier_documentNumber, by_status_due, by_einvoice_identity

voucherLines: 🔒 { voucherId; position: number; account: string /* SKR */; description?: string;
  quantityMilli?: number;                 // default 1000 (VOU-002)
  netCents: number; vatRateBp: number; vatCents: number; grossCents: number;
  selfAssessedVatCents?: number;          // §13b / §1a self-assessment per line (VOU-022)
  netEurCents?: number; vatEurCents?: number;   // non-EUR: per-line half-up conversion (VOU-028)
  nonDeductibleShareBp?: number;          // Bewirtung 30 %, private share
  assetId?: Id<"assets">; costCenterId?: Id<"costCenters">; projectId?: Id<"projects"> }

inboxItems: { source: "email" | "upload" | "app" | "api" | "mcp";   // email = e-mail-in via Cloudflare Email Routing → Worker → R2, polled (F06 INB-048/049); no IMAP
  receivedAt: number; clientCapturedAt?: number; from?: string; subject?: string; messageId?: string;
  r2?: { bucket: string; objectKey: string; etag?: string };   // e-mail-in object; idempotency key; deleted from R2 only after commit (F06 INB-049)
  duplicateOfInboxItemId?: Id<"inboxItems">;                   // same Message-ID seen again (kept, status "duplicate")
  files: { storageId: Id<"_storage">; sha256: string; name: string; mime: string; bytes: number }[];
  classification?: "xrechnung" | "zugferd" | "pdf" | "image" | "other";
  einvoiceProfile?: string; confidence?: number; flags?: string[];   // e.g. "unknown_sender", "not_einvoice"
  status: "new" | "processing" | "needs_review" | "converted" | "rejected" | "duplicate";
  rejectReason?: "no_business_document" | "not_addressed_to_us" | "faulty_invoice_correction_requested" | "other";   // INB-010
  rejectText?: string;
  attempts: number; nextAttemptAt?: number;   // classification retries (INB-024)
  retentionUntil?: string;                    // rejected items (EC-INB-12)
  voucherId?: Id<"vouchers">; error?: string }
// indexes: by_status_receivedAt, by_messageId, by_r2Object (bucket, objectKey; unique), by_file_sha256
// flags include "unknown_sender", "sender_auth_failed", "attachment_too_large", "mail_unparseable", "not_einvoice"

supplierProfiles: { key: string /* vatId | iban | normalized name */; contactId?: Id<"contacts">;
  lastAccount?: string; lastTaxRule?: string; lastCostCenterId?: Id<"costCenters">; uses: number; updatedAt: number }

recurringVouchers: { template: Partial<Voucher>; interval: string /* P1W … P5Y */; firstDate: string; nextDate: string; endDate?: string;
  active: boolean; createAs: "open" | "draft";
  expectedMandateRef?: string; expectedIban?: string; referenceFile?: FileRef;   // linked, not copied (VOU-064)
  recurringPayment?: boolean;
  lastGeneratedIds: Id<"vouchers">[] /* last 3 */ }
```

## 7. Banking and cash

```ts
bankTransactions: 🔒 { accountId: Id<"bankAccounts">;   // booked transactions only; pending items live in bankPendingTransactions (BNK-111)
  bookingDate: string /* Europe/Berlin (BNK-112) */; valueDate?: string; amountCents: number; currency: string;
  amountEurCents?: number; fxRate?: FxRate;   // non-EUR pockets (BNK-028)
  counterpartyName?: string; counterpartyIban?: string; counterpartyBic?: string;
  counterpartySource?: "provider" | "description" | "statement";   // BNK-120
  purpose: string; reference?: string /* structured, e.g. RF */; endToEndId?: string; mandateRef?: string; creditorId?: string; bankRef?: string;
  source: { kind: "enable_banking" | "camt053" | "mt940" | "revolut_csv" | "csv";   // first source that delivered the row
            entryReference?: string;          // Enable Banking / statement entry reference: the dedupe key (never transaction_id, BNK-109)
            providerTransactionId?: string;   // informational only (Enable Banking transaction_id "may change"; Revolut CSV "ID")
            bankTransactionCode?: string; proprietaryCode?: string; merchantName?: string; mcc?: string;
            feeCents?: number;                // fee reported as a field, booked as a separate journal line (BNK-023)
            exchangeRate?: string; instructedAmount?: { amountMinor: number; currency: string };
            balanceAfterCents?: number;       // continuity check (BNK-035)
            bookedAtRaw?: string /* UTC timestamp as delivered */; importId?: Id<"bankImports">; rawSha256: string };
  sources: { kind: string; importId?: Id<"bankImports">; entryReference?: string; providerTransactionId?: string;
             rawSha256: string; at: number }[];   // further sources that delivered the same booking (cross-source dedupe, BNK-110; append-only)
  dedupeKey: string;                      // `${accountId}:er:${entryReference}` or `${accountId}:h:${contentHash}:${ordinal}` (BNK-109/034)
  contentHash: string;                    // sha256(accountId, bookingDate, valueDate, amountCents, currency, normalise(iban ∨ name), normalise(purpose)) (BNK-110)
  importId?: Id<"bankImports">;
  status: "open" | "matched" | "partially_matched" | "booked" | "private" | "transfer" | "ignored";
  ignoredReason?: "duplicate_of_file_import" | "neutralised_pair" | "test_or_zero" | "import_rolled_back";   // BNK-036/063
  ignoredLinkId?: Id<"bankTransactions">;
  reversalOfId?: Id<"bankTransactions">;  // bank counter-entry confirmed as reversal of the original (BNK-121; set once)
  allocatedCents: number;
  recordedAt: number; bookedAt?: number; lockedAt?: number }
// indexes: by_dedupeKey (unique), by_account_contentHash, by_account_bookingDate, by_status, by_account_entryReference
bankPendingTransactions: { accountId: Id<"bankAccounts">; entryReference?: string; bookingDate?: string; amountCents: number;
  currency: string; counterpartyName?: string; purpose: string; fetchedAt: number; rawSha256: string }
  // not protected, not part of the books: provisional feed rows (status PDNG), replaced for the fetched window on every poll (BNK-111)
bankTransactionRevisions: 🔒 { transactionId: Id<"bankTransactions">; sourceKind: string; rawSha256: string; rawJson: string;
                               fetchedAt: number; applied: boolean }   // false = a re-delivered booked row differs (integrity finding, BNK-113)
  // append-only raw payloads / file line references for GoBD traceability; unique (transactionId, rawSha256)
bankStatements: 🔒 { accountId: Id<"bankAccounts">; periodFrom: string; periodTo: string;
  periodStartUtc: number; periodEndUtc: number;          // statements are UTC by default (EC-155)
  pdf?: FileRef; camt?: FileRef; other?: FileRef[];      // signed PDF = official Kontoauszug; CAMT/MT940/CSV as imported
  openingBalanceCents?: number; closingBalanceCents?: number; importId?: Id<"bankImports">;
  reconciled: boolean; differences?: { kind: "missing" | "extra" | "amount"; detail: string; transactionId?: Id<"bankTransactions">; amountCents?: number }[];
  rolledBack?: boolean; uploadedAt: number; retentionUntil: string }
  // official Kontoauszug per currency account; monthly import to-do (BNK-030, EC-156); statement import is the main bank data path in P1
bankImports: { accountId; source: "enable_banking" | "camt053" | "mt940" | "revolut_csv" | "csv";
  fileStorageId?: Id<"_storage">; fileSha256?: string; periodFrom: string; periodTo: string;
  openingBalanceCents?: number; closingBalanceCents?: number; continuityOk?: boolean;   // GOBD-02
  counts: { total: number; inserted: number; duplicates: number; mergedCrossSource: number; possibleDuplicates: number };
  rolledBackAt?: number; at: number; actor: Actor }
possibleDuplicates: { accountId: Id<"bankAccounts">; candidate: unknown /* normalised row */; existingIds: Id<"bankTransactions">[];
  importId?: Id<"bankImports">; status: "open" | "same" | "separate"; resolvedAt?: number; actor?: Actor }   // review list (BNK-109/110)
matchSuggestions: { transactionId;
  kind: "single" | "combined" | "partial";
  allocations: { target: { kind: "salesDocument" | "voucher" | "contactCredit" | "payment" | "cashTransfer"; id: string };   // payment = existing unreconciled manual payment; cashTransfer = open Geldtransit from a cash deposit
                 amountCents: number; differences?: { reason: string; amountCents: number }[] }[];
  score: number /* 0..1 */;
  reasons: ("number_in_purpose" | "rf_reference" | "exact_amount" | "bill_amount" | "skonto_amount" | "known_iban"
          | "name_similarity" | "date_window" | "rule" | "existing_manual_payment" | "recurring_expected"
          | "amount_tolerance" | "partial" | "ambiguous")[];
  status: "suggested" | "auto_applied" | "confirmed" | "rejected"; createdAt: number }
matchRejections: { transactionId: Id<"bankTransactions">; target: { kind: string; id: string }; at: number; actor: Actor }   // BNK-046
matchingRules: { name: string; priority: number; enabled: boolean; mode: "suggest" | "auto";   // API/MCP-created rules: always "suggest" (BNK-054)
  when: { accountId?: string; direction?: "in" | "out"; currency?: string; bankTransactionCode?: string; proprietaryCode?: string;
          purposeContains?: string; purposeRegex?: string /* RE2-safe, ≤ 200 chars */;
          counterpartyContains?: string; ibanEquals?: string; merchantContains?: string; mccIn?: string[];
          amountMinCents?: number; amountMaxCents?: number };
  then: { action: "categorize" | "private" | "transfer" | "link_contact" | "ignore" | "loan";
          account?: string; taxRule?: string; contactId?: Id<"contacts">;
          transferTarget?: { kind: "bank"; accountId: Id<"bankAccounts"> } | { kind: "cash" };
          loanAccount?: string; interestAccount?: string;
          createVoucher?: boolean; statementSufficesAsVoucher?: boolean };   // BNK-052
  createdVia: Channel; createdAt: number }

// Cash (B3, F07 CSH-020…030): no cash book. One cash ledger account (role `cash`, SKR03 1000 / SKR04 1600); its balance and
// movement list are derived from journal lines. Cash receipts/payments are `payments` with source { kind: "cash" }.
cashTransfers: 🔒 { date: string; kind: "deposit_to_bank" | "private_withdrawal" | "bank_withdrawal_to_cash";   // CSH-024/025
  amountCents: number /* > 0 */; bankAccountId?: Id<"bankAccounts">;
  bankTransactionId?: Id<"bankTransactions">;   // deposit: bank credit matched later (set once); ATM: the marked bank debit
  note?: string; backdateReason?: string;       // > 10 days in the past (CSH-021 dating rules)
  eigenbelegFile: FileRef;                      // auto Eigenbeleg PDF with hash
  journalEntryIds: Id<"journalEntries">[];
  reversalOfId?: Id<"cashTransfers">; reason?: string;   // reversal row (CSH-027)
  recordedAt: number; actor: Actor }
// never-negative (CSH-026, RI-11): the `cash` account balance in (date, journal seq) order ≥ 0 at every date, checked in the serialisable mutation
```

## 8. Bookkeeping, assets, tax

The journal is a **single double-entry ledger**. Postings are produced only by the pure posting engine (`src/domain/accounting/post.ts`) and speak in **account roles** (`receivable`, `revenue.domestic.19`, `vat.output.19`, `bank.<accountId>`, …); roles are resolved to SKR accounts through `accountRoleMappings` valid on the posting date. Sales documents post at **finalisation** and payments at **allocation** (from P1); vouchers post at booking.

```ts
ledgerAccounts: { chart: "SKR03" | "SKR04"; number: string; name: string;
  type: "asset" | "liability" | "equity" | "revenue" | "expense" | "neutral";
  taxKeyDefault?: string; automaticVatAccount?: boolean; euerKey?: string; euerLineByYear?: Record<string, string>;
  bwaGroup?: string; passThrough?: boolean /* durchlaufende Posten (VOU-011) */;
  allowedTaxRules?: string[]; isSystem: boolean; archivedAt?: number }   // seeded from data files

accountRoleMappings: { chart: "SKR03" | "SKR04"; role: string; account: string;
  validFrom: string; mappingVersion: string /* e.g. "roles-2026.1" or "override-<n>" */;
  source: "seed" | "override"; sourceText?: string;          // override: audited with source text (ACC-008)
  confirmedByAdvisorOn?: string }                            // optional, non-blocking "Mit Steuerberater geprüft am" (⚠ rows); defaults are decided (B5)
  // append-only versions; resolution = latest validFrom ≤ posting date per (chart, role); index by_chart_role_validFrom

journalEntries: 🔒 { seq: number;                           // gapless (GOBD-05)
  date: string; period: string /* YYYY-MM */;
  originalDate?: string; latePosting?: { reason: string };  // externally dated event into a locked period → first open period (ACC-006 b)
  lines: { account: string; role?: string; debitCents: number; creditCents: number; taxKey?: string; costCenterId?: string;
           contactId?: Id<"contacts">;                      // removed by staged purge after contact anonymisation (PRV-007)
           taxPointDate?: string; taxPeriod?: string;       // VAT-relevant lines (TAX-008); UStVA reads taxPeriod
           currency?: string; amountFx?: number /* minor units */; fxRate?: FxRate }[];   // ACC-023
                                                            // Σdebit = Σcredit > 0, ≥ 2 lines (asserted)
  text: string /* ≤ 60 chars (DATEV) */; longText?: string;
  source: { kind: "salesDocument" | "voucher" | "payment" | "bankTransaction" | "cashTransfer" | "asset_depreciation" | "manual"
                  | "opening_balance" | "tax" | "fx" | "period_close";
            id: string };
  attachments?: FileRef[];                                  // manual entries: required unless opening balance or reversal (ACC-005)
  ruleVersion: string; roleMappingVersion: string; explanation: string;   // "Warum dieses Konto?" key (ACC-003)
  reversalOfId?: Id<"journalEntries">; recordedAt: number; lockedAt?: number; actor: Actor }
// indexes: by_seq (unique), by_period, by_source, by_account (via lines read model)

allocations: 🔒 { paymentId: Id<"payments">;                 // cash-basis view (F08 §4.4): EÜR, Ist-UStVA, profitability
  target: { kind: "salesDocument" | "voucher" | "opening_item"; id: string };
  date: string /* payment date */; taxPeriod?: string;
  kind: "payment" | "skonto" | "write_off" | "other_difference" | "reversal";
  account: string; role?: string; vatRateBp: number; netCents: number; vatCents: number; grossCents: number;
  alreadyTaxed?: boolean;                                   // Soll → Ist switch: VAT declared before (E-TAX-07)
  recordedAt: number }
  // pro rata by gross per (account, rate) of the target, largest remainder; Σ over a fully paid document = document net/VAT

periods: { period: string /* YYYY-MM */; status: "open" | "locking" | "locked"; lockedAt?: number; lockedBy?: Actor;
           reason?: "ustva_submitted" | "zm_submitted" | "euer_submitted" | "manual" | "datev_export" | "year_close" }   // GOBD-06 Festschreibung; locking = lock job running (E-ACC-20); irreversible

assets: 🔒 { inventoryNumber: string; name: string; account: string;
  acquisitionDate: string; costCents: number; voucherLineId?: Id<"voucherLines">;
  method: "linear" | "degressive" | "gwg" | "pool" | "ev_special";
  usefulLifeMonths?: number; degressiveRateBp?: number; poolYear?: number;
  costCenterId?: Id<"costCenters">; notes?: string;
  disposal?: { date: string; kind: "sale" | "scrap" | "withdrawal"; proceedsCents?: number; documentId?: string; journalEntryId?: Id<"journalEntries"> };
  firstDepreciationAt?: number;           // after this only disposal and notes may change (AST-001)
  ruleVersion: string }
depreciationRuns: 🔒 { year: number; month?: number; entries: { assetId: Id<"assets">; amountCents: number; journalEntryId: Id<"journalEntries"> }[]; at: number }
  // idempotent per (asset, period)

taxFilings: 🔒 { kind: "ustva" | "ustva_correction" | "zm" | "zm_correction" | "sondervorauszahlung" | "euer"; period: string /* YYYY-MM | YYYY-Qn | YYYY (euer) */; ruleVersion: string;
  values: Record<string, number> /* Kennzahl → cents (or whole euros per form rule) */;
  drillDown: Record<string, { source: string; id: string }[]>;   // frozen contributor list at submission (TAX-005)
  supersedesId?: Id<"taxFilings">;        // correction filing → previous filing (TAX-007)
  overrideReason?: string;                // ZM ↔ UStVA mismatch override (TAX-010)
  status: "draft" | "submitted_manually" | "superseded";
  submittedVia?: "mein_elster_manual" | "eric";   // manual entry in Mein ELSTER with the app's step-by-step sheet; ERiC is a P4 option (F08 TAX-020…024)
  submittedOn?: string; sheetHash?: string;        // the sheet version the owner entered (F08 TAX-021)
  elsterReportedTotalCents?: number;               // cross-check value shown by ELSTER (e.g. Kz 83)
  submittedValuesDiffer?: boolean; valuesDifferReason?: string;   // "abweichend übermittelt"
  submittedAt?: number; transmissionTicket?: string /* ELSTER Transferticket, mandatory at submission */; protocolStorageId?: Id<"_storage">; actor: Actor }

plannedCashItems: { name: string; direction: "in" | "out"; amountCents: number; currency: string;
  kind: "manual" | "tax_prepayment";      // tax_prepayment: ESt/GewSt/KSt Vorauszahlungen (TAX-019)
  taxKind?: "est" | "gewst" | "kst";
  date?: string; recurrence?: { interval: string; firstDate: string; endDate?: string };
  confidenceBp?: number; note?: string; archivedAt?: number }   // RPT-013; not bookkeeping data

taxReserveInputs: { year: number; profitOverrideCents?: number; deductionsCents?: number; splitting: boolean;
  churchTaxBp?: 0 | 800 | 900; gewerbesteuerHebesatzBp?: number; partners?: { name: string; shareBp: number }[] }   // RPT-010 inputs (not filing data)
```

## 9. Projects and time (P4)

```ts
projects:    { number: string /* own range, docType "project" */; name: string; description?: string;
               contactId?: Id<"contacts">; status: "active" | "done" | "archived";
               billingMode: "hourly" | "fixed" | "non_billable";
               hourlyRateMicros?: number; internalCostRateMicros?: number; currency: string /* = contact currency */;
               budget?: { kind: "hours" | "amount"; value: number /* minutes for hours, cents for amount */ };
               budgetAlerts: { thresholdBp: 8000 | 10000; notifiedAt?: number }[];   // re-armed when the budget is raised
               startDate?: string; endDate?: string; defaultProductId?: Id<"products">;
               costCenterId?: Id<"costCenters">; rounding?: TimeRounding; attachTimesheetDefault?: boolean }
timeEntries: { projectId?: Id<"projects">; contactId?: Id<"contacts">; date: string /* Europe/Berlin date of start */;
               startedAt?: number; endedAt?: number; durationMinutes: number; roundedMinutes?: number /* computed at invoicing */;
               description: string; productId?: Id<"products">;
               hourlyRateMicros: number; billable: boolean;
               status: "open" | "in_draft" | "invoiced";            // F11 §4.1
               invoicedLineId?: Id<"documentLines">;
               invoicedLineHistory: Id<"documentLines">[];          // previous lines after Storno ("wieder abrechenbar")
               source: "timer" | "manual" | "mcp" | "api" | "offline";
               incomplete?: boolean; conflict?: boolean; flaggedForReview?: boolean;   // E-PRJ-02/03/29
               lockedAt?: number; retentionClass: RetentionClass; retentionUntil?: string;   // invoiced → vouchers8 of the invoice (PRJ-019)
               actor: Actor }
runningTimer: { startedAt: number; projectId?: Id<"projects">; contactId?: Id<"contacts">; description?: string;
                productId?: Id<"products">; startedVia: Channel; deviceId?: string }   // singleton: at most one row (PRJ-005)
```

## 10. Platform

```ts
auditLog: 🔒 { seq: number; prevHash: string; hash: string; at: number;
  actor: Actor; actorRole?: MemberRole /* for user: actors, role at write time */;
  actorLabel?: string /* user e-mail or key name at write time */; client?: { name: string; version: string } /* MCP */;
  channel: Channel; ip?: string /* truncated /24 or /48; normally absent: behind the tailnet edge only the proxy address is visible (02 §4.1) */;
  userAgent?: string; requestId?: string; sessionId?: string /* Better Auth session of user: actors */;
  action: string;                         // taxonomy F12 §4.1, e.g. "document.finalize", "contact.update", "settings.company.update"
  entity: { table: string; id: string; label?: string };
  diff?: { before?: unknown; after?: unknown };   // JSON diff; secrets redacted before hashing; personal values of contacts
                                          // stored as { enc: { contactId, iv, ct } } with the contactKeys data key (crypto-shredding)
  diffBlob?: { storageId: Id<"_storage">; sha256: string };   // diffs > 64 KB (AUD-003); referenced inside the hashed entry
  reason?: string }
  // hash = SHA-256(prevHash ‖ JCS(entry without hash)); indexes: by_seq, by_entity, by_actor_at

integrityCheckpoints: 🔒 { date: string; lastSeq: number; lastHash: string; counts: Record<string, number>;
  artifactsCount: number; journalSeq: number; appVersion: string; schemaVersion: string; prevCheckpointHash: string;
  jws: string /* ES256, CHECKPOINT_SIGNING_KEY_PEM */; kid: string; tsaToken?: string /* RFC 3161, AUD-018 */;
  exportedTo?: string /* r2://<checkpoint-bucket>/checkpoints/YYYY/MM/DD.jws */; uploadStatus: "pending" | "uploaded" | "failed"; at: number }
integrityRuns: { at: number; ok: boolean; scope: "incremental" | "full" | "startup";
  lastVerifiedSeq: number; findings: { kind: string; severity: "warning" | "error"; detail: string; entity?: { table: string; id: string }; firstBrokenSeq?: number }[];
  acknowledgedAt?: number; acknowledgedNote?: string; acknowledgedBy?: Actor }   // AUD-015: finalisation blocked until acknowledged
chainAnchors: 🔒 { seq: number; hash: string; jws: string; createdAt: number; purgeBatchId: Id<"purgeBatches">; exportedTo?: string }   // PRV-008
clockChecks: { at: number; ntpServer: string; ntpSkewMs: number; convexSkewMs: number; severity: "ok" | "warning" | "critical" }   // AUD-019; technical log (90 days)
restoreDrills: 🔒 { date: string; backupObject: string; targetEnvironment: string; integrityOk: boolean; headMatchesCheckpoint: boolean;
  notes?: string; kind: "drill" | "production_restore"; restoredHeadSeq?: number; gapToCheckpoint?: number; actor: Actor; at: number }   // AUD-027

apiKeys: { name: string; prefix: string; last4: string; hash: string;   // public key ID (prefix) is the <id> in "api-key:<id>" / "mcp:<id>"
  scopes: string[]; channel: "api" | "mcp" | "both";
  createdAt: number; createdBy: Actor /* always the owner's user: actor */; lastUsedAt?: number; expiresAt?: number; revokedAt?: number;
  rateLimitPerMinute?: number }   // no IP allowlist: client IPs are not visible behind the tailnet edge; rate limits are per key
idempotencyKeys: { apiKeyId; key: string; requestHash: string; status: number; responseBody: string; expiresAt: number }

// ── Auth (02 §4.2–4.3). Better Auth component tables live in convex/betterAuth/ (Local Install, schema generated by
//    `npx auth generate`): user, session, account, verification, passkey, twoFactor, jwks. They are written only by the
//    component adapter (allowlisted in the mutation inventory), are not bookkeeping records and are not GoBD-protected.
//    Our own auth tables below are written only through convex/model/** and every change is audited.
members: { authUserId: string /* Better Auth user._id; unique index */; email: string /* lower-case */; name?: string;
  role: MemberRole;                       // exactly one active "owner"
  expiresAt?: number;                     // mandatory for "auditor" (≤ 30 days per grant), optional for viewer/bookkeeper
  auditor?: { organisation?: string; purpose: string /* Aktenzeichen */; fiscalYears: number[];
              extensions: { at: number; expiresAt: number; reason: string }[];
              firstAccessAt?: number; lastAccessAt?: number };   // F12 AUD-022 (replaces auditorGrants)
  totpEnabled: boolean;                   // mirror of the twoFactor plugin state, for the wrapper's TOTP enforcement
  invitedBy?: Actor; inviteId?: Id<"invites">;
  createdAt: number; disabledAt?: number; disabledReason?: string }
  // indexes: by_authUserId (unique), by_email, by_role
invites: { email: string /* lower-case */; role: Exclude<MemberRole, "owner">;
  memberExpiresAt?: number; auditor?: { organisation?: string; purpose: string; fiscalYears: number[] };
  expiresAt: number /* invite validity, default 7 days */; createdBy: Actor; createdAt: number;
  sentAt?: number; mailOutcome?: "ok" | "failed"; acceptedAt?: number; acceptedUserId?: string; revokedAt?: number }
  // the sign-up gate (02 §4.3) accepts an e-mail only with a matching unexpired, unrevoked, unaccepted invite;
  // bootstrap: while no user exists only OWNER_EMAIL may sign up and becomes role "owner" (actor system:auth)

verfahrensdokuVersions: 🔒 { version: number; validFrom: string; releasedAt: number; releasedBy: Actor;
  sourceJson: string; pdf: FileRef; supersededAt?: number; retentionUntil?: string /* end of year superseded + 10 y */;
  watchSnapshot: Record<string, string> }   // AUD-025

webhookEndpoints: { url: string; description?: string; events: string[]; encryptedSecret: string;
  enabled: boolean; disabledReason?: string; createdAt: number }
webhookEvents: { type: string; payload: string; createdAt: number }
webhookDeliveries: { endpointId; eventId; attempt: number; status: "pending" | "success" | "failed" | "gave_up";
  httpStatus?: number; responseSnippet?: string; nextAttemptAt?: number; durationMs?: number; at: number }

jobs: { kind: "bulk_export" | "bulk_mark_sent" | "bulk_remind" | "pdf_zip" | "datev_export" | "gdpdu_export" | "full_export" | "import_sevdesk_export"
            | "csv_export" | "import_csv" | "zm_export" | "dsgvo_export" | "purge" | "verfahrensdoku_pdf";
  status: "queued" | "running" | "done" | "failed"; progress: { done: number; total: number };
  resultStorageId?: Id<"_storage">; error?: string; actor: Actor; createdAt: number }

datevExports: 🔒 { from: string; to: string; scope: ("revenue" | "vouchers" | "payments" | "master_data" | "documents")[];
  mode: "new" | "full"; formatVersion: 12 | 13; festschreibung: boolean; isRepeat: boolean;
  journalLineIds: string[] /* `${entryId}:${lineIndex}` exactly exported */; rowCount: number; sumUmsatzCents: number;
  file: FileRef; validationReport?: unknown; actor: Actor; at: number }   // F09 EXP-009/010; downloads re-serve stored bytes
datevAcceptance: { /* pre-condition for the first real handover to an advisor, not a go-live gate (F09 EXP-016) */ testedOn: string; formatVersion: 12 | 13; buKeysConfirmed: boolean; advisorName?: string;
  remarks?: string; recordedAt: number; actor: Actor }   // F09 EXP-016 go-live gate (append-only)

notifications: { kind: string; severity: "info" | "warning" | "error" | "critical"; title: string; body?: string;
  link?: string; entity?: { table: string; id: string };
  dedupeKey: string /* kind + entity + day */; count: number; escalatedAt?: number;
  readAt?: number; createdAt: number }    // NTF-001/006; read ones purged after 90 days
notificationSettings: { email?: { address: string; digest: boolean };   // sent via Cloudflare Email Sending (02 §9)
  ntfy?: { serverUrl: string; topic: string; encryptedToken?: string; sendDetails: boolean; quietHours: { from: string; to: string } };
  channelsByKind: Record<string, { inApp: boolean; email: boolean; ntfy: boolean; digest: boolean }> }   // singleton (NTF-002…005)

dsgvoRequests: { contactId?: Id<"contacts">; subject?: { name: string; email?: string };   // data subject if not a contact
  kind: "access" | "rectification" | "erasure" | "restriction" | "portability" | "objection";   // Art. 15/16/17/18/20/21
  channel: "email" | "post" | "phone" | "portal" | "other";
  receivedAt: string; dueAt: string;
  identityVerified?: { method: string; at: number };
  extension?: { newDueAt: string; reason: string; noticeSentOn: string };   // Art. 12 Abs. 3
  status: "open" | "in_progress" | "extended" | "done" | "rejected"; rejectionReason?: string;
  resultStorageId?: Id<"_storage">; notes?: string }

retentionHolds: { reason: string; fiscalYears: number[]; activeFrom: number; endedAt?: number; actor: Actor }   // "Betriebsprüfung-Modus" (PRV-004): no purge while active
purgeBatches: 🔒 { createdAt: number; actor: Actor; classes: RetentionClass[]; years: number[];
  checklist: Record<string, true>;        // Ablaufhemmung confirmations (PRV-005)
  status: "running" | "done" | "failed"; counts: Record<string, number>; offHostLogKey?: string; finishedAt?: number }
purgeTombstones: 🔒 { table: string; recordId: string; retentionClass: RetentionClass; retentionUntil: string;
  contentSha256: string; batchId: Id<"purgeBatches">; purgedAt: number }   // PRV-006

imports: { source: "sevdesk_export" | "lexoffice_csv" | "generic_csv";   // sevdesk: file exports only (contacts/products/invoice+voucher list CSV, DATEV, GoBD ZIP, PDFs); no API (F09)
  files: (FileRef & { detectedKind?: string; encoding?: string; delimiter?: string; headers?: string[]; ignored?: boolean })[];
  status: "uploaded" | "previewed" | "running" | "done" | "failed" | "discarded";
  previewHash?: string;                 // commit only with the current preview (F09 IMP-023, 409 preview_stale)
  resolutions?: unknown;                // PDF assignments, contact matches, excluded rows, entered open amounts / VAT splits, missing-PDF reasons
  protocolFile?: FileRef; committedAt?: number; committedBy?: Actor;
  retentionUntil?: string;              // source files kept ≥ 10 years as migration evidence (F09 IMP-024)
  preview?: { counts: Record<string, number>; errors: unknown[]; warnings: unknown[]; duplicates: unknown[];
              numberRangeContinuation: { rangeId: Id<"numberRanges">; lastImported: string; nextValue: number }[] };
  stats: Record<string, number>; mapping?: unknown; log: string[];
  importerVersion: string; startedAt: number; finishedAt?: number; actor: Actor }
importMappingPresets: { source: string; fileKind: string; name: string; columns: Record<string, string>; options?: unknown;
  shipped: boolean; unsure: boolean /* sevdesk layouts UNSURE until owner samples exist */; createdAt: number; actor?: Actor }
importedRecords: { importId; externalType: string; externalId: string; table: string; localId: string }  // idempotent re-runs; index by_external (unique)
```

## 11. Immutability matrix (enforced by `convex/functions.ts` triggers + model layer)

"Append-only" = insert only; no update, no delete (except draft deletion where stated and the audited retention purge, which replaces records with `purgeTombstones`). Every listed mutation writes an audit entry. Nothing dated in a locked period changes after `periods.lockedAt` (RI-13).

| Table | Mutable fields after finalisation/lock (frozen otherwise) | How it is corrected |
|---|---|---|
| `salesDocuments` | `status` (only along allowed transitions, incl. `superseded`, `withdrawn`), `paymentStatus`, `openAmountCents`, `sentAt`, `sentOn`, `firstExportedAt`, `viewedAt`, `artifactStatus`, `lockedAt`, `tags`, `internalNote`, `deductedInId` (set by the final's finalisation, cleared by its Storno), `coverage` (derived cache), `dunningBlocked`, `disputed`, `zugang`, `overdueNotifiedAt`, `collection`, `evidence` (append-only); set once: `acceptance`, `rejection`, `received`, `cancellation`, `objection`, `datevBelegnummer` | Storno (`cancellation`) / Rechnungskorrektur / Rechnungsberichtigung (`correction`) document |
| `documentLines` | derived caches `invoicedQtyMilli`, `deliveredQtyMilli` only (not in the snapshot) | via the parent |
| `documentSnapshots`, `documentArtifacts`, `sendLog` | none (append-only) | new artifact row; a wrong sent mark is corrected by a `retraction` row |
| `numberRegister` | `status` only `issued → cancelled_by_storno` / `issued → corrected` | n/a |
| `companyProfileVersions`, `layoutVersions`, `accountRoleMappings` | none (append-only versions) | new version row |
| `vatIdChecks`, `auditLog`, `chainAnchors`, `restoreDrills`, `purgeTombstones`, `datevExports`, `dunningRuns`, `datevAcceptance` | none | n/a (auditLog: prefix purge with chain anchor only, PRV-008) |
| `contacts` (master data, not protected) | all, audited; merge sets `mergedIntoId` + `status: archived` | finalised records keep their `contactId` and resolve the alias; never rewritten |
| `contactKeys` | `wrappedKey` removed and `shreddedAt` set, once (purge) | n/a |
| `vouchers`, `voucherLines` | while booked and unlocked: correction with Generalumkehr + re-post, `version + 1`, reason (VOU-008); always: `status`, `openAmountCents`, `bookedAt`, `lockedAt`, `tags`, `checkedComplete` (once), `duplicateDismissals` (append), `rebilledLineId` (once), `originalFiles` (append; `replacedBy` on the old entry), `renditions` (append), `bewirtung.versions` (append); `internalNumber` set once at booking | after lock: `cancelled` with reversal journal + new voucher ("Duplizieren") |
| `payments` | `reversedById`, `lockedAt`, `reconciledTransactionId` (once), `receiptFile` (once) | reversal payment (`reversalOfId`) |
| `allocations` | none | written by reversal payments |
| `journalEntries` | `lockedAt`; `lines[].contactId` removed by staged purge (PRV-007) | reversal entry (Generalumkehr) |
| `cashTransfers` | `bankTransactionId` (once, when the bank side is matched) | reversal row (`reversalOfId`), subject to the never-negative check |
| `bankTransactions` | `status`, `ignoredReason`, `ignoredLinkId`, `allocatedCents`, `bookedAt`, `lockedAt`, `sources` (append), `reversalOfId` (once), one-time fill of empty counterparty fields (BNK-122) | n/a (booked bank data never changes; a differing re-delivery is stored as a revision with `applied: false` + integrity finding, BNK-113) |
| `bankTransactionRevisions`, `bankStatements` | none (statement: `reconciled`/`differences` recomputed on re-upload as a new row) | new row |
| `assets` | before `firstDepreciationAt`: all; after: `disposal` (once), `notes` | manual journal entry with reason (AST-011) |
| `depreciationRuns` | none | reversal journal entry |
| `taxFilings` | `status` (`draft → submitted_manually → superseded`), `submittedVia`, `submittedOn`, `sheetHash`, `elsterReportedTotalCents`, `submittedValuesDiffer`, `valuesDifferReason`, `submittedAt`, `transmissionTicket`, `protocolStorageId` (at submission) | correction filing (`supersedesId`) |
| `periods` | `status` `open → locking → locked` (irreversible), `lockedAt`, `lockedBy`, `reason` | n/a |
| `withdrawals` | `acknowledgement.sentAt`/`sendLogId`, `handledAt`, `resolution` | n/a |
| `providerEvents` | `processedAt`, `processingError` | n/a |
| `sepaCollectionRuns` | `status`, `submittedAt`, `creditTransactionId`, `items[].returned` (once per item) | new run |
| `timeEntries` (not 🔒, but guarded) | `open`: all (audited); `in_draft`: none; `invoiced`: only `status → open` after Storno of the invoice (with `invoicedLineHistory` append), `retentionUntil` | new entry |
| `verfahrensdokuVersions` | `supersededAt`, `retentionUntil` (once, when the next version is released) | new version |
| `purgeBatches` | `status`, `counts`, `offHostLogKey`, `finishedAt` | n/a |
| `integrityRuns` | `acknowledgedAt`, `acknowledgedNote`, `acknowledgedBy` (once) | n/a |
| `integrityCheckpoints` | `uploadStatus` only `pending → uploaded \| failed`, `failed → uploaded \| failed` (hourly retry); `exportedTo` set once on upload. The signed content (`date` … `jws`, `kid`) never changes | n/a (a broken checkpoint is reported, never rewritten) |

Drafts (`status: "draft"`) of documents and vouchers can be deleted. Deletion is logged in `auditLog` with the draft content, so the deletion itself stays traceable. Records within `retentionUntil` cannot be deleted on any path (RI-20); unprotected tables (settings, lookups, `members`, `invites`, `apiKeys` (revocation via `revokedAt`, never deleted), `dismissedDuplicates`, `contactAliases`, `matchRejections`, `bankPendingTransactions`, `possibleDuplicates`, `plannedCashItems`, `runningTimer`, `notifications`, `clockChecks`) are freely mutable with audit. The Better Auth component tables (`convex/betterAuth/**`) are outside this matrix; sign-in/sign-out are audited through session triggers.

## 12. Consolidation log

Conflicts and naming differences resolved while merging the F01–F12 data-model deltas. Where a feature spec still uses the old shape, 03 wins; the listed feature sections should be aligned.

| Item | Sources | Decision | Reason |
|---|---|---|---|
| Stored document status / `overdue` | F04 §4.2.9, DOC-55, App. G; F05 PAY-044, §4.3, D-12; 03 v1.0 | Invoice family stores `draft \| finalized \| sent \| cancelled`; other types per §4 table; `overdue` removed from every stored enum and derived by `displayStatus()`; `receivables.refreshOverdue` only emits `invoice.overdue` and sets `overdueNotifiedAt` | A stored date-dependent status goes stale and needs a mutating cron on finalised records; F05 PAY-044 and §4.3 must drop the `"overdue"` write |
| `paymentStatus` values | Lead decision (`partial`, `credited`); 03 v1.0 (`partially_paid`); F04 §4.2.5; F05 §4.3 | `open \| partially_paid \| paid \| credited \| written_off`; `partially_paid` kept (03 value covers "partial"); `credited` = open reached 0 through corrections/offsets without cash | Kept the name F04/F05/API already use; `credited` separates "settled by Rechnungskorrektur" from cash receipts |
| Quote revisions | F04 QUO-06, App. G | `revision: number` + status `superseded`; `originId` links the previous revision | `version` is the OCC counter and must not double as the revision |
| Actor identifiers | Lead decision; F12 AUD-002 and Q7 (`apiKey` vs `api-key:<id>`); F04 REC-07 (`system:recurring`); F05 DUN-037 (`system:dunning`); F01 SET-035 (`system:ku-monitor`); F11 PRJ-021; **platform update 2026-10-12** | `Actor` is the string `"<kind>:<id>"` with kinds `user`, `api-key`, `mcp`, `system` (+ `portal` reserved) (§0.1; was `owner`, `api-key`, `mcp`, `portal`, `auditor`, `system` — `owner:owner` became `user:<betterAuthUserId>`, `auditor` became the member role `auditor`); cron jobs are `system:cron.<job>` (e.g. `system:cron.recurring.generate`, `system:cron.dunning.run`); display data moved to `auditLog.actorLabel/client` | One canonical form across audit, API and MCP; F04/F05/F12 wording to align |
| Voucher numbering moment | F01 SET-064 (on creation); F06 VOU-007, D-01, Q-10 (at finalisation); lead decision | `vouchers.internalNumber` optional, assigned at **booking** (= finalisation) | Drafts are deletable; assigning at creation would leave gaps (GOBD-05). F01 SET-064 to drop `voucherInternal` from "assigned on creation" |
| Imported numbers in the register | F01 SET-065 (`status: "imported"`); F09 IMP-004 (`imported: true` + status issued/cancelled) | Boolean `imported?: true`; `status` keeps its issued/cancelled/corrected meaning | Imported Stornos must still show `cancelled_by_storno`; a status value cannot carry both facts. F01 SET-065 to align |
| Revolut dedupe key | F07 BNK-020, D-01; lead decision | **Superseded (B1):** `dedupeKey` = `{accountId}:er:{entryReference}` or `{accountId}:h:{contentHash}:{ordinal}` (F07 BNK-109) | The Revolut Business API is not used |
| `placeOfSupplyRule` enum | F03 PRD-009 (`general_b2b`, `admission_event`, `short_term_vehicle_rental`, `b2c_general`); F04 App. C (`general`, `event_admission`, `short_term_rental`, `passenger_transport`, `catalogue_3a4`, `electronic`) | Union with one name per rule: `general` (default), `property`, `event_admission`, `restaurant`, `short_term_vehicle_rental`, `passenger_transport`, `catalogue_3a4`, `electronic`; `b2c_general` dropped (= `general` for consumers) | App. C drives the decision table; `general` already covers §3a Abs. 1 for consumers; the F03 vehicle name is more precise. F03 PRD-009 / T-PRD-051 to align |
| §13b on products | Lead decision ("flag/service type"); F04 App. C, App. G (`reverseCharge13b`) | `products.reverseCharge13b?: Rc13bType` (absent = no §13b), copied to `documentLines.reverseCharge13b`; types validated against rule table `rc13bTypes` | A typed value works as the flag and also selects the §13b paragraph/note text; keeping it as rule data follows CLAUDE.md rule 2 |
| `vatRateKey` | F03 delta (enum vs rule-table string) | `string` validated against `vatRateKeys` (v1: `standard`, `reduced`, `restaurant_food`, `zero`, `exempt`) | The 2026 restaurant change is category-specific; a fixed enum cannot follow future changes |
| Final-invoice deductions | F04 App. G (`deductions[].decision: "deduct" \| "not_deducted" \| "cancelled"`), INV-07, 9.14; 10 EC-070; lead decision | `deductions[]` lists only deducted advances (`advanceNumber/advanceDate` for BG-3 BT-25/26, `byGroup`, `deductedGrossCents`, `partiallyPaid`); BT-113 = `totals.advancesDeductedGrossCents`, BT-115 = `totals.payableCents`; no `decision` field and **no "not deducted" option**; replaces `advanceIds` | "Nicht abziehen" was removed (double-claim/§14c risk). An unpaid advance has to be cancelled first, a partially paid one reduced to the received amount by a Rechnungskorrektur (coordinator decision, 10 EC-071); a cancelled advance never appears in `deductions`. F04 INV-07, §4.7 step 2, 9.14 and 10 EC-070 to align |
| FX rate shape | F04 App. G (`bmf_monthly \| ecb_daily \| manual` + `sourceText`); F06 VOU-028 (ECB/BMF/fixed bank debit); F07 BNK-028 (implicit transaction rate/ECB); F08 ACC-023 | Shared `FxRate { rate: string; source: bmf_monthly \| ecb_daily \| manual \| transaction; sourceText?; date }` used everywhere | One type for documents, vouchers, payments, bank and journal; `transaction` covers the implicit/actual-debit rate |
| Bank account currency / FX cost | F01 delta (top-level `currency`, `isForeignCurrency`); 03 v1.0 `revolut.currency`; F08 Q9 (`avgCostRate`) | Top-level `currency` only (`revolut.currency` removed); "foreign currency" derived from `currency ≠ "EUR"`; moving average stored as integers `fxCost { balanceMinor, costEurCents }` | Avoids redundant/contradicting fields and float rates on money |
| `companyProfile.chartOfAccounts` / `profitMethod` | F01 delta (chart date-effective), F01 Q2 (profit method), F08 ACC-007, EC-116 | Both date-effective lists keyed by `validFromFiscalYear` | Switching is only allowed at a fiscal-year start; history is needed to report earlier years correctly (profit method marked LEGAL-OPEN F01 Q2) |
| `managingDirectors` | F01 delta | Renamed to `representatives: { name; role?: "chair" }[]`; print label per legal form | Covers Vorstand chair (AG) and Gesellschafter (GbR/OHG) |
| `numberRanges.docType` | F01 delta; F11 (`project`) | `docTypes[]` + `isDefault`; `project` added | One range can serve several invoice types; several ranges per type need a default |
| `integrations` "smtp" rows | F01 delta ("consider") | Not added; the DSGVO-04 external-services list is a computed view | Avoids duplicating `mailIdentities` data |
| PDF consent history | F02 CON-081, delta; F10 POR-032 (`contacts.einvoice.pdfConsent`) | `contacts.einvoice.pdfConsents[]` history with `revokedAt`; portal consent appends a row with `source: "portal"` | Revocation must keep the consent that was valid at earlier send dates. F10 POR-032 to align |
| §13b certificate | F02 CON-072, delta | `reverseCharge13bCertificates[]` history with `FileRef` (sha256) | Evidence for documents issued while an older certificate was valid |
| Contact merge | F02 CON-133, Q6; 10 EC-113; lead decision | `mergedIntoId` alias + `contactMerges` record (needed for CON-134 undo); finalised records are never re-pointed | Satisfies GOBD-06 and the 03 §11 matrix. 10 EC-113 wording ("re-pointed") to align |
| Audit diffs with personal data | F02 §5.12, Q7, delta; F12; lead decision | Crypto-shredding: personal values encrypted per contact (`contactKeys`, `shreddedAt`); F02's `destroyedAt` renamed `shreddedAt`; "field names only" alternative rejected | DSGVO-02 erasure without breaking the hash chain (GOBD-06) |
| VAT-ID check result | F02 delta (`status`) | `status: "valid" \| "invalid" \| "unavailable"` replaces `valid: boolean`; `contacts.vatIdStatus.status` likewise | "Service unavailable" is not the same as "invalid" (CON-055) |
| Send outcome | F04 SND-12, App. G; 03 v1.0 `sendLog.ok` | **Superseded (owner update 2026-10-12, B2):** `sendLog` is a dispatch record of manual marks (`kind`, `sentOn`, `channel`, `artifacts`); no outcome, SMTP or Message-ID | The app no longer sends anything |
| Artifact variants | F04 9.8, App. G (variant vs new kinds) | `documentArtifacts.variant: original \| copy \| reading` on kind `pdf` | Keeps the kind list stable; hashes per variant serve MAIL-02 |
| Correction kinds | F04 INV-10/12/13, App. G; lead decision | Storno = type `cancellation`; Rechnungskorrektur / Rechnungsberichtigung = type `correction` + `correctionKind: credit \| rectification` | Matches the F04 type catalogue (different TypeCodes, journal effect and register status) |
| Seller withdraw vs consumer Widerruf | F04 §4.2.1/4.2.2 (withdraw → `cancelled`); F10 POR-013 (`withdrawn`) | Both kept: owner withdrawal → `cancelled` (+ `cancellation.reason`); consumer Widerruf → new status `withdrawn` + `withdrawals` row | Different legal acts and different follow-up work |
| Invoicing progress on frozen lines | F04 App. G, §4.3.3 (`invoicedQtyMilli`, `deliveredQtyMilli`, `prepaidNetByGroup`) | Stored as derived caches (`documentLines.invoicedQtyMilli/deliveredQtyMilli`, `salesDocuments.coverage`), whitelisted in §11, excluded from the snapshot, recomputable from `sourceLineId`/chain | Allows fast reads without weakening the immutability of snapshot data |
| Gross-mode flags | F04 DOC-10, App. E.3, 9.12; lead decision | `priceMode` on document; `documentLines.lineGrossCents`; `totals.byGroup[].enteredGrossCents/grossDeviationCents` | The "largest net that fits" algorithm needs the entered gross to show `gross_rounding_deviation`; BT-114 rounding not used (9.12 default) |
| Payment differences | F05 D-01/D-02, PAY-028; 03 v1.0 `difference` | `differences[]`; `default_interest` added; `partial`/`collective` kept for imports only | Skonto plus bank fee on the same transfer is common |
| Payment reversal links | F05 D-05, PAY-040; 03 v1.0 `reversedById` | Both: `reversalOfId` on the reversal row, `reversedById` on the original (whitelisted) | Navigation in both directions without scanning |
| Cash balance definition | F07 CSH-013, D-06; 03 v1.0 | **Superseded (B3):** no cash book; the `cash` account balance is derived from the journal in (date, seq) order (F07 CSH-026) | Simple cash, no Kassenbuch |
| Recurring template status | F04 §4.2.10, App. G | `status: active \| inactive` (UI "Pausiert"); "Beendet" derived | No stored state that a date passing has to flip |
| Journal roles | F08 ACC-003/008; lead decision | `accountRoleMappings` (versioned, per chart, `validFrom`, overrides with source text); journal lines store resolved `account` + `role`; entries store `ruleVersion`, `roleMappingVersion`, `explanation` | Reproducible postings; DATEV/EÜR read the resolved account |
| Voucher totals currency | F06 Q-06, D-03 | Both: `totals` (document currency) and `totalsEur` (+ per-line `netEurCents/vatEurCents`) | UStVA/EÜR need EUR; the supplier's document is in the foreign currency |
| `dsgvoRequests.kind` | F12 PRV-010; 03 v1.0 `deletion` | `erasure` (Art. 17) replaces `deletion`; `rectification`, `objection` added | Matches F12 and GDPR naming |
| Contact address on drafts | F02 delta, CON-023, EC-111 | `salesDocuments.billingAddress` copy next to `billingAddressId` | Drafts keep the previous address until the owner confirms the change |
| Credit balances | F05 D-03/D-04, PAY-031/032 | `payments.target.kind = "contactCredit"`, `source.kind = "credit" \| "adjustment"` | Overpayments and write-offs need a target/source that is not cash |
| Contact display/search fields | F02 delta | `displayName` + `searchText` added; search index on `searchText` | Convex search needs one stored field |
| Imported tax case | F09 IMP-010 | `TaxCase` += `unknown_imported` (archive only, never selectable) | OSS/unknown sevdesk rules must be importable without guessing |

### Platform update 2026-10-12 (auth, network, mail, storage — research 14)

| Item | Change | Reason |
|---|---|---|
| Actors | Kinds `user`, `api-key`, `mcp`, `system`; `portal` reserved; `auditLog.actorRole` + `sessionId` added; `owner:owner` → `user:<betterAuthUserId>`; `auditor:<grantId>` removed | Better Auth login replaces "no login" (02 §4, ADR-015) |
| `members`, `invites` (new) | Roles `owner \| bookkeeper \| viewer \| auditor`, optional `expiresAt` (mandatory for auditors), auditor scope (fiscal years, Aktenzeichen); invite-only sign-up | 02 §4.3; roles live in our table, not in Better Auth's admin/organization plugins |
| `auditorGrants` | **Removed**; replaced by `members.role = "auditor"` + `members.auditor` + `expiresAt` | The token route `/pruefung/**` is gone (no public host); a Betriebsprüfer gets a time-limited user (F12 AUD-022) |
| Better Auth component tables | `user`, `session`, `account`, `verification`, `passkey`, `twoFactor`, `jwks` in `convex/betterAuth/` (Local Install); written only by the component; allowlisted in the mutation inventory | Auth records are not bookkeeping records |
| `companyProfile.accessGate` | Replaced by `accessConcept { baseDomain, network: "tailnet", tailnetName?, confirmedAt }` | No gate modes A–D any more (02 §4.1) |
| `mailIdentities` | **Removed** (no SMTP); `notificationSettings.email.mailIdentityId` removed; `textTemplates.kind` loses `email_subject/email_body/email_signature` | The app never e-mails customers (02 §9) |
| `integrations.kind` | `imap`, `s3checkpoint` removed; `cloudflare_email`, `r2_checkpoint`, `r2_inbox` added; secrets for these come from the Convex env | D3/D4 (02 §4.5) |
| `apiKeys.allowedIps` | **Removed**; `createdBy` added | Client IPs are invisible behind the tailnet edge; rate limits are per key |
| `integrityCheckpoints.exportedTo` | Points to the R2 checkpoint bucket | D4 (02 §4.6) |
| `integrityCheckpoints` matrix row | Moved out of the "none" row: `uploadStatus`/`exportedTo` change after insert (the row is stored before the R2 upload so a failed upload is visible and retried, E-AUD-10); the signed fields stay frozen | P0 implementation (convex/integrity.ts), 2026-10-12 |

Still referencing removed shapes (owned by the parallel feature pass, to align): `recurringTemplates.automation.send/mailTemplateId/mailIdentityId` (§4), `sendLog.smtpResponse` and the e-mail send outcome (§4), `companyProfile.portal` (F10 deferred), `bankConnections` (Revolut-only fields → Enable Banking consent fields, F07). — **Resolved** by the owner-decisions update below; `companyProfile.portal` and the portal tables are marked reserved (F10 deferred).

### Owner-decisions update 2026-10-12 (B1–B6: bank, sending, cash, sevdesk import, tax, inbox)

| Item | Change | Reason / source |
|---|---|---|
| `bankAccounts` | `kind: "bank" \| "clearing" \| "paypal"` (was `revolut \| import \| …`); `revolut` → `feed { connectionId, identificationHash, providerAccountUid, lastPolledAt, backoffUntil, unattendedFetches }`; `importFormat` → `statementFormat` (+ `revolut_csv`) | B1: no Revolut Business API; Enable Banking feed + statement import (F07 BNK-001, BNK-104, BNK-106) |
| `bankConnections` | Enable Banking only: application key, ASPSP, redirect URL, state nonce, session, `validUntil` (≤ 180 days), reminders, backfill, `evaluationConfirmation`; Revolut certificate/token/webhook/Expenses fields removed | B1 (F07 BNK-101…117) |
| `bankTransactions` | `provider` (Revolut legs/states) → `source` (kind, `entryReference`, informational `providerTransactionId`, codes, fee, exchange rate, balance) + append-only `sources[]`; `contentHash`; `reversalOfId`; `ignoredReason` loses `declined/failed/reverted`; booked rows only, immutable except the BNK-122 whitelist | B1 (F07 BNK-109…122) |
| `bankPendingTransactions`, `possibleDuplicates` (new, not protected) | Provisional PSD2 rows replaced every poll; review list for cross-source duplicates | F07 BNK-110, BNK-111 |
| `bankTransactionRevisions`, `bankStatements`, `bankImports`, `matchingRules`, `matchSuggestions` | Raw revisions keyed by `rawSha256`; statements by period with `pdf`/`camt` FileRefs; import sources without `revolut_api`; rules use bank transaction codes and transfer target `cash`; suggestion target `cashTransfer` | B1/B3 (F07) |
| `cashBooks`, `cashEntries`, `cashDayClosings` | **Removed**; new `cashTransfers` 🔒; `payments.source` `{ kind: "cash" }` (no entry ID) and `{ kind: "private" }`; `payments.backdateReason`, `note`, `receiptFile` (set once) | B3: simple cash, no Kassenbuch (F07 CSH-020…030, F05 PAY-061…063) |
| `sendLog` | Dispatch record of manual marks (`kind: mark_sent \| retraction`, `sentOn`, `channel: email_manual \| post \| hand \| upload_portal \| other`, `note`, `artifacts`, `einvoiceHandedOverElectronically`); third target `inboxItemId`; purposes without `pre_due_reminder`/`withdrawal_ack` | B2: no customer e-mailing (F04 SND-16…24, F05 DUN-058, F06 INB-046) |
| `salesDocuments` | `sentOn`, `firstExportedAt`; `zugang.basis` per channel + `reason`; `attachments[].includeInExport`; `imported?: true`; `origin.source: "sevdesk_export" \| "lexoffice_csv" \| "generic_csv"` | B2, B4 |
| `documentArtifacts` | `eml` removed; `supplier_correction_letter`, `void_notice` added; optional `inboxItemId` target | B2 (F04, F05 DUN-009, F06 INB-046) |
| `recurringTemplates`, `dunningPolicies`, `dunningRuns`, `companyProfile.receivables` | No send automation (`automation: { finalize }`, `steps[].autoFinalize`, actions `create_draft \| finalize \| skip \| todo_mark_sent`); `daysAfter` from the previous reminder's Zugang; `dueSoonDays`; `autoSendReminders` → `autoFinalizeReminders`, `bankDataMaxAgeDays`, `defaultStartViaReminder` (default `after_printed_deadline`) | B2 (F05 DUN-053…058, PAY-053) |
| `textTemplates.kind` | `message_text` added for "E-Mail-Text kopieren" | F04 SND-19 |
| `jobs.kind` | `bulk_send` → `bulk_export`, `bulk_mark_sent`; `import_sevdesk` → `import_sevdesk_export` | B2, B4 |
| `imports`, `importMappingPresets`, `documentLines.fromSummary`, `vouchers.imported/origin` | sevdesk file exports only (no API): files with detection metadata, preview + `previewHash`, resolutions, protocol, ≥ 10-year retention of source files; mapping presets flagged `unsure` | B4 (F09 IMP-016…026) |
| `inboxItems` | `external` (Revolut Expenses) removed; `r2 { bucket, objectKey, etag }` with unique index; `duplicateOfInboxItemId` | B6 (F06 INB-048…052) |
| `taxFilings`, `periods.reason` | `kind` += `euer`; `submittedVia`, `submittedOn`, `sheetHash`, ELSTER cross-check and "abweichend übermittelt" fields; Transferticket mandatory; lock reasons `zm_submitted`, `euer_submitted`; `journalEntries.source.kind` `cash` → `cashTransfer` | B5: the owner files via Mein ELSTER with the app's instructions (F08) |
| `datevAcceptance` | Not a go-live gate; pre-condition for the first advisor handover | B5 (F09 EXP-016) |

**Open items (not resolved here):**
- F01 Q2: whether `profitMethod` really needs date-effective history. Modelled date-effective (LEGAL-OPEN); confirm with the Steuerberater.
- F04 9.12: gross-mode deviation vs BT-114 rounding amount. Modelled as deviation + warning (default); changing it would add `totals.roundingAmountCents`.
- F05 Q-08: Sammelmahnung (`reminder.invoiceIds[]`) not modelled (P3 COULD).
- F04 9.6/9.7: REST resource names for self-billing/proforma belong in 05, not here.
- Process/cron/webhook deltas outside 03 (F05 D-11/D-12, F06 D-08, F07 D-08/D-09, F10 events) belong in 02 §7 / 05 §5.3; D-12 must be reworded per the `overdue` decision above.
- Feature-spec wording to align with this file (owned by the parallel editing pass): F01 SET-064, SET-065, SET-050 (`revolut.currency`); F02 CON-081 (`pdfConsent`), CON-070 (`reverseCharge13bCertificate`), §9 `destroyedAt`; F03 PRD-009 enum, PRD-020 key list; F04 INV-07, §4.7, 9.14, App. G `decision`, §4.10.1 `ok`, REC-07 `system:recurring`; F05 PAY-044, §4.3, DUN-037 `system:dunning`; F07 BNK-020 `rev:` prefix; F10 POR-032; F12 AUD-002 `apiKey`; 10 EC-070, EC-113.
