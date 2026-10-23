import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DraftValues } from "../src/domain/schemas/documents";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { CONTACT_RANGE, createValues, PRODUCT_RANGE, personForm, productForm } from "./catalog.fixtures";
import {
  b2bBuyer,
  consumerBuyer,
  finalizedInvoice,
  INVOICE_RANGE,
  invoiceValues,
  settle,
  setupInvoicing,
} from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import { seedCategories } from "./model/products";
import { makeT } from "./test.setup";

/** Branch coverage of convex/invoices.ts (F04 DOC-03…42, SND-07/19/21, QUO tabs, 02 §6 pipeline reads). */

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

const PAGE = { numItems: 50, cursor: null };
const range = (key: string, name: string, prefix: string) => ({
  key,
  name,
  format: `${prefix}-{YYYY}-{####}`,
  resetPolicy: "yearly",
  next: 1,
});
const LETTER_RANGES = [
  range("quote", "Angebote", "AN"),
  range("order_confirmation", "Auftragsbestätigungen", "AB"),
  range("delivery_note", "Lieferscheine", "LS"),
  range("proforma", "Proforma", "PF"),
];

function letter(type: DraftValues["type"], contactId: string): DraftValues {
  const { supplyDate, ...rest } = invoiceValues(contactId);
  return { ...rest, type, ...(type === "delivery_note" ? { supplyDate } : {}) } as DraftValues;
}

const ids = (rows: { _id: string }[]) => rows.map((r) => r._id).sort();

describe("list tabs (DOC-37, F04 §6.1)", () => {
  test("DOC-37 the invoice tabs, an unknown tab and the exact document number as search", async () => {
    const t = makeT();
    const { owner, id, number, personId } = await finalizedInvoice(t);
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const tab = async (name?: string, q?: string) =>
      (
        await owner.query(api.invoices.list, {
          paginationOpts: PAGE,
          ...(name ? { tab: name } : {}),
          ...(q !== undefined ? { q } : {}),
        })
      ).page;

    expect(ids(await tab())).toEqual([id, draft].sort());
    expect(ids(await tab("bogus"))).toEqual([id, draft].sort());
    expect(ids(await tab("draft"))).toEqual([draft]);
    expect(ids(await tab("unsent"))).toEqual([id]);
    expect(await tab("open")).toEqual([]);
    expect(await tab("overdue")).toEqual([]);
    expect(await tab("paid")).toEqual([]);
    expect(await tab("exported_not_marked")).toEqual([]);
    // the letter-only tabs never match invoices
    for (const name of ["accepted", "received", "rejected", "expired", "invoiced"]) expect(await tab(name)).toEqual([]);
    // the number (case-insensitive) finds the invoice even though the full-text index searches names
    const hit = await tab(undefined, number.toLowerCase());
    expect(hit.map((r) => r._id)).toEqual([id]);
    expect(hit[0]).toMatchObject({ number, exported: false, correctionKind: null, invoicingDeadline: null });
    // a name search
    expect((await tab(undefined, "Beispiel")).length).toBeGreaterThan(0);
  });

  test("DOC-37 QUO lists: quotes by tab (open, accepted, rejected), delivery notes (received), search inside a type", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await owner.mutation(api.settings.saveNumberRanges, {
      values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE, ...LETTER_RANGES] },
    });
    const { personId } = await b2bBuyer(owner);
    const mk = async (type: DraftValues["type"]) => {
      const { id } = await owner.mutation(api.invoices.createDraft, { values: letter(type, personId) });
      await owner.action(api.invoices.finalize, { id, version: 1 });
      return id;
    };
    const q1 = await mk("quote");
    const q2 = await mk("quote");
    const q3 = await mk("quote");
    const dn = await mk("delivery_note");
    await settle(t);
    await owner.mutation(api.documentFlows.accept, {
      id: q1,
      values: { date: "2026-10-12", byName: "Max Beispiel", channel: "email" },
    });
    await owner.mutation(api.documentFlows.reject, { id: q2, values: { date: "2026-10-12" } });
    await owner.mutation(api.documentFlows.markReceived, {
      id: dn,
      values: { date: "2026-10-12", byName: "Max Beispiel" },
    });
    const list = async (type: DraftValues["type"], tab?: string, q?: string) =>
      ids(
        (
          await owner.query(api.invoices.list, {
            paginationOpts: PAGE,
            type,
            ...(tab ? { tab } : {}),
            ...(q ? { q } : {}),
          })
        ).page,
      );
    expect(await list("quote")).toEqual([q1, q2, q3].sort());
    expect(await list("quote", "open")).toEqual([q3]);
    expect(await list("quote", "accepted")).toEqual([q1]);
    expect(await list("quote", "rejected")).toEqual([q2]);
    expect(await list("quote", "received")).toEqual([]);
    expect(await list("delivery_note", "received")).toEqual([dn]);
    expect(await list("delivery_note", "accepted")).toEqual([]);
    expect(await list("quote", undefined, "Beispiel")).toEqual([q1, q2, q3].sort());
    // the quote detail via invoices.get (letter types are served too)
    const detail = await owner.query(api.invoices.get, { id: q3 });
    expect(detail?.doc.type).toBe("quote");
    expect(detail?.register).toMatchObject({ rangeName: "Angebote" });
  });
});

