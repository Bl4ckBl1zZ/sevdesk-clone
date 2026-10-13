import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { filter } from "convex-helpers/server/filter";
import { normalizeContactNumber, normalizeSearchQuery } from "../src/domain/contacts/core";
import { contactCreateSchema, contactFormFromRecord, contactSchema } from "../src/domain/schemas/contacts";
import type { Doc, Id } from "./_generated/dataModel";
import type { QueryCtx } from "./_generated/server";
import { mutation, query } from "./functions";
import { appError } from "./lib/errors";
import { parse } from "./lib/parse";
import {
  childPersons,
  contactAddresses,
  contactChannels,
  createContact,
  setArchived,
  updateContact,
} from "./model/contacts";
import type { ReadCtx } from "./model/types";

/**
 * Contacts for REST and MCP (05 §4.1, F02 §7). Thin adapters over the same model functions and zod schemas as the
 * UI (CLAUDE.md rule 5); the wire mapping lives in src/domain/schemas/api/contacts.ts. Restricted contacts (DSGVO
 * Art. 18) are invisible to API keys (F02 §7.1/§7.2); merged contacts are listed only with `includeMerged`.
 */

type Channel = "ui" | "api" | "mcp" | "system" | "cron";

const visibleToCaller = (c: Doc<"contacts">, channel: Channel) =>
  !(channel === "api" || channel === "mcp") || c.dsgvo?.restrictedAt === undefined;

async function withSubRecords(ctx: ReadCtx, c: Doc<"contacts">) {
  const addresses = (await contactAddresses(ctx, c._id)).filter((a) => a.archivedAt === undefined);
  const channels = await contactChannels(ctx, c._id);
  return { contact: c, addresses, channels };
}

async function idsByEmail(ctx: ReadCtx, email: string): Promise<Id<"contacts">[]> {
  const value = email.trim();
  const lower = value.toLowerCase();
  const rows = [
    ...(await ctx.db
      .query("contactChannels")
      .withIndex("by_type_value", (q) => q.eq("type", "email").eq("value", value))
      .collect()),
    ...(value === lower
      ? []
      : await ctx.db
          .query("contactChannels")
          .withIndex("by_type_value", (q) => q.eq("type", "email").eq("value", lower))
          .collect()),
  ];
  return [...new Set(rows.map((r) => r.contactId))];
}

async function idsByVatId(ctx: ReadCtx, vatId: string): Promise<Id<"contacts">[]> {
  const normalized = vatId.toUpperCase().replace(/[\s.-]/g, "");
  const rows = await ctx.db
    .query("contacts")
    .withIndex("by_vatId", (q) => q.eq("vatId", normalized))
    .collect();
  return rows.map((r) => r._id);
}

async function idsByNumber(ctx: ReadCtx, number: string): Promise<Id<"contacts">[]> {
  const rows = await ctx.db
    .query("contacts")
    .withIndex("by_number", (q) => q.eq("numberNormalized", normalizeContactNumber(number)))
    .collect();
  return rows.map((r) => r._id);
}

const vListStatus = v.optional(
  v.union(v.literal("lead"), v.literal("active"), v.literal("archived"), v.literal("all")),
);

const listArgs = {
  q: v.optional(v.string()),
  role: v.optional(v.union(v.literal("customer"), v.literal("supplier"), v.literal("partner"), v.literal("prospect"))),
  status: vListStatus,
  vatId: v.optional(v.string()),
  email: v.optional(v.string()),
  number: v.optional(v.string()),
  tag: v.optional(v.string()),
  includeMerged: v.optional(v.boolean()),
  updatedSince: v.optional(v.number()),
};

function baseQuery(ctx: QueryCtx, a: { q?: string; status?: string; updatedSince?: number }) {
  if (a.updatedSince !== undefined) {
    const since = a.updatedSince;
    return ctx.db.query("contacts").withIndex("by_updatedAt", (i) => i.gt("updatedAt", since));
  }
  const q = a.q?.trim() ? normalizeSearchQuery(a.q) : "";
  const status = a.status;
  if (q) {
    return ctx.db.query("contacts").withSearchIndex("search", (s) => {
      const base = s.search("searchText", q);
      return status === "lead" || status === "active" || status === "archived" ? base.eq("status", status) : base;
    });
  }
  if (status === "lead" || status === "active" || status === "archived") {
    return ctx.db.query("contacts").withIndex("by_status_name", (i) => i.eq("status", status));
  }
  return ctx.db.query("contacts").withIndex("by_status_name");
}

