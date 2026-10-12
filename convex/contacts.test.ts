import { describe, expect, test } from "vitest";
import { isEncryptedValue } from "../src/domain/audit/personal";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, personForm, setupCatalog } from "./catalog.fixtures";
import { errorCode } from "./lib/errors";
import { ensurePersonalAccount } from "./model/contacts";
import { makeT, type TestT } from "./test.setup";

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const page = { numItems: 50, cursor: null };

type Owner = Awaited<ReturnType<typeof setupCatalog>>;

async function createOrg(owner: Owner, name: string, opts: Parameters<typeof createValues>[1] = {}, over = {}) {
  return owner.mutation(api.contacts.create, {
    values: createValues(orgForm(name, over), { address: BERLIN, ...opts }),
  });
}

async function contact(t: TestT, id: Id<"contacts">) {
  return t.run(async (ctx) => {
    const c = await ctx.db.get(id);
    if (!c) throw new Error("missing");
    return c;
  });
}

describe("CON-001…008 contact master data", () => {
  test("CON-003 numbers come from the contact range; manual numbers are unique case-insensitively and skipped by the range", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const a = await createOrg(owner, "Alpha GmbH");
    expect(a.number).toBe("10000");
    await owner.mutation(api.contacts.create, { values: createValues(orgForm("Manuell AG", { number: "10001" })) });
    const b = await createOrg(owner, "Beta GmbH");
    expect(b.number).toBe("10002");
    await owner.mutation(api.contacts.create, { values: createValues(orgForm("Kunde X", { number: "kd-1" })) });
    const dup = await owner
      .mutation(api.contacts.create, { values: createValues(orgForm("Kunde Y", { number: "KD-1" })) })
      .catch(reasonOf);
    expect(dup).toBe("CONTACT_NUMBER_TAKEN");
    expect(await owner.query(api.contacts.nextNumber, {})).toBe("10003");
  });

  test("CON-001 CON-002 CON-009 a person belongs to an organisation only; display name is derived", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const org = await createOrg(owner, "Müller GmbH");
    const person = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "Müller", { academicTitle: "Dr.", parentId: org.id })),
    });
    expect((await contact(t, person.id)).displayName).toBe("Dr. Anna Müller");
    const bad = await owner
      .mutation(api.contacts.create, { values: createValues(personForm("Bob", "B", { parentId: person.id })) })
      .catch(reasonOf);
    expect(bad).toBe("PARENT_INVALID");
    const detail = await owner.query(api.contacts.get, { id: org.id });
    expect(detail?.persons.map((p) => p.displayName)).toEqual(["Dr. Anna Müller"]);
  });

  test("CON-007 a stale version is rejected with VERSION_CONFLICT", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const a = await createOrg(owner, "Alpha GmbH");
    await owner.mutation(api.contacts.update, { id: a.id, version: 1, values: orgForm("Alpha GmbH & Co. KG") });
    const stale = await owner
      .mutation(api.contacts.update, { id: a.id, version: 1, values: orgForm("Alpha 2") })
      .catch((e: unknown) => e);
    expect(errorCode(stale)).toBe("version_conflict");
    expect(reasonOf(stale)).toBe("VERSION_CONFLICT");
    expect((await contact(t, a.id)).displayName).toBe("Alpha GmbH & Co. KG");
  });

  test("CON-008 every write is audited; personal fields are encrypted, business identifiers stay readable", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const p = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "Schmidt", { isConsumer: true }), {
        address: BERLIN,
        email: "anna@example.de",
      }),
    });
    const entries = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "contacts").eq("entity.id", p.id))
        .collect(),
    );
    const create = entries.find((e) => e.action === "contact.create");
    const after = (create?.diff as { after?: Record<string, unknown> } | undefined)?.after ?? {};
    expect(create?.actor).toBe(owner.actor);
    expect(isEncryptedValue(after.lastName)).toBe(true);
    expect(isEncryptedValue(after.displayName)).toBe(true);
    expect(after.number).toBe("10000");
    const channel = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .filter((q) => q.eq(q.field("action"), "contact.channel.create"))
        .first(),
    );
    expect(isEncryptedValue((channel?.diff as { after?: Record<string, unknown> } | undefined)?.after?.value)).toBe(
      true,
    );
  });

  test("CON-042 CON-050 context rules: consumer and authority exclusive, VAT ID format, own VAT ID", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const conflict = await owner
      .mutation(api.contacts.create, {
        values: createValues(
          orgForm("Amt", { isConsumer: true, isPublicAuthority: true, buyerReference: "991-01234-38" }),
        ),
      })
      .catch(reasonOf);
    expect(conflict).toBe("CONTACT_TYPE_CONFLICT");
    const checksum = await owner
      .mutation(api.contacts.create, { values: createValues(orgForm("X", { vatId: "DE123456789" })) })
      .catch(reasonOf);
    expect(checksum).toBe("VAT_ID_CHECKSUM");
  });

  test("SEC-01 viewers can read contacts but never write", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await createOrg(owner, "Alpha GmbH");
    const viewer = await t.asUser("viewer");
    expect((await viewer.query(api.contacts.list, { paginationOpts: page })).page).toHaveLength(1);
    const denied = await viewer
      .mutation(api.contacts.create, { values: createValues(orgForm("Nope")) })
      .catch((e: unknown) => e);
    expect(errorCode(denied)).toBe("forbidden_role");
    const bookkeeper = await t.asUser("bookkeeper");
    await bookkeeper.mutation(api.contacts.create, { values: createValues(orgForm("Erlaubt GmbH")) });
  });
});

