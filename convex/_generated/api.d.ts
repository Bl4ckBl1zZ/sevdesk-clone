/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as accounting from "../accounting.js";
import type * as apiKeys from "../apiKeys.js";
import type * as assets from "../assets.js";
import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as authMail from "../authMail.js";
import type * as backups from "../backups.js";
import type * as bankFeed from "../bankFeed.js";
import type * as bankFeedNode from "../bankFeedNode.js";
import type * as bankFeedValidators from "../bankFeedValidators.js";
import type * as bankValidators from "../bankValidators.js";
import type * as banking from "../banking.js";
import type * as bulk from "../bulk.js";
import type * as cash from "../cash.js";
import type * as confirmTokens from "../confirmTokens.js";
import type * as contacts from "../contacts.js";
import type * as contactsApi from "../contactsApi.js";
import type * as corrections from "../corrections.js";
import type * as crons from "../crons.js";
import type * as csvImports from "../csvImports.js";
import type * as dashboard from "../dashboard.js";
import type * as datev from "../datev.js";
import type * as datevJob from "../datevJob.js";
import type * as documentArtifacts from "../documentArtifacts.js";
import type * as documentFlows from "../documentFlows.js";
import type * as documentsApi from "../documentsApi.js";
import type * as dsgvo from "../dsgvo.js";
import type * as dsgvoNode from "../dsgvoNode.js";
import type * as dunning from "../dunning.js";
import type * as exports from "../exports.js";
import type * as fullExport from "../fullExport.js";
import type * as fullExportJob from "../fullExportJob.js";
import type * as functions from "../functions.js";
import type * as gdpdu from "../gdpdu.js";
import type * as gdpduJob from "../gdpduJob.js";
import type * as http from "../http.js";
import type * as idempotency from "../idempotency.js";
import type * as imports from "../imports.js";
import type * as importsNode from "../importsNode.js";
import type * as inbox from "../inbox.js";
import type * as inboxNode from "../inboxNode.js";
import type * as integrity from "../integrity.js";
import type * as invariants from "../invariants.js";
import type * as invites from "../invites.js";
import type * as invoices from "../invoices.js";
import type * as jobs from "../jobs.js";
import type * as journalIntegrity from "../journalIntegrity.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_auditorScope from "../lib/auditorScope.js";
import type * as lib_authHardening from "../lib/authHardening.js";
import type * as lib_authMail from "../lib/authMail.js";
import type * as lib_backupStore from "../lib/backupStore.js";
import type * as lib_bankFeedProvider from "../lib/bankFeedProvider.js";
import type * as lib_bankKeys from "../lib/bankKeys.js";
import type * as lib_checkpointStore from "../lib/checkpointStore.js";
import type * as lib_claudeOcr from "../lib/claudeOcr.js";
import type * as lib_clock from "../lib/clock.js";
import type * as lib_datevLoad from "../lib/datevLoad.js";
import type * as lib_einvoiceInbound from "../lib/einvoiceInbound.js";
import type * as lib_einvoiceTools from "../lib/einvoiceTools.js";
import type * as lib_enableBanking from "../lib/enableBanking.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_finalizePipeline from "../lib/finalizePipeline.js";
import type * as lib_importFiles from "../lib/importFiles.js";
import type * as lib_jws from "../lib/jws.js";
import type * as lib_ntfy from "../lib/ntfy.js";
import type * as lib_parse from "../lib/parse.js";
import type * as lib_r2Inbox from "../lib/r2Inbox.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_secrets from "../lib/secrets.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_vatProviders from "../lib/vatProviders.js";
import type * as lookups from "../lookups.js";
import type * as manualEntries from "../manualEntries.js";
import type * as matching from "../matching.js";
import type * as matchingRules from "../matchingRules.js";
import type * as members from "../members.js";
import type * as migrations from "../migrations.js";
import type * as model_accounting from "../model/accounting.js";
import type * as model_apiKeys from "../model/apiKeys.js";
import type * as model_assets from "../model/assets.js";
import type * as model_audit from "../model/audit.js";
import type * as model_auditViewer from "../model/auditViewer.js";
import type * as model_bankAccounts from "../model/bankAccounts.js";
import type * as model_bankFeed from "../model/bankFeed.js";
import type * as model_bankImport from "../model/bankImport.js";
import type * as model_bankTransactions from "../model/bankTransactions.js";
import type * as model_bankViews from "../model/bankViews.js";
import type * as model_cash from "../model/cash.js";
import type * as model_clock from "../model/clock.js";
import type * as model_companyProfile from "../model/companyProfile.js";
import type * as model_confirmTokens from "../model/confirmTokens.js";
import type * as model_contactKeys from "../model/contactKeys.js";
import type * as model_contacts from "../model/contacts.js";
import type * as model_csvExports from "../model/csvExports.js";
import type * as model_csvImports from "../model/csvImports.js";
import type * as model_dashboard from "../model/dashboard.js";
import type * as model_datev from "../model/datev.js";
import type * as model_db from "../model/db.js";
import type * as model_deliveryDeadlines from "../model/deliveryDeadlines.js";
import type * as model_devMailbox from "../model/devMailbox.js";
import type * as model_documentAttachments from "../model/documentAttachments.js";
import type * as model_documentChains from "../model/documentChains.js";
import type * as model_documentFlows from "../model/documentFlows.js";
import type * as model_documentHistory from "../model/documentHistory.js";
import type * as model_dsgvo from "../model/dsgvo.js";
import type * as model_dunning from "../model/dunning.js";
import type * as model_files from "../model/files.js";
import type * as model_finalizeGuard from "../model/finalizeGuard.js";
import type * as model_gdpdu from "../model/gdpdu.js";
import type * as model_idempotency from "../model/idempotency.js";
import type * as model_imports from "../model/imports.js";
import type * as model_inbox from "../model/inbox.js";
import type * as model_inboxLinks from "../model/inboxLinks.js";
import type * as model_inboxSettings from "../model/inboxSettings.js";
import type * as model_integrations from "../model/integrations.js";
import type * as model_integrity from "../model/integrity.js";
import type * as model_invariants from "../model/invariants.js";
import type * as model_invoiceChains from "../model/invoiceChains.js";
import type * as model_invoiceCorrections from "../model/invoiceCorrections.js";
import type * as model_jobs from "../model/jobs.js";
import type * as model_journal from "../model/journal.js";
import type * as model_kuMonitor from "../model/kuMonitor.js";
import type * as model_layouts from "../model/layouts.js";
import type * as model_ledgerAccounts from "../model/ledgerAccounts.js";
import type * as model_lookups from "../model/lookups.js";
import type * as model_manualEntries from "../model/manualEntries.js";
import type * as model_matching from "../model/matching.js";
import type * as model_matchingRules from "../model/matchingRules.js";
import type * as model_members from "../model/members.js";
import type * as model_migrations from "../model/migrations.js";
import type * as model_notificationSettings from "../model/notificationSettings.js";
import type * as model_notifications from "../model/notifications.js";
import type * as model_numberRanges from "../model/numberRanges.js";
import type * as model_payments from "../model/payments.js";
import type * as model_periodLock from "../model/periodLock.js";
import type * as model_privacy from "../model/privacy.js";
import type * as model_products from "../model/products.js";
import type * as model_recurring from "../model/recurring.js";
import type * as model_recurringVouchers from "../model/recurringVouchers.js";
import type * as model_retention from "../model/retention.js";
import type * as model_ruleOverrides from "../model/ruleOverrides.js";
import type * as model_salesDocuments from "../model/salesDocuments.js";
import type * as model_seeds from "../model/seeds.js";
import type * as model_settlement from "../model/settlement.js";
import type * as model_setup from "../model/setup.js";
import type * as model_system from "../model/system.js";
import type * as model_taxFilings from "../model/taxFilings.js";
import type * as model_textTemplates from "../model/textTemplates.js";
import type * as model_turnover from "../model/turnover.js";
import type * as model_types from "../model/types.js";
import type * as model_vatChecks from "../model/vatChecks.js";
import type * as model_verfahrensdoku from "../model/verfahrensdoku.js";
import type * as model_voucherPayments from "../model/voucherPayments.js";
import type * as model_voucherStatus from "../model/voucherStatus.js";
import type * as model_voucherViews from "../model/voucherViews.js";
import type * as model_vouchers from "../model/vouchers.js";
import type * as notifications from "../notifications.js";
import type * as paymentValidators from "../paymentValidators.js";
import type * as payments from "../payments.js";
import type * as periods from "../periods.js";
import type * as privacy from "../privacy.js";
import type * as products from "../products.js";
import type * as productsApi from "../productsApi.js";
import type * as recurring from "../recurring.js";
import type * as restore from "../restore.js";
import type * as retention from "../retention.js";
import type * as settings from "../settings.js";
import type * as settingsApi from "../settingsApi.js";
import type * as signup from "../signup.js";
import type * as system from "../system.js";
import type * as taxes from "../taxes.js";
import type * as testFixtures from "../testFixtures.js";
import type * as validators from "../validators.js";
import type * as vatIdChecks from "../vatIdChecks.js";
import type * as verfahrensdoku from "../verfahrensdoku.js";
import type * as voucherIntegrity from "../voucherIntegrity.js";
import type * as voucherValidators from "../voucherValidators.js";
import type * as vouchers from "../vouchers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  accounting: typeof accounting;
  apiKeys: typeof apiKeys;
  assets: typeof assets;
  auditLog: typeof auditLog;
  auth: typeof auth;
  authMail: typeof authMail;
  backups: typeof backups;
  bankFeed: typeof bankFeed;
  bankFeedNode: typeof bankFeedNode;
  bankFeedValidators: typeof bankFeedValidators;
  bankValidators: typeof bankValidators;
  banking: typeof banking;
  bulk: typeof bulk;
  cash: typeof cash;
  confirmTokens: typeof confirmTokens;
  contacts: typeof contacts;
  contactsApi: typeof contactsApi;
  corrections: typeof corrections;
  crons: typeof crons;
  csvImports: typeof csvImports;
  dashboard: typeof dashboard;
  datev: typeof datev;
  datevJob: typeof datevJob;
  documentArtifacts: typeof documentArtifacts;
  documentFlows: typeof documentFlows;
  documentsApi: typeof documentsApi;
  dsgvo: typeof dsgvo;
  dsgvoNode: typeof dsgvoNode;
  dunning: typeof dunning;
  exports: typeof exports;
  fullExport: typeof fullExport;
  fullExportJob: typeof fullExportJob;
  functions: typeof functions;
  gdpdu: typeof gdpdu;
  gdpduJob: typeof gdpduJob;
  http: typeof http;
  idempotency: typeof idempotency;
  imports: typeof imports;
  importsNode: typeof importsNode;
  inbox: typeof inbox;
  inboxNode: typeof inboxNode;
  integrity: typeof integrity;
  invariants: typeof invariants;
  invites: typeof invites;
  invoices: typeof invoices;
  jobs: typeof jobs;
  journalIntegrity: typeof journalIntegrity;
  "lib/actor": typeof lib_actor;
  "lib/auditorScope": typeof lib_auditorScope;
  "lib/authHardening": typeof lib_authHardening;
  "lib/authMail": typeof lib_authMail;
  "lib/backupStore": typeof lib_backupStore;
  "lib/bankFeedProvider": typeof lib_bankFeedProvider;
  "lib/bankKeys": typeof lib_bankKeys;
  "lib/checkpointStore": typeof lib_checkpointStore;
  "lib/claudeOcr": typeof lib_claudeOcr;
  "lib/clock": typeof lib_clock;
  "lib/datevLoad": typeof lib_datevLoad;
  "lib/einvoiceInbound": typeof lib_einvoiceInbound;
  "lib/einvoiceTools": typeof lib_einvoiceTools;
  "lib/enableBanking": typeof lib_enableBanking;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "lib/finalizePipeline": typeof lib_finalizePipeline;
  "lib/importFiles": typeof lib_importFiles;
  "lib/jws": typeof lib_jws;
  "lib/ntfy": typeof lib_ntfy;
  "lib/parse": typeof lib_parse;
  "lib/r2Inbox": typeof lib_r2Inbox;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/secrets": typeof lib_secrets;
  "lib/time": typeof lib_time;
  "lib/vatProviders": typeof lib_vatProviders;
  lookups: typeof lookups;
  manualEntries: typeof manualEntries;
  matching: typeof matching;
  matchingRules: typeof matchingRules;
  members: typeof members;
  migrations: typeof migrations;
  "model/accounting": typeof model_accounting;
  "model/apiKeys": typeof model_apiKeys;
  "model/assets": typeof model_assets;
  "model/audit": typeof model_audit;
  "model/auditViewer": typeof model_auditViewer;
  "model/bankAccounts": typeof model_bankAccounts;
  "model/bankFeed": typeof model_bankFeed;
  "model/bankImport": typeof model_bankImport;
  "model/bankTransactions": typeof model_bankTransactions;
  "model/bankViews": typeof model_bankViews;
  "model/cash": typeof model_cash;
  "model/clock": typeof model_clock;
  "model/companyProfile": typeof model_companyProfile;
  "model/confirmTokens": typeof model_confirmTokens;
  "model/contactKeys": typeof model_contactKeys;
  "model/contacts": typeof model_contacts;
  "model/csvExports": typeof model_csvExports;
  "model/csvImports": typeof model_csvImports;
  "model/dashboard": typeof model_dashboard;
  "model/datev": typeof model_datev;
  "model/db": typeof model_db;
  "model/deliveryDeadlines": typeof model_deliveryDeadlines;
  "model/devMailbox": typeof model_devMailbox;
  "model/documentAttachments": typeof model_documentAttachments;
  "model/documentChains": typeof model_documentChains;
  "model/documentFlows": typeof model_documentFlows;
  "model/documentHistory": typeof model_documentHistory;
  "model/dsgvo": typeof model_dsgvo;
  "model/dunning": typeof model_dunning;
  "model/files": typeof model_files;
  "model/finalizeGuard": typeof model_finalizeGuard;
  "model/gdpdu": typeof model_gdpdu;
  "model/idempotency": typeof model_idempotency;
  "model/imports": typeof model_imports;
  "model/inbox": typeof model_inbox;
  "model/inboxLinks": typeof model_inboxLinks;
  "model/inboxSettings": typeof model_inboxSettings;
  "model/integrations": typeof model_integrations;
  "model/integrity": typeof model_integrity;
  "model/invariants": typeof model_invariants;
  "model/invoiceChains": typeof model_invoiceChains;
  "model/invoiceCorrections": typeof model_invoiceCorrections;
  "model/jobs": typeof model_jobs;
  "model/journal": typeof model_journal;
  "model/kuMonitor": typeof model_kuMonitor;
  "model/layouts": typeof model_layouts;
  "model/ledgerAccounts": typeof model_ledgerAccounts;
  "model/lookups": typeof model_lookups;
  "model/manualEntries": typeof model_manualEntries;
  "model/matching": typeof model_matching;
  "model/matchingRules": typeof model_matchingRules;
  "model/members": typeof model_members;
  "model/migrations": typeof model_migrations;
  "model/notificationSettings": typeof model_notificationSettings;
  "model/notifications": typeof model_notifications;
  "model/numberRanges": typeof model_numberRanges;
  "model/payments": typeof model_payments;
  "model/periodLock": typeof model_periodLock;
  "model/privacy": typeof model_privacy;
  "model/products": typeof model_products;
  "model/recurring": typeof model_recurring;
  "model/recurringVouchers": typeof model_recurringVouchers;
  "model/retention": typeof model_retention;
  "model/ruleOverrides": typeof model_ruleOverrides;
  "model/salesDocuments": typeof model_salesDocuments;
  "model/seeds": typeof model_seeds;
  "model/settlement": typeof model_settlement;
  "model/setup": typeof model_setup;
  "model/system": typeof model_system;
  "model/taxFilings": typeof model_taxFilings;
  "model/textTemplates": typeof model_textTemplates;
  "model/turnover": typeof model_turnover;
  "model/types": typeof model_types;
  "model/vatChecks": typeof model_vatChecks;
  "model/verfahrensdoku": typeof model_verfahrensdoku;
  "model/voucherPayments": typeof model_voucherPayments;
  "model/voucherStatus": typeof model_voucherStatus;
  "model/voucherViews": typeof model_voucherViews;
  "model/vouchers": typeof model_vouchers;
  notifications: typeof notifications;
  paymentValidators: typeof paymentValidators;
  payments: typeof payments;
  periods: typeof periods;
  privacy: typeof privacy;
  products: typeof products;
  productsApi: typeof productsApi;
  recurring: typeof recurring;
  restore: typeof restore;
  retention: typeof retention;
  settings: typeof settings;
  settingsApi: typeof settingsApi;
  signup: typeof signup;
  system: typeof system;
  taxes: typeof taxes;
  testFixtures: typeof testFixtures;
  validators: typeof validators;
  vatIdChecks: typeof vatIdChecks;
  verfahrensdoku: typeof verfahrensdoku;
  voucherIntegrity: typeof voucherIntegrity;
  voucherValidators: typeof voucherValidators;
  vouchers: typeof vouchers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("../betterAuth/_generated/component.js").ComponentApi<"betterAuth">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
