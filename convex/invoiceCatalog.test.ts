import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import { emptyAddress } from "../src/domain/schemas/contacts";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { BERLIN, createValues, orgForm, productForm } from "./catalog.fixtures";
import { b2bBuyer, consumerBuyer, finalizedInvoice, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { seedCategories } from "./model/products";
import { makeT, type TestT } from "./test.setup";

/** Contacts and products wired to sales documents (F02/F03 items deferred to the invoice slice). */

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

/** Every finalised document row, snapshot and artifact (T-CON-061). */
const frozenState = (t: TestT) =>
  t.run(async (ctx) => ({
    docs: (await ctx.db.query("salesDocuments").collect()).filter((d) => d.status !== "draft"),
    snapshots: await ctx.db.query("documentSnapshots").collect(),
    artifacts: await ctx.db.query("documentArtifacts").collect(),
  }));

describe("F02 contacts × invoices", () => {
  test("CON-024 T-CON-002 deleting an address used by a document archives it; drafts fall back with a warning", async () => {
    const t = makeT();
    const { owner, id: finalId, orgId, personId } = await finalizedInvoice(t);
    const used = (await t.run((ctx) => ctx.db.get(finalId)))?.billingAddressId as Id<"contactAddresses">;
    const second = await owner.mutation(api.contacts.saveAddress, {
      contactId: orgId,
      values: {
        ...emptyAddress(),
        type: "billing",
        isDefault: true,
        street: "Ringstraße 9",
        postalCode: "50667",
        city: "Köln",
      },
    });
    const { id: draftId } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.mutation(api.invoices.updateDraft, {
      id: draftId,
      version: 1,
      values: invoiceValues(personId),
      billingAddressId: used,
    });
    await owner.mutation(api.contacts.removeAddress, { addressId: used });
    const row = await t.run((ctx) => ctx.db.get(used));
    expect(row?.archivedAt).toBe(NOW.getTime());
    const draft = await owner.query(api.invoices.check, { id: draftId, values: invoiceValues(personId) });
    expect(draft?.buyer?.address?.street).toBe("Ringstraße 9");
    const detail = await owner.query(api.invoices.get, { id: draftId });
    expect(detail?.findings.map((f) => f.code)).toContain("address_removed");
    // An unreferenced address is really deleted.
    await owner.mutation(api.contacts.removeAddress, { addressId: second as Id<"contactAddresses"> });
    expect(await t.run((ctx) => ctx.db.get(second as Id<"contactAddresses">))).toBeNull();
  });

  test("CON-181 T-CON-061 contact update, archive and VAT-ID change leave finalised documents untouched", async () => {
    const t = makeT();
    const { owner, orgId } = await finalizedInvoice(t);
    const before = await frozenState(t);
    const c = await owner.query(api.contacts.get, { id: orgId });
    await owner.mutation(api.contacts.update, {
      id: orgId,
      version: c?.contact.version ?? 1,
      values: orgForm("Umbenannt GmbH", { number: "K-10023", vatId: "DE136695976" }),
    });
    await owner.mutation(api.contacts.archive, { id: orgId });
    expect(await frozenState(t)).toEqual(before);
  });

  test("CON-132 CON-134 T-CON-051 drafts move with a merge, finalised documents stay; undo is impossible once a moved draft is finalised", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    const loser = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Beispiel Kunde (Dublette)", { vatId: "DE811907980" }), { address: { ...BERLIN } }),
    });
    const winner = (await t.run((ctx) => ctx.db.get(personId)))?.parentId as Id<"contacts">;
    const { id: draftId } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(loser.id) });
    const before = await frozenState(t);
    const [mergeId] = await owner.mutation(api.contacts.merge, {
      values: { winnerId: winner, loserIds: [loser.id], fieldChoices: {}, confirmVatConflict: true },
    });
    expect((await t.run((ctx) => ctx.db.get(draftId)))?.contactId).toBe(winner);
    expect(await frozenState(t)).toEqual(before);
    await owner.mutation(api.invoices.updateDraft, { id: draftId, version: 2, values: invoiceValues(winner) });
    await owner.action(api.invoices.finalize, { id: draftId, version: 3 });
    await settle(t);
    const undo = await owner
      .mutation(api.contacts.undoMerge, { mergeId: mergeId as Id<"contactMerges"> })
      .catch(reasonOf);
    expect(undo).toBe("MERGE_UNDO_IMPOSSIBLE");
  });

  test("CON-150 statistics over finalised invoices of the contact and its persons", async () => {
    const t = makeT();
    const { owner, orgId } = await finalizedInvoice(t);
    const c = await owner.query(api.contacts.get, { id: orgId });
    expect(c?.stats).toMatchObject({
      revenueThisYearCents: 100_000,
      revenueAllTimeCents: 100_000,
      invoiceCount: 1,
      lastInvoiceDate: "2026-10-12",
      openCents: 119_000,
      overdueCents: 0,
    });
  });

  test("CON-170 a contact with documents cannot be deleted", async () => {
    const t = makeT();
    const { owner, personId } = await finalizedInvoice(t);
    const c = await owner.query(api.contacts.get, { id: personId });
    expect(c?.deleteBlockedBy).toContain("1 Dokument");
    const e = await owner.mutation(api.contacts.remove, { id: personId }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
  });

  test("CON-111 printable custom fields are frozen into the snapshot", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.lookups.createCustomField, {
      values: {
        entity: "contact",
        key: "kostenstelle",
        label: "Kostenstelle",
        type: "text",
        printOnDocuments: true,
        required: false,
      },
    });
    const r = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Kunde mit Feld GmbH", { customFields: { kostenstelle: "KST-4711" } }), {
        address: { ...BERLIN },
        email: "re@kunde.de",
      }),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(r.id) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const s = (await owner.query(api.invoices.get, { id }))?.snapshot as DocumentSnapshot;
    expect(s.customFields).toEqual([{ label: "Kostenstelle", value: "KST-4711" }]);
  });

  test("CON-033 without an invoice e-mail the invoice can still be finalised, exported and marked as sent by post", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const r = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Ohne Mail GmbH", { vatId: "DE811907980" }), { address: { ...BERLIN } }),
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(r.id) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.buyer?.invoiceEmail).toBeUndefined();
    const exp = await owner.action(api.documentArtifacts.exportFiles, { id, request: { entry: "default" } });
    await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "post", artifactIds: exp.files.map((f) => f.artifactId) },
    });
    expect((await owner.query(api.invoices.get, { id }))?.doc.status).toBe("sent");
  });
});