describe("detail and live check (DOC-19/20/42)", () => {
  test("DOC-20 get: a margin-scheme draft is blocked — no tax case row, reasons or categories; no lines → no totals", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, {
      values: invoiceValues(personId, { marginScheme: true, lines: [] }),
    });
    const d = await owner.query(api.invoices.get, { id });
    expect(d?.resolved).toMatchObject({ taxCaseRow: null, taxCaseReasons: [], categoriesAllowed: [] });
    expect(d?.findings.some((f) => f.code === "margin_scheme_blocked")).toBe(true);
    expect(d?.canFinalize).toBe(false);
    const c = await owner.query(api.invoices.check, { values: invoiceValues(personId, { marginScheme: true }) });
    expect(c).toMatchObject({ taxCaseReasons: [], categoriesAllowed: [], canFinalize: false });
  });

  test("DOC-19 check: invalid values → null; with id, payment method, bank account, chain order and delivery default", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    expect(await owner.query(api.invoices.check, { values: { type: "nope" } })).toBeNull();
    const methods = await t.run((ctx) => ctx.db.query("paymentMethods").collect());
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const r = await owner.query(api.invoices.check, {
      id,
      values: invoiceValues(personId, {
        bankAccountId: bankAccount,
        paymentMethodId: methods[0]?._id,
      }),
    });
    expect(r?.taxCase).toBeTruthy();
    expect(r?.totals?.grossCents).toBe(119_000);
    expect(r?.buyer).not.toBeNull();
    // without contact: no buyer, no totals problem
    const { contactId: _x, ...noContact } = invoiceValues(personId);
    const n = await owner.query(api.invoices.check, { values: { ...noContact, lines: [] } });
    expect(n?.buyer).toBeNull();
    expect(n?.canFinalize).toBe(false);
  });

  test("DOC-08 DOC-16 draftDefaults: without contact the company defaults; a consumer gets gross prices", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t);
    const none = await owner.query(api.invoices.draftDefaults, {});
    expect(none).toMatchObject({ currency: "EUR", contact: null, bankAccountId: bankAccount, showEpcQr: true });
    const consumer = await consumerBuyer(owner);
    const c = await owner.query(api.invoices.draftDefaults, { contactId: consumer });
    expect(c).toMatchObject({ priceMode: "gross", contact: { isConsumer: true, hasInvoiceEmail: true } });
    // a contact with its own payment method and terms
    const methods = await t.run((ctx) => ctx.db.query("paymentMethods").collect());
    const m = methods.find((x) => x.active) ?? methods[0];
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedPatch(
        ctx,
        "contacts",
        consumer,
        { paymentMethodId: m?._id, paymentTerms: { dueDays: 7 }, defaultDiscountBp: 500, buyerReference: "LR-1" },
        { action: "contact.update" },
      ),
    );
    expect(await owner.query(api.invoices.draftDefaults, { contactId: consumer })).toMatchObject({
      paymentMethodId: m?._id,
      paymentTerms: { dueDays: 7 },
      defaultDiscountBp: 500,
      buyerReference: "LR-1",
    });
  });

  test("DOC-05 productLine: unknown product, invalid date, contact discount and a product without description", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) => seedCategories(ctx));
    const p = await owner.mutation(api.products.create, { values: productForm("Schulung", { price: "200,00" }) });
    const productId = p.id as Id<"products">;
    const base = { productId, referenceDate: "2026-10-12", priceMode: "net" as const, currency: "EUR" };
    expect(await fail(owner.query(api.invoices.productLine, { ...base, referenceDate: "12.10.2026" }))).toMatchObject({
      code: "invalid_input",
      message: "Ungültiges Datum.",
    });
    const contact = await owner.mutation(api.contacts.create, {
      values: createValues(personForm("Rabatt", "Kunde")),
    });
    const contactId = contact.id as Id<"contacts">;
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, (ctx) =>
      auditedPatch(ctx, "contacts", contactId, { defaultDiscountBp: 1000 }, { action: "contact.update" }),
    );
    const r = await owner.query(api.invoices.productLine, { ...base, contactId });
    expect(r.line).toMatchObject({ unitPriceMicros: 2_000_000, discount: { kind: "percent", valueBp: 1000 } });
    expect(r.line.description).toBeUndefined();
    expect(r.purchasePriceMicros).toBeNull();
    // a foreign currency without a rate is refused by the pricing rule
    const fx = await fail(owner.query(api.invoices.productLine, { ...base, currency: "USD" }));
    expect(fx.code).toBe("invalid_input");
    // with a rate the price converts
    const usd = await owner.query(api.invoices.productLine, { ...base, currency: "USD", fxRate: "1.1" });
    expect(usd.line.unitPriceMicros).toBeGreaterThan(0);
    await t.run(async (ctx) => {
      await ctx.db.delete(productId);
    });
    expect(await fail(owner.query(api.invoices.productLine, base))).toMatchObject({
      code: "not_found",
      message: "Produkt nicht gefunden.",
    });
  });
});