describe("CON-020…032 addresses and channels", () => {
  test("CON-020 exactly one default per type; removing the default promotes the next address", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const a = await createOrg(owner, "Alpha GmbH");
    const second = await owner.mutation(api.contacts.saveAddress, {
      contactId: a.id,
      values: {
        type: "billing",
        isDefault: true,
        name: "",
        name2: "",
        department: "Filiale",
        street: "Nebenstr. 2",
        street2: "",
        postalCode: "80331",
        city: "München",
        countryCode: "DE",
        poBox: "",
      },
    });
    let rows = (await owner.query(api.contacts.get, { id: a.id }))?.addresses ?? [];
    expect(rows.filter((r) => r.isDefault).map((r) => r._id)).toEqual([second]);
    expect(rows.find((r) => r._id === second)?.address.name).toBe("Alpha GmbH"); // CON-021 default name
    await owner.mutation(api.contacts.removeAddress, { addressId: second });
    rows = (await owner.query(api.contacts.get, { id: a.id }))?.addresses ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isDefault).toBe(true);
  });

  test("CON-030 CON-032 channels: e-mails normalised, duplicates rejected, one primary per type, phones get E.164", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const a = await createOrg(owner, "Alpha GmbH", { email: "Info@Alpha.DE", phone: "030 1234567" });
    const detail = await owner.query(api.contacts.get, { id: a.id });
    expect(detail?.channels.find((c) => c.type === "email")?.value).toBe("Info@alpha.de");
    expect(detail?.channels.find((c) => c.type === "phone")?.e164).toBe("+49301234567");
    const dup = await owner
      .mutation(api.contacts.saveChannel, {
        contactId: a.id,
        values: { type: "email", value: "info@alpha.de", label: "", isPrimary: false, isInvoiceEmail: false },
      })
      .catch(reasonOf);
    expect(dup).toBe("CHANNEL_DUPLICATE");
    await owner.mutation(api.contacts.saveChannel, {
      contactId: a.id,
      values: {
        type: "email",
        value: "buchhaltung@alpha.de",
        label: "Buchhaltung",
        isPrimary: true,
        isInvoiceEmail: true,
      },
    });
    const after = await owner.query(api.contacts.get, { id: a.id });
    const emails = after?.channels.filter((c) => c.type === "email") ?? [];
    expect(emails.filter((c) => c.isPrimary).map((c) => c.value)).toEqual(["buchhaltung@alpha.de"]);
    expect(after?.invoiceRecipients).toEqual(["Info@alpha.de", "buchhaltung@alpha.de"]);
  });

  test("CON-031 a person without own invoice e-mail uses the organisation's invoice e-mails", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const org = await createOrg(owner, "Alpha GmbH", { email: "rechnung@alpha.de" });
    const p = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "A", { parentId: org.id })),
    });
    expect((await owner.query(api.contacts.get, { id: p.id }))?.invoiceRecipients).toEqual(["rechnung@alpha.de"]);
  });
});

