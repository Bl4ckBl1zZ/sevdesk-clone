import { describe, expect, test } from "vitest";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { auditedInsert } from "./model/audit";
import { notifyTaxDeadlines } from "./model/taxFilings";
import { makeT, type TestT } from "./test.setup";

describe("deadline notifications (TAX-019)", () => {
  test("TAX-019 deadlines.notify creates one reminder per open deadline (dedupe on re-run)", async () => {
    const t = makeT();
    await setupBooks(t);
    const at = Date.parse("2026-10-07T06:00:00Z");
    const run = () => t.asSystem("cron.deadlines.notify").model((ctx) => notifyTaxDeadlines({ ...ctx, now: () => at }));
    expect(await run()).toBeGreaterThan(0);
    await run();
    const rows = await t.run((ctx) => ctx.db.query("notifications").collect());
    const ustva = rows.filter((r) => r.kind === "deadline.ustva");
    expect(ustva.map((r) => [r.title, r.count])).toEqual([["UStVA 09/2026 – fällig am 12.10.2026", 2]]);
  });
});

const SEP = "2026-09";

async function owner(t: TestT) {
  return t.asUser("owner");
}

async function submitUstva(
  u: Awaited<ReturnType<typeof owner>>,
  period: string,
  over: Partial<{
    transferTicket: string;
    crossCheckCents: number;
    sheetHash: string;
    valuesDifferReason: string;
    submittedOn: string;
  }> = {},
) {
  const view = await u.query(api.taxes.ustva, { period });
  return u.mutation(api.taxes.recordFilingSubmission, {
    form: "ustva",
    period,
    submittedOn: "2026-10-09",
    transferTicket: "et123456789012345678",
    crossCheckCents: view.sheet?.totalCents ?? 0,
    sheetHash: view.guide?.sheetHash ?? "",
    ...over,
  });
}

describe("UStVA drill-down (TAX-005)", () => {
  test("TAX-005 TST-TAX-05 Kz 81 drills down to the journal entry and its document; the document links back to UStVA 09/2026 Kz 81", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100000));
    const u = await owner(t);
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.drillDown["81"]).toEqual([
      expect.objectContaining({
        seq: 1,
        date: "2026-09-10",
        cents: 100000,
        source: { kind: "salesDocument", id: "d9" },
        href: "/rechnungen/d9",
      }),
    ]);
    // Kz 83 is computed from the fields, so a document contributes to its base Kennzahl only
    expect(await u.query(api.taxes.sourceKennzahlen, { kind: "salesDocument", id: "d9" })).toEqual([
      { period: SEP, kz: "81" },
    ]);
    expect(await u.query(api.taxes.sourceKennzahlen, { kind: "salesDocument", id: "other" })).toEqual([]);
  });
});

