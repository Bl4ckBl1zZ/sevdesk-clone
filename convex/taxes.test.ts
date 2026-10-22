import { describe, expect, test } from "vitest";
import type { BusinessEvent } from "../src/domain/accounting/events";
import { berlinCalendarDate } from "../src/domain/time/berlin";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
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

/** An EU business customer with a USt-IdNr (ZM rows, E-UVA-12…14). */
function euCustomer(t: TestT, n: string, name: string, vatId: string) {
  return t.model(OWNER, (ctx) =>
    auditedInsert(
      ctx,
      "contacts",
      {
        kind: "organization",
        number: n,
        numberNormalized: n,
        roles: ["customer"],
        status: "active",
        organizationName: name,
        displayName: name,
        searchText: name.toLowerCase(),
        isConsumer: false,
        isPublicAuthority: false,
        vatId,
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

const igl = (id: string, contactId: string, date: string, netCents: number, supply = date): BusinessEvent => ({
  kind: "invoice_finalised",
  documentId: id,
  documentNumber: `RE-${id}`,
  documentType: "invoice",
  date,
  supplyDate: { kind: "date", date: supply },
  taxCase: "intra_community_supply",
  contactId,
  vatGroups: [{ category: "K", rateBp: 0, netCents, vatCents: 0 }],
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

  test("E-UVA-04 after the submission the period only offers a berichtigte Voranmeldung (guide with Kz 10 = 1)", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "d9", "2026-09-10", 100000));
    const u = await owner(t);
    await submitUstva(u, SEP);
    const view = await u.query(api.taxes.ustva, { period: SEP });
    expect(view.sheet?.notices).toContain(
      "Für 09/2026 wurde bereits eine Voranmeldung übermittelt. Bitte eine berichtigte Voranmeldung erstellen.",
    );
    expect(view.guide?.steps[0]?.title).toBe("Berichtigte Anmeldung");
    expect(view.guide?.correction).toBe(true);
    // a plain second record is refused (no delta → E-UVA-05); with a delta it becomes ustva_correction (TST-TAX-07)
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

  test("TAX-007 TST-TAX-07 TST-TAX-24 EC-171 RI-23 E-TAX-01 a late Sept supply posted in Oct → „Korrektur erforderlich“, correction with Kz 10 supersedes, Sept stays locked", async () => {
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

  test("TAX-010 E-UVA-13 ZM Σ L differs from Kz 41 (per-row truncation) → warning; recording needs a reason, which is stored", async () => {
    const t = makeT();
    await setupBooks(t, { period: "quarterly" });
    const fr = await euCustomer(t, "10001", "Client SARL", "FR12345678901");
    const it = await euCustomer(t, "10002", "Cliente SRL", "IT12345678901");
    for (const [id, contactId] of [
      ["ig1", fr],
      ["ig2", it],
    ] as const) {
      await post(t, {
        kind: "invoice_finalised",
        documentId: id,
        documentNumber: `RE-${id}`,
        documentType: "invoice",
        date: "2026-08-14",
        supplyDate: { kind: "date", date: "2026-08-14" },
        taxCase: "intra_community_supply",
        contactId,
        vatGroups: [{ category: "K", rateBp: 0, netCents: 10060, vatCents: 0 }],
      });
    }
    const u = await owner(t);
    const view = await u.query(api.taxes.zm, { period: "2026-Q3" });
    // ZM: 100 € + 100 € (each row truncated); UStVA Kz 41: 201.20 € → 201 €
    expect(view.zm.totalsByType.L).toBe(200);
    expect(view.reconciliation).toEqual(["ZM-Summe (200 €) weicht von UStVA Kz 41 (201 €) ab."]);
    const args = {
      form: "zm" as const,
      period: "2026-Q3",
      submittedOn: "2026-10-12",
      transferTicket: "zm-ticket-1",
      crossCheckCents: 20000,
      sheetHash: view.guide.sheetHash,
    };
    const blocked = await u.mutation(api.taxes.recordFilingSubmission, args).catch((e: unknown) => e);
    expect(errorCode(blocked)).toBe("filing_blocked");
    expect((blocked as { data: { message: string } }).data.message).toContain(
      "ZM-Summe (200 €) weicht von UStVA Kz 41 (201 €) ab.",
    );
    const r = await u.mutation(api.taxes.recordFilingSubmission, {
      ...args,
      reconciliationOverrideReason: "Rundung je USt-IdNr in der ZM",
    });
    expect(r.kind).toBe("zm");
    const filing = await t.run((ctx) => ctx.db.query("taxFilings").first());
    expect(filing?.reconciliationOverrideReason).toBe("Rundung je USt-IdNr in der ZM");
  });

  test("E-UVA-12 a ZM row whose USt-IdNr has no qualified confirmation warns; a qualified eVatR check clears it", async () => {
    const t = makeT();
    await setupBooks(t, { period: "quarterly" });
    const fr = await euCustomer(t, "10001", "Client SARL", "FR12345678901");
    await post(t, igl("ig1", fr, "2026-08-14", 100000));
    const u = await owner(t);
    const warn = "USt-IdNr FR12345678901 nicht qualifiziert bestätigt.";
    expect((await u.query(api.taxes.zm, { period: "2026-Q3" })).vatIdWarnings).toContain(warn);
    await t.model(OWNER, (ctx) =>
      auditedInsert(
        ctx,
        "vatIdChecks",
        {
          contactId: fr as Id<"contacts">,
          vatId: "FR12345678901",
          provider: "bzst_evatr",
          request: {},
          response: {},
          status: "valid",
          qualified: { name: "A", street: "A", postalCode: "A", city: "A" },
          checkedAt: Date.now(),
          retentionUntil: "2036-12-31",
        },
        { action: "contact.vat_check" },
      ),
    );
    expect((await u.query(api.taxes.zm, { period: "2026-Q3" })).vatIdWarnings).not.toContain(warn);
  });

  test("E-UVA-14 TAX-009 ZM correction for an already reported customer/period carries that customer's corrected total in the original period", async () => {
    const t = makeT();
    await setupBooks(t, { period: "quarterly" });
    const fr = await euCustomer(t, "10001", "Client SARL", "FR12345678901");
    const it = await euCustomer(t, "10002", "Cliente SRL", "IT12345678901");
    await post(t, igl("ig1", fr, "2026-08-14", 250000));
    await post(t, igl("ig2", it, "2026-08-20", 100000));
    const u = await owner(t);
    const record = async (crossCheckCents: number) => {
      const view = await u.query(api.taxes.zm, { period: "2026-Q3" });
      return u.mutation(api.taxes.recordFilingSubmission, {
        form: "zm",
        period: "2026-Q3",
        submittedOn: "2026-10-12",
        transferTicket: `zm-${crossCheckCents}`,
        crossCheckCents,
        sheetHash: view.guide.sheetHash,
      });
    };
    await record(350000);
    // invoice of 2026-10-02 for an August supply to FR: igL tax point end of September → Q3 (§13 Abs. 1 Nr. 6)
    await post(t, igl("ig3", fr, "2026-10-02", 40000, "2026-08-25"));
    const view = await u.query(api.taxes.zm, { period: "2026-Q3" });
    expect(view.correction).toMatchObject({
      required: true,
      deltas: [
        { kz: "FR12345678901|L", beforeCents: 250000, afterCents: 290000, deltaCents: 40000 },
        { kz: "sum", beforeCents: 350000, afterCents: 390000, deltaCents: 40000 },
      ],
    });
    expect(view.zm.rows.map((r) => [r.vatId, r.euros])).toEqual([
      ["FR12345678901", 2900],
      ["IT12345678901", 1000],
    ]);
    const r = await record(390000);
    expect(r.kind).toBe("zm_correction");
    const filings = await t.run((ctx) => ctx.db.query("taxFilings").collect());
    expect(filings.map((f) => [f.kind, f.status])).toEqual([
      ["zm", "superseded"],
      ["zm_correction", "submitted_manually"],
    ]);
    // complete values for the period: the corrected FR total and the unchanged IT row
    expect(filings[1]?.zmRows).toEqual([
      { vatId: "FR12345678901", type: "L", euros: 2900 },
      { vatId: "IT12345678901", type: "L", euros: 1000 },
    ]);
  });

  test("E-UVA-09 E-UVA-08 Dauerfristverlängerung, monthly filer without a recorded Sondervorauszahlung → December warns, Kz 39 stays empty", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t, { dauerfrist: true });
    await post(t, invoiceEvent(customer, "d12", "2026-12-01", 100000));
    const u = await owner(t);
    const dec = await u.query(api.taxes.ustva, { period: "2026-12" });
    expect(dec.sheet?.notices).toContain("Sondervorauszahlung nicht erfasst – Kz 39 bleibt leer.");
    expect(dec.sheet?.fields.find((f) => f.kz === "39")?.valueCents).toBe(0);
    expect(dec.sheet?.totalCents).toBe(19000);
    // only December carries the warning
    const nov = await u.query(api.taxes.ustva, { period: "2026-11" });
    expect(nov.sheet?.notices).not.toContain("Sondervorauszahlung nicht erfasst – Kz 39 bleibt leer.");
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

describe("USt-Jahreserklärung worksheet (TAX-023)", () => {
  test("TAX-023 TST-TAX-35 year totals from the journal; reconciliation with the UStVA in force names the late Sept entry; superseded filings excluded", async () => {
    const t = makeT();
    const { customer } = await setupBooks(t);
    await post(t, invoiceEvent(customer, "a", "2026-09-10", 100000));
    const u = await owner(t);
    await submitUstva(u, SEP);
    await post(
      t,
      invoiceEvent(customer, "late", "2026-10-03", 20000, { supplyDate: { kind: "date", date: "2026-09-28" } }),
    );
    const view = await u.query(api.taxes.ustAnnual, { year: 2026 });
    expect(view.sheet.mappingVersion).toBe("ust-annual-2026.1");
    expect(view.sheet.rows.find((r) => r.kz === "177")).toMatchObject({ zeile: 24, valueCents: 120000 });
    expect(view.sheet.totals).toEqual({
      verbleibendCents: 22800,
      vorauszahlungssollCents: 19000,
      abschlussCents: 3800,
    });
    const late = view.sheet.reconciliation.causes.find((c) => c.kind === "nachgemeldet");
    expect(late).toMatchObject({ period: SEP, amountCents: 3800 });
    expect(late?.entries.map((e) => e.source)).toEqual([{ kind: "salesDocument", id: "late" }]);
    expect(view.drillDown["81"]?.map((d) => d.source.id)).toEqual(["a", "late"]);
    // the year is not over: copy strings blocked, values visible
    expect(view.sheet.guide.blocked).toBe(true);
    expect(view.sheet.blockers).toContain("Das Jahr 2026 ist noch nicht abgeschlossen.");
    // the correction supersedes the first filing → the worksheet reconciles to 0
    await submitUstva(u, SEP, { submittedOn: "2026-10-10" });
    const after = await u.query(api.taxes.ustAnnual, { year: 2026 });
    expect(after.sheet.totals.abschlussCents).toBe(0);
    expect(after.sheet.reconciliation.causes).toEqual([]);
    // no submission record of its own
    expect((await t.run((ctx) => ctx.db.query("taxFilings").collect())).map((f) => f.kind)).toEqual([
      "ustva",
      "ustva_correction",
    ]);
  });
});
