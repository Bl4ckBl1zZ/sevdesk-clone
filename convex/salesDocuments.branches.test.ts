import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import type { DraftValues } from "../src/domain/schemas/documents";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, createValues, orgForm, PRODUCT_RANGE, personForm } from "./catalog.fixtures";
import { b2bBuyer, finalizedInvoice, INVOICE_RANGE, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert, auditedPatch } from "./model/audit";
import { getCompanyProfile, patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/** Branch coverage of convex/model/salesDocuments.ts (F04 DOC-03…39, SND-05…22, QUO-06, EC-DOC-97). */

const NOW = new Date("2026-10-12T10:00:00Z");
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const data = (e: unknown) => (e as { data?: { reason?: string; message?: string } }).data ?? {};
async function fail(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), ...data(e) };
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];
const as = (owner: Owner) => ({ actor: owner.actor, role: "owner", channel: "ui" }) as const;
const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => {
    const d = await ctx.db.get(id);
    if (!d) throw new Error("missing");
    return d;
  });
const snapshotOf = async (t: TestT, id: Id<"salesDocuments">) => {
  const d = await doc(t, id);
  const s = await t.run((ctx) => (d.snapshotId ? ctx.db.get(d.snapshotId) : null));
  return JSON.parse(s?.json ?? "null") as DocumentSnapshot;
};

const ADDRESS = {
  name: "Rechnungsstelle",
  name2: "Haus B",
  department: "Buchhaltung",
  street: "Industriestr. 5",
  street2: "Hinterhof",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE",
  poBox: "12 34 56",
};

describe("frozen buyer and seller data (DOC-22, CON-009/180)", () => {
  test("DOC-22 a person under an organisation bills the organisation's full address, tax ids and the delivery default", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await t.model(as(owner), async (ctx) => {
      const p = await getCompanyProfile(ctx);
      if (!p) throw new Error("no profile");
      await patchCompanyProfile(
        ctx,
        {
          tradeName: "Muster Design",
          address: { ...p.address, poBox: "99 88" },
          supervisoryBoardChair: "Dr. Aufsicht",
          foundedOn: "2010-01-01",
          defaults: { ...p.defaults, paymentReferencePrefix: "KD" },
        },
        { action: "settings.company.update" },
      );
    });
    const org = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Großkunde AG", { vatId: "DE136695976" })),
    });
    const orgId = org.id as Id<"contacts">;
    const person = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Anna", "Einkauf", { parentId: orgId })),
    });
    const personId = person.id as Id<"contacts">;
    await t.model(as(owner), async (ctx) => {
      await auditedPatch(
        ctx,
        "contacts",
        orgId,
        {
          organizationName2: "Niederlassung Berlin",
          taxNumber: "27/123/45678",
          registerNumber: "HRB 4711 B",
          buyerReference: "LR-991",
          einvoice: {
            preferredFormat: "auto",
            pdfConsents: [{ givenAt: "2026-01-01", source: "email", recordedAt: 1, revokedAt: "2026-02-01" }],
          },
        },
        { action: "contact.update" },
      );
      await auditedInsert(
        ctx,
        "contactAddresses",
        { contactId: orgId, type: "billing", address: ADDRESS, isDefault: true },
        { action: "contact.update" },
      );
      await auditedInsert(
        ctx,
        "contactAddresses",
        {
          contactId: orgId,
          type: "delivery",
          address: {
            name: "Großkunde AG",
            street: "Lagerweg 1",
            postalCode: "14482",
            city: "Potsdam",
            countryCode: "DE",
          },
          isDefault: true,
        },
        { action: "contact.update" },
      );
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const draft = await owner.query(api.invoices.get, { id });
    expect(draft?.buyer).toMatchObject({
      name: "Großkunde AG",
      tradeName: "Niederlassung Berlin",
      taxNumber: "27/123/45678",
      registerNumber: "HRB 4711 B",
      contactPerson: { name: expect.stringContaining("Einkauf") },
      address: {
        name: "Rechnungsstelle",
        name2: "Haus B",
        department: "Buchhaltung",
        street2: "Hinterhof",
        poBox: "12 34 56",
      },
    });
    // the live check uses the contact's delivery default while the draft names none
    const check = await owner.query(api.invoices.check, { id, values: invoiceValues(personId) });
    expect(check?.buyer).toMatchObject({ name: "Großkunde AG" });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const snap = await snapshotOf(t, id);
    expect(snap.seller).toMatchObject({ tradeName: "Muster Design", address: { poBox: "99 88" } });
    expect(snap.buyer.address?.city).toBe("Berlin");
    expect(snap.deliveryAddress?.city ?? snap.delivery?.address?.city).toBe("Potsdam");
    expect((await doc(t, id)).billingAddressId).toBeDefined();
    await settle(t);
  });

  test("DOC-22 a buyer without any address freezes no address (country DE); without company profile everything blocks", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const org = await owner.mutation(api.contacts.create, { values: createValues(orgForm("Ohne Adresse GmbH")) });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(org.id) });
    const d = await owner.query(api.invoices.get, { id });
    expect(d?.buyer?.address).toBeUndefined();
    expect(d?.canFinalize).toBe(false);

    const bare = makeT();
    const o2 = await bare.asUser("owner");
    const { contactId: _c, ...noContact } = invoiceValues("");
    const c = await o2.query(api.invoices.check, { values: noContact as DraftValues });
    expect(c?.canFinalize).toBe(false);
    expect(c?.findings.length).toBeGreaterThan(0);
  });
});