describe("last document, message text, attachments (DOC-36, SND-19, DOC-18)", () => {
  test("DOC-36 lastDocument: unknown type and a contact without issued documents → null", async () => {
    const t = makeT();
    const { owner, personId, id, number } = await finalizedInvoice(t);
    expect(await owner.query(api.invoices.lastDocument, { contactId: personId, type: "storno" })).toBeNull();
    const other = await consumerBuyer(owner);
    expect(await owner.query(api.invoices.lastDocument, { contactId: other, type: "invoice" })).toBeNull();
    const last = await owner.query(api.invoices.lastDocument, { contactId: personId, type: "invoice" });
    expect(last).toMatchObject({ id, number });
  });

  test("SND-19 messageText: drafts → null; recipients from the snapshot and the invoice e-mails of person and organisation", async () => {
    const t = makeT();
    const { owner, personId, orgId, id } = await finalizedInvoice(t);
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect(await owner.query(api.invoices.messageText, { id: draft })).toBeNull();
    await t.model({ actor: owner.actor, role: "owner", channel: "ui" }, async (ctx) => {
      const { auditedInsert } = await import("./model/audit");
      await auditedInsert(
        ctx,
        "contactChannels",
        { contactId: personId, type: "email", value: "max@beispiel.de", isPrimary: true, isInvoiceEmail: true },
        { action: "contact.update" },
      );
      await auditedInsert(
        ctx,
        "contactChannels",
        { contactId: orgId, type: "phone", value: "+49 30 1", isPrimary: false, isInvoiceEmail: false },
        { action: "contact.update" },
      );
    });
    const m = await owner.query(api.invoices.messageText, { id });
    expect(m?.recipients).toEqual(expect.arrayContaining(["max@beispiel.de"]));
    expect(m?.recipients).not.toContain("+49 30 1");
    expect(m?.mailto).toMatch(/^mailto:/);
  });

  test("DOC-18 attachmentUrl: unknown sha256 → null", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    expect(await owner.query(api.invoices.attachmentUrl, { id, sha256: "0".repeat(64) })).toBeNull();
  });
});

