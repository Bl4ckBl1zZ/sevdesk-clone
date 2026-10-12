import { v } from "convex/values";

/** Shared Convex validators for the embedded types of 03 §0.2. */

/** Canonical actor string `"<kind>:<id>"` (03 §0.1); format checked by the model layer (`actorSchema`). */
export const vActor = v.string();

export const vMemberRole = v.union(
  v.literal("owner"),
  v.literal("bookkeeper"),
  v.literal("viewer"),
  v.literal("auditor"),
);
export const vInviteRole = v.union(v.literal("bookkeeper"), v.literal("viewer"), v.literal("auditor"));

export const vChannel = v.union(
  v.literal("ui"),
  v.literal("api"),
  v.literal("mcp"),
  v.literal("portal"),
  v.literal("cron"),
  v.literal("import"),
  v.literal("system"),
);

export const vPostalAddress = v.object({
  name: v.string(),
  name2: v.optional(v.string()),
  department: v.optional(v.string()),
  street: v.string(),
  street2: v.optional(v.string()),
  postalCode: v.string(),
  city: v.string(),
  countryCode: v.string(),
  poBox: v.optional(v.string()),
});

export const vFileRef = v.object({
  storageId: v.id("_storage"),
  sha256: v.string(),
  bytes: v.number(),
  mime: v.string(),
  name: v.string(),
});

export const vPaymentTerms = v.object({
  dueDays: v.number(),
  skontoPercentBp: v.optional(v.number()),
  skontoDays: v.optional(v.number()),
  text: v.optional(v.string()),
});

export const vTimeRounding = v.object({
  incrementMinutes: v.union(
    v.literal(0),
    v.literal(1),
    v.literal(5),
    v.literal(6),
    v.literal(10),
    v.literal(15),
    v.literal(30),
    v.literal(60),
  ),
  mode: v.union(v.literal("up"), v.literal("nearest")),
  minimumMinutes: v.optional(v.number()),
});

export const vSalesDocType = v.union(
  v.literal("quote"),
  v.literal("order_confirmation"),
  v.literal("delivery_note"),
  v.literal("proforma"),
  v.literal("invoice"),
  v.literal("advance_invoice"),
  v.literal("partial_invoice"),
  v.literal("final_invoice"),
  v.literal("cancellation"),
  v.literal("correction"),
  v.literal("self_billing"),
  v.literal("reminder"),
);

export const vAuditorScope = v.object({
  organisation: v.optional(v.string()),
  purpose: v.string(),
  fiscalYears: v.array(v.number()),
});

export const vIntegrityFinding = v.object({
  kind: v.string(),
  severity: v.union(v.literal("warning"), v.literal("error")),
  detail: v.string(),
  entity: v.optional(v.object({ table: v.string(), id: v.string() })),
  firstBrokenSeq: v.optional(v.number()),
});

/** The actor context passed from a trusted action to an internal mutation (never from a client). */
export const vActorContext = v.object({
  actor: vActor,
  role: v.optional(vMemberRole),
  label: v.optional(v.string()),
  channel: vChannel,
  sessionId: v.optional(v.string()),
  client: v.optional(v.object({ name: v.string(), version: v.string() })),
  scopes: v.optional(v.array(v.string())),
});