describe("draft header fields (DOC-03, DOC-08, EC-DOC-97)", () => {
  test("DOC-03 optional header fields round-trip through the draft values", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const methods = await t.run((ctx) => ctx.db.query("paymentMethods").collect());
    const values = invoiceValues(personId, {
      documentDate: "2026-10-05" as DraftValues["documentDate"],
      backdateReason: "  Leistung im Vormonat abgeschlossen  ",
      footText: "Danke.",
      buyerReference: " LR-7 ",
      orderReference: "B-1",
      contractReference: "V-2",
      propertyRelated: true,
      documentDiscount: { kind: "percent", valueBp: 500, isSurcharge: false, reason: "Treue" },
      internalNote: "nur intern",
      paymentMethodId: methods[0]?._id,
      bankAccountId: bankAccount,
      taxCaseOverride: { taxCase: "domestic", reason: "geprüft" },
    });
    const { id } = await owner.mutation(api.invoices.createDraft, { values });
    const d = await owner.query(api.invoices.get, { id });
    expect(d?.values).toMatchObject({
      backdateReason: "Leistung im Vormonat abgeschlossen",
      footText: "Danke.",
      buyerReference: "LR-7",
      orderReference: "B-1",
      contractReference: "V-2",
      propertyRelated: true,
      documentDiscount: { kind: "percent", valueBp: 500 },
      taxCaseOverride: { taxCase: "domestic", reason: "geprüft" },
    });
    expect((await doc(t, id)).internalNote).toBe("nur intern");
    // duplicating a draft names it „Entwurf“ in the audit reason
    const { id: copy } = await owner.mutation(api.invoices.duplicate, { id });
    const reason = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).find(
        (a) => a.entity.id === copy && a.action === "document.create_draft",
      ),
    );
    expect(reason?.reason).toBe("Dupliziert aus Entwurf");
  });

  test("QUO-09 a delivery note keeps „Preise drucken“; EC-DOC-97 a draft with a closed bank account uses the default", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: {
        ranges: [
          CONTACT_RANGE,
          PRODUCT_RANGE,
          INVOICE_RANGE,
          { key: "delivery_note", name: "Lieferscheine", format: "LS-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
        ],
      },
    });
    const { personId } = await b2bBuyer(owner);
    const { id: dn } = await owner.mutation(api.invoices.createDraft, {
      values: { ...invoiceValues(personId), type: "delivery_note", showPrices: true },
    });
    expect((await doc(t, dn)).showPrices).toBe(true);
    const second = await t.model(as(owner), (ctx) =>
      auditedInsert(
        ctx,
        "bankAccounts",
        {
          kind: "bank",
          name: "Alt",
          currency: "EUR",
          iban: "DE02120300000000202051",
          accountHolder: "Muster GmbH",
          ledgerAccount: "1210",
          showOnInvoices: true,
          isDefaultForInvoices: false,
          autoApplyMatches: false,
        },
        { action: "settings.bank_account.create" },
      ),
    );
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { bankAccountId: second }),
    });
    await t.model(as(owner), (ctx) =>
      auditedPatch(ctx, "bankAccounts", second, { archivedAt: Date.now() }, { action: "settings.bank_account.update" }),
    );
    await owner.action(api.invoices.finalize, { id, version: 1 });
    const snap = await snapshotOf(t, id);
    const iban = (await t.run((ctx) => ctx.db.get(bankAccount)))?.iban;
    expect(snap.payment.bankAccount?.iban).toBe(iban);
    await settle(t);
  });
});

