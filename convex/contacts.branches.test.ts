import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type ContactFormValues, contactCreateSchema, contactSchema } from "../src/domain/schemas/contacts";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, PARIS, personForm, productForm } from "./catalog.fixtures";
import { invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import {
  companyContext,
  createContact,
  ensurePersonalAccount,
  resolveContactAlias,
  updateContact,
} from "./model/contacts";
import { recordCheck } from "./model/vatChecks";
import { makeT, type TestT } from "./test.setup";

/**
 * F02 contacts — the guards, optional fields and filter combinations of convex/contacts.ts and
 * convex/model/contacts.ts that the feature suites do not reach (list filters, rich master data, sub-records,
 * consents and certificates, import/export, merge undo, DATEV personal accounts).
 */

const NOW = new Date("2026-10-12T10:00:00Z");
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const page = { numItems: 100, cursor: null };
const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const reasonOf = (e: unknown) => dataOf(e).reason;
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

async function setup(t: TestT) {
  const { owner } = await setupInvoicing(t);
  return owner;
}

async function org(owner: Owner, name: string, over: Partial<ContactFormValues> = {}, opts = {}) {
  const r = await owner.mutation(api.contacts.create, {
    values: createValues(orgForm(name, over), { address: BERLIN, ...opts }),
  });
  return r.id as Id<"contacts">;
}

async function person(owner: Owner, first: string, last: string, over: Partial<ContactFormValues> = {}) {
  const r = await owner.mutation(api.contacts.create, { values: createValues(personForm(first, last, over)) });
  return r.id as Id<"contacts">;
}

const contactOf = (t: TestT, id: Id<"contacts">) => t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"contacts">);

/** DSGVO Art. 18 restriction as the F12 model writes it (audited, so RI-15 holds). */
function restrict(t: TestT, owner: Owner, id: Id<"contacts">) {
  const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
  return t.model(actor, (ctx) =>
    auditedPatch(ctx, "contacts", id, { dsgvo: { restrictedAt: Date.now() } }, { action: "dsgvo.restrict", label: id }),
  );
}

const ids = (rows: { _id: string }[]) => rows.map((r) => r._id).sort();

function check(t: TestT, owner: Owner, id: Id<"contacts">, vatId: string, kind: "valid" | "qualified" | "invalid") {
  const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
  return t.model(actor, (ctx) =>
    recordCheck(ctx, id, vatId, {
      provider: kind === "qualified" ? "bzst_evatr" : "eu_vies",
      request: {},
      response: {},
      status: kind === "invalid" ? "invalid" : "valid",
      ...(kind === "qualified" ? { qualified: { name: "A", street: "A", postalCode: "A", city: "A" } } : {}),
      message: kind === "invalid" ? "ungültig" : "gültig",
      fingerprint: `${id}-${kind}`,
    }),
  );
}

describe("CON-172 CON-173 list filters", () => {
  test("CON-172 CON-173 status, kind, role, type, VAT status, tag (inherited from the parent), country and parent filters", async () => {
    const t = makeT();
    const owner = await setup(t);
    const vip = await owner.mutation(api.lookups.saveTag, { values: { name: "VIP", color: "blue" } });
    const alpha = await org(owner, "Alpha GmbH", { vatId: "FR40303265045", tags: [vip] });
    const beta = await org(owner, "Beta Interessent GmbH", { status: "lead", roles: ["prospect"] });
    const amt = await org(owner, "Stadtverwaltung Musterstadt", {
      isPublicAuthority: true,
      buyerReference: "04011000-1234512345-06",
    });
    const paris = await org(owner, "Paris SARL", { vatId: "FR83404833048", roles: ["supplier"] }, { address: PARIS });
    const delta = await org(owner, "Delta GmbH", { vatId: "ATU13585627" });
    const gamma = await org(owner, "Gamma GmbH", { vatId: "BE0411905847" });
    const erika = await person(owner, "Erika", "Verbraucherin", { isConsumer: true });
    const anna = await person(owner, "Anna", "Alpha", { parentId: alpha });
    const archived = await org(owner, "Zeta Archiv GmbH");
    await owner.mutation(api.contacts.archive, { id: archived });
    await check(t, owner, alpha, "FR40303265045", "qualified");
    await check(t, owner, paris, "FR83404833048", "valid");
    await check(t, owner, delta, "ATU13585627", "invalid");

    const list = async (f: Record<string, unknown>) =>
      ids((await owner.query(api.contacts.list, { paginationOpts: page, ...f })).page);

    expect(await list({ status: "lead" })).toEqual([beta]);
    expect(await list({ status: "archived" })).toEqual([archived]);
    expect(await list({ status: "all" })).toContain(archived);
    expect(await list({})).not.toContain(archived);
    expect(await list({ status: "active", kind: "person" })).toEqual(ids([{ _id: erika }, { _id: anna }]));
    expect(await list({ role: "supplier" })).toEqual([paris]);
    expect(await list({ type: "b2c" })).toEqual([erika]);
    expect(await list({ type: "b2g" })).toEqual([amt]);
    expect(await list({ type: "b2b" })).not.toContain(erika);
    expect(await list({ type: "b2b" })).not.toContain(amt);
    expect(await list({ vatStatus: "qualified" })).toEqual([alpha]);
    expect(await list({ vatStatus: "valid" })).toEqual([paris]);
    expect(await list({ vatStatus: "invalid" })).toEqual([delta]);
    expect(await list({ vatStatus: "unchecked" })).toContain(gamma);
    expect(await list({ vatStatus: "unchecked" })).not.toContain(alpha);
    // CON-010: the person inherits the organisation's tag for filtering
    expect(await list({ tag: vip })).toEqual(ids([{ _id: alpha }, { _id: anna }]));
    expect(await list({ country: "fr" })).toEqual([paris]);
    expect(await list({ parentId: alpha })).toEqual([anna]);
    expect(await list({ q: "Alpha", status: "active", kind: "organization" })).toEqual([alpha]);

    // the list row shows the VAT badge, the parent name and the phone fallback
    const rows = (await owner.query(api.contacts.list, { paginationOpts: page, status: "all" })).page;
    expect(rows.find((r) => r._id === anna)?.parentName).toBe("Alpha GmbH");
    expect(rows.find((r) => r._id === alpha)?.vatBadge).not.toBeNull();
    expect(rows.find((r) => r._id === erika)?.vatBadge).toBeNull();

    // options: the picker with a kind filter; ranking with the default limit
    expect((await owner.query(api.contacts.options, { kind: "person" })).map((o) => o._id).sort()).toEqual(
      ids([{ _id: erika }, { _id: anna }]),
    );
    const ranked = await owner.query(api.contacts.ranking, { sortBy: "open", dir: "asc", status: "lead" });
    expect(ranked.map((r) => r._id)).toEqual([beta]);
  });

  test("CON-172 restricted (Art. 18) and merged contacts only appear under „Alle“", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const b = await org(owner, "Beta GmbH");
    await restrict(t, owner, a);
    const list = async (f: Record<string, unknown>) =>
      ids((await owner.query(api.contacts.list, { paginationOpts: page, ...f })).page);
    expect(await list({})).toEqual([b]);
    expect(await list({ status: "all" })).toEqual(ids([{ _id: a }, { _id: b }]));
  });
});

