import { afterEach, describe, expect, test, vi } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { b2bBuyer, invoiceValues, settle, setupInvoicing } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { notifyTaxDeadlines, recordSubmission, sourceHref, taxDeadlines } from "./model/taxFilings";
import { makeT, type TestT } from "./test.setup";

/**
 * F08 TAX-002…TAX-021 UStVA/ZM/Sondervorauszahlung: the branches of the period context, the Ist base share, the
 * deadline calendar and notifications, and the guards of the submission record.
 */

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};
const messageOf = (e: unknown) => String(dataOf(e).message ?? e);
const SEP = "2026-09";

afterEach(() => {
  vi.useRealTimers();
});

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function submit(u: Owner, form: "ustva" | "zm", period: string, over: Record<string, unknown> = {}) {
  const view = form === "ustva" ? await u.query(api.taxes.ustva, { period }) : await u.query(api.taxes.zm, { period });
  const total =
    form === "ustva"
      ? ((view as { sheet: { totalCents: number } | null }).sheet?.totalCents ?? 0)
      : (view as { zm: { totalEuros: number } }).zm.totalEuros * 100;
  return u.mutation(api.taxes.recordFilingSubmission, {
    form,
    period,
    submittedOn: "2026-10-09",
    transferTicket: "et123456789012345678",
    crossCheckCents: total,
    sheetHash: (view as { guide: { sheetHash: string } | null }).guide?.sheetHash ?? "",
    ...over,
  } as never);
}

async function frenchCustomer(t: TestT) {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "contacts",
      {
        kind: "organization",
        number: "10001",
        numberNormalized: "10001",
        roles: ["customer"],
        status: "active",
        organizationName: "Client SARL",
        displayName: "Client SARL",
        searchText: "client sarl",
        isConsumer: false,
        isPublicAuthority: false,
        vatId: "FR12345678901",
        reverseCharge13bCertificates: [],
        einvoice: { preferredFormat: "auto", pdfConsents: [] },
        language: "en",
        currency: "EUR",
        tags: [],
        customFields: {},
        version: 1,
      } as never,
      { action: "contact.create" },
    ),
  );
}

describe("period context and read models (TAX-003, TAX-005, TAX-011)", () => {
  test("TAX-021 an invalid period is refused, a missing profile is incomplete; without a profile there are no deadlines", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect(errorCode(await owner.query(api.taxes.ustva, { period: SEP }).catch((e: unknown) => e))).toBe(
      "setup_incomplete",
    );
    expect(errorCode(await owner.query(api.taxes.sondervorauszahlung, { year: 2026 }).catch((e: unknown) => e))).toBe(
      "setup_incomplete",
    );
    expect(await owner.query(api.taxes.deadlines, { year: 2026 })).toEqual([]);
    await setupBooks(t);
    const bad = await owner.query(api.taxes.ustva, { period: "2026-13" }).catch((e: unknown) => e);
    expect(errorCode(bad)).toBe("invalid_input");
    expect(messageOf(bad)).toBe("Ungültiger Zeitraum (JJJJ-MM, JJJJ-Qn oder JJJJ).");
  });

  test("TAX-020 E-UVA-20 a year without UStVA mapping has no sheet; recording that period is blocked with the mapping notice", async () => {
    const t = makeT();
    await setupBooks(t);
    const u = await t.asUser("owner");
    const view = await u.query(api.taxes.ustva, { period: "2024-05" });
    expect(view.sheet).toBeNull();
    expect(view.guide).toBeNull();
    expect(view.blockers).toHaveLength(1);
    expect(view.blockers[0]).toContain("2024");
    expect(view.drillDown).toEqual({});
    const err = await submit(u, "ustva", "2024-05", { submittedOn: "2024-06-05" }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("filing_blocked");
    expect(messageOf(err)).toBe(view.blockers[0]);
  });

  test("UVA-06 TAX-005 Ist taxation: the VAT of a customer payment on a sales document carries its base share; the document links back to the Kennzahl", async () => {
    const t = makeT();
    const { owner, bankAccount } = await setupInvoicing(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { taxationMethod: [{ validFrom: "2020-01-01", method: "ist" }] },
        { action: "settings.tax.update" },
      ),
    );
    const { personId } = await b2bBuyer(owner);
    const { id } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(personId) });
    await owner.action(api.invoices.finalize, { id, version: 1 });
    await settle(t);
    const today = berlinCalendarDate(Date.now());
    await owner.mutation(api.payments.recordForInvoice, {
      documentId: id as Id<"salesDocuments">,
      source: { kind: "clearing", accountId: bankAccount },
      date: today,
      amountCents: 59_500,
    });
    const view = await owner.query(api.taxes.ustva, { period: today.slice(0, 7) });
    // half of the 1 190 € invoice paid: base 500 €, VAT 95 € (UVA-06)
    expect(view.sheet?.fields.find((f) => f.kz === "81")).toMatchObject({ valueCents: 50_000, formTaxCents: 9_500 });
    const payments = await t.run((ctx) => ctx.db.query("payments").collect());
    const back = await owner.query(api.taxes.sourceKennzahlen, {
      kind: "payment",
      id: payments[0]?._id as string,
    });
    expect(back).toEqual([{ period: today.slice(0, 7), kz: "81" }]);
    // the payment drill-down has no document page link
    expect(view.drillDown["81"]?.[0]?.href).toBeNull();
    expect(sourceHref({ kind: "voucher", id: "v1" })).toBe("/belege/v1");
  });

  test("TAX-011 TAX-009 a Kleinunternehmer gives no ZM; EU supplies add the ZM deadlines; quarterly filers get quarterly UStVA deadlines", async () => {
    const t = makeT();
    await setupBooks(t, { period: "quarterly" });
    const fr = await frenchCustomer(t);
    await post(t, {
      kind: "invoice_finalised",
      documentId: "ig1",
      documentNumber: "RE-ig1",
      documentType: "invoice",
      date: "2026-08-14",
      supplyDate: { kind: "date", date: "2026-08-14" },
      taxCase: "intra_community_supply",
      contactId: fr,
      vatGroups: [{ category: "K", rateBp: 0, netCents: 250_050, vatCents: 0 }],
    });
    const u = await t.asUser("owner");
    const list = await u.query(api.taxes.deadlines, { year: 2026 });
    expect(list.filter((d) => d.kind === "zm").map((d) => d.period)).toEqual([
      "2026-Q1",
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
    ]);
    expect(list.filter((d) => d.kind === "ustva").map((d) => d.period)).toContain("2026-Q3");
    // the same company as Kleinunternehmer: the ZM view is blocked with the KU notice
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }] },
        { action: "settings.tax.update" },
      ),
    );
    const zm = await u.query(api.taxes.zm, { period: "2026-Q3" });
    expect(zm.blockers).toContain("Als Kleinunternehmer (§ 19 UStG) ist keine Zusammenfassende Meldung abzugeben.");
    expect(zm.reconciliation).toEqual([]);
    const kuList = await t.run((ctx) => taxDeadlines(ctx, 2026));
    expect(kuList.some((d) => d.kind === "zm")).toBe(false);
  });

  test("TAX-021 the filings of a year are listed in period order with their values", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d8", "2026-08-10", 50_000));
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100_000));
    const u = await t.asUser("owner");
    await submit(u, "ustva", SEP);
    const list = await u.query(api.taxes.filings, { year: 2026 });
    expect(list.map((f) => [f.kind, f.period, f.values["81"]])).toEqual([["ustva", SEP, 100_000]]);
    expect(list[0]).toMatchObject({ hasProtocol: false, submittedValuesDiffer: false, elsterReportedTotalCents: null });
    expect(await u.query(api.taxes.filings, { year: 2025 })).toEqual([]);
  });
});