describe("updateDraft / deleteDraft guards (DOC-03, PRV-012, INV-16)", () => {
  test("DOC-03 type change, version conflict, unknown, restricted and non-supplier contacts are refused", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId, orgId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect(
      await fail(
        owner.mutation(api.invoices.updateDraft, {
          id,
          version: 1,
          values: { ...invoiceValues(personId), type: "proforma" },
        }),
      ),
    ).toMatchObject({ code: "invalid_input", reason: "type_immutable" });
    expect(
      await fail(owner.mutation(api.invoices.updateDraft, { id, version: 7, values: invoiceValues(personId) })),
    ).toMatchObject({ code: "version_conflict" });
    // a contact change updates the name; removing the contact clears it
    const r = await owner.mutation(api.invoices.updateDraft, { id, version: 1, values: invoiceValues(orgId) });
    expect(r.version).toBe(2);
    expect((await doc(t, id)).contactName).toBe("Beispiel Kunde GmbH");
    const { contactId: _c, ...noContact } = invoiceValues(orgId);
    await owner.mutation(api.invoices.updateDraft, { id, version: 2, values: noContact });
    expect((await doc(t, id)).contactName).toBeUndefined();
    // restricted (Art. 18) contact
    await t.model(as(owner), (ctx) =>
      auditedPatch(ctx, "contacts", orgId, { dsgvo: { restrictedAt: Date.now() } }, { action: "contact.update" }),
    );
    expect(
      await fail(owner.mutation(api.invoices.updateDraft, { id, version: 3, values: invoiceValues(orgId) })),
    ).toMatchObject({ code: "invalid_input", reason: "CONTACT_RESTRICTED" });
    // a Gutschrift needs a supplier
    expect(
      await fail(
        owner.mutation(api.invoices.createDraft, { values: { ...invoiceValues(personId), type: "self_billing" } }),
      ),
    ).toMatchObject({ code: "invalid_input", reason: "NOT_A_SUPPLIER" });
    // an unknown (deleted) contact
    const ghost = await owner.mutation(api.contacts.create, { values: createValues(personForm("Geist", "Kontakt")) });
    await t.run(async (ctx) => {
      await ctx.db.delete(ghost.id as Id<"contacts">);
    });
    expect(
      await fail(owner.mutation(api.invoices.updateDraft, { id, version: 3, values: invoiceValues(ghost.id) })),
    ).toMatchObject({ code: "invalid_input", reason: "contact_missing", message: "Kontakt nicht gefunden." });
  });

  test("DOC-03 a finalised document is no draft: update, delete and duplicate-free paths refuse", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    expect(await fail(owner.mutation(api.invoices.deleteDraft, { id }))).toMatchObject({
      code: "document_not_draft",
    });
    expect(
      await fail(owner.mutation(api.invoices.updateDraft, { id, version: 1, values: invoiceValues(personId) })),
    ).toMatchObject({ code: "document_not_draft" });
    // DOC-35 a finalised invoice can be duplicated; the reason names its number
    const { id: copy } = await owner.mutation(api.invoices.duplicate, { id });
    expect((await doc(t, copy)).status).toBe("draft");
    // unknown document
    await owner.mutation(api.invoices.deleteDraft, { id: copy });
    expect(await fail(owner.query(api.invoices.finalizeCheck, { id: copy }))).toMatchObject({
      code: "not_found",
      message: "Dokument nicht gefunden.",
    });
  });
});