describe("CON-001…CON-112 master data with every optional field", () => {
  test("CON-004 CON-005 CON-040 CON-090 CON-091 CON-100 CON-102 a fully filled organisation and person are stored, shown and cleared again", async () => {
    const t = makeT();
    const owner = await setup(t);
    const vip = await owner.mutation(api.lookups.saveTag, { values: { name: "VIP", color: "blue" } });
    const { id: orgId } = await owner.mutation(api.contacts.create, {
      values: createValues(
        orgForm("Voll GmbH", {
          organizationName2: "Abteilung Einkauf",
          vatId: "DE 811 907 980",
          taxNumber: "27/815/08155",
          defaultTaxCase: "domestic",
          buyerReference: "PO-4711",
          electronicAddressScheme: "EM",
          electronicAddressValue: "rechnung@voll.de",
          dueDays: "14",
          skontoPercent: "2",
          skontoDays: "7",
          paymentTermsText: "Zahlbar ohne Abzug",
          defaultDiscount: "5",
          iban: "DE89 3704 0044 0532 0130 00",
          bic: "COBADEFFXXX",
          debtorAccount: "10001",
          creditorAccount: "70001",
          tags: [vip],
          notes: "Wichtiger Kunde",
        }),
        { address: BERLIN, email: "info@voll.de", phone: "+49 30 123456" },
      ),
    });
    const id = orgId as Id<"contacts">;
    const c = await contactOf(t, id);
    expect(c).toMatchObject({
      organizationName2: "Abteilung Einkauf",
      vatId: "DE811907980",
      taxNumber: "27/815/08155",
      defaultTaxCase: "domestic",
      buyerReference: "PO-4711",
      electronicAddress: { scheme: "EM", value: "rechnung@voll.de" },
      paymentTerms: { dueDays: 14, skontoPercentBp: 200, skontoDays: 7, text: "Zahlbar ohne Abzug" },
      defaultDiscountBp: 500,
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
      debtorAccount: "10001",
      creditorAccount: "70001",
      notes: "Wichtiger Kunde",
    });
    expect(c.searchText).toContain("vip");

    const pId = await person(owner, "Anna", "Muster", {
      parentId: id,
      salutation: "frau",
      academicTitle: "Dr.",
      position: "Geschäftsführerin",
      birthday: "1980-05-01",
    });
    expect(await contactOf(t, pId)).toMatchObject({
      salutation: "frau",
      academicTitle: "Dr.",
      position: "Geschäftsführerin",
      birthday: "1980-05-01",
      displayName: "Dr. Anna Muster",
    });

    // the person's page shows the parent and inherits its invoice recipients
    const pd = await owner.query(api.contacts.get, { id: pId });
    expect(pd?.parent).toEqual({ _id: id, number: c.number, displayName: "Voll GmbH" });
    expect(pd?.supplierStats).toBeNull();
    const od = await owner.query(api.contacts.get, { id });
    expect(od?.persons).toEqual([
      expect.objectContaining({ _id: pId, position: "Geschäftsführerin", displayName: "Dr. Anna Muster" }),
    ]);
    expect(od?.deleteBlockedBy).toEqual(["1 Ansprechpartner"]);
    expect(od?.tags).toEqual([{ _id: vip, name: "VIP", color: "blue" }]);
    expect(await catching(owner.mutation(api.contacts.remove, { id }))).toSatisfy(
      (e: unknown) => reasonOf(e) === "CONTACT_IN_USE" && messageOf(e).includes("1 Ansprechpartner"),
    );

    // DATEV accounts are unique (CON-101)
    expect(reasonOf(await catching(org(owner, "Zweite GmbH", { debtorAccount: "10001" })))).toBe("DATEV_ACCOUNT_TAKEN");
    expect(reasonOf(await catching(org(owner, "Dritte GmbH", { creditorAccount: "70001" })))).toBe(
      "DATEV_ACCOUNT_TAKEN",
    );
    expect(reasonOf(await catching(org(owner, "Vierte GmbH", { tags: ["kein-tag"] })))).toBe("TAG_UNKNOWN");

    // an update that empties the optional fields removes them (REMOVABLE), the number changes to a free one
    const r = await owner.mutation(api.contacts.update, {
      id,
      version: c.version,
      values: orgForm("Voll GmbH", { number: "K-1" }),
    });
    expect(r).toEqual({ warnings: [], vatIdChanged: true });
    const cleared = await contactOf(t, id);
    expect(cleared.number).toBe("K-1");
    for (const k of [
      "vatId",
      "taxNumber",
      "iban",
      "bic",
      "paymentTerms",
      "notes",
      "debtorAccount",
      "electronicAddress",
    ])
      expect(cleared[k as keyof typeof cleared]).toBeUndefined();
    const other = await org(owner, "Andere GmbH", { number: "K-2" });
    expect(
      reasonOf(
        await catching(
          owner.mutation(api.contacts.update, {
            id: other,
            version: 1,
            values: orgForm("Andere GmbH", { number: "k-1" }),
          }),
        ),
      ),
    ).toBe("CONTACT_NUMBER_TAKEN");
    // a person cannot become an organisation's child of a person (PARENT_INVALID), an organisation with persons
    // cannot become a person (CON-001)
    expect(
      reasonOf(
        await catching(
          owner.mutation(api.contacts.update, {
            id,
            version: cleared.version,
            values: personForm("Voll", "GmbH"),
          }),
        ),
      ),
    ).toBeTruthy();
  });

  test("CON-007 CON-008 version conflicts, archived and active status are kept, merged contacts are read-only", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const conflict = await catching(owner.mutation(api.contacts.update, { id: a, version: 9, values: orgForm("X") }));
    expect(errorCode(conflict)).toBe("version_conflict");
    expect(messageOf(conflict)).toBe("Der Kontakt wurde zwischenzeitlich geändert. Bitte neu laden.");

    // lead → active is never downgraded by the form
    await owner.mutation(api.contacts.update, { id: a, version: 1, values: orgForm("Alpha GmbH", { status: "lead" }) });
    expect((await contactOf(t, a)).status).toBe("active");
    // an archived contact stays archived on edit; archiving twice is a no-op
    await owner.mutation(api.contacts.archive, { id: a });
    await owner.mutation(api.contacts.archive, { id: a });
    const archived = await contactOf(t, a);
    await owner.mutation(api.contacts.update, { id: a, version: archived.version, values: orgForm("Alpha AG") });
    expect(await contactOf(t, a)).toMatchObject({ status: "archived", displayName: "Alpha AG" });
    await owner.mutation(api.contacts.unarchive, { id: a });
    expect((await contactOf(t, a)).status).toBe("active");

    const b = await org(owner, "Beta GmbH");
    await owner.mutation(api.contacts.merge, {
      values: { winnerId: a, loserIds: [b], fieldChoices: {}, confirmVatConflict: false },
    });
    const merged = await contactOf(t, b);
    const e = await catching(
      owner.mutation(api.contacts.update, { id: b, version: merged.version, values: orgForm("Beta") }),
    );
    expect(reasonOf(e)).toBe("CONTACT_MERGED");
    expect(messageOf(e)).toBe("Der Kontakt wurde zusammengeführt und kann nicht mehr bearbeitet werden.");
    expect(reasonOf(await catching(owner.mutation(api.contacts.unarchive, { id: b })))).toBe("CONTACT_MERGED");
    // CON-133: aliases resolve to the winner
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    expect((await t.model(actor, (ctx) => resolveContactAlias(ctx, b)))._id).toBe(a);
    // the alias page has no duplicate hints and names the winner
    const detail = await owner.query(api.contacts.get, { id: b });
    expect(detail?.mergedInto?._id).toBe(a);
    expect(detail?.duplicateHints).toEqual([]);
    // the merge form refuses unknown ids
    const bad = await catching(
      owner.mutation(api.contacts.merge, {
        values: { winnerId: a, loserIds: ["kein-kontakt"], fieldChoices: {}, confirmVatConflict: false },
      }),
    );
    expect(errorCode(bad)).toBe("not_found");
    expect(messageOf(bad)).toBe("Kontakt nicht gefunden.");
  });

  test("CON-003 nextNumber is null without a contact range; a missing contact returns null on the page", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(await owner.query(api.contacts.nextNumber, {})).toBeNull();
    const a = await setup(t).then((o) => org(o, "Alpha GmbH"));
    await owner.mutation(api.contacts.remove, { id: a });
    expect(await owner.query(api.contacts.get, { id: a })).toBeNull();
  });

  test("CON-130 duplicate hints while typing normalise VAT ID, e-mail and IBAN", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(
      owner,
      "Alpha Bau GmbH",
      { vatId: "DE811907980", iban: "DE89370400440532013000" },
      { email: "rechnung@alpha.de" },
    );
    const hints = await owner.query(api.contacts.duplicateHints, {
      displayName: "Alpha Bau GmbH",
      vatId: "de 811.907-980",
      email: " Rechnung@Alpha.de ",
      iban: "de89 3704 0044 0532 0130 00",
      postalCode: "10115",
    });
    expect(hints.map((h) => h.id)).toEqual([a]);
    expect(hints[0]?.reasons.length).toBeGreaterThan(0);
    // the contact itself is excluded while editing; empty strings are ignored
    expect(
      await owner.query(api.contacts.duplicateHints, { id: a, displayName: "Alpha Bau GmbH", vatId: "", iban: "" }),
    ).toEqual([]);
  });
});

