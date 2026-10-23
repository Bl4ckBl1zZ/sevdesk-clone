import "server-only";
import { compileRoutes, type Resource } from "../endpoint";
import { accountingReportsResource } from "./accounting-reports";
import { bankFeedResource } from "./bank-feed";
import { contactsResource } from "./contacts";
import { correctionsResource } from "./corrections";
import { documentsResource, selfBillingResource } from "./documents";
import { dunningResource } from "./dunning";
import { exportsResource } from "./exports";
import { inboxResource } from "./inbox";
import { metaResource } from "./meta";
import { paymentsResource } from "./payments";
import { productsResource } from "./products";
import { receivableLettersResource } from "./receivable-letters";
import { recurringResource } from "./recurring";
import { reportsResource } from "./reports";
import { settingsResource } from "./settings";
import { recurringVouchersResource, vouchersResource } from "./vouchers";

/**
 * Every REST resource of /api/v1 (05 §4). A later slice adds one module with `defineResource(…)` and one line here;
 * routing, auth, scopes, idempotency, problem+json, the access log and the OpenAPI document follow automatically.
 */
export const RESOURCES: readonly Resource[] = [
  metaResource,
  contactsResource,
  productsResource,
  settingsResource,
  documentsResource,
  correctionsResource,
  selfBillingResource,
  paymentsResource,
  receivableLettersResource,
  recurringResource,
  dunningResource,
  vouchersResource,
  recurringVouchersResource,
  inboxResource,
  bankFeedResource,
  reportsResource,
  accountingReportsResource,
  exportsResource,
];

export const ROUTES = compileRoutes(RESOURCES);