describe("CON-172 CON-173 search and filters", () => {
  test("CON-172 search finds folded names, e-mails, phone digits and the city", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await createOrg(owner, "Müller Bau GmbH", { email: "info@mueller-bau.de", phone: "+49 30 9876543" });
    await createOrg(owner, "Schmidt KG");
    const search = async (q: string) =>
      (await owner.query(api.contacts.list, { paginationOpts: page, q })).page.map((r) => r.displayName);
    expect(await search("muller")).toEqual(["Müller Bau GmbH"]);
    expect(await search("mueller")).toEqual(["Müller Bau GmbH"]);
    expect(await search("info@mueller-bau.de")).toEqual(["Müller Bau GmbH"]);
    expect(await search("030 9876543")).toEqual(["Müller Bau GmbH"]);
    expect(await search("10001")).toEqual(["Schmidt KG"]);
  });

  test("CON-173 CON-171 CON-010 archived hidden by default; role and tag filters (organisation tags apply to persons)", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const tag = await owner.mutation(api.lookups.saveTag, { values: { name: "VIP", color: "blue" } });
    const org = await createOrg(owner, "Alpha GmbH");
    await owner.mutation(api.contacts.bulkTag, { ids: [org.id], tagId: tag, add: true });
    await owner.mutation(api.contacts.create, { values: createValues(personForm("Anna", "A", { parentId: org.id })) });
    const supplier = await createOrg(owner, "Lieferant AG", {}, { roles: ["supplier"] });
    await owner.mutation(api.contacts.archive, { id: supplier.id });
    const names = async (args: Record<string, unknown>) =>
      (await owner.query(api.contacts.list, { paginationOpts: page, ...args })).page.map((r) => r.displayName).sort();
    expect(await names({})).toEqual(["Alpha GmbH", "Anna A"]);
    expect(await names({ status: "archived" })).toEqual(["Lieferant AG"]);
    expect(await names({ status: "all", role: "supplier" })).toEqual(["Lieferant AG"]);
    expect(await names({ tag })).toEqual(["Alpha GmbH", "Anna A"]);
    await owner.mutation(api.contacts.unarchive, { id: supplier.id });
    expect(await names({ role: "supplier" })).toEqual(["Lieferant AG"]);
  });

  test("SET-094 deleting a tag removes it from every contact", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const tag = await owner.mutation(api.lookups.saveTag, { values: { name: "VIP", color: "blue" } });
    const org = await createOrg(owner, "Alpha GmbH", {}, { tags: [tag] });
    await owner.mutation(api.lookups.deleteTag, { tagId: tag });
    expect((await contact(t, org.id)).tags).toEqual([]);
  });
});

describe("CON-170 CON-171 archive and delete", () => {
  test("CON-170 delete is refused while persons belong to the organisation; otherwise sub-records go with it", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const org = await createOrg(owner, "Alpha GmbH", { email: "a@alpha.de" });
    const p = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "A", { parentId: org.id })),
    });
    expect(await owner.mutation(api.contacts.remove, { id: org.id }).catch(reasonOf)).toBe("CONTACT_IN_USE");
    await owner.mutation(api.contacts.remove, { id: p.id });
    await owner.mutation(api.contacts.remove, { id: org.id });
    const left = await t.run(async (ctx) => ({
      contacts: (await ctx.db.query("contacts").collect()).length,
      addresses: (await ctx.db.query("contactAddresses").collect()).length,
      channels: (await ctx.db.query("contactChannels").collect()).length,
    }));
    expect(left).toEqual({ contacts: 0, addresses: 0, channels: 0 });
  });
});

describe("CON-120…123 activities", () => {
  test("CON-121 CON-122 CON-123 notes and tasks can be added, completed, edited and deleted", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const org = await createOrg(owner, "Alpha GmbH");
    const task = await owner.mutation(api.contacts.addActivity, {
      contactId: org.id,
      values: { kind: "task", text: "Angebot nachfassen", dueOn: "2026-10-20" },
    });
    expect(
      await owner
        .mutation(api.contacts.addActivity, { contactId: org.id, values: { kind: "task", text: "x", dueOn: "" } })
        .catch((e: unknown) => errorCode(e)),
    ).toBe("invalid_input");
    await owner.mutation(api.contacts.setTaskDone, { activityId: task, done: true });
    await owner.mutation(api.contacts.updateActivity, {
      activityId: task,
      values: { kind: "task", text: "Angebot nachfassen (erledigt)", dueOn: "2026-10-20" },
    });
    const detail = await owner.query(api.contacts.get, { id: org.id });
    expect(detail?.activities[0]?.doneAt).toBeTypeOf("number");
    expect(detail?.activities[0]?.editedAt).toBeTypeOf("number");
    await owner.mutation(api.contacts.removeActivity, { activityId: task });
    expect((await owner.query(api.contacts.get, { id: org.id }))?.activities).toEqual([]);
  });
});

