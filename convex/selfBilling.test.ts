import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DocumentSnapshot } from "../src/domain/documents/snapshot";
import type { DraftValues } from "../src/domain/schemas/documents";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CONTACT_RANGE, createValues, orgForm, PRODUCT_RANGE } from "./catalog.fixtures";
import { INVOICE_RANGE, invoiceValues, type SellerPreset, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const GS_RANGE = {
  key: "self_billing",
  name: "Gutschriften",
  format: "GS-{YYYY}-{####}",
  resetPolicy: "yearly",
  next: 1,
};
const VOUCHER_RANGE = {
  key: "voucherInternal",
  name: "Belege (intern)",
  format: "BE-{YYYY}-{#####}",
  resetPolicy: "yearly",
  next: 1,
};
const AGREEMENT = {
  agreedOn: "2026-01-02",
  scope: "Provisionsabrechnungen",
  validFrom: "2026-01-01",
  iban: "DE75 5121 0800 1245 1261 99",
};

type Owner = Awaited<ReturnType<typeof setupInvoicing>>["owner"];

const doc = (t: TestT, id: Id<"salesDocuments">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"salesDocuments">);
const snapshotOf = (t: TestT, d: Doc<"salesDocuments">) =>
  t.run(async (ctx) => {
    const s = d.snapshotId ? await ctx.db.get(d.snapshotId) : null;
    return s ? (JSON.parse(s.json) as DocumentSnapshot) : null;
  });
const voucherLines = (t: TestT, voucherId: Id<"vouchers">) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "voucher").eq("source.id", voucherId))
        .collect()
    ).map((e) => e.lines.map((l) => [l.account, l.debitCents > 0 ? "S" : "H", l.debitCents || l.creditCents] as const)),
  );

async function setup(
  t: TestT,
  opts: { seller?: SellerPreset; agreement?: boolean; roles?: ("supplier" | "customer")[] } = {},
) {
  const { owner } = await setupInvoicing(t, opts.seller ? { seller: opts.seller } : {});
  await owner.mutation(api.settings.saveNumberRanges, {
    values: { ranges: [CONTACT_RANGE, PRODUCT_RANGE, INVOICE_RANGE, GS_RANGE, VOUCHER_RANGE] },
  });
  const { id } = await owner.mutation(api.contacts.create, {
    values: createValues(
      orgForm("Agentur Nord GmbH", {
        roles: opts.roles ?? ["supplier"],
        vatId: "DE136695976",
      }),
      {
        address: { street: "Speicherstadt 4", postalCode: "20457", city: "Hamburg", countryCode: "DE" },
        email: "abrechnung@agentur-nord.de",
        phone: "+49 40 123456",
      },
    ),
  });
  const supplierId = id as Id<"contacts">;
  if (opts.agreement !== false) {
    await owner.mutation(api.contacts.setSelfBillingAgreement, { id: supplierId, agreement: AGREEMENT });
  }
  return { owner, supplierId };
}

const commission = (contactId: string): DraftValues =>
  invoiceValues(contactId, {
    type: "self_billing",
    supplyDate: { kind: "month", month: "2026-09" },
    paymentTerms: { dueDays: 0 },
    showEpcQr: false,
    lines: [
      {
        kind: "item",
        productType: "service",
        name: "Provision September 2026",
        quantityMilli: 1_000,
        unitCode: "C62",
        unitPriceMicros: 50_000_000,
        vatRateKey: "standard",
      },
    ],
  });

async function finalizedGutschrift(t: TestT, owner: Owner, supplierId: Id<"contacts">) {
  const { id } = await owner.mutation(api.invoices.createDraft, { values: commission(supplierId) });
  const r = await owner.action(api.invoices.finalize, { id, version: 1 });
  await settle(t);
  return { id, number: r.number };
}