describe("CON-020…CON-033 addresses and channels", () => {
  test("CON-021 CON-022 CON-023 changing a default address's type promotes the next one; unknown ids are refused", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const addr = (over: Record<string, unknown>) => ({
      type: "billing",
      isDefault: false,
      name: "",
      name2: "Zentrale",
      department: "Einkauf",
      street: "Nebenstr. 2",
      street2: "Hinterhaus",
      postalCode: "10117",
      city: "Berlin",
      countryCode: "DE",
      poBox: "",
      ...over,
    });
    const second = await owner.mutation(api.contacts.saveAddress, { contactId: a, values: addr({}) });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("contactAddresses")
        .withIndex("by_contact", (q) => q.eq("contactId", a))
        .collect(),
    );
    const first = rows.find((r) => r._id !== second);
    expect(first?.isDefault).toBe(true);
    expect(rows.find((r) => r._id === second)?.address).toMatchObject({
      name: "Alpha GmbH",
      name2: "Zentrale",
      department: "Einkauf",
      street2: "Hinterhaus",
    });
    // the default billing address becomes a delivery address → the other billing address is promoted
    await owner.mutation(api.contacts.saveAddress, {
      contactId: a,
      addressId: first?._id,
      values: addr({ type: "delivery", isDefault: true }),
    });
    const after = await t.run((ctx) =>
      ctx.db
        .query("contactAddresses")
        .withIndex("by_contact", (q) => q.eq("contactId", a))
        .collect(),
    );
    expect(after.find((r) => r._id === second)?.isDefault).toBe(true);
    expect(after.find((r) => r._id === first?._id)).toMatchObject({ type: "delivery", isDefault: true });

    // an address id of another contact is not found
    const b = await org(owner, "Beta GmbH");
    const e = await catching(
      owner.mutation(api.contacts.saveAddress, { contactId: b, addressId: second, values: addr({}) }),
    );
    expect(errorCode(e)).toBe("not_found");
    expect(messageOf(e)).toBe("Adresse nicht gefunden.");
    await owner.mutation(api.contacts.removeAddress, { addressId: second });
    expect(errorCode(await catching(owner.mutation(api.contacts.removeAddress, { addressId: second })))).toBe(
      "not_found",
    );
  });

  test("CON-024 an address used by a draft of a person of the organisation is archived instead of deleted", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const p = await person(owner, "Anna", "Alpha", { parentId: a });
    const addressId = (
      await t.run((ctx) =>
        ctx.db
          .query("contactAddresses")
          .withIndex("by_contact", (q) => q.eq("contactId", a))
          .first(),
      )
    )?._id as Id<"contactAddresses">;
    const { id: draftId } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(p) });
    await t.run((ctx) => ctx.db.patch(draftId as Id<"salesDocuments">, { billingAddressId: addressId }));
    await owner.mutation(api.contacts.removeAddress, { addressId });
    const row = await t.run((ctx) => ctx.db.get(addressId));
    expect(row).toMatchObject({ isDefault: false });
    expect(row?.archivedAt).toBeTypeOf("number");
    expect((await owner.query(api.contacts.get, { id: a }))?.addresses).toEqual([]);
  });

  test("CON-030 CON-031 CON-032 a second primary e-mail demotes the first; removing the primary promotes the next", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH", {}, { email: "eins@alpha.de" });
    const ch = (value: string, over: Record<string, unknown> = {}) => ({
      type: "email",
      value,
      label: "Buchhaltung",
      isPrimary: true,
      isInvoiceEmail: false,
      ...over,
    });
    const second = await owner.mutation(api.contacts.saveChannel, { contactId: a, values: ch("zwei@alpha.de") });
    const rows = async () =>
      t.run((ctx) =>
        ctx.db
          .query("contactChannels")
          .withIndex("by_contact", (q) => q.eq("contactId", a))
          .collect(),
      );
    expect((await rows()).filter((r) => r.isPrimary).map((r) => r.value)).toEqual(["zwei@alpha.de"]);
    // edit of the existing row keeps it primary and stores the label
    await owner.mutation(api.contacts.saveChannel, {
      contactId: a,
      channelId: second,
      values: ch("zwei@alpha.de", { label: "" }),
    });
    expect((await rows()).find((r) => r._id === second)?.label).toBeUndefined();
    const b = await org(owner, "Beta GmbH");
    const e = await catching(
      owner.mutation(api.contacts.saveChannel, { contactId: b, channelId: second, values: ch("x@beta.de") }),
    );
    expect(messageOf(e)).toBe("Eintrag nicht gefunden.");
    await owner.mutation(api.contacts.removeChannel, { channelId: second });
    expect((await rows()).map((r) => [r.value, r.isPrimary])).toEqual([["eins@alpha.de", true]]);
    // a phone number is stored with its E.164 form and searchable
    await owner.mutation(api.contacts.saveChannel, {
      contactId: a,
      values: { type: "mobile", value: "0171 1234567", label: "", isPrimary: false, isInvoiceEmail: false },
    });
    expect((await contactOf(t, a)).searchText).toContain("491711234567");
    expect(errorCode(await catching(owner.mutation(api.contacts.removeChannel, { channelId: second })))).toBe(
      "not_found",
    );
  });
});