describe("submission record guards (TAX-021, E-UVA-01…05)", () => {
  test("TAX-021 E-UVA-01 E-UVA-02 an empty Transferticket, a malformed date, a date in the period and a missing protocol are refused", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100_000));
    const u = await t.asUser("owner");
    const ticket = await submit(u, "ustva", SEP, { transferTicket: " " }).catch((e: unknown) => e);
    expect(errorCode(ticket)).toBe("transfer_ticket_required");
    const early = await submit(u, "ustva", SEP, { submittedOn: "2026-09-30" }).catch((e: unknown) => e);
    expect(errorCode(early)).toBe("filing_blocked");
    expect(messageOf(early)).toBe("Der Zeitraum 09/2026 ist noch nicht abgeschlossen.");
    const malformed = await t
      .model(OWNER, (ctx) =>
        recordSubmission(ctx, {
          form: "ustva",
          period: SEP,
          submittedOn: "09.10.2026",
          transferTicket: "et",
          crossCheckCents: 0,
          sheetHash: "x",
        }),
      )
      .catch((e: unknown) => e);
    expect(messageOf(malformed)).toBe("Das Übermittlungsdatum darf nicht in der Zukunft liegen.");
    const storageId = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4 Protokoll"])));
    await t.run((ctx) => ctx.storage.delete(storageId));
    const gone = await submit(u, "ustva", SEP, { protocolStorageId: storageId }).catch((e: unknown) => e);
    expect(messageOf(gone)).toBe("Das Übermittlungsprotokoll wurde nicht gefunden.");
    // a stored protocol is archived with its hash
    const pdf = await t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4 Protokoll UStVA"])));
    await submit(u, "ustva", SEP, { protocolStorageId: pdf });
    const [filing] = await t.run((ctx) => ctx.db.query("taxFilings").collect());
    expect(filing?.protocolStorageId).toBe(pdf);
    expect(filing?.protocolSha256).toBeTypeOf("string");
    const list = await u.query(api.taxes.filings, { year: 2026 });
    expect(list[0]?.hasProtocol).toBe(true);
  });

  test("TAX-002 E-UVA-09 without Dauerfristverlängerung the Sondervorauszahlung is not applicable and cannot be recorded; a second record of the year is blocked", async () => {
    const t = makeT();
    await setupBooks(t);
    const u = await t.asUser("owner");
    const none = await u.query(api.taxes.sondervorauszahlung, { year: 2026 });
    expect(none.applicable).toBe(false);
    expect(none.guide).toBeNull();
    expect(none.blockers).toEqual([none.reason]);
    const err = await u
      .mutation(api.taxes.recordFilingSubmission, {
        form: "sondervorauszahlung",
        period: "2026",
        submittedOn: "2026-02-09",
        transferTicket: "svz",
        crossCheckCents: 0,
        sheetHash: "",
      })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("filing_blocked");
    expect(messageOf(err)).toBe(none.reason);
  });

  test("TAX-002 a recorded Sondervorauszahlung cannot be recorded twice", async () => {
    const t = makeT();
    await setupBooks(t, { dauerfrist: true });
    const u = await t.asUser("owner");
    const svz = await u.query(api.taxes.sondervorauszahlung, { year: 2026 });
    expect(svz.applicable).toBe(true);
    const rec = () =>
      u.mutation(api.taxes.recordFilingSubmission, {
        form: "sondervorauszahlung",
        period: "2026",
        submittedOn: "2026-02-09",
        transferTicket: "svz-1",
        crossCheckCents: svz.amountCents,
        sheetHash: svz.guide?.sheetHash ?? "",
      });
    await rec();
    const again = await rec().catch((e: unknown) => e);
    expect(errorCode(again)).toBe("filing_blocked");
    expect(messageOf(again)).toBe("Für 2026 ist die Sondervorauszahlung bereits erfasst.");
  });

  test("TAX-009 E-UVA-05 a ZM correction with unchanged values is refused („keine Berichtigung nötig“); a changed hash is sheet_changed", async () => {
    const t = makeT();
    await setupBooks(t, { period: "quarterly" });
    const fr = await frenchCustomer(t);
    await post(t, {
      kind: "invoice_finalised",
      documentId: "ig1",
      documentNumber: "RE-ig1",
      documentType: "invoice",
      date: "2026-08-14",
      supplyDate: { kind: "date", date: "2026-08-14" },
      taxCase: "intra_community_supply",
      contactId: fr,
      vatGroups: [{ category: "K", rateBp: 0, netCents: 250_000, vatCents: 0 }],
    });
    const u = await t.asUser("owner");
    const stale = await submit(u, "zm", "2026-Q3", { sheetHash: "stale" }).catch((e: unknown) => e);
    expect(errorCode(stale)).toBe("sheet_changed");
    expect(messageOf(stale)).toContain("(2 Kennzahlen)"); // the row and the sum
    await submit(u, "zm", "2026-Q3", { submittedOn: "2026-10-12" });
    const view = await u.query(api.taxes.zm, { period: "2026-Q3" });
    expect(view.correction).toEqual({ required: false, deltas: [], notice: null });
    const again = await submit(u, "zm", "2026-Q3", { submittedOn: "2026-10-12" }).catch((e: unknown) => e);
    expect(errorCode(again)).toBe("filing_blocked");
    expect(messageOf(again)).toBe("Die berichtigten Werte entsprechen der letzten Meldung – keine Berichtigung nötig.");
  });

  test("TAX-007 E-UVA-19 after „abweichend übermittelt“ the correction worklist carries the ELSTER Kz 83 as before-value", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100_000));
    const u = await t.asUser("owner");
    await submit(u, "ustva", SEP, { crossCheckCents: 18_000, valuesDifferReason: "In ELSTER anders erfasst" });
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.correction?.required).toBe(true);
    expect(view.correction?.deltas).toEqual([{ kz: "83", beforeCents: 18_000, afterCents: 19_000, deltaCents: 1_000 }]);
    expect(view.filings[0]).toMatchObject({
      submittedValuesDiffer: true,
      elsterReportedTotalCents: 18_000,
      valuesDifferReason: "In ELSTER anders erfasst",
    });
  });
});