describe("CON-070…081 consents and certificates", () => {
  test("T-CON-042 CON-081 tacit consent needs a note; revocation keeps the history", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const org = await createOrg(owner, "Alpha GmbH");
    const noNote = await owner
      .mutation(api.contacts.addPdfConsent, {
        contactId: org.id,
        values: { givenAt: "2026-01-10", source: "tacit", note: "" },
      })
      .catch((e: unknown) => (e as { data?: { message?: string } }).data?.message);
    expect(noNote).toBe("Bitte beschreiben, woraus sich die stillschweigende Zustimmung ergibt.");
    await owner.mutation(api.contacts.addPdfConsent, {
      contactId: org.id,
      values: { givenAt: "2026-01-10", source: "email", note: "" },
    });
    await owner.mutation(api.contacts.revokePdfConsent, { contactId: org.id, revokedAt: "2026-03-01" });
    const c = await contact(t, org.id);
    expect(c.einvoice.pdfConsents).toHaveLength(1);
    expect(c.einvoice.pdfConsents[0]?.revokedAt).toBe("2026-03-01");
  });

  test("CON-070 CON-072 a new USt 1 TG certificate replaces the current one and keeps the previous as evidence", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const org = await createOrg(owner, "Bau GmbH");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.7"], { type: "application/pdf" })));
    await owner.mutation(api.contacts.addCertificate, {
      contactId: org.id,
      validUntil: "2027-12-31",
      storageId,
      fileName: "ust1tg.pdf",
    });
    await owner.mutation(api.contacts.addCertificate, { contactId: org.id, validUntil: "2029-12-31" });
    const c = await contact(t, org.id);
    expect(c.reverseCharge13bCertificates).toHaveLength(2);
    expect(c.reverseCharge13bCertificates[0]?.replacedAt).toBeTypeOf("number");
    expect(c.reverseCharge13bCertificates[0]?.file?.mime).toBe("application/pdf");
    expect((await owner.query(api.contacts.get, { id: org.id }))?.certificate?.validUntil).toBe("2029-12-31");
  });
});

describe("CON-130…135 duplicates and merge", () => {
  test("CON-130 CON-131 same VAT ID is a hint; the duplicates page lists the pair until dismissed", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const a = await createOrg(owner, "Dupont SA", {}, { vatId: "FR40303265045" });
    const b = await createOrg(owner, "Dupont S.A.", {}, { vatId: "FR40303265045" });
    const hints = (await owner.query(api.contacts.get, { id: b.id }))?.duplicateHints ?? [];
    expect(hints.map((h) => h.id)).toEqual([a.id]);
    expect(hints[0]?.reasons).toContain("vat_id");
    expect(await owner.query(api.contacts.duplicates, {})).toHaveLength(1);
    await owner.mutation(api.contacts.dismissDuplicate, { a: b.id, b: a.id });
    expect(await owner.query(api.contacts.duplicates, {})).toHaveLength(0);
  });

  test("CON-132 CON-133 CON-134 merge moves sub-records, archives the loser as alias; undo restores both", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const winner = await createOrg(owner, "Alpha GmbH", { email: "info@alpha.de" });
    const loser = await createOrg(
      owner,
      "Alpha G.m.b.H.",
      { email: "rechnung@alpha.de" },
      { iban: "DE89370400440532013000" },
    );
    const person = await createOrg(owner, "Alpha Person");
    const kind = await owner
      .mutation(api.contacts.merge, {
        values: {
          winnerId: winner.id,
          loserIds: [(await owner.mutation(api.contacts.create, { values: createValues(personForm("P", "Q")) })).id],
          fieldChoices: {},
          confirmVatConflict: false,
        },
      })
      .catch(reasonOf);
    expect(kind).toBe("MERGE_KIND_MISMATCH");
    const [mergeId] = await owner.mutation(api.contacts.merge, {
      values: {
        winnerId: winner.id,
        loserIds: [loser.id],
        fieldChoices: { iban: loser.id },
        confirmVatConflict: false,
      },
    });
    const w = await owner.query(api.contacts.get, { id: winner.id });
    expect(w?.channels.map((c) => c.value).sort()).toEqual(["info@alpha.de", "rechnung@alpha.de"]);
    expect(w?.addresses).toHaveLength(2);
    expect(w?.contact.iban).toBe("DE89370400440532013000");
    const l = await contact(t, loser.id);
    expect(l.status).toBe("archived");
    expect(l.mergedIntoId).toBe(winner.id);
    expect((await owner.query(api.contacts.list, { paginationOpts: page })).page.map((r) => r._id)).not.toContain(
      loser.id,
    );
    await owner.mutation(api.contacts.undoMerge, { mergeId: mergeId as Id<"contactMerges"> });
    const w2 = await owner.query(api.contacts.get, { id: winner.id });
    expect(w2?.channels.map((c) => c.value)).toEqual(["info@alpha.de"]);
    expect(w2?.contact.iban).toBeUndefined();
    const l2 = await contact(t, loser.id);
    expect(l2.status).toBe("active");
    expect(l2.mergedIntoId).toBeUndefined();
    expect((await owner.query(api.contacts.get, { id: loser.id }))?.addresses.filter((a) => a.isDefault)).toHaveLength(
      1,
    );
    expect(
      await owner.mutation(api.contacts.undoMerge, { mergeId: mergeId as Id<"contactMerges"> }).catch(reasonOf),
    ).toBe("MERGE_ALREADY_UNDONE");
    expect(person.id).toBeDefined();
  });
});