describe("CON-120…CON-123 activities", () => {
  test("CON-122 CON-123 tasks get a due date, can be edited into notes, done and reopened; unknown ids are refused", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const task = await owner.mutation(api.contacts.addActivity, {
      contactId: a,
      values: { kind: "task", text: "Angebot nachfassen", dueOn: "2026-10-20" },
    });
    expect((await t.run((ctx) => ctx.db.get(task)))?.dueAt).toBeTypeOf("number");
    await owner.mutation(api.contacts.setTaskDone, { activityId: task, done: true });
    expect((await t.run((ctx) => ctx.db.get(task)))?.doneAt).toBeTypeOf("number");
    await owner.mutation(api.contacts.setTaskDone, { activityId: task, done: false });
    expect((await t.run((ctx) => ctx.db.get(task)))?.doneAt).toBeUndefined();
    await owner.mutation(api.contacts.updateActivity, {
      activityId: task,
      values: { kind: "note", text: "Erledigt per Telefon", dueOn: "" },
    });
    const note = await t.run((ctx) => ctx.db.get(task));
    expect(note).toMatchObject({ kind: "note", text: "Erledigt per Telefon" });
    expect(note?.dueAt).toBeUndefined();
    expect(note?.editedAt).toBeTypeOf("number");
    // a note is not a task
    const notTask = await catching(owner.mutation(api.contacts.setTaskDone, { activityId: task, done: true }));
    expect(messageOf(notTask)).toBe("Aufgabe nicht gefunden.");
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((x) => x.action));
    expect(audit).toEqual(expect.arrayContaining(["contact.task.done", "contact.task.reopen"]));
    await owner.mutation(api.contacts.removeActivity, { activityId: task });
    for (const p of [
      owner.mutation(api.contacts.removeActivity, { activityId: task }),
      owner.mutation(api.contacts.updateActivity, {
        activityId: task,
        values: { kind: "note", text: "x", dueOn: "" },
      }),
      owner.mutation(api.contacts.setTaskDone, { activityId: task, done: true }),
    ])
      expect(errorCode(await catching(p))).toBe("not_found");
  });
});