describe("UStVA submission records (TAX-006, TAX-007, TAX-021)", () => {
  test("TAX-006 TAX-021 UVA-04 TST-TAX-06 recording the submission freezes values and drill-down, locks the months (ustva_submitted) and is audited", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100000));
    const u = await owner(t);
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.sheet?.fields.find((f) => f.kz === "81")).toMatchObject({ valueCents: 100000, formTaxCents: 19000 });
    expect(view.guide?.blocked).toBe(false);
    expect(view.drillDown["81"]?.[0]).toMatchObject({ seq: 1, source: { kind: "salesDocument", id: "d9" } });
    const r = await submitUstva(u, SEP);
    expect(r).toMatchObject({ kind: "ustva", submittedValuesDiffer: false });
    expect(r.lockedMonths).toEqual(monthsTo(9));
    const filing = await t.run((ctx) => ctx.db.query("taxFilings").first());
    expect(filing).toMatchObject({
      kind: "ustva",
      status: "submitted_manually",
      submittedVia: "mein_elster_manual",
      submittedOn: "2026-10-09",
      transmissionTicket: "et123456789012345678",
      ruleVersion: "ustva-2026.2",
      actor: u.actor,
    });
    expect(filing?.values).toEqual([
      { kz: "81", cents: 100000 },
      { kz: "83", cents: 19000 },
    ]);
    expect(filing?.drillDown).toEqual([{ kz: "81", refs: [{ source: "salesDocument", id: "d9" }] }]);
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.find((p) => p.period === SEP)).toMatchObject({ status: "locked", reason: "ustva_submitted" });
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .withIndex("by_entity", (q) => q.eq("entity.table", "taxFilings"))
        .collect(),
    );
    expect(audit.map((a) => [a.action, a.actor])).toEqual([["tax_filing.submit", u.actor]]);
    // E-UVA-04: a second plain submission is a correction; without changes there is nothing to correct (E-UVA-05)
    expect(await submitUstva(u, SEP).catch(errorCode)).toBe("filing_blocked");
  });

  test("TAX-021 E-UVA-01 E-UVA-18 TST-TAX-28 no Transferticket → blocked; a sheet hash from before a late posting → sheet_changed", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "a", "2026-09-10", 100000));
    const u = await owner(t);
    expect(await submitUstva(u, SEP, { transferTicket: "  " }).catch(errorCode)).toBe("transfer_ticket_required");
    const stale = (await u.query(api.taxes.ustva, { period: SEP })).guide?.sheetHash ?? "";
    await post(t, invoiceEvent(customer, "b", "2026-09-20", 5000));
    const fresh = await u.query(api.taxes.ustva, { period: SEP });
    const err = await u
      .mutation(api.taxes.recordFilingSubmission, {
        form: "ustva",
        period: SEP,
        submittedOn: "2026-10-09",
        transferTicket: "et1",
        crossCheckCents: fresh.sheet?.totalCents ?? 0,
        sheetHash: stale,
      })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("sheet_changed");
    expect(await t.run((ctx) => ctx.db.query("taxFilings").collect())).toEqual([]);
  });

  test("TAX-021 TAX-007 E-UVA-19 TST-TAX-29 Kz 83 from ELSTER 1,000.00 vs app 1,019.00 → blocked; „abweichend übermittelt“ stores it and opens the correction", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "a", "2026-09-10", 536400)); // form tax 1,019.16 €
    const u = await owner(t);
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.sheet?.totalCents).toBe(101916);
    expect(await submitUstva(u, SEP, { crossCheckCents: 100000 }).catch(errorCode)).toBe("cross_check_mismatch");
    const r = await submitUstva(u, SEP, { crossCheckCents: 100000, valuesDifferReason: "Tippfehler in Kz 81" });
    expect(r.submittedValuesDiffer).toBe(true);
    const filing = await t.run((ctx) => ctx.db.query("taxFilings").first());
    expect(filing).toMatchObject({ elsterReportedTotalCents: 100000, submittedValuesDiffer: true });
    const after = await u.query(api.taxes.ustva, { period: SEP });
    expect(after.correction).toMatchObject({
      required: true,
      deltas: [{ kz: "83", beforeCents: 100000, afterCents: 101916, deltaCents: 1916 }],
    });
  });

  test("TAX-007 TST-TAX-07 TST-TAX-24 EC-171 RI-23 a late Sept supply posted in Oct → „Korrektur erforderlich“, correction with Kz 10 supersedes, Sept stays locked", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "a", "2026-09-10", 100000));
    const u = await owner(t);
    await submitUstva(u, SEP);
    // RI-23: unchanged journal → recomputation equals the stored values
    expect((await u.query(api.taxes.ustva, { period: SEP })).correction).toMatchObject({ required: false, deltas: [] });
    // invoice dated 2026-10-03 (open month) for a supply on 2026-09-28 → tax point September (Soll)
    await post(
      t,
      invoiceEvent(customer, "late", "2026-10-03", 20000, { supplyDate: { kind: "date", date: "2026-09-28" } }),
    );
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.correction?.required).toBe(true);
    expect(view.correction?.deltas.find((d) => d.kz === "81")).toMatchObject({ deltaCents: 20000 });
    expect(view.correction?.notice).toBe(
      "1 Buchungen gehören steuerlich in den bereits gemeldeten Zeitraum 09/2026. Eine berichtigte Voranmeldung ist erforderlich.",
    );
    expect(view.guide?.correction).toBe(true);
    expect(view.guide?.steps[0]?.instruction).toBe("Berichtigte Anmeldung: Ja (Kz 10 = 1)");
    const r = await submitUstva(u, SEP, { submittedOn: "2026-10-10" });
    expect(r.kind).toBe("ustva_correction");
    const filings = await t.run((ctx) => ctx.db.query("taxFilings").collect());
    expect(filings.map((f) => [f.kind, f.status])).toEqual([
      ["ustva", "superseded"],
      ["ustva_correction", "submitted_manually"],
    ]);
    expect(filings[1]?.values.find((v) => v.kz === "81")?.cents).toBe(120000);
    const sep = await t.run((ctx) =>
      ctx.db
        .query("periods")
        .withIndex("by_period", (q) => q.eq("period", SEP))
        .first(),
    );
    expect(sep?.status).toBe("locked");
  });

  test("TAX-021 E-UVA-02 E-UVA-03 the current month cannot be recorded; drafts in the period block the guide", async () => {
    const t = makeT();
    await setupBooks(t);
    const u = await owner(t);
    const current = berlinCalendarDate(Date.now()).slice(0, 7);
    expect(await submitUstva(u, current).catch(errorCode)).toBe("filing_blocked");
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "vouchers",
        {
          direction: "expense",
          kind: "standard",
          status: "draft",
          documentDate: "2026-09-12",
          receivedAt: Date.parse("2026-09-12T10:00:00Z"),
          currency: "EUR",
          priceMode: "net",
          taxRule: "input_vat_deductible",
          totals: { netCents: 0, vatCents: 0, grossCents: 0, selfAssessedVatCents: 0, byRate: [] },
          openAmountCents: 0,
          originalFiles: [],
          renditions: [],
          duplicateDismissals: [],
          tags: [],
          journalEntryIds: [],
          recordedAt: Date.now(),
          retentionClass: "vouchers8",
          actor: OWNER.actor,
          version: 1,
        } as never,
        { action: "voucher.create" },
      ),
    );
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.guide?.blocked).toBe(true);
    expect(view.blockers).toContain(
      "Es gibt 1 Entwürfe mit Leistungsdatum im Zeitraum. Bitte fertigstellen oder löschen.",
    );
    expect(await submitUstva(u, SEP).catch(errorCode)).toBe("filing_blocked");
  });

  test("TAX-011 KU-05 a Kleinunternehmer without §13b/igE has no UStVA: page says so, recording is refused", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t, { ku: true });
    await post(t, {
      kind: "invoice_finalised",
      documentId: "ku1",
      documentNumber: "RE-ku1",
      documentType: "invoice",
      date: "2026-09-03",
      supplyDate: { kind: "date", date: "2026-09-03" },
      taxCase: "kleinunternehmer",
      contactId: customer,
      vatGroups: [{ category: "KU", rateBp: 0, netCents: 50000, vatCents: 0 }],
    });
    const u = await owner(t);
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.sheet).toMatchObject({ ku: true, required: false });
    expect(view.guide?.blocked).toBe(true);
    expect(await submitUstva(u, SEP).catch(errorCode)).toBe("filing_blocked");
    expect((await u.query(api.taxes.deadlines, { year: 2026 })).some((d) => d.kind === "ustva")).toBe(false);
  });

  test("TAX-009 TAX-021 TST-TAX-31 ZM Q3 recorded with the Σ cross-check → zm_submitted lock of Jul–Sep", async () => {
    const t = makeT();
    await setupBooks(t, { period: "quarterly" });
    const fr = await t.model(OWNER, (ctx) =>
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
    await post(t, {
      kind: "invoice_finalised",
      documentId: "ig1",
      documentNumber: "RE-ig1",
      documentType: "invoice",
      date: "2026-08-14",
      supplyDate: { kind: "date", date: "2026-08-14" },
      taxCase: "intra_community_supply",
      contactId: fr,
      vatGroups: [{ category: "K", rateBp: 0, netCents: 250050, vatCents: 0 }],
    });
    const u = await owner(t);
    const view = await u.query(api.taxes.zm, { period: "2026-Q3" });
    expect(view.zm.rows).toMatchObject([{ countryCode: "FR", vatNumber: "12345678901", type: "L", euros: 2500 }]);
    expect(view.reconciliation).toEqual([]);
    expect(view.deadline).toEqual({ statutory: "2026-10-25", due: "2026-10-26" });
    const r = await u.mutation(api.taxes.recordFilingSubmission, {
      form: "zm",
      period: "2026-Q3",
      submittedOn: "2026-10-12",
      transferTicket: "zm-ticket-1",
      crossCheckCents: 250000,
      sheetHash: view.guide.sheetHash,
    });
    expect(r.kind).toBe("zm");
    const periods = await t.run((ctx) => ctx.db.query("periods").collect());
    expect(periods.filter((p) => p.reason === "zm_submitted").map((p) => p.period)).toEqual(monthsTo(9));
  });

  test("TAX-002 UVA-02 the Sondervorauszahlung is 1/11 of the prior year's Kz 83, recorded without lock and deducted in December (Kz 39)", async () => {
    const t = makeT();
    await setupBooks(t, { dauerfrist: true });
    // prior-year (2025) monthly filing recorded earlier: Kz 83 = 2,200.00 €
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "taxFilings",
        {
          kind: "ustva",
          period: "2025-12",
          ruleVersion: "ustva-2025",
          values: [{ kz: "83", cents: 220000 }],
          drillDown: [],
          status: "submitted_manually",
          submittedVia: "mein_elster_manual",
          submittedOn: "2026-01-09",
          submittedAt: Date.parse("2026-01-09T10:00:00Z"),
          transmissionTicket: "old",
          actor: OWNER.actor,
        },
        { action: "tax_filing.submit" },
      ),
    );
    const u = await owner(t);
    const svz = await u.query(api.taxes.sondervorauszahlung, { year: 2026 });
    expect(svz).toMatchObject({ applicable: true, amountCents: 20000, priorMonthsFiled: 1 });
    expect(svz.guide?.steps[0]?.fields[0]?.copy).toBe("200,00");
    // the 2027 USt 1 H guide is not verified yet (E-UVA-20)
    expect((await u.query(api.taxes.sondervorauszahlung, { year: 2027 })).guide?.blocked).toBe(true);
    const r = await u.mutation(api.taxes.recordFilingSubmission, {
      form: "sondervorauszahlung",
      period: "2026",
      submittedOn: "2026-02-09",
      transferTicket: "svz-1",
      crossCheckCents: 20000,
      sheetHash: svz.guide?.sheetHash ?? "",
    });
    expect(r).toMatchObject({ kind: "sondervorauszahlung", lockedMonths: [] });
    expect(await t.run((ctx) => ctx.db.query("periods").collect())).toEqual([]);
    const dec = await u.query(api.taxes.ustva, { period: "2026-12" });
    expect(dec.sheet?.fields.find((f) => f.kz === "39")?.valueCents).toBe(20000);
    expect(dec.sheet?.totalCents).toBe(-20000);
    const nov = await u.query(api.taxes.ustva, { period: "2026-11" });
    expect(nov.sheet?.fields.find((f) => f.kz === "39")?.valueCents ?? 0).toBe(0);
  });
});

function monthsTo(m: number): string[] {
  return Array.from({ length: m }, (_, i) => `2026-${String(i + 1).padStart(2, "0")}`);
}
