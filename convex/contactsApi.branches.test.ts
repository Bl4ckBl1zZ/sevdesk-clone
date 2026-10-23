import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, personForm, setupCatalog } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { makeT, type TestT } from "./test.setup";

/**
 * Contacts over REST/MCP (05 §4.1, F02 §7) — the filter, visibility and upsert branches of convex/contactsApi.ts
 * that the main suite does not reach: UI callers see restricted contacts, `audit:read` keys read them by id,
 * search with status, `updated_since` with `q`, exact-key intersections, merged contacts and the persons list.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const page = { numItems: 25, cursor: null };
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<typeof setupCatalog>>;

async function create(owner: Owner, values: ReturnType<typeof createValues>) {
  return (await owner.mutation(api.contacts.create, { values })).id as Id<"contacts">;
}

/** DSGVO Art. 18 restriction, audited like the F12 model writes it (RI-15). */
function restrict(t: TestT, owner: Owner, id: Id<"contacts">) {
  const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
  return t.model(actor, (ctx) =>
    auditedPatch(ctx, "contacts", id, { dsgvo: { restrictedAt: Date.now() } }, { action: "dsgvo.restrict", label: id }),
  );
}

async function seed(t: TestT) {
  const owner = await setupCatalog(t);
  const vip = await owner.mutation(api.lookups.saveTag, { values: { name: "VIP", color: "blue" } });
  const alpha = await create(
    owner,
    createValues(orgForm("Alpha GmbH", { vatId: "DE811907980", tags: [vip] }), {
      address: BERLIN,
      email: "info@alpha.de",
    }),
  );
  const lead = await create(owner, createValues(orgForm("Lead Interessent GmbH", { status: "lead" })));
  const archived = await create(owner, createValues(orgForm("Archiv GmbH")));
  await owner.mutation(api.contacts.archive, { id: archived });
  const anna = await create(owner, createValues(personForm("Anna", "Alpha", { parentId: alpha })));
  return { owner, vip, alpha, lead, archived, anna };
}

const idsOf = (r: { page: { contact: { _id: string } }[] }) => r.page.map((x) => x.contact._id).sort();

describe("API-012 contact list filters", () => {
  test("API-012 status, tag, search with status, updated_since with q and unknown tags", async () => {
    const t = makeT();
    const { vip, alpha, lead, archived, anna } = await seed(t);
    const key = await t.asApiKey(["contacts:read"]);
    const list = (a: Record<string, unknown>) => key.query(api.contactsApi.list, { paginationOpts: page, ...a });

    expect(idsOf(await list({}))).toEqual([alpha, lead, anna].sort());
    expect(idsOf(await list({ status: "lead" }))).toEqual([lead]);
    expect(idsOf(await list({ status: "archived" }))).toEqual([archived]);
    expect(idsOf(await list({ status: "all" }))).toEqual([alpha, lead, archived, anna].sort());
    expect(idsOf(await list({ tag: vip }))).toEqual([alpha]);
    expect(await list({ tag: "kein-tag" })).toEqual({ page: [], isDone: true, continueCursor: "" });
    expect(idsOf(await list({ q: "Alpha", status: "active" }))).toEqual([alpha, anna].sort());
    expect(idsOf(await list({ q: "Archiv", status: "archived" }))).toEqual([archived]);
    expect(idsOf(await list({ q: "Interessent" }))).toEqual([lead]);
    // updated_since uses the sync index; q then filters by the normalised search text
    expect(idsOf(await list({ updatedSince: 0, q: "alpha gmbh", status: "all" }))).toEqual([alpha]);
    expect(idsOf(await list({ updatedSince: 0, q: "zeta" }))).toEqual([]);
  });

  test("API-012 exact lookups intersect e-mail, VAT ID and number; merged contacts only with includeMerged", async () => {
    const t = makeT();
    const { owner, alpha } = await seed(t);
    const twin = await create(owner, createValues(orgForm("Alpha Zwei GmbH"), { email: "info@alpha.de" }));
    const key = await t.asApiKey(["contacts:read"]);
    const list = (a: Record<string, unknown>) => key.query(api.contactsApi.list, { paginationOpts: page, ...a });
    expect(idsOf(await list({ email: "info@alpha.de" }))).toEqual([alpha, twin].sort());
    expect(idsOf(await list({ email: "info@alpha.de", vatId: "DE811907980" }))).toEqual([alpha]);
    const number = (await t.run((ctx) => ctx.db.get(twin)))?.number ?? "";
    expect(idsOf(await list({ email: "info@alpha.de", number }))).toEqual([twin]);
    expect(idsOf(await list({ vatId: "DE811907980", number }))).toEqual([]);

    await owner.mutation(api.contacts.merge, {
      values: { winnerId: alpha, loserIds: [twin], fieldChoices: {}, confirmVatConflict: false },
    });
    expect(idsOf(await list({ number }))).toEqual([]);
    expect(idsOf(await list({ number, includeMerged: true, status: "all" }))).toEqual([twin]);
  });

  test("PRV-012 the UI channel lists restricted contacts; API keys do not", async () => {
    const t = makeT();
    const { owner, alpha } = await seed(t);
    await restrict(t, owner, alpha);
    const key = await t.asApiKey(["contacts:read"]);
    expect(idsOf(await key.query(api.contactsApi.list, { paginationOpts: page }))).not.toContain(alpha);
    expect(idsOf(await owner.query(api.contactsApi.list, { paginationOpts: page }))).toContain(alpha);
  });
});