describe("CON-070…CON-081 certificates and PDF consent", () => {
  test("CON-081 CON-082 a consent with a note is recorded, revoked and shown in the history; revoking without a consent fails", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const none = await catching(
      owner.mutation(api.contacts.revokePdfConsent, { contactId: a, revokedAt: "2026-10-01" }),
    );
    expect(errorCode(none)).toBe("invalid_input");
    const future = await catching(
      owner.mutation(api.contacts.addPdfConsent, {
        contactId: a,
        values: { givenAt: "2026-12-01", source: "email", note: "" },
      }),
    );
    expect(errorCode(future)).toBe("invalid_input");
    await owner.mutation(api.contacts.addPdfConsent, {
      contactId: a,
      values: { givenAt: "2026-09-01", source: "contract", note: "  Rahmenvertrag § 4  " },
    });
    expect((await contactOf(t, a)).einvoice.pdfConsents[0]?.note).toBe("Rahmenvertrag § 4");
    await owner.mutation(api.contacts.revokePdfConsent, { contactId: a, revokedAt: "2026-10-01" });
    const d = await owner.query(api.contacts.get, { id: a });
    expect(d?.derived.find((x) => x.kind === "consent")?.text).toBe(
      "Zustimmung zu PDF-Rechnungen erfasst (gegeben am 01.09.2026), widerrufen am 01.10.2026",
    );
  });

  test("CON-070 CON-071 CON-072 certificates with a file: MIME from the name, the previous one is marked replaced, expired → warning", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Bau GmbH");
    // convex-test stores no content type, so the MIME type comes from the file name (mimeFromName)
    const store = () => t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.7"])));
    const missing = await store();
    await t.run((ctx) => ctx.storage.delete(missing));
    const gone = await catching(
      owner.mutation(api.contacts.addCertificate, { contactId: a, validUntil: "2027-12-31", storageId: missing }),
    );
    expect(messageOf(gone)).toBe("Datei nicht gefunden.");
    // without a file name the default name is used and the type is unknown → refused
    const unnamed = await catching(
      owner.mutation(api.contacts.addCertificate, {
        contactId: a,
        validUntil: "2027-12-31",
        storageId: await store(),
        fileName: "  ",
      }),
    );
    expect(messageOf(unnamed)).toBe("Bitte PDF, JPG oder PNG bis 10 MB hochladen.");
    for (const fileName of ["x.txt", "archiv"]) {
      const bad = await catching(
        owner.mutation(api.contacts.addCertificate, {
          contactId: a,
          validUntil: "2028-12-31",
          storageId: await store(),
          fileName,
        }),
      );
      expect(reasonOf(bad)).toBe("FILE_INVALID");
    }

    const r1 = await owner.mutation(api.contacts.addCertificate, {
      contactId: a,
      validUntil: "2027-12-31",
      storageId: await store(),
      fileName: "bescheinigung.pdf",
    });
    expect(r1.warnings).toEqual([]);
    const r2 = await owner.mutation(api.contacts.addCertificate, {
      contactId: a,
      validUntil: "2026-01-31",
      storageId: await store(),
      fileName: "scan.png",
    });
    expect(r2.warnings).toEqual(["Die Bescheinigung ist bereits abgelaufen."]);
    await owner.mutation(api.contacts.addCertificate, {
      contactId: a,
      validUntil: "2027-06-30",
      storageId: await store(),
      fileName: "foto.JPEG",
    });
    const certs = (await contactOf(t, a)).reverseCharge13bCertificates;
    expect(certs.map((c) => c.file?.mime)).toEqual(["application/pdf", "image/png", "image/jpeg"]);
    expect(certs[0]?.replacedAt).toBeTypeOf("number");
    expect(certs[1]?.replacedAt).toBeTypeOf("number");
    expect(certs[2]?.replacedAt).toBeUndefined();
    // a fourth certificate without a file keeps the earlier replacedAt stamps
    await owner.mutation(api.contacts.addCertificate, { contactId: a, validUntil: "2028-12-31" });
    const after = (await contactOf(t, a)).reverseCharge13bCertificates;
    expect(after[0]?.replacedAt).toBe(certs[0]?.replacedAt);
    expect(after[3]?.file).toBeUndefined();
    const d = await owner.query(api.contacts.get, { id: a });
    expect(d?.derived.filter((x) => x.kind === "certificate")).toHaveLength(4);
    expect(d?.certificate?.validUntil).toBe("2028-12-31");
  });
});