describe("commit (DOC-24, EC-DOC-02, EC-013)", () => {
  test("DOC-24 a replayed commit of the same version is idempotent; another version → document_not_draft; stale → version_conflict", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const commit = (version: number, extra: Record<string, unknown> = {}) =>
      t.mutation(internal.invoices.commit, {
        actorContext: as(owner),
        id,
        version,
        validation: "not_required",
        ...extra,
      });
    expect(await fail(commit(5))).toMatchObject({ code: "version_conflict" });
    const changed = await commit(1, { expected: { taxCase: "domestic", buyerIsConsumer: true } });
    expect(changed).toMatchObject({ status: "invalid" });
    const first = await commit(1, { backdateReason: "  ", documentDate: "2026-10-12" });
    expect(first).toMatchObject({ status: "finalized", idempotentReplay: false });
    const again = await commit(1);
    expect(again).toMatchObject({
      status: "finalized",
      idempotentReplay: true,
      number: (first as { number: string }).number,
    });
    expect(await fail(commit(2))).toMatchObject({ code: "document_not_draft" });
    await settle(t);
  });
});

describe("artifacts and export records (DOC-28, SND-16, SND-22)", () => {
  test("DOC-28 archiving files for a draft is refused; a late failure after success is ignored; restart needs blocked", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["x"])));
    const art = {
      kind: "pdf" as const,
      storageId,
      sha256: "a".repeat(64),
      bytes: 1,
      mime: "application/pdf",
      name: "x.pdf",
    };
    expect(await fail(t.mutation(internal.invoices.storeArtifacts, { id: draft, artifacts: [art] }))).toMatchObject({
      code: "document_not_draft",
    });
    expect(await t.mutation(internal.invoices.artifactFailure, { id, error: "spät" })).toEqual({ retryInMs: null });
    expect(await fail(owner.mutation(api.invoices.retryArtifacts, { id }))).toMatchObject({
      code: "conflict",
      message: "Die Dateien werden bereits erzeugt oder liegen vor.",
    });
    // the watchdog finds nothing pending
    expect(await t.mutation(internal.invoices.artifactsWatchdog, {})).toEqual({ restarted: 0 });
  });

  test("SND-22 recording an export: drafts and foreign files are refused; an archive export does not set firstExportedAt", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const arts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    const rec = (docId: Id<"salesDocuments">, artifactIds: Id<"documentArtifacts">[], entry = "default") =>
      t.mutation(internal.invoices.recordExportEntry, {
        actorContext: as(owner),
        id: docId,
        artifactIds,
        entry,
        original: false,
      });
    expect(await fail(rec(draft, []))).toMatchObject({ code: "document_not_draft" });
    // a second finalised invoice's file is foreign to the first
    const { id: other } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id: other, version: 1 });
    await settle(t);
    const foreign = await t.run(async (ctx) =>
      (
        await ctx.db
          .query("documentArtifacts")
          .withIndex("by_document", (q) => q.eq("documentId", other))
          .collect()
      ).map((a) => a._id),
    );
    expect(await fail(rec(id, foreign))).toMatchObject({
      code: "invalid_input",
      message: "Datei gehört nicht zu diesem Dokument.",
    });
    await rec(
      id,
      arts.map((a) => a._id),
      "archive",
    );
    expect((await doc(t, id)).firstExportedAt).toBeUndefined();
    await t.mutation(internal.invoices.recordExportEntry, {
      actorContext: as(owner),
      id,
      artifactIds: arts.map((a) => a._id),
      entry: "default",
      original: true,
      reason: "  erneut  ",
    });
    expect((await doc(t, id)).firstExportedAt).toBeDefined();
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.defaultMarkSelection.length).toBeGreaterThan(0);
  });
});