describe("self-billing Gutschrift end to end (F04 §4.9, INV-16; UST-11, UST-33)", { timeout: 60_000 }, () => {
  test("INV-16 UST-11 T-INV-013 T-DOC-039 finalising swaps the parties, uses GS-, keeps vouchers8 and books the purchase voucher", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t);
    const { id, number } = await finalizedGutschrift(t, owner, supplierId);
    expect(number).toBe("GS-2026-0001");
    const d = await doc(t, id);
    expect(d).toMatchObject({
      type: "self_billing",
      status: "finalized",
      contactName: "Agentur Nord GmbH",
      retentionClass: "vouchers8",
      retentionUntil: "2034-12-31",
      artifactStatus: "ready",
    });
    // not a receivable of ours (the payable lives on the voucher)
    expect(d.paymentStatus).toBeUndefined();
    const s = await snapshotOf(t, d);
    expect(s?.seller).toMatchObject({ name: "Agentur Nord GmbH", vatId: "DE136695976" });
    expect(s?.buyer.name).toBe("Muster Design GmbH");
    expect(s?.issuer?.name).toBe("Muster Design GmbH");
    expect(s?.notes.map((n) => n.id)).toContain("sb_info");
    expect(s?.payment.bankAccount?.iban).toBe("DE75512108001245126199");
    const register = await t.run((ctx) => ctx.db.query("numberRegister").collect());
    expect(register.find((r) => r.number === number)?.docType).toBe("self_billing");

    // F06 voucher link: booked with input VAT and the payable; the archived Gutschrift PDF is its original file
    const voucherId = d.selfBillingVoucherId as Id<"vouchers">;
    const v = (await t.run((ctx) => ctx.db.get(voucherId))) as Doc<"vouchers">;
    expect(v).toMatchObject({
      status: "open",
      direction: "expense",
      supplierContactId: supplierId,
      documentNumber: number,
      selfBillingDocumentId: id,
      totals: expect.objectContaining({ grossCents: 595_000 }),
    });
    expect(v.internalNumber).toMatch(/^BE-2026-/);
    expect(v.originalFiles).toHaveLength(1);
    expect(v.originalFiles[0]?.mime).toBe("application/pdf");
    expect(await voucherLines(t, voucherId)).toEqual([
      [
        ["3100", "S", 500_000],
        ["1576", "S", 95_000],
        ["1600", "H", 595_000],
      ],
    ]);
    // no revenue was posted for the Gutschrift itself
    const own = await t.run((ctx) =>
      ctx.db
        .query("journalEntries")
        .withIndex("by_source", (q) => q.eq("source.kind", "salesDocument").eq("source.id", id))
        .collect(),
    );
    expect(own).toHaveLength(0);
  });

  test("INV-16 SND-19 a Gutschrift offers no customer e-mail text (the parties are swapped)", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t);
    const { id } = await finalizedGutschrift(t, owner, supplierId);
    expect(await owner.query(api.invoices.messageText, { id })).toBeNull();
  });

  test("INV-16 a Kleinunternehmer owner records the 19 % Gutschrift gross as expense (no input VAT)", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t, { seller: "ku" });
    const { id } = await finalizedGutschrift(t, owner, supplierId);
    const d = await doc(t, id);
    expect(d.totals).toMatchObject({ netCents: 500_000, vatCents: 95_000, grossCents: 595_000 });
    const lines = await voucherLines(t, d.selfBillingVoucherId as Id<"vouchers">);
    expect(lines[0]?.find(([acc]) => acc === "1576")).toBeUndefined();
    expect(lines[0]?.find(([, side]) => side === "H")).toEqual(["1600", "H", 595_000]);
  });

  test("UST-33 T-EC-103 EC-DOC-103 without an agreement finalising is blocked and consumes no GS- number", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t, { agreement: false });
    const { id } = await owner.mutation(api.invoices.createDraft, { values: commission(supplierId) });
    const detail = await owner.query(api.invoices.get, { id });
    expect(detail?.findings.map((f) => f.code)).toContain("self_billing_agreement_missing");
    expect(detail?.findings.find((f) => f.code === "self_billing_agreement_missing")?.message).toBe(
      "Mit Agentur Nord GmbH ist keine gültige Gutschriftsvereinbarung hinterlegt (§ 14 Abs. 2 UStG).",
    );
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(errorCode(e)).toBe("validation_failed");
    expect((await doc(t, id)).status).toBe("draft");
    expect(await t.run((ctx) => ctx.db.query("vouchers").collect())).toHaveLength(0);
    expect(
      (await t.run((ctx) => ctx.db.query("numberRegister").collect())).filter((r) => r.docType === "self_billing"),
    ).toHaveLength(0);
  });

  test("INV-16 a Gutschrift can only be created for a supplier contact", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t, { roles: ["customer"] });
    const e = await owner
      .mutation(api.invoices.createDraft, { values: commission(supplierId) })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("invalid_input");
    expect((e as { data?: { reason?: string } }).data?.reason).toBe("NOT_A_SUPPLIER");
  });

  test("INV-16 a Widerspruch is recorded with its date, cancels the Gutschrift by a mirror and reverses the voucher", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t);
    const { id, number } = await finalizedGutschrift(t, owner, supplierId);
    // the normal Storno is not the way to cancel a Gutschrift (F04 §4.2.8)
    const storno = await owner.mutation(api.corrections.cancel, { id }).catch((x: unknown) => x);
    expect(errorCode(storno)).toBe("conflict");
    // invalid objections
    const future = await owner
      .mutation(api.corrections.recordObjection, { id, date: "2026-10-13", text: "Provision zu hoch" })
      .catch((x: unknown) => x);
    expect(errorCode(future)).toBe("invalid_input");
    const empty = await owner
      .mutation(api.corrections.recordObjection, { id, date: "2026-10-12", text: " " })
      .catch((x: unknown) => x);
    expect(errorCode(empty)).toBe("invalid_input");

    const r = await owner.mutation(api.corrections.recordObjection, {
      id,
      date: "2026-10-12",
      text: "Provision zu hoch abgerechnet",
    });
    await settle(t);
    const d = await doc(t, id);
    expect(d.status).toBe("cancelled");
    expect(d.objection).toMatchObject({ date: "2026-10-12", text: "Provision zu hoch abgerechnet" });
    const mirror = await doc(t, r.cancellationId);
    expect(mirror).toMatchObject({ type: "cancellation", status: "finalized", correctsId: id });
    const ms = await snapshotOf(t, mirror);
    expect(ms?.seller.name).toBe("Agentur Nord GmbH");
    expect(ms?.issuer?.name).toBe("Muster Design GmbH");
    expect(ms?.references.precedingInvoices[0]).toMatchObject({ number, role: "original" });
    expect(ms?.texts.headText).toContain("Widerspruch vom 12.10.2026");
    const v = (await t.run((ctx) => ctx.db.get(d.selfBillingVoucherId as Id<"vouchers">))) as Doc<"vouchers">;
    expect(v.status).toBe("cancelled");
    expect(await voucherLines(t, v._id)).toHaveLength(2); // booking + Generalumkehr
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "document.objection")).toBe(true);
    // a second objection is refused
    const again = await owner
      .mutation(api.corrections.recordObjection, { id, date: "2026-10-12", text: "nochmal" })
      .catch((x: unknown) => x);
    expect(errorCode(again)).toBe("invalid_input");
  });

  test("INV-16 a viewer cannot record an objection", async () => {
    const t = makeT();
    const { owner, supplierId } = await setup(t);
    const { id } = await finalizedGutschrift(t, owner, supplierId);
    const viewer = await t.asUser("viewer");
    const e = await viewer
      .mutation(api.corrections.recordObjection, { id, date: "2026-10-12", text: "x" })
      .catch((x: unknown) => x);
    expect(errorCode(e)).toBe("forbidden_role");
  });
});

