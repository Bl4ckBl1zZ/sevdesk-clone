import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { createValues, orgForm } from "./catalog.fixtures";
import { finalizedInvoice, invoiceValues, settle } from "./invoices.fixtures";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * 10-edge-cases §3.10 master-data changes (EC-110…EC-114): issued documents keep their frozen snapshot, only future
 * documents use the new data; contacts with documents are archived, never deleted; merges never re-point finalised
 * records.
 */

const NOW = new Date("2026-10-12T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;
const snapshotOf = async (owner: Awaited<ReturnType<typeof finalizedInvoice>>["owner"], id: Id<"salesDocuments">) =>
  (await owner.query(api.invoices.get, { id }))?.snapshot as DocumentSnapshot;
const artifactHashes = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect()
    ).map((a) => a.sha256),
  );

describe("EC-110 company data changes", () => {
  test("EC-110 name, address, legal form data and managing directors change: issued snapshot and files stay, drafts pick up the new data", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const before = await snapshotOf(owner, id);
    const hashes = await artifactHashes(t, id);
    const draft = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });

    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        {
          name: "Muster Studio GmbH",
          address: {
            name: "Muster Studio GmbH",
            street: "Neue Allee 9",
            postalCode: "10117",
            city: "Berlin",
            countryCode: "DE",
          },
          representatives: [{ name: "Erika Musterfrau" }],
        },
        { action: "settings.company.update" },
      ),
    );
    // SET-020: the change is reported as affecting the open draft.
    expect((await owner.query(api.settings.companyChangeImpact, {})).drafts).toBe(1);

    expect(await snapshotOf(owner, id)).toEqual(before);
    expect(before.seller.name).toBe("Muster Design GmbH");
    expect(await artifactHashes(t, id)).toEqual(hashes);

    // The draft re-renders with the current data at finalisation.
    await owner.action(api.invoices.finalize, { id: draft.id, version: 1 });
    await settle(t);
    const fresh = await snapshotOf(owner, draft.id);
    expect(fresh.seller.name).toBe("Muster Studio GmbH");
    expect(fresh.seller.address).toMatchObject({ street: "Neue Allee 9", postalCode: "10117" });
    expect(JSON.stringify(fresh.seller)).not.toContain("Max Mustermann");
    expect(JSON.stringify(before.seller)).toContain("Max Mustermann");
  });
});

describe("EC-111 contact address changes after invoices were issued", () => {
  test("EC-111 issued documents keep the buyer address of their snapshot", async () => {
    const t = makeT();
    const { owner, id, orgId } = await finalizedInvoice(t);
    const before = await snapshotOf(owner, id);
    expect(before.buyer.address).toMatchObject({ street: "Musterweg 5", city: "Köln" });
    const c = await owner.query(api.contacts.get, { id: orgId });
    const billing = c?.addresses.find((a) => a.type === "billing" && a.isDefault);
    if (!billing) throw new Error("no billing address");
    await owner.mutation(api.contacts.saveAddress, {
      contactId: orgId,
      addressId: billing._id,
      values: {
        type: "billing",
        isDefault: true,
        name: "",
        name2: "",
        department: "",
        street: "Domplatz 1",
        street2: "",
        postalCode: "50667",
        city: "Köln",
        countryCode: "DE",
        poBox: "",
      },
    });
    expect((await owner.query(api.contacts.get, { id: orgId }))?.addresses.map((a) => a.address.street)).toContain(
      "Domplatz 1",
    );
    const after = await snapshotOf(owner, id);
    expect(after).toEqual(before);
    expect(after.buyer.address.street).toBe("Musterweg 5");
  });
});

describe("EC-112 deleting a contact with documents", () => {
  test("EC-112 a contact with a finalised document (or a draft) cannot be deleted, only archived; without documents it can be deleted", async () => {
    const t = makeT();
    const { owner, orgId, personId } = await finalizedInvoice(t);
    // The invoice goes to the person under the organisation: both are referenced.
    expect(await owner.mutation(api.contacts.remove, { id: personId }).catch(reasonOf)).toBe("CONTACT_IN_USE");
    expect(await owner.mutation(api.contacts.remove, { id: orgId }).catch(reasonOf)).toBe("CONTACT_IN_USE");
    await owner.mutation(api.contacts.archive, { id: personId });
    expect((await t.run((ctx) => ctx.db.get(personId)))?.status).toBe("archived");

    const other = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Nur Entwurf GmbH"), {
        address: { street: "Weg 1", postalCode: "10115", city: "Berlin", countryCode: "DE" },
        email: "a@nur-entwurf.de",
      }),
    });
    const draft = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(other.id as string) });
    expect(await owner.mutation(api.contacts.remove, { id: other.id }).catch(reasonOf)).toBe("CONTACT_IN_USE");
    await owner.mutation(api.invoices.deleteDraft, { id: draft.id });
    await owner.mutation(api.contacts.remove, { id: other.id });
    expect(await t.run((ctx) => ctx.db.get(other.id as Id<"contacts">))).toBeNull();
  });
});