describe("PRV-012 restricted contacts by id", () => {
  test("PRV-012 restrictedInfo answers only for restricted contacts and keys without audit:read; get honours audit:read", async () => {
    const t = makeT();
    const { owner, alpha, lead, anna } = await seed(t);
    const reader = await t.asApiKey(["contacts:read"]);
    const auditor = await t.asApiKey(["contacts:read", "audit:read"]);
    expect(await reader.query(api.contactsApi.restrictedInfo, { id: "kein-kontakt" })).toBeNull();
    expect(await reader.query(api.contactsApi.restrictedInfo, { id: lead })).toBeNull();
    await restrict(t, owner, alpha);
    const number = (await t.run((ctx) => ctx.db.get(alpha)))?.number;
    expect(await reader.query(api.contactsApi.restrictedInfo, { id: alpha })).toEqual({
      id: alpha,
      number,
      restricted: true,
    });
    expect(await auditor.query(api.contactsApi.restrictedInfo, { id: alpha })).toBeNull();

    expect(await reader.query(api.contactsApi.get, { id: alpha })).toBeNull();
    expect(await reader.query(api.contactsApi.get, { id: "kein-kontakt" })).toBeNull();
    const got = await auditor.query(api.contactsApi.get, { id: alpha });
    expect(got?.contact._id).toBe(alpha);
    expect(got?.persons.map((p) => p._id)).toEqual([anna]);
    // a restricted person is left out of the organisation's persons for API keys
    await owner.mutation(api.contacts.unarchive, { id: lead });
    await restrict(t, owner, anna);
    expect((await auditor.query(api.contactsApi.get, { id: alpha }))?.persons).toEqual([]);
  });
});

describe("API-015 API-017 writes", () => {
  test("API-015 PATCH and archive of an unknown contact are not found", async () => {
    const t = makeT();
    await seed(t);
    const key = await t.asApiKey(["contacts:read", "contacts:write"]);
    for (const p of [
      key.mutation(api.contactsApi.patch, { id: "kein-kontakt", version: 1, values: {} }),
      key.mutation(api.contactsApi.archive, { id: "kein-kontakt" }),
    ]) {
      const e = await catching(p);
      expect(errorCode(e)).toBe("not_found");
      expect(dataOf(e).message).toBe("Kontakt nicht gefunden.");
    }
  });

  test("API-017 upsert skips keys without a value, matches by number and archives via the API", async () => {
    const t = makeT();
    const { alpha, lead } = await seed(t);
    const key = await t.asApiKey(["contacts:read", "contacts:write"]);
    const number = (await t.run((ctx) => ctx.db.get(lead)))?.number ?? "";
    const r = await key.mutation(api.contactsApi.upsert, {
      match: ["email", "vat_id", "number"],
      matchValues: { number },
      values: createValues(orgForm("egal")),
      patch: { notes: "aus dem Shop" },
    });
    expect(r).toEqual({ id: lead, created: false, matchedBy: "number", warnings: [] });
    expect((await t.run((ctx) => ctx.db.get(lead)))?.notes).toBe("aus dem Shop");
    const none = await key.mutation(api.contactsApi.upsert, {
      match: ["vat_id"],
      matchValues: { vat_id: "ATU13585627" },
      values: createValues(orgForm("Österreich GmbH", { vatId: "ATU13585627" })),
      patch: {},
    });
    expect(none).toMatchObject({ created: true, matchedBy: null });
    expect(await key.mutation(api.contactsApi.archive, { id: alpha })).toEqual({ id: alpha });
    expect((await t.run((ctx) => ctx.db.get(alpha)))?.status).toBe("archived");
  });
});