/** GET /contacts and MCP `contact_search`: filters of F02 §7.1, cursor pagination, `updated_since` sync. */
export const list = query({
  permission: "contacts.read",
  args: { paginationOpts: paginationOptsValidator, ...listArgs },
  handler: async (ctx, { paginationOpts, ...a }) => {
    const tagId = a.tag ? ctx.db.normalizeId("tags", a.tag) : null;
    if (a.tag && !tagId) return { page: [], isDone: true, continueCursor: "" };
    const q = a.q?.trim() ? normalizeSearchQuery(a.q) : "";
    const keep = (c: Doc<"contacts">) => {
      if (!visibleToCaller(c, ctx.actorContext.channel as Channel)) return false;
      if (c.mergedIntoId && !a.includeMerged) return false;
      const status = a.status;
      if (!status && c.status === "archived") return false;
      if ((status === "lead" || status === "active" || status === "archived") && c.status !== status) return false;
      if (a.role && !c.roles.includes(a.role)) return false;
      if (tagId && !c.tags.includes(tagId)) return false;
      // With `updated_since` the sync index is used; `q` then filters by the same normalised search text.
      if (a.updatedSince !== undefined && q && !q.split(/\s+/).every((t) => c.searchText.includes(t))) return false;
      return true;
    };
    // Exact lookups (website sign-ups, sync by key): small result sets, one page.
    if (a.email || a.vatId || a.number) {
      let ids: Id<"contacts">[] | undefined;
      const intersect = (next: Id<"contacts">[]) => {
        ids = ids === undefined ? next : ids.filter((id) => next.includes(id));
      };
      if (a.email) intersect(await idsByEmail(ctx, a.email));
      if (a.vatId) intersect(await idsByVatId(ctx, a.vatId));
      if (a.number) intersect(await idsByNumber(ctx, a.number));
      const docs = (await Promise.all((ids ?? []).map((id) => ctx.db.get(id)))).filter(
        (c): c is Doc<"contacts"> => c !== null && keep(c),
      );
      return {
        page: await Promise.all(docs.slice(0, paginationOpts.numItems).map((c) => withSubRecords(ctx, c))),
        isDone: true,
        continueCursor: "",
      };
    }
    const page = await filter(baseQuery(ctx, a), keep).paginate(paginationOpts);
    return { ...page, page: await Promise.all(page.page.map((c) => withSubRecords(ctx, c))) };
  },
});

/** GET /contacts/{id} and MCP `contact_get`: the record with addresses, channels and persons; null if invisible. */
export const get = query({
  permission: "contacts.read",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const nid = ctx.db.normalizeId("contacts", id);
    const c = nid ? await ctx.db.get(nid) : null;
    if (!c || !visibleToCaller(c, ctx.actorContext.channel as Channel)) return null;
    const persons = (await childPersons(ctx, c._id)).filter(
      (p) => !p.mergedIntoId && visibleToCaller(p, ctx.actorContext.channel as Channel),
    );
    return { ...(await withSubRecords(ctx, c)), persons };
  },
});

async function loadForWrite(ctx: ReadCtx & { actorContext: { channel: string } }, id: string) {
  const nid = ctx.db.normalizeId("contacts", id);
  const c = nid ? await ctx.db.get(nid) : null;
  if (!c || !visibleToCaller(c, ctx.actorContext.channel as Channel)) {
    throw appError("not_found", "Kontakt nicht gefunden.");
  }
  return c;
}

/**
 * PATCH /contacts/{id}: the given form fields overlay the stored record (contactFormFromRecord, shared with the UI)
 * and the whole contact is validated again with the same schema and context rules.
 */
export const patch = mutation({
  permission: "contacts.write",
  args: { id: v.string(), version: v.number(), values: v.any() },
  handler: async (ctx, { id, version, values }) => {
    const c = await loadForWrite(ctx, id);
    const form = { ...contactFormFromRecord(c), ...(values as Record<string, unknown>) };
    const r = await updateContact(ctx, c._id, version, parse(contactSchema, form));
    return { id: c._id, warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })) };
  },
});

const vMatchKey = v.union(v.literal("email"), v.literal("vat_id"), v.literal("number"));

/**
 * POST /contacts?match=… and MCP `contact_upsert` (05 §4.1): the first key with exactly one match updates that
 * contact with the given fields; more than one match → 409 UPSERT_AMBIGUOUS; no match on any key → create.
 * Merged and restricted contacts never match.
 */
export const upsert = mutation({
  permission: "contacts.write",
  args: {
    match: v.array(vMatchKey),
    matchValues: v.object({
      email: v.optional(v.string()),
      vat_id: v.optional(v.string()),
      number: v.optional(v.string()),
    }),
    values: v.any(),
    patch: v.any(),
  },
  handler: async (ctx, { match, matchValues, values, patch: patchValues }) => {
    for (const key of match) {
      const value = matchValues[key];
      if (!value) continue;
      const ids =
        key === "email"
          ? await idsByEmail(ctx, value)
          : key === "vat_id"
            ? await idsByVatId(ctx, value)
            : await idsByNumber(ctx, value);
      const docs = (await Promise.all(ids.map((id) => ctx.db.get(id)))).filter(
        (c): c is Doc<"contacts"> =>
          c !== null && !c.mergedIntoId && visibleToCaller(c, ctx.actorContext.channel as Channel),
      );
      if (docs.length > 1) {
        throw appError("invalid_input", `Mehrere Kontakte passen zu ${key} – bitte eindeutig zuordnen.`, {
          reason: "UPSERT_AMBIGUOUS",
          matchedBy: key,
        });
      }
      const existing = docs[0];
      if (existing) {
        const form = { ...contactFormFromRecord(existing), ...(patchValues as Record<string, unknown>) };
        const r = await updateContact(ctx, existing._id, existing.version, parse(contactSchema, form));
        return {
          id: existing._id,
          created: false,
          matchedBy: key,
          warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })),
        };
      }
    }
    const r = await createContact(ctx, parse(contactCreateSchema, values));
    return {
      id: r.id,
      created: true,
      matchedBy: null,
      warnings: r.warnings.map((w) => ({ code: w.code, message: w.message })),
    };
  },
});

/** POST /contacts/{id}/archive and MCP `contact_archive` (reversible). */
export const archive = mutation({
  permission: "contacts.write",
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const c = await loadForWrite(ctx, id);
    await setArchived(ctx, c._id, true);
    return { id: c._id };
  },
});
