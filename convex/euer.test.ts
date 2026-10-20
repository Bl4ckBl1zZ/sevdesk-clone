import { describe, expect, test } from "vitest";
import type { BusinessEvent } from "../src/domain/accounting/events";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { type Books, invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/** A customer payment row plus its journal entry (the EÜR reads the target from `payments`). */
async function pay(t: TestT, b: Books, doc: string, date: string, amountCents: number) {
  const paymentId = await t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "payments",
      {
        target: { kind: "salesDocument", id: doc },
        contactId: b.customer,
        date,
        amountCents,
        currency: "EUR",
        source: { kind: "cash" },
        differences: [],
        journalEntryIds: [],
        actor: OWNER.actor,
        recordedAt: Date.now(),
      },
      { action: "payment.record" },
    ),
  );
  const event: BusinessEvent = {
    kind: "payment_received",
    paymentId,
    date,
    means: { kind: "bank_account", bankAccountId: b.bank },
    amountCents,
    target: { kind: "salesDocument", id: doc },
    contactId: b.customer,
  };
  await post(t, event);
  return paymentId as Id<"payments">;
}

const kuInvoice = (b: Books, id: string, date: string, gross: number) =>
  invoiceEvent(b.customer, id, date, gross, {
    taxCase: "kleinunternehmer",
    vatGroups: [{ category: "E", rateBp: 0, netCents: gross, vatCents: 0 }],
  });

async function submit(
  u: Awaited<ReturnType<TestT["asUser"]>>,
  year: number,
  over: Partial<{ submittedOn: string; crossCheckCents: number; transferTicket: string }> = {},
) {
  const view = await u.query(api.taxes.euer, { year });
  return u.mutation(api.taxes.recordFilingSubmission, {
    form: "euer",
    period: String(year),
    submittedOn: "2026-05-04",
    transferTicket: "et-euer-2025",
    crossCheckCents: view.sheet.sums.gewinnCents,
    sheetHash: view.guide.sheetHash,
    ...over,
  });
}

describe("EÜR read model (TAX-015, AO-02, RPT-001)", () => {
  test("TAX-015 AO-02 KU-05 a KU company: income by payment date in Zeile 12, drill-down to the payment and the invoice", async () => {
    const t = makeT();
    const b = await setupBooks(t, { ku: true, chart: "SKR04" });
    await post(t, kuInvoice(b, "d1", "2025-11-20", 150000));
    await post(t, kuInvoice(b, "d2", "2025-12-15", 80000));
    await pay(t, b, "d1", "2025-12-01", 150000);
    await pay(t, b, "d2", "2026-01-12", 80000);
    const u = await t.asUser("owner");
    const view = await u.query(api.taxes.euer, { year: 2025 });
    expect(view.ku).toBe(true);
    expect(view.values).toMatchObject({ "111": 150000, "159": 150000, "199": 0, "219": 150000 });
    const z12 = view.sheet.lines.find((l) => l.kz === "111");
    expect(z12?.drillDown).toEqual([
      expect.objectContaining({
        date: "2025-12-01",
        cents: 150000,
        via: { kind: "salesDocument", id: "d1" },
        href: "/rechnungen/d1",
      }),
    ]);
    expect(view.status.provisional).toBe(true);
    expect(view.ruleVersions).toEqual(["euer-2025.1", "elster-euer-2025"]);
    // RI-28: the December invoice paid in January is income of 2026
    const v26 = await u.query(api.taxes.euer, { year: 2026 });
    expect(v26.values["111"]).toBe(80000);
  });

  test("E-RPT-02 EÜR for a Bilanz company is not available (409)", async () => {
    const t = makeT();
    await setupBooks(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { profitMethod: [{ validFromFiscalYear: 2025, method: "bilanz" }] },
        { action: "settings.tax.update" },
      ),
    );
    const u = await t.asUser("owner");
    const err = await u.query(api.taxes.euer, { year: 2025 }).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("conflict");
    expect(JSON.stringify((err as { data: unknown }).data)).toContain(
      "Ihre Gewinnermittlung ist Bilanzierung – EÜR nicht verfügbar.",
    );
  });
});