describe("CON-140…CON-143 import and export", () => {
  test("CON-141 CON-142 preview and commit match by number, VAT ID and invoice e-mail; errors, skips and the 100-row limit", async () => {
    const t = makeT();
    const owner = await setup(t);
    const byNumber = await org(owner, "Nummer GmbH", { number: "K-100" });
    const byVat = await org(owner, "Vat GmbH", { vatId: "DE811907980" });
    const byMail = await org(owner, "Mail GmbH", {}, { email: "rechnung@mail.de" });
    // the mail match has no billing address yet → an update adds it
    const mailAddress = await t.run((ctx) =>
      ctx.db
        .query("contactAddresses")
        .withIndex("by_contact", (q) => q.eq("contactId", byMail))
        .first(),
    );
    await owner.mutation(api.contacts.removeAddress, { addressId: mailAddress?._id as Id<"contactAddresses"> });

    const row = (rowNumber: number, values: unknown) => ({ rowNumber, values });
    const rows = [
      row(1, createValues(orgForm("Nummer GmbH neu", { number: "K-100" }), { address: BERLIN })),
      row(2, createValues(orgForm("Vat GmbH neu", { vatId: "DE811907980" }))),
      row(3, createValues(orgForm("Mail GmbH neu"), { address: BERLIN, email: "rechnung@mail.de" })),
      row(4, createValues(orgForm("Neu GmbH"), { address: BERLIN })),
      row(5, { contact: { kind: "organization" } }),
      row(6, createValues(orgForm("Kaputt GmbH", { tags: ["kein-tag"] }))),
    ];
    const preview = await owner.query(api.contacts.importPreview, { rows, mode: "create_and_update" });
    expect(preview.map((p) => [p.rowNumber, p.status])).toEqual([
      [1, "update"],
      [2, "update"],
      [3, "update"],
      [4, "new"],
      [5, "error"],
      [6, "new"],
    ]);
    expect(preview[1]?.matchId).toBe(byVat);
    expect(preview[4]?.message).toMatch(/^contact/);

    const out = await owner.mutation(api.contacts.importCommit, { rows, mode: "create_and_update" });
    expect(out.map((o) => [o.rowNumber, o.status])).toEqual([
      [1, "updated"],
      [2, "updated"],
      [3, "updated"],
      [4, "created"],
      [5, "error"],
      [6, "error"],
    ]);
    expect(out[5]?.message).toBe("Unbekanntes Tag.");
    expect((await contactOf(t, byNumber)).displayName).toBe("Nummer GmbH neu");
    expect((await owner.query(api.contacts.get, { id: byMail }))?.addresses).toHaveLength(1);

    const skipped = await owner.mutation(api.contacts.importCommit, { rows: rows.slice(0, 1), mode: "create_only" });
    expect(skipped[0]?.status).toBe("skipped");
    expect(skipped[0]?.message).toBeTruthy();

    const many = Array.from({ length: 101 }, (_, i) => row(i + 1, rows[3]?.values));
    const e = await catching(owner.mutation(api.contacts.importCommit, { rows: many, mode: "create_only" }));
    expect(reasonOf(e)).toBe("IMPORT_BATCH_TOO_LARGE");
    expect(messageOf(e)).toBe("Höchstens 100 Zeilen pro Aufruf.");
  });

  test("CON-143 PRV-012 the export skips restricted contacts unless requested and carries VAT status, terms and tags", async () => {
    const t = makeT();
    const owner = await setup(t);
    const vip = await owner.mutation(api.lookups.saveTag, { values: { name: "VIP", color: "blue" } });
    const a = await org(
      owner,
      "Alpha GmbH",
      { vatId: "FR40303265045", dueDays: "21", tags: [vip] },
      { email: "a@alpha.de", phone: "+49 30 1" },
    );
    await check(t, owner, a, "FR40303265045", "valid");
    const r = await org(owner, "Gesperrt GmbH");
    await restrict(t, owner, r);
    const rows = await owner.query(api.contacts.exportRows, { status: "all" });
    expect(rows).toHaveLength(2);
    const line = rows[1]?.join(";") ?? "";
    expect(line).toContain("Alpha GmbH");
    expect(line).toContain("VIP");
    expect(line).toContain("21");
    const all = await owner.query(api.contacts.exportRows, { status: "all", includeRestricted: true });
    expect(all).toHaveLength(3);
  });
});

describe("CON-132…CON-135 merge and undo", () => {
  test("CON-132 CON-134 drafts, persons, activities and prices move; undo restores them and is refused twice or after finalising", async () => {
    const t = makeT();
    const owner = await setup(t);
    const winner = await org(owner, "Alpha GmbH", {}, { email: "info@alpha.de" });
    const loser = await org(owner, "Alpha G.m.b.H.", { status: "lead" }, { email: "rechnung@alpha.de" });
    const p = await person(owner, "Paul", "Loser", { parentId: loser });
    await owner.mutation(api.contacts.addActivity, {
      contactId: loser,
      values: { kind: "note", text: "Altkunde", dueOn: "" },
    });
    await owner.mutation(api.contacts.saveAddress, {
      contactId: loser,
      values: {
        ...BERLIN,
        type: "delivery",
        isDefault: true,
        name: "",
        name2: "",
        department: "",
        street2: "",
        poBox: "",
      },
    });
    const { id: d1 } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(loser) });
    const { id: d2 } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(loser) });

    const preview = await owner.query(api.contacts.mergePreview, { winnerId: winner, loserIds: [loser] });
    expect(preview.moves).toEqual({ addresses: 2, channels: 1, activities: 1, customerPrices: 0, persons: 1 });
    const [mergeId] = await owner.mutation(api.contacts.merge, {
      values: { winnerId: winner, loserIds: [loser], fieldChoices: {}, confirmVatConflict: false },
    });
    const merge = mergeId as Id<"contactMerges">;
    expect((await contactOf(t, p)).parentId).toBe(winner);
    expect((await t.run((ctx) => ctx.db.get(d1 as Id<"salesDocuments">)))?.contactId).toBe(winner);
    const wd = await owner.query(api.contacts.get, { id: winner });
    expect(wd?.merges).toEqual([expect.objectContaining({ _id: merge, moved: 7 })]);
    expect(wd?.derived.find((x) => x.kind === "merge")?.text).toContain("Alpha G.m.b.H.");
    expect(wd?.deleteBlockedBy).toEqual(expect.arrayContaining(["Zusammenführungen", "2 Dokumente"]));

    await owner.mutation(api.contacts.undoMerge, { mergeId: merge });
    const restored = await contactOf(t, loser);
    expect(restored.status).toBe("lead");
    expect(restored.mergedIntoId).toBeUndefined();
    expect((await contactOf(t, p)).parentId).toBe(loser);
    expect((await t.run((ctx) => ctx.db.get(d2 as Id<"salesDocuments">)))?.contactId).toBe(loser);
    const ld = await owner.query(api.contacts.get, { id: loser });
    expect(
      ld?.addresses
        .filter((x) => x.isDefault)
        .map((x) => x.type)
        .sort(),
    ).toEqual(["billing", "delivery"]);
    expect(ld?.channels.every((c) => c.isPrimary)).toBe(true);
    expect(ld?.activities).toHaveLength(1);
    const twice = await catching(owner.mutation(api.contacts.undoMerge, { mergeId: merge }));
    expect(errorCode(twice)).toBe("invalid_input");

    // merge again, finalise a moved draft → undo is impossible (CON-134)
    const [m2] = await owner.mutation(api.contacts.merge, {
      values: { winnerId: winner, loserIds: [loser], fieldChoices: {}, confirmVatConflict: false },
    });
    const moved = await t.run((ctx) => ctx.db.get(d1 as Id<"salesDocuments">));
    await owner.action(api.invoices.finalize, { id: d1, version: moved?.version ?? 0 });
    const locked = await catching(owner.mutation(api.contacts.undoMerge, { mergeId: m2 as Id<"contactMerges"> }));
    expect(errorCode(locked)).toBe("invalid_input");
    const lockedEntry = await t.run((ctx) => ctx.db.get(m2 as Id<"contactMerges">));
    expect(lockedEntry?.undoneAt).toBeUndefined();
  });

  test("CON-131 dismissing a duplicate pair twice stores it once", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH", {}, { email: "info@alpha.de" });
    const b = await org(owner, "Alpha GmbH", {}, { email: "info@alpha.de" });
    expect(await owner.query(api.contacts.duplicates, {})).toHaveLength(1);
    await owner.mutation(api.contacts.dismissDuplicate, { a, b });
    await owner.mutation(api.contacts.dismissDuplicate, { a: b, b: a });
    expect(await t.run((ctx) => ctx.db.query("dismissedDuplicates").collect())).toHaveLength(1);
    expect(await owner.query(api.contacts.duplicates, {})).toHaveLength(0);
  });
});