describe("pipeline reads and sent-mark preview (DOC-42, SND-07, §5.1.8)", () => {
  test("DOC-42 finalizeCheck on a draft lists the check; on a finalised invoice only the status", async () => {
    const t = makeT();
    const { owner, id, number, personId } = await finalizedInvoice(t);
    expect(await owner.query(api.invoices.finalizeCheck, { id })).toEqual({
      status: "finalized",
      version: expect.any(Number),
      type: "invoice",
      number,
      check: null,
    });
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    const c = await owner.query(api.invoices.finalizeCheck, {
      id: draft,
      documentDate: "2026-10-12",
      backdateReason: "x",
      overrides: { vatCheck: { reason: "geprüft" } },
    });
    expect(c.number).toBeNull();
    expect(c.check).toMatchObject({ canFinalize: true, taxCase: expect.any(String) });
    expect(c.check?.totals).not.toBeNull();
  });

  test("02 §6 pipelinePreview of a draft without customer: no expected derivation", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { contactId: _c, ...noContact } = invoiceValues("");
    const { id } = await owner.mutation(api.invoices.createDraft, { values: noContact as DraftValues });
    const p = await t.query(internal.invoices.pipelinePreview, { id });
    expect(p).toMatchObject({ status: "draft", number: null, finalizedFromVersion: null });
    expect(p.findings.length).toBeGreaterThan(0);
  });

  test("SND-07 markSentPreview: an error keeps the status; a valid mark previews „sent“", async () => {
    const t = makeT();
    const { owner, id } = await finalizedInvoice(t);
    const bad = await owner.query(api.invoices.markSentPreview, {
      id,
      values: { sentOn: "2026-10-12", channel: "post", artifactIds: [] },
    });
    expect(bad.errors.length).toBeGreaterThan(0);
    expect(bad.statusAfter).toBe("finalized");
    const detail = await owner.query(api.invoices.get, { id });
    const ok = await owner.query(api.invoices.markSentPreview, {
      id,
      values: { sentOn: "2026-10-12", channel: "post", artifactIds: detail?.defaultMarkSelection ?? [] },
    });
    expect(ok).toMatchObject({ errors: [], statusAfter: "sent", sentOn: "2026-10-12", firstEffective: true });
  });

  test("SND-21 todos list the open to-dos; the deadline cron does nothing in tests without force", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    const todos = await owner.query(api.invoices.todos, {});
    expect(Array.isArray(todos)).toBe(true);
    for (const n of todos) expect(n.link === null || typeof n.link === "string").toBe(true);
    expect(await t.mutation(internal.invoices.notifyDeadlinesCron, {})).toEqual({ created: 0 });
    const forced = await t.mutation(internal.invoices.notifyDeadlinesCron, { force: true });
    expect(forced.created).toBeGreaterThanOrEqual(0);
  });

  test("DOC-28 renderInput of a draft has no snapshot; exportInput lists the archived files", async () => {
    const t = makeT();
    const { owner, id, personId } = await finalizedInvoice(t);
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    expect(await t.query(internal.invoices.renderInput, { id: draft })).toMatchObject({
      status: "draft",
      snapshotJson: null,
      layoutConfig: null,
      finalizedAt: null,
      hasArtifacts: false,
      xmlAttachments: [],
    });
    const fin = await t.query(internal.invoices.renderInput, { id });
    expect(fin.snapshotJson).not.toBeNull();
    expect(fin.hasArtifacts).toBe(true);
    const ex = await t.query(internal.invoices.exportInput, { id });
    expect(ex).toMatchObject({ status: "finalized", marked: false, attachments: [] });
    expect(ex.artifacts.length).toBeGreaterThan(0);
  });
});

describe("guards via the public functions", () => {
  test("DOC-24 a viewer cannot create drafts (forbidden_role)", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const viewer = await t.asUser("viewer");
    expect(await fail(viewer.mutation(api.invoices.createDraft, { values: invoiceValues(personId) }))).toMatchObject({
      code: "forbidden_role",
    });
  });
});
