import "server-only";
import { compileRoutes, type Resource } from "../endpoint";
import { contactsResource } from "./contacts";
import { correctionsResource } from "./corrections";
import { documentsResource } from "./documents";
import { dunningResource } from "./dunning";
import { metaResource } from "./meta";
import { paymentsResource } from "./payments";
import { productsResource } from "./products";
import { settingsResource } from "./settings";

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
  paymentsResource,
  dunningResource,
];

export const ROUTES = compileRoutes(RESOURCES);