describe("CON-101 DATEV personal accounts", () => {
  test("CON-101 the next free account is assigned once; collective debtors get none; a stored account is kept", async () => {
    const t = makeT();
    const owner = await setup(t);
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    const a = await org(owner, "Alpha GmbH");
    const kept = await org(owner, "Beta GmbH", { debtorAccount: "10500" });
    const collective = await org(owner, "Gamma GmbH", { useCollectiveDebtor: true });
    const assign = (id: Id<"contacts">, kind: "debtor" | "creditor") =>
      t.model(actor, (ctx) => ensurePersonalAccount(ctx, id, kind));
    const debtor = await assign(a, "debtor");
    expect(debtor).toMatch(/^1\d{4}$/);
    expect(await assign(a, "debtor")).toBe(debtor);
    expect(await assign(kept, "debtor")).toBe("10500");
    expect(await assign(collective, "debtor")).toBeNull();
    expect(await assign(collective, "creditor")).toMatch(/^7\d{4}$/);
    expect((await contactOf(t, collective)).useCollectiveDebtor).toBe(true);
  });

  test("CON-100 the company's collective debtor account is part of the context", async () => {
    const t = makeT();
    const owner = await setup(t);
    const actor = { actor: owner.actor, role: "owner", channel: "ui" } as const;
    await t.model(actor, (ctx) =>
      patchCompanyProfile(
        ctx,
        { datev: { accountLength: 5, personalAccounts: true, collectiveDebtorAccount: "10000" } } as never,
        { action: "settings.company.update" },
      ),
    );
    const cc = await t.model(actor, (ctx) => companyContext(ctx, Date.now()));
    expect(cc.collectiveDebtorAccount).toBe("10000");
  });
});

describe("INV-16 self-billing agreement on the supplier contact", () => {
  test("INV-16 the agreement is stored with end date, file, KU flag and normalised IBAN, refused when incomplete and removable", async () => {
    const t = makeT();
    const owner = await setup(t);
    const s = await org(owner, "Lieferant AG", { roles: ["supplier"] });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.7"])));
    const file = { storageId, sha256: "abc", bytes: 8, mime: "application/pdf", name: "vereinbarung.pdf" };
    await owner.mutation(api.contacts.setSelfBillingAgreement, {
      id: s,
      agreement: {
        agreedOn: "2026-01-15",
        scope: "  Provisionsabrechnungen ",
        validFrom: "2026-02-01",
        validTo: "2027-01-31",
        file,
        supplierKleinunternehmer: true,
        iban: "de89 3704 0044 0532 0130 00",
      },
    });
    expect((await contactOf(t, s)).selfBillingAgreement).toEqual({
      agreedOn: "2026-01-15",
      scope: "Provisionsabrechnungen",
      validFrom: "2026-02-01",
      validTo: "2027-01-31",
      file,
      supplierKleinunternehmer: true,
      iban: "DE89370400440532013000",
    });
    const bad = await catching(
      owner.mutation(api.contacts.setSelfBillingAgreement, {
        id: s,
        agreement: { agreedOn: "", scope: " ", validFrom: "2026-02-01", validTo: "2026-01-01" },
      }),
    );
    expect(messageOf(bad)).toBe(
      "Bitte das Datum der Vereinbarung angeben. Das Enddatum liegt vor dem Beginn. Bitte den Umfang der Vereinbarung beschreiben (z. B. Provisionsabrechnungen).",
    );
    await owner.mutation(api.contacts.setSelfBillingAgreement, { id: s, agreement: null });
    expect((await contactOf(t, s)).selfBillingAgreement).toBeUndefined();
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((a) => a.action));
    expect(audit).toEqual(
      expect.arrayContaining(["contact.self_billing_agreement", "contact.self_billing_agreement_removed"]),
    );
  });
});

