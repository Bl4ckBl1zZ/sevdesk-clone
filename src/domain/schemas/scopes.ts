import { z } from "zod";

/** API-key scopes (05-api §2.2). Shared by REST, MCP, the key dialog and the Convex wrappers. */
export const SCOPES = [
  "contacts:read",
  "contacts:write",
  "products:read",
  "products:write",
  "documents:read",
  "documents:write",
  "invoices:finalize",
  "invoices:send",
  "invoices:cancel",
  "payments:read",
  "payments:write",
  "dunning:write",
  "dunning:manage",
  "vouchers:read",
  "vouchers:write",
  "banking:read",
  "banking:write",
  "accounting:read",
  "accounting:write",
  "reports:read",
  "exports:run",
  "imports:run",
  "settings:read",
  "settings:write",
  "webhooks:manage",
  "audit:read",
  "projects:read",
  "projects:write",
  "time:write",
  "portal:manage",
  "company:public",
] as const;

export type Scope = (typeof SCOPES)[number];
export const scopeSchema = z.enum(SCOPES);

/** Reserved scopes that are never offered while the feature is deferred (05-api §2.2). */
export const RESERVED_SCOPES: readonly Scope[] = ["portal:manage"];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}