describe("deadline notifications (TAX-019)", () => {
  test("TAX-019 on the due day the notification says „Heute fällig“; a deadline shifted by § 108 Abs. 3 AO says so in the body", async () => {
    const t = makeT();
    await setupBooks(t);
    // UStVA 10/2026 is due on Tuesday 10.11.2026
    const due = Date.parse("2026-11-10T07:00:00Z");
    await t.asSystem("cron.deadlines.notify").model((ctx) => notifyTaxDeadlines({ ...ctx, now: () => due }));
    const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
    const today = rows.find((r) => r.title === "Heute fällig: UStVA 10/2026");
    expect(today).toMatchObject({ kind: "deadline.ustva", link: "/steuern/ustva" });
    expect(today?.body).toBe("Frist UStVA 10/2026: 10.11.2026.");
    // UStVA 09/2026: statutory Saturday 10.10. → due Monday 12.10.
    const sat = Date.parse("2026-10-12T07:00:00Z");
    await t.asSystem("cron.deadlines.notify").model((ctx) => notifyTaxDeadlines({ ...ctx, now: () => sat }));
    const after = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(after.find((r) => r.title === "Heute fällig: UStVA 09/2026")?.body).toBe(
      "Frist UStVA 09/2026: 12.10.2026 (verschoben nach § 108 Abs. 3 AO).",
    );
  });
});