describe("Gutschriftsvereinbarung on the supplier contact (F04 §4.9, INV-16, UST-33)", () => {
  test("INV-16 UST-33 an agreement is stored and removed audited; an incomplete one is refused", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    await owner.mutation(api.settings.saveNumberRanges, { values: { ranges: [CONTACT_RANGE] } });
    const { id } = await owner.mutation(api.contacts.create, {
      values: createValues(orgForm("Agentur Nord GmbH", { vatId: "DE811907980" })),
    });
    const agreement = { agreedOn: "2026-01-02", scope: "Provisionsabrechnungen", validFrom: "2026-01-01" };
    await owner.mutation(api.contacts.setSelfBillingAgreement, { id, agreement });
    const stored = await t.run((ctx) => ctx.db.get(id));
    expect(stored?.selfBillingAgreement).toEqual(agreement);
    const err = await owner
      .mutation(api.contacts.setSelfBillingAgreement, { id, agreement: { ...agreement, scope: "" } })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
    // KU flag and payout IBAN are kept (IBAN normalised); a malformed IBAN is refused
    await owner.mutation(api.contacts.setSelfBillingAgreement, {
      id,
      agreement: { ...agreement, supplierKleinunternehmer: true, iban: "de75 5121 0800 1245 1261 99" },
    });
    expect((await t.run((ctx) => ctx.db.get(id)))?.selfBillingAgreement).toMatchObject({
      supplierKleinunternehmer: true,
      iban: "DE75512108001245126199",
    });
    const badIban = await owner
      .mutation(api.contacts.setSelfBillingAgreement, { id, agreement: { ...agreement, iban: "12345" } })
      .catch((e: unknown) => e);
    expect(errorCode(badIban)).toBe("invalid_input");
    await owner.mutation(api.contacts.setSelfBillingAgreement, { id, agreement: null });
    expect((await t.run((ctx) => ctx.db.get(id)))?.selfBillingAgreement).toBeUndefined();
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((e) => e.action).filter((a) => a.includes("self_billing"))).toEqual([
      "contact.self_billing_agreement",
      "contact.self_billing_agreement",
      "contact.self_billing_agreement_removed",
    ]);
    const viewer = await t.asUser("viewer");
    const denied = await viewer
      .mutation(api.contacts.setSelfBillingAgreement, { id, agreement })
      .catch((e: unknown) => e);
    expect(errorCode(denied)).toBe("forbidden_role");
  });
});