describe("CON-170 CON-174 deletion and bulk tags", () => {
  test("CON-170 deleting an unused contact also removes its channels, activities, customer prices and dismissed pairs", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH", {}, { email: "info@alpha.de" });
    const b = await org(owner, "Alpha GmbH", {}, { email: "info@alpha.de" });
    await owner.mutation(api.contacts.dismissDuplicate, { a, b });
    await owner.mutation(api.contacts.addActivity, {
      contactId: a,
      values: { kind: "call", text: "Rückruf", dueOn: "" },
    });
    const { id: productId } = await owner.mutation(api.products.create, {
      values: productForm("Beratung", { unitCode: "HUR" }),
    });
    await owner.mutation(api.products.saveCustomerPrice, {
      productId: productId as Id<"products">,
      values: { contactId: a, priceMode: "net", price: "80", validFrom: "" },
    });
    await owner.mutation(api.contacts.remove, { id: a });
    const left = await t.run(async (ctx) => ({
      contact: await ctx.db.get(a),
      channels: (await ctx.db.query("contactChannels").collect()).filter((c) => c.contactId === a),
      activities: (await ctx.db.query("contactActivities").collect()).filter((c) => c.contactId === a),
      prices: (await ctx.db.query("customerPrices").collect()).filter((c) => c.contactId === a),
      dismissed: await ctx.db.query("dismissedDuplicates").collect(),
    }));
    expect(left).toEqual({ contact: null, channels: [], activities: [], prices: [], dismissed: [] });
    const gone = await catching(owner.query(api.contacts.mergePreview, { winnerId: b, loserIds: [a] }));
    expect(errorCode(gone)).toBe("not_found");
    expect(messageOf(gone)).toBe("Kontakt nicht gefunden.");
  });

  test("CON-174 SET-094 bulk tagging skips contacts that already have the tag; an unknown tag is refused; a deleted tag disappears", async () => {
    const t = makeT();
    const owner = await setup(t);
    const tag = await owner.mutation(api.lookups.saveTag, { values: { name: "Newsletter", color: "gray" } });
    const a = await org(owner, "Alpha GmbH", { tags: [tag] });
    const b = await org(owner, "Beta GmbH");
    expect(await owner.mutation(api.contacts.bulkTag, { ids: [a, b], tagId: tag, add: true })).toBe(1);
    expect(await owner.mutation(api.contacts.bulkTag, { ids: [a], tagId: tag, add: false })).toBe(1);
    expect(await owner.mutation(api.contacts.bulkArchive, { ids: [a, b] })).toBe(2);
    await owner.mutation(api.lookups.deleteTag, { tagId: tag });
    expect((await contactOf(t, b)).tags).toEqual([]);
    const e = await catching(owner.mutation(api.contacts.bulkTag, { ids: [a], tagId: tag, add: true }));
    expect(messageOf(e)).toBe("Tag nicht gefunden.");
  });

  test("CON-032 removing a non-primary channel keeps the primary; removing the only phone leaves none", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH", {}, { email: "eins@alpha.de", phone: "+49 30 1234" });
    const extra = await owner.mutation(api.contacts.saveChannel, {
      contactId: a,
      values: { type: "email", value: "zwei@alpha.de", label: "", isPrimary: false, isInvoiceEmail: true },
    });
    await owner.mutation(api.contacts.removeChannel, { channelId: extra });
    const rows = await t.run((ctx) =>
      ctx.db
        .query("contactChannels")
        .withIndex("by_contact", (q) => q.eq("contactId", a))
        .collect(),
    );
    expect(rows.map((r) => [r.type, r.isPrimary])).toEqual([
      ["email", true],
      ["phone", true],
    ]);
    await owner.mutation(api.contacts.removeChannel, { channelId: rows[1]?._id as Id<"contactChannels"> });
    expect((await owner.query(api.contacts.get, { id: a }))?.channels.map((c) => c.type)).toEqual(["email"]);
  });
});

describe("CON-001 CON-020 CON-030 model-level validation (REST/MCP bypass the form)", () => {
  test("CON-001 CON-020 CON-030 the model refuses an empty name, an unknown parent, an invalid billing address and an invalid channel", async () => {
    const t = makeT();
    const owner = await setup(t);
    const actor = { actor: owner.actor, role: "owner", channel: "api" } as const;
    const good = contactCreateSchema.parse(createValues(orgForm("Gut GmbH"), { address: BERLIN }));
    const run = (values: unknown) => catching(t.model(actor, (ctx) => createContact(ctx, values as typeof good)));
    expect(errorCode(await run({ ...good, contact: { ...good.contact, organizationName: "" } }))).toBe("invalid_input");
    const parentless = contactSchema.parse(personForm("Paula", "Ohne"));
    expect(reasonOf(await run({ ...good, contact: { ...parentless, parentId: "kein-kontakt" } }))).toBe(
      "PARENT_INVALID",
    );
    const badAddress = await run({ ...good, billingAddress: { ...good.billingAddress, postalCode: "1" } });
    expect(String(dataOf(badAddress).field).startsWith("billingAddress.")).toBe(true);
    const badMail = await run({
      ...good,
      channels: [{ type: "email", value: "kein-mail", label: "", isPrimary: true, isInvoiceEmail: true }],
    });
    expect(errorCode(badMail)).toBe("invalid_input");
    // two channels of one type: only one becomes primary
    const two = await t.model(actor, (ctx) =>
      createContact(ctx, {
        ...good,
        channels: [
          { type: "phone", value: "+49 30 1", label: "", isPrimary: false, isInvoiceEmail: false },
          { type: "phone", value: "+49 30 2", label: "", isPrimary: true, isInvoiceEmail: false },
        ],
      }),
    );
    const phones = await t.run((ctx) =>
      ctx.db
        .query("contactChannels")
        .withIndex("by_contact", (q) => q.eq("contactId", two.id))
        .collect(),
    );
    expect(phones.map((p) => p.isPrimary)).toEqual([true, false]);
    // the company's own VAT ID is refused with context (tax rules)
    await t.model(actor, (ctx) =>
      patchCompanyProfile(ctx, { vatId: "DE811907980" } as never, { action: "settings.company.update" }),
    );
    const own = await catching(
      t.model(actor, (ctx) => updateContact(ctx, two.id, 1, { ...good.contact, vatId: "DE811907980" })),
    );
    expect(errorCode(own)).toBe("invalid_input");
  });
});

describe("CON-150 CON-153 statistics and ranking", () => {
  test("CON-150 CON-153 a finalised invoice to a person counts for its organisation (ranking and stats)", async () => {
    const t = makeT();
    const owner = await setup(t);
    const a = await org(owner, "Alpha GmbH");
    const p = await person(owner, "Anna", "Alpha", { parentId: a });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(p) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const ranked = await owner.query(api.contacts.ranking, {
      sortBy: "revenueYear",
      dir: "desc",
      kind: "organization",
      limit: 1,
    });
    expect(ranked.map((r) => [r._id, r.revenueYearCents])).toEqual([[a, 100_000]]);
    const stats = (await owner.query(api.contacts.get, { id: a }))?.stats;
    expect(stats?.openCents).toBe(119_000);
  });

  test("CON-141 import matches by invoice e-mail when number and VAT ID do not match", async () => {
    const t = makeT();
    const owner = await setup(t);
    const m = await org(owner, "Mail GmbH", {}, { email: "rechnung@mail.de" });
    const rows = [
      {
        rowNumber: 1,
        values: createValues(orgForm("Mail GmbH", { number: "X-1", vatId: "ATU13585627" }), {
          email: "rechnung@mail.de",
        }),
      },
    ];
    const [preview] = await owner.query(api.contacts.importPreview, { rows, mode: "create_and_update" });
    expect(preview).toMatchObject({ status: "update", matchId: m });
  });
});