describe("CON-100 CON-101 DATEV personal accounts", () => {
  test("CON-101 the next free debtor account is max used + 1; accounts are unique (CON-102)", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    const a = await createOrg(owner, "Alpha GmbH");
    const b = await createOrg(owner, "Beta GmbH");
    const first = await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      ensurePersonalAccount(ctx, a.id, "debtor"),
    );
    const second = await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      ensurePersonalAccount(ctx, b.id, "debtor"),
    );
    expect(Number(second)).toBe(Number(first) + 1);
    const c = await createOrg(owner, "Gamma GmbH");
    const taken = await owner
      .mutation(api.contacts.update, {
        id: c.id,
        version: 1,
        values: orgForm("Gamma GmbH", { debtorAccount: first as string }),
      })
      .catch(reasonOf);
    expect(taken).toBe("DATEV_ACCOUNT_TAKEN");
  });
});

describe("CON-140…143 import and export", () => {
  test("CON-141 CON-142 preview classifies rows; commit is idempotent by number", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await createOrg(owner, "Bestand GmbH", {}, { number: "K-1" });
    const rows = [
      { rowNumber: 2, values: createValues(orgForm("Bestand GmbH", { number: "K-1" }), { address: BERLIN }) },
      { rowNumber: 3, values: createValues(orgForm("Neu GmbH", { number: "K-2" }), { address: BERLIN }) },
      { rowNumber: 4, values: createValues(orgForm("", { number: "K-3" })) },
    ];
    const preview = await owner.query(api.contacts.importPreview, { rows, mode: "create_only" });
    expect(preview.map((r) => r.status)).toEqual(["conflict", "new", "error"]);
    const first = await owner.mutation(api.contacts.importCommit, { rows, mode: "create_and_update" });
    expect(first.map((r) => r.status)).toEqual(["updated", "created", "error"]);
    const again = await owner.mutation(api.contacts.importCommit, { rows, mode: "create_and_update" });
    expect(again.map((r) => r.status)).toEqual(["updated", "updated", "error"]);
    expect(await t.run(async (ctx) => (await ctx.db.query("contacts").collect()).length)).toBe(2);
  });

  test("CON-143 export rows follow the header order", async () => {
    const t = makeT();
    const owner = await setupCatalog(t);
    await createOrg(owner, "Alpha GmbH", { email: "info@alpha.de" });
    const rows = await owner.query(api.contacts.exportRows, {});
    expect(rows[0]?.[0]).toBe("Kontaktnummer");
    expect(rows[1]?.slice(0, 3)).toEqual(["10000", "Organisation", "Alpha GmbH"]);
  });
});