describe("sent mark and retraction (SND-07, SND-17, SND-18)", () => {
  test("SND-07 an invalid mark is refused with the rule code; a valid one records the Zugang; SND-18 retraction", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const detail = await owner.query(api.invoices.get, { id });
    const artifactIds = detail?.defaultMarkSelection ?? [];
    const bad = await fail(
      owner.mutation(api.invoices.markSent, { id, values: { sentOn: "2026-10-12", channel: "post", artifactIds: [] } }),
    );
    expect(bad.code).toBe("mark_sent_invalid");
    expect(bad.reason).toBeTruthy();
    const sha = Object.fromEntries((detail?.artifacts ?? []).map((a) => [a._id, a.sha256]));
    const m = await owner.mutation(api.invoices.markSent, {
      id,
      values: { sentOn: "2026-10-12", channel: "post", artifactIds, suppliedSha256: sha },
    });
    expect(m.firstEffective).toBe(true);
    const after = await doc(t, id);
    expect(after.status).toBe("sent");
    // retraction with a too-short reason is refused
    const r1 = await fail(
      owner.mutation(api.invoices.retractMark, { id, values: { retractsId: m.sendLogId, reason: "kurz" } }),
    );
    expect(r1.code).toBe("retraction_invalid");
    expect(r1.reason).toBeTruthy();
    const r = await owner.mutation(api.invoices.retractMark, {
      id,
      values: { retractsId: m.sendLogId, reason: "Falsche Rechnung markiert, nicht versendet." },
    });
    expect(r.status).toBe("finalized");
    // retracting the retraction target again is no longer effective
    const again = await fail(
      owner.mutation(api.invoices.retractMark, {
        id,
        values: { retractsId: m.sendLogId, reason: "Noch einmal zurücknehmen bitte." },
      }),
    );
    expect(again.code).toBe("retraction_invalid");
  });
});

describe("quote revisions (QUO-06 suffix numbering)", () => {
  test("QUO-06 T-QUO-004 the finalised revision of a quote gets „-V2“ of the first number; the first version is replaced", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: {
        ranges: [
          CONTACT_RANGE,
          PRODUCT_RANGE,
          INVOICE_RANGE,
          { key: "quote", name: "Angebote", format: "AN-{YYYY}-{####}", resetPolicy: "yearly", next: 1 },
        ],
      },
    });
    const { personId } = await b2bBuyer(owner);
    const { supplyDate: _s, ...rest } = invoiceValues(personId);
    const { id: q1 } = await owner.mutation(api.invoices.createDraft, { values: { ...rest, type: "quote" } });
    await owner.action(api.invoices.finalize, { id: q1, version: 1 });
    const { id: q2 } = await owner.mutation(api.documentFlows.revise, {
      id: q1,
      values: { reason: "Preis angepasst" },
    });
    const r2 = await owner.action(api.invoices.finalize, { id: q2, version: (await doc(t, q2)).version });
    expect(r2.number).toBe("AN-2026-0001-V2");
    const { id: q3 } = await owner.mutation(api.documentFlows.revise, { id: q2, values: {} });
    const r3 = await owner.action(api.invoices.finalize, { id: q3, version: (await doc(t, q3)).version });
    expect(r3.number).toBe("AN-2026-0001-V3");
    const reg = await owner.query(api.invoices.get, { id: q3 });
    expect(reg?.register).toMatchObject({ number: "AN-2026-0001-V3", rangeName: "Angebote" });
    await settle(t);
  });
});

describe("deadline notices (SND-21)", () => {
  test("SND-21 an exported but unmarked invoice gets „Exportiert, aber nicht als versendet markiert“ after the window", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const arts = await t.run((ctx) =>
      ctx.db
        .query("documentArtifacts")
        .withIndex("by_document", (q) => q.eq("documentId", id))
        .collect(),
    );
    await t.mutation(internal.invoices.recordExportEntry, {
      actorContext: as(owner),
      id,
      artifactIds: arts.map((a) => a._id),
      entry: "default",
      original: false,
    });
    vi.setSystemTime(new Date("2026-11-30T10:00:00Z"));
    const r = await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    expect(r.created).toBeGreaterThanOrEqual(1);
    const todos = await owner.query(api.invoices.todos, {});
    expect(todos.some((n) => n.link?.includes(id))).toBe(true);
  });
});
