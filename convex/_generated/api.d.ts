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
import type * as auditLog from "../auditLog.js";
import type * as auth from "../auth.js";
import type * as authMail from "../authMail.js";
import type * as bankValidators from "../bankValidators.js";
import type * as banking from "../banking.js";
import type * as cash from "../cash.js";
import type * as confirmTokens from "../confirmTokens.js";
import type * as contacts from "../contacts.js";
import type * as contactsApi from "../contactsApi.js";
import type * as corrections from "../corrections.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as documentArtifacts from "../documentArtifacts.js";
import type * as documentFlows from "../documentFlows.js";
import type * as documentsApi from "../documentsApi.js";
import type * as dunning from "../dunning.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as idempotency from "../idempotency.js";
import type * as imports from "../imports.js";
import type * as importsNode from "../importsNode.js";
import type * as integrity from "../integrity.js";
import type * as invariants from "../invariants.js";
import type * as invites from "../invites.js";
import type * as invoices from "../invoices.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_authHardening from "../lib/authHardening.js";
import type * as lib_authMail from "../lib/authMail.js";
import type * as lib_checkpointStore from "../lib/checkpointStore.js";
import type * as lib_clock from "../lib/clock.js";
import type * as lib_einvoiceTools from "../lib/einvoiceTools.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_finalizePipeline from "../lib/finalizePipeline.js";
import type * as lib_importFiles from "../lib/importFiles.js";
import type * as lib_jws from "../lib/jws.js";
import type * as lib_ntfy from "../lib/ntfy.js";
import type * as lib_parse from "../lib/parse.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_time from "../lib/time.js";
import type * as lib_vatProviders from "../lib/vatProviders.js";
import type * as lookups from "../lookups.js";
import type * as matching from "../matching.js";
import type * as members from "../members.js";
import type * as migrations from "../migrations.js";
import type * as model_accounting from "../model/accounting.js";
import type * as model_apiKeys from "../model/apiKeys.js";
import type * as model_audit from "../model/audit.js";
import type * as model_auditViewer from "../model/auditViewer.js";
import type * as model_bankAccounts from "../model/bankAccounts.js";
import type * as model_bankImport from "../model/bankImport.js";
import type * as model_bankTransactions from "../model/bankTransactions.js";
import type * as model_bankViews from "../model/bankViews.js";
import type * as model_cash from "../model/cash.js";
import type * as model_companyProfile from "../model/companyProfile.js";
import type * as model_confirmTokens from "../model/confirmTokens.js";
import type * as model_contactKeys from "../model/contactKeys.js";
import type * as model_contacts from "../model/contacts.js";
import type * as model_dashboard from "../model/dashboard.js";
import type * as model_db from "../model/db.js";
import type * as model_devMailbox from "../model/devMailbox.js";
import type * as model_documentChains from "../model/documentChains.js";
import type * as model_documentFlows from "../model/documentFlows.js";
import type * as model_documentHistory from "../model/documentHistory.js";
import type * as model_dunning from "../model/dunning.js";
import type * as model_files from "../model/files.js";
import type * as model_finalizeGuard from "../model/finalizeGuard.js";
import type * as model_idempotency from "../model/idempotency.js";
import type * as model_imports from "../model/imports.js";
import type * as model_integrations from "../model/integrations.js";
import type * as model_integrity from "../model/integrity.js";
import type * as model_invariants from "../model/invariants.js";
import type * as model_invoiceChains from "../model/invoiceChains.js";
import type * as model_invoiceCorrections from "../model/invoiceCorrections.js";
import type * as model_journal from "../model/journal.js";
import type * as model_kuMonitor from "../model/kuMonitor.js";
import type * as model_layouts from "../model/layouts.js";
import type * as model_lookups from "../model/lookups.js";
import type * as model_matching from "../model/matching.js";
import type * as model_members from "../model/members.js";
import type * as model_migrations from "../model/migrations.js";
import type * as model_notificationSettings from "../model/notificationSettings.js";
import type * as model_notifications from "../model/notifications.js";
import type * as model_numberRanges from "../model/numberRanges.js";
import type * as model_payments from "../model/payments.js";
import type * as model_products from "../model/products.js";
import type * as model_recurring from "../model/recurring.js";
import type * as model_salesDocuments from "../model/salesDocuments.js";
import type * as model_seeds from "../model/seeds.js";
import type * as model_settlement from "../model/settlement.js";
import type * as model_setup from "../model/setup.js";
import type * as model_system from "../model/system.js";
import type * as model_textTemplates from "../model/textTemplates.js";
import type * as model_turnover from "../model/turnover.js";
import type * as model_types from "../model/types.js";
import type * as model_vatChecks from "../model/vatChecks.js";
import type * as notifications from "../notifications.js";
import type * as paymentValidators from "../paymentValidators.js";
import type * as payments from "../payments.js";
import type * as products from "../products.js";
import type * as productsApi from "../productsApi.js";
import type * as recurring from "../recurring.js";
import type * as settings from "../settings.js";
import type * as settingsApi from "../settingsApi.js";
import type * as signup from "../signup.js";
import type * as system from "../system.js";
import type * as testFixtures from "../testFixtures.js";
import type * as validators from "../validators.js";
import type * as vatIdChecks from "../vatIdChecks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  accounting: typeof accounting;
  apiKeys: typeof apiKeys;
  auditLog: typeof auditLog;
  auth: typeof auth;
  authMail: typeof authMail;
  bankValidators: typeof bankValidators;
  banking: typeof banking;
  cash: typeof cash;
  confirmTokens: typeof confirmTokens;
  contacts: typeof contacts;
  contactsApi: typeof contactsApi;
  corrections: typeof corrections;
  crons: typeof crons;
  dashboard: typeof dashboard;
  documentArtifacts: typeof documentArtifacts;
  documentFlows: typeof documentFlows;
  documentsApi: typeof documentsApi;
  dunning: typeof dunning;
  functions: typeof functions;
  http: typeof http;
  idempotency: typeof idempotency;
  imports: typeof imports;
  importsNode: typeof importsNode;
  integrity: typeof integrity;
  invariants: typeof invariants;
  invites: typeof invites;
  invoices: typeof invoices;
  "lib/actor": typeof lib_actor;
  "lib/authHardening": typeof lib_authHardening;
  "lib/authMail": typeof lib_authMail;
  "lib/checkpointStore": typeof lib_checkpointStore;
  "lib/clock": typeof lib_clock;
  "lib/einvoiceTools": typeof lib_einvoiceTools;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "lib/finalizePipeline": typeof lib_finalizePipeline;
  "lib/importFiles": typeof lib_importFiles;
  "lib/jws": typeof lib_jws;
  "lib/ntfy": typeof lib_ntfy;
  "lib/parse": typeof lib_parse;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/time": typeof lib_time;
  "lib/vatProviders": typeof lib_vatProviders;
  lookups: typeof lookups;
  matching: typeof matching;
  members: typeof members;
  migrations: typeof migrations;
  "model/accounting": typeof model_accounting;
  "model/apiKeys": typeof model_apiKeys;
  "model/audit": typeof model_audit;
  "model/auditViewer": typeof model_auditViewer;
  "model/bankAccounts": typeof model_bankAccounts;
  "model/bankImport": typeof model_bankImport;
  "model/bankTransactions": typeof model_bankTransactions;
  "model/bankViews": typeof model_bankViews;
  "model/cash": typeof model_cash;
  "model/companyProfile": typeof model_companyProfile;
  "model/confirmTokens": typeof model_confirmTokens;
  "model/contactKeys": typeof model_contactKeys;
  "model/contacts": typeof model_contacts;
  "model/dashboard": typeof model_dashboard;
  "model/db": typeof model_db;
  "model/devMailbox": typeof model_devMailbox;
  "model/documentChains": typeof model_documentChains;
  "model/documentFlows": typeof model_documentFlows;
  "model/documentHistory": typeof model_documentHistory;
  "model/dunning": typeof model_dunning;
  "model/files": typeof model_files;
  "model/finalizeGuard": typeof model_finalizeGuard;
  "model/idempotency": typeof model_idempotency;
  "model/imports": typeof model_imports;
  "model/integrations": typeof model_integrations;
  "model/integrity": typeof model_integrity;
  "model/invariants": typeof model_invariants;
  "model/invoiceChains": typeof model_invoiceChains;
  "model/invoiceCorrections": typeof model_invoiceCorrections;
  "model/journal": typeof model_journal;
  "model/kuMonitor": typeof model_kuMonitor;
  "model/layouts": typeof model_layouts;
  "model/lookups": typeof model_lookups;
  "model/matching": typeof model_matching;
  "model/members": typeof model_members;
  "model/migrations": typeof model_migrations;
  "model/notificationSettings": typeof model_notificationSettings;
  "model/notifications": typeof model_notifications;
  "model/numberRanges": typeof model_numberRanges;
  "model/payments": typeof model_payments;
  "model/products": typeof model_products;
  "model/recurring": typeof model_recurring;
  "model/salesDocuments": typeof model_salesDocuments;
  "model/seeds": typeof model_seeds;
  "model/settlement": typeof model_settlement;
  "model/setup": typeof model_setup;
  "model/system": typeof model_system;
  "model/textTemplates": typeof model_textTemplates;
  "model/turnover": typeof model_turnover;
  "model/types": typeof model_types;
  "model/vatChecks": typeof model_vatChecks;
  notifications: typeof notifications;
  paymentValidators: typeof paymentValidators;
  payments: typeof payments;
  products: typeof products;
  productsApi: typeof productsApi;
  recurring: typeof recurring;
  settings: typeof settings;
  settingsApi: typeof settingsApi;
  signup: typeof signup;
  system: typeof system;
  testFixtures: typeof testFixtures;
  validators: typeof validators;
  vatIdChecks: typeof vatIdChecks;
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