describe("EC-113 merging duplicate contacts with documents", () => {
  test("EC-113 finalised documents keep the loser's id, drafts move to the winner, stats resolve the alias, undo is impossible once a moved draft is finalised", async () => {
    const t = makeT();
    const { owner, id: issued, orgId: loserOrg, personId: loserPerson } = await finalizedInvoice(t);
    const winner = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Beispiel Kunde G.m.b.H."), {
        address: { street: "Musterweg 5", postalCode: "50667", city: "Köln", countryCode: "DE" },
        email: "info@beispiel-kunde.de",
      }),
    });
    const winnerId = winner.id as Id<"contacts">;
    // A draft for the loser organisation itself.
    const draft = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(loserOrg) });
    const [mergeId] = await owner.mutation(api.contacts.merge, {
      values: { winnerId, loserIds: [loserOrg], fieldChoices: {}, confirmVatConflict: true },
    });

    const issuedDoc = await t.run((ctx) => ctx.db.get(issued));
    expect(issuedDoc?.contactId).toBe(loserPerson); // never re-pointed
    expect((await t.run((ctx) => ctx.db.get(draft.id)))?.contactId).toBe(winnerId);
    const loser = await t.run((ctx) => ctx.db.get(loserOrg));
    expect(loser).toMatchObject({ status: "archived", mergedIntoId: winnerId });
    const merge = await t.run((ctx) => ctx.db.get(mergeId as Id<"contactMerges">));
    expect(merge?.moved).toEqual(expect.arrayContaining([{ table: "salesDocuments", id: draft.id }]));
    // The person (and with it the issued invoice) now belongs to the winner; the stats resolve it.
    const w = await owner.query(api.contacts.get, { id: winnerId });
    expect(w?.stats.invoiceCount).toBe(1);
    expect(w?.stats.revenueAllTimeCents).toBe(100_000);
    // Audited.
    const audit = await t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).map((e) => e.action));
    expect(audit).toContain("contact.merge");

    await owner.action(api.invoices.finalize, { id: draft.id, version: 2 });
    await settle(t);
    expect(
      await owner.mutation(api.contacts.undoMerge, { mergeId: mergeId as Id<"contactMerges"> }).catch(reasonOf),
    ).toBe("MERGE_UNDO_IMPOSSIBLE");
  });
});

describe("EC-114 changing the bank account (IBAN)", () => {
  test("EC-114 only future documents use the new IBAN; finalised open invoices keep the old IBAN in their snapshot and XML", async () => {
    const t = makeT();
    const { owner, id, personId, bankAccount } = await finalizedInvoice(t);
    const before = await snapshotOf(owner, id);
    expect(before.payment.bankAccount?.iban).toBe("DE89370400440532013000");
    const hashes = await artifactHashes(t, id);

    const second = (await owner.mutation(api.settings.addBankAccount, {
      values: {
        name: "Neues Konto",
        iban: "DE02 1203 0000 0000 2020 51",
        bic: "",
        accountHolder: "Muster Design GmbH",
        currency: "EUR",
      },
    })) as Id<"bankAccounts">;
    await owner.mutation(api.settings.setDefaultBankAccount, { bankAccountId: second });
    await owner.mutation(api.settings.archiveBankAccount, { bankAccountId: bankAccount });

    expect(await snapshotOf(owner, id)).toEqual(before);
    expect(await artifactHashes(t, id)).toEqual(hashes);
    const { id: next } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect((await t.run((ctx) => ctx.db.get(next)))?.bankAccountId).toBe(second);
    await owner.action(api.invoices.finalize, { id: next, version: 1 });
    await settle(t);
    expect((await snapshotOf(owner, next)).payment.bankAccount?.iban).toBe("DE02120300000000202051");
  });
});