describe("EÜR submission record (TAX-022, TAX-021, ACC-016)", () => {
  test("TAX-022 E-UVA-21 TST-TAX-32 a year that has not ended or with UStVA missing is blocked", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2025-03-10", 100000));
    const u = await t.asUser("owner");
    const view = await u.query(api.taxes.euer, { year: 2025 });
    expect(view.blockers).toContain(
      "Die EÜR 2025 kann erst erfasst werden, wenn das Jahr abgeschlossen und alle Voranmeldungen 2025 übermittelt sind.",
    );
    const err = await submit(u, 2025).catch((e: unknown) => e);
    expect(errorCode(err)).toBe("filing_blocked");
    expect((err as { data: { reason?: string } }).data.reason).toBe("ustva_missing");
    // the current year has not ended
    const err26 = await submit(u, 2026, { submittedOn: "2026-10-01" }).catch((e: unknown) => e);
    expect((err26 as { data: { reason?: string } }).data.reason).toBe("fiscal_year_not_ended");
  });

  test("TAX-022 TAX-021 ACC-016 TST-TAX-32 recording the EÜR 2025 locks all 12 months (euer_submitted); a later posting dated 2025-11-20 is listed as „nach Abgabe erfasst“", async () => {
    const t = makeT();
    const b = await setupBooks(t, { ku: true, chart: "SKR04" });
    await post(t, kuInvoice(b, "d1", "2025-06-10", 200000));
    await pay(t, b, "d1", "2025-06-20", 200000);
    await post(t, kuInvoice(b, "d2", "2025-10-01", 50000));
    const u = await t.asUser("owner");
    // E-UVA-01 and E-UVA-19 first
    expect(await submit(u, 2025, { transferTicket: " " }).catch(errorCode)).toBe("transfer_ticket_required");
    expect(await submit(u, 2025, { crossCheckCents: 1 }).catch(errorCode)).toBe("cross_check_mismatch");
    const r = await submit(u, 2025);
    expect(r).toMatchObject({ kind: "euer", submittedValuesDiffer: false });
    expect(r.lockedMonths).toHaveLength(12);
    const filing = await t.run((ctx) => ctx.db.query("taxFilings").first());
    expect(filing).toMatchObject({
      kind: "euer",
      period: "2025",
      status: "submitted_manually",
      submittedVia: "mein_elster_manual",
      ruleVersion: "euer-2025.1",
      transmissionTicket: "et-euer-2025",
      actor: u.actor,
    });
    expect(filing?.values).toEqual(
      expect.arrayContaining([
        { kz: "111", cents: 200000 },
        { kz: "219", cents: 200000 },
      ]),
    );
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.filter((p) => p.period.startsWith("2025") && p.reason === "euer_submitted")).toHaveLength(12);
    // a bank posting with the original date 2025-11-20 moves into the first open period and is listed
    await pay(t, b, "d2", "2025-11-20", 50000);
    const after = await u.query(api.taxes.euer, { year: 2025 });
    expect(after.lateEntries).toEqual([expect.objectContaining({ originalDate: "2025-11-20" })]);
    expect(after.lateEntries[0]?.date.startsWith("2026")).toBe(true);
    expect(after.status.provisional).toBe(false);
    // no correction kind in v1.1
    expect(await submit(u, 2025).catch(errorCode)).toBe("filing_blocked");
  });

  test("TAX-022 E-UVA-20 the unverified 2026 table blocks the guide and the submission", async () => {
    const t = makeT();
    await setupBooks(t, { ku: true, chart: "SKR04" });
    const u = await t.asUser("owner");
    const view = await u.query(api.taxes.euer, { year: 2026 });
    expect(view.sheet.verified).toBe(false);
    expect(view.guide.blocked).toBe(true);
    expect(view.blockers).toContain(
      "Zeilen gegen amtlichen Vordruck prüfen – die Zuordnung für 2026 ist noch nicht geprüft.",
    );
  });
});
