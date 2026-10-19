import { describe, expect, test } from "vitest";
import { clearInvariantTarget } from "../test/invariants";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, personForm, setupCatalog } from "./catalog.fixtures";
import { makeT, type TestT } from "./test.setup";

async function reasonOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    const d = (e as { data?: { reason?: string; code?: string } }).data;
    return d?.reason ?? d?.code;
  }
}

const page = { numItems: 25, cursor: null };

async function seed(t: TestT) {
  const owner = await setupCatalog(t);
  const a = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm("Alpha GmbH", { vatId: "DE123456788" }), { address: BERLIN, email: "info@alpha.de" }),
  });
  const b = await owner.mutation(api.contacts.create, {
    values: createValues(personForm("Berta", "Beispiel", { roles: ["supplier"] }), { email: "berta@example.de" }),
  });
  return { owner, a, b };
}

describe("contacts via REST/MCP (05 §4.1, F02 §7)", () => {
  test("API-012 list filters by role, exact e-mail, VAT ID and number; sub-records are included", async () => {
    const t = makeT();
    const { a, b } = await seed(t);
    const key = await t.asApiKey(["contacts:read"]);
    const all = await key.query(api.contactsApi.list, { paginationOpts: page });
    expect(all.page.map((r) => r.contact._id).sort()).toEqual([a.id, b.id].sort());
    const suppliers = await key.query(api.contactsApi.list, { paginationOpts: page, role: "supplier" });
    expect(suppliers.page.map((r) => r.contact._id)).toEqual([b.id]);
    const byEmail = await key.query(api.contactsApi.list, { paginationOpts: page, email: "INFO@alpha.de" });
    expect(byEmail.page.map((r) => r.contact._id)).toEqual([a.id]);
    expect(byEmail.page[0]?.channels[0]?.value).toBe("info@alpha.de");
    expect(byEmail.page[0]?.addresses[0]?.address.city).toBe("Berlin");
    const byVat = await key.query(api.contactsApi.list, { paginationOpts: page, vatId: "de 123456788" });
    expect(byVat.page.map((r) => r.contact._id)).toEqual([a.id]);
    const byNumber = await key.query(api.contactsApi.list, { paginationOpts: page, number: b.number });
    expect(byNumber.page.map((r) => r.contact._id)).toEqual([b.id]);
  });

  test("API-012 updated_since returns only contacts changed after the instant (sync stamp)", async () => {
    const t = makeT();
    const { owner, a } = await seed(t);
    const key = await t.asApiKey(["contacts:read"]);
    const since = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await owner.mutation(api.contacts.update, { id: a.id, version: 1, values: orgForm("Alpha GmbH & Co. KG") });
    const changed = await key.query(api.contactsApi.list, { paginationOpts: page, updatedSince: since });
    expect(changed.page.map((r) => r.contact._id)).toEqual([a.id]);
  });

  test("API-017 restricted contacts are invisible to API keys (F02 §7.1)", async () => {
    const t = makeT();
    const { a } = await seed(t);
    await t.run((ctx) => ctx.db.patch(a.id as Id<"contacts">, { dsgvo: { restrictedAt: Date.now() } }));
    clearInvariantTarget(); // tampered on purpose
    const key = await t.asApiKey(["contacts:read", "contacts:write"]);
    expect(await key.query(api.contactsApi.get, { id: a.id })).toBeNull();
    const list = await key.query(api.contactsApi.list, { paginationOpts: page });
    expect(list.page.map((r) => r.contact._id)).not.toContain(a.id);
    expect(await reasonOf(key.mutation(api.contactsApi.archive, { id: a.id }))).toBe("not_found");
  });

  test("CON-160 the DSGVO fields restrictedAt, deletionRequestedAt and scheduledPurgeAt exist from P1 and survive edits", async () => {
    const t = makeT();
    const { owner, a } = await seed(t);
    const dsgvo = {
      restrictedAt: 1_760_000_000_000,
      deletionRequestedAt: 1_759_000_000_000,
      scheduledPurgeAt: "2033-01-01",
    };
    // the schema accepts all three fields (P3 fills them through the DSGVO request flow, PRV-011)
    await t.run((ctx) => ctx.db.patch(a.id as Id<"contacts">, { dsgvo }));
    clearInvariantTarget(); // written without the (P3) request flow on purpose
    const stored = await t.run((ctx) => ctx.db.get(a.id as Id<"contacts">));
    expect(stored?.dsgvo).toEqual(dsgvo);
    // restrictedAt hides the contact from API/MCP; an owner edit of the master data keeps the DSGVO fields
    const key = await t.asApiKey(["contacts:read"]);
    expect(await key.query(api.contactsApi.get, { id: a.id })).toBeNull();
    await owner.mutation(api.contacts.update, { id: a.id, version: 1, values: orgForm("Alpha GmbH") });
    expect((await t.run((ctx) => ctx.db.get(a.id as Id<"contacts">)))?.dsgvo).toEqual(dsgvo);
  });

  test("API-015 PATCH overlays the given fields, validates the whole contact and checks the version", async () => {
    const t = makeT();
    const { a } = await seed(t);
    const key = await t.asApiKey(["contacts:read", "contacts:write"]);
    await key.mutation(api.contactsApi.patch, { id: a.id, version: 1, values: { notes: "Großkunde" } });
    const got = await key.query(api.contactsApi.get, { id: a.id });
    expect(got?.contact).toMatchObject({ notes: "Großkunde", organizationName: "Alpha GmbH", vatId: "DE123456788" });
    expect(await reasonOf(key.mutation(api.contactsApi.patch, { id: a.id, version: 1, values: {} }))).toBe(
      "VERSION_CONFLICT",
    );
    expect(
      await reasonOf(key.mutation(api.contactsApi.patch, { id: a.id, version: 2, values: { vatId: "DE123456789" } })),
    ).toBe("VAT_ID_CHECKSUM");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.actor === key.actor && e.channel === "api")).toBe(true);
  });

  test("API-017 upsert updates the single match, creates when nothing matches and refuses ambiguous matches", async () => {
    const t = makeT();
    const { owner, a } = await seed(t);
    const key = await t.asApiKey(["contacts:read", "contacts:write"]);
    const updated = await key.mutation(api.contactsApi.upsert, {
      match: ["vat_id", "email"],
      matchValues: { vat_id: "DE123456788" },
      values: createValues(orgForm("egal")),
      patch: { notes: "per Website" },
    });
    expect(updated).toMatchObject({ id: a.id, created: false, matchedBy: "vat_id" });
    const created = await key.mutation(api.contactsApi.upsert, {
      match: ["email"],
      matchValues: { email: "neu@example.de" },
      values: createValues(orgForm("Neu GmbH"), { email: "neu@example.de" }),
      patch: {},
    });
    expect(created.created).toBe(true);
    await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Alpha Zwei"), { email: "info@alpha.de" }),
    });
    expect(
      await reasonOf(
        key.mutation(api.contactsApi.upsert, {
          match: ["email"],
          matchValues: { email: "info@alpha.de" },
          values: createValues(orgForm("x")),
          patch: {},
        }),
      ),
    ).toBe("UPSERT_AMBIGUOUS");
  });

  test("API-005 a read-only key cannot write", async () => {
    const t = makeT();
    const { a } = await seed(t);
    const key = await t.asApiKey(["contacts:read"]);
    expect(await reasonOf(key.mutation(api.contactsApi.archive, { id: a.id }))).toBe("forbidden_scope");
  });
});
