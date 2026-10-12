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
import type * as auth from "../auth.js";
import type * as authMail from "../authMail.js";
import type * as crons from "../crons.js";
import type * as functions from "../functions.js";
import type * as http from "../http.js";
import type * as integrity from "../integrity.js";
import type * as invariants from "../invariants.js";
import type * as invites from "../invites.js";
import type * as lib_actor from "../lib/actor.js";
import type * as lib_authHardening from "../lib/authHardening.js";
import type * as lib_authMail from "../lib/authMail.js";
import type * as lib_checkpointStore from "../lib/checkpointStore.js";
import type * as lib_env from "../lib/env.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_jws from "../lib/jws.js";
import type * as lib_parse from "../lib/parse.js";
import type * as lib_rateLimits from "../lib/rateLimits.js";
import type * as lib_time from "../lib/time.js";
import type * as lookups from "../lookups.js";
import type * as members from "../members.js";
import type * as model_audit from "../model/audit.js";
import type * as model_bankAccounts from "../model/bankAccounts.js";
import type * as model_companyProfile from "../model/companyProfile.js";
import type * as model_contactKeys from "../model/contactKeys.js";
import type * as model_db from "../model/db.js";
import type * as model_devMailbox from "../model/devMailbox.js";
import type * as model_documentHistory from "../model/documentHistory.js";
import type * as model_files from "../model/files.js";
import type * as model_finalizeGuard from "../model/finalizeGuard.js";
import type * as model_integrations from "../model/integrations.js";
import type * as model_integrity from "../model/integrity.js";
import type * as model_invariants from "../model/invariants.js";
import type * as model_layouts from "../model/layouts.js";
import type * as model_lookups from "../model/lookups.js";
import type * as model_members from "../model/members.js";
import type * as model_notificationSettings from "../model/notificationSettings.js";
import type * as model_numberRanges from "../model/numberRanges.js";
import type * as model_seeds from "../model/seeds.js";
import type * as model_setup from "../model/setup.js";
import type * as model_system from "../model/system.js";
import type * as model_textTemplates from "../model/textTemplates.js";
import type * as model_types from "../model/types.js";
import type * as settings from "../settings.js";
import type * as signup from "../signup.js";
import type * as system from "../system.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  access: typeof access;
  auth: typeof auth;
  authMail: typeof authMail;
  crons: typeof crons;
  functions: typeof functions;
  http: typeof http;
  integrity: typeof integrity;
  invariants: typeof invariants;
  invites: typeof invites;
  "lib/actor": typeof lib_actor;
  "lib/authHardening": typeof lib_authHardening;
  "lib/authMail": typeof lib_authMail;
  "lib/checkpointStore": typeof lib_checkpointStore;
  "lib/env": typeof lib_env;
  "lib/errors": typeof lib_errors;
  "lib/jws": typeof lib_jws;
  "lib/parse": typeof lib_parse;
  "lib/rateLimits": typeof lib_rateLimits;
  "lib/time": typeof lib_time;
  lookups: typeof lookups;
  members: typeof members;
  "model/audit": typeof model_audit;
  "model/bankAccounts": typeof model_bankAccounts;
  "model/companyProfile": typeof model_companyProfile;
  "model/contactKeys": typeof model_contactKeys;
  "model/db": typeof model_db;
  "model/devMailbox": typeof model_devMailbox;
  "model/documentHistory": typeof model_documentHistory;
  "model/files": typeof model_files;
  "model/finalizeGuard": typeof model_finalizeGuard;
  "model/integrations": typeof model_integrations;
  "model/integrity": typeof model_integrity;
  "model/invariants": typeof model_invariants;
  "model/layouts": typeof model_layouts;
  "model/lookups": typeof model_lookups;
  "model/members": typeof model_members;
  "model/notificationSettings": typeof model_notificationSettings;
  "model/numberRanges": typeof model_numberRanges;
  "model/seeds": typeof model_seeds;
  "model/setup": typeof model_setup;
  "model/system": typeof model_system;
  "model/textTemplates": typeof model_textTemplates;
  "model/types": typeof model_types;
  settings: typeof settings;
  signup: typeof signup;
  system: typeof system;
  validators: typeof validators;
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