describe("F03 products × invoices", () => {
  async function withProduct(t: TestT, over: Parameters<typeof productForm>[1] = {}) {
    const setup = await setupInvoicing(t);
    await t.model({ actor: setup.owner.actor, role: "owner", channel: "ui" }, (ctx) => seedCategories(ctx));
    const p = await setup.owner.mutation(api.products.create, {
      values: productForm("Webdesign Stunde", { price: "100,00", purchasePrice: "40,00", ...over }),
    });
    const { personId } = await b2bBuyer(setup.owner);
    const line = {
      kind: "item" as const,
      productId: p.id,
      productType: "service" as const,
      productSyncedVersion: 1,
      name: "Webdesign Stunde",
      quantityMilli: 2_000,
      unitCode: "HUR",
      unitPriceMicros: 1_000_000,
      vatRateKey: "standard",
    };
    return { ...setup, productId: p.id as Id<"products">, personId, line };
  }

  test("DOC-05 DOC-06 picking a product copies its data; the customer price of the parent organisation wins", async () => {
    const t = makeT();
    const { owner, productId, personId } = await withProduct(t, { description: "Gestaltung je Stunde" });
    const base = await owner.query(api.invoices.productLine, {
      productId,
      contactId: personId,
      referenceDate: "2026-10-12",
      priceMode: "gross",
      currency: "EUR",
    });
    expect(base.line).toMatchObject({
      productId,
      name: "Webdesign Stunde",
      description: "Gestaltung je Stunde",
      unitCode: "HUR",
      unitPriceMicros: 1_190_000,
      vatRateKey: "standard",
      itemNumber: "ART-00001",
    });
    expect(base.source).toBe("base");
    const orgId = (await t.run((ctx) => ctx.db.get(personId)))?.parentId as Id<"contacts">;
    await owner.mutation(api.products.saveCustomerPrice, {
      productId,
      values: { contactId: orgId, price: "80,00", priceMode: "net", validFrom: "" },
    });
    const customer = await owner.query(api.invoices.productLine, {
      productId,
      contactId: personId,
      referenceDate: "2026-10-12",
      priceMode: "net",
      currency: "EUR",
    });
    expect(customer).toMatchObject({ source: "parent_customer", line: { unitPriceMicros: 800_000 } });
  });

  test("DOC-03 the detail of a draft returns its editable values", async () => {
    const t = makeT();
    const { owner, personId, line } = await withProduct(t);
    const values = invoiceValues(personId, { lines: [line], subject: "Projekt Relaunch" });
    const { id } = await owner.mutation(api.invoices.createDraft, { values });
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.values).toMatchObject({ subject: "Projekt Relaunch", contactId: personId, lines: [line] });
  });

  test("PRD-073 PRD-062 a product used on a document cannot be deleted, only archived", async () => {
    const t = makeT();
    const { owner, productId, personId, line } = await withProduct(t);
    await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId, { lines: [line] }) });
    expect(await owner.mutation(api.products.remove, { id: productId }).catch(reasonOf)).toBe("PRODUCT_IN_USE");
    await owner.mutation(api.products.archive, { id: productId });
  });

  test("PRD-037 T-PRD-037 the purchase price never reaches the snapshot or the XML", async () => {
    const t = makeT();
    const { owner, personId, line } = await withProduct(t, { purchasePrice: "37,77" });
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { lines: [line] }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const snap = await t.run(async (ctx) => {
      const d = await ctx.db.get(id);
      return d?.snapshotId ? ctx.db.get(d.snapshotId) : null;
    });
    expect(snap?.json).not.toMatch(/purchase|377700|37,77|margin/i);
  });

  test("PRD-071 T-PRD-002 EC-041 draft lines keep their copy but take a changed VAT key with a notice", async () => {
    const t = makeT();
    const { owner, productId, personId, line } = await withProduct(t);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { lines: [line] }),
    });
    const p = await owner.query(api.products.get, { id: productId });
    await owner.mutation(api.products.update, {
      id: productId,
      version: p?.product.version ?? 1,
      values: productForm("Webdesign Stunde (neu)", { price: "120,00", vatRateKey: "reduced" }),
    });
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.productChanged).toHaveLength(1); // „Produkt geändert“ → „Übernehmen“
    expect(detail?.lines[0]?.name).toBe("Webdesign Stunde");
    const r = await owner.mutation(api.invoices.updateDraft, {
      id,
      version: 1,
      values: invoiceValues(personId, { lines: [line] }),
    });
    expect(r.notices).toEqual(["Steuersatz geändert: Standard → Ermäßigt (Webdesign Stunde)"]);
    const after = await owner.query(api.invoices.get, { id });
    expect(after?.lines[0]).toMatchObject({ vatRateKey: "reduced", unitPriceMicros: 1_000_000, vatRateBp: 700 });
  });

  test("PRD-042 MISC-07 B2C invoices show the labour subtotal from isLaborCost lines", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const contactId = await consumerBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(contactId, {
        lines: [
          { ...invoiceValues(contactId).lines[0], name: "Montage", isLaborCost: true } as ReturnType<
            typeof invoiceValues
          >["lines"][0],
          {
            kind: "item",
            productType: "good",
            name: "Material",
            quantityMilli: 1_000,
            unitCode: "C62",
            unitPriceMicros: 500_000,
            vatRateKey: "standard",
          },
        ],
      }),
    });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const s = (await owner.query(api.invoices.get, { id }))?.snapshot as DocumentSnapshot;
    expect(s.totals.labor).toEqual({ netCents: 100_000, vatCents: 19_000, grossCents: 119_000 });
  });
});

describe("F01 settings × drafts", () => {
  test("SET-020 the company-change dialog counts the drafts that pick up the change", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect(await owner.query(api.settings.companyChangeImpact, {})).toEqual({ drafts: 2 });
  });
});
