import { describe, expect, test } from "vitest";
import type { BusinessEvent, ReversalEvent, VoucherBookedEvent } from "../accounting/events";
import { type PostingContext, postEvent, type RoleLine, reversalPosting } from "../accounting/post";
import { ustvaMappingFor } from "../rules/ustva";
import {
  type Contribution,
  computeUstva,
  elsterCopyString,
  entryContributions,
  filingPeriodOf,
  KU_NOT_REQUIRED,
  kennzahlDeltas,
  monthsOfFilingPeriod,
  sheetHash,
  sheetValues,
  submittedPeriodNotices,
  type TaxJournalEntry,
} from "./ustva";

const M2026 = ustvaMappingFor(2026);
if (!M2026) throw new Error("mapping 2026 missing");
const M = M2026;

const ctxOf = (method: "soll" | "ist" = "soll"): PostingContext => ({
  taxationMethod: method,
  legalForm: "einzelunternehmen",
  ustvaPeriod: [{ year: 2026, period: "monthly" }],
});

let seq = 0;
function asEntry(p: { date: string; source: { kind: string; id: string }; text: string; lines: RoleLine[] }) {
  seq++;
  const entry: TaxJournalEntry = {
    id: `e${seq}`,
    seq,
    date: p.date,
    recordedAt: seq,
    source: p.source,
    text: p.text,
    lines: p.lines.map((l) => ({ ...l, account: l.account ?? "" })),
  };
  return entry;
}

function post(e: BusinessEvent, method: "soll" | "ist" = "soll"): TaxJournalEntry {
  const r = postEvent(e as Exclude<BusinessEvent, ReversalEvent>, ctxOf(method));
  if (!r.ok || r.value.kind !== "entry") throw new Error(`no entry: ${JSON.stringify(r)}`);
  return asEntry(r.value.posting);
}

function contributionsOf(entries: TaxJournalEntry[]): Contribution[] {
  return entries.flatMap((e) => entryContributions(e, M));
}

/** Contributions of the filing period `period` (monthly). */
function sheet(entries: TaxJournalEntry[], period: string, opts: { ku?: boolean; svz?: number } = {}) {
  const c = contributionsOf(entries).filter((x) => filingPeriodOf(x.taxPointDate, "monthly") === period);
  return computeUstva(period, c, M, {
    ku: opts.ku ?? false,
    ...(opts.svz ? { sondervorauszahlungCents: opts.svz } : {}),
  });
}

const field = (s: ReturnType<typeof sheet>, kz: string) => s.fields.find((f) => f.kz === kz);

const invoice = (id: string, date: string, groups: { rateBp: number; net: number; vat: number }[]): BusinessEvent => ({
  kind: "invoice_finalised",
  documentId: id,
  documentNumber: `RE-${id}`,
  documentType: "invoice",
  date,
  supplyDate: { kind: "date", date },
  taxCase: "domestic",
  contactId: "c1",
  vatGroups: groups.map((g) => ({ category: "S" as const, rateBp: g.rateBp, netCents: g.net, vatCents: g.vat })),
});

const voucher = (over: Partial<VoucherBookedEvent>): BusinessEvent => ({
  kind: "voucher_booked",
  voucherId: `v${seq + 1}`,
  number: "BE-2026-00001",
  direction: "expense",
  voucherKind: "standard",
  taxRule: "input_vat_deductible",
  companyIsKu: false,
  date: "2026-09-15",
  supplyDate: { kind: "date", date: "2026-09-10" },
  receivedDate: "2026-09-12",
  lines: [{ account: "4930", netCents: 10000, vatCents: 1900, vatRateBp: 1900 }],
  ...over,
});

describe("UStVA computation (TAX-003, TAX-004, TAX-011)", () => {
  test("TAX-004 TST-TAX-04 base 1,234.56 € at 19 % → Kz 81 = 1,234 €, tax laut Formular 234.46 €, laut Buchhaltung 234.57 €", () => {
    const s = sheet([post(invoice("a", "2026-09-10", [{ rateBp: 1900, net: 123456, vat: 23457 }]))], "2026-09");
    expect(field(s, "81")).toMatchObject({
      valueCents: 123400,
      exactCents: 123456,
      formTaxCents: 23446,
      bookedTaxCents: 23457,
      differenceCents: -11,
    });
    // Kz 83 follows the form arithmetic, never the booked VAT
    expect(s.totalCents).toBe(23446);
    expect(field(s, "83")?.valueCents).toBe(23446);
  });

  test("TAX-020 TST-TAX-27 copy strings: base „1234“, tax „234,46“, negative „-12,30“, zero → leer lassen, Kz 83 always", () => {
    expect(elsterCopyString("base_computed", 123400)).toBe("1234");
    expect(elsterCopyString("tax", 23446)).toBe("234,46");
    expect(elsterCopyString("tax", -1230)).toBe("-12,30");
    expect(elsterCopyString("tax", 123456789)).toBe("1234567,89");
    expect(elsterCopyString("base", 0)).toBeNull();
    expect(elsterCopyString("total", 0)).toBe("0,00");
  });

  test("TAX-003 UVA-03 TST-TAX-03 golden month: sales 19/7 %, input VAT, igL, EU service, §13b EU purchase → Kennzahlen and Kz 83", () => {
    const entries = [
      post(
        invoice("s1", "2026-09-03", [
          { rateBp: 1900, net: 100000, vat: 19000 },
          { rateBp: 700, net: 50000, vat: 3500 },
        ]),
      ),
      post({
        kind: "invoice_finalised",
        documentId: "igl",
        documentNumber: "RE-igl",
        documentType: "invoice",
        date: "2026-09-05",
        supplyDate: { kind: "date", date: "2026-09-05" },
        taxCase: "intra_community_supply",
        contactId: "c2",
        vatGroups: [{ category: "K", rateBp: 0, netCents: 200000, vatCents: 0 }],
      }),
      post({
        kind: "invoice_finalised",
        documentId: "ae",
        documentNumber: "RE-ae",
        documentType: "invoice",
        date: "2026-09-08",
        supplyDate: { kind: "date", date: "2026-09-08" },
        taxCase: "eu_b2b_service",
        contactId: "c3",
        vatGroups: [{ category: "AE", rateBp: 0, netCents: 80000, vatCents: 0 }],
      }),
      post(voucher({})),
      post(
        voucher({
          taxRule: "reverse_charge_eu",
          lines: [{ account: "4964", netCents: 5000, vatCents: 0, vatRateBp: 1900, selfAssessedVatCents: 950 }],
        }),
      ),
    ];
    const s = sheet(entries, "2026-09");
    const v = sheetValues(s);
    expect(v).toEqual({
      "81": 100000,
      "86": 50000,
      "41": 200000,
      "21": 80000,
      "46": 5000,
      "47": 950,
      "66": 1900,
      "67": 950,
      "83": 19000 + 3500 + 950 - 1900 - 950,
    });
    // drill-down (TAX-005): Kz 81 → the invoice entry
    expect(s.drillDown["81"]?.map((d) => d.source)).toEqual([{ kind: "salesDocument", id: "s1" }]);
    expect(s.drillDown["66"]?.map((d) => d.source.kind)).toEqual(["voucher"]);
  });

  test("TAX-011 KU-05 TST-TAX-12 E-UVA-15 KU company with an EU SaaS reverse-charge voucher: only Kz 46/47 and 67 (zero), KU invoices ignored", () => {
    const entries = [
      post({
        kind: "invoice_finalised",
        documentId: "ku1",
        documentNumber: "RE-ku1",
        documentType: "invoice",
        date: "2026-09-03",
        supplyDate: { kind: "date", date: "2026-09-03" },
        taxCase: "kleinunternehmer",
        contactId: "c1",
        vatGroups: [{ category: "KU", rateBp: 0, netCents: 50000, vatCents: 0 }],
      }),
      post(
        voucher({
          taxRule: "reverse_charge_eu",
          companyIsKu: true,
          lines: [{ account: "4964", netCents: 2000, vatCents: 0, vatRateBp: 1900, selfAssessedVatCents: 380 }],
        }),
      ),
    ];
    const s = sheet(entries, "2026-09", { ku: true });
    expect(s.ku).toBe(true);
    expect(s.required).toBe(true);
    expect(s.fields.map((f) => f.kz)).toEqual(["89", "93", "46", "47", "84", "85", "61", "67", "83"]);
    expect(sheetValues(s)).toEqual({ "46": 2000, "47": 380, "83": 380 });
    expect(field(s, "67")?.valueCents).toBe(0);
    expect(s.notices).toContain("Als Kleinunternehmer melden Sie nur Steuer nach § 13b/igE.");
    // without §13b/igE there is no UStVA for the KU company (visible as „not required“)
    const none = sheet([entries[0] as TaxJournalEntry], "2026-09", { ku: true });
    expect(none.required).toBe(false);
    expect(none.notices).toContain(KU_NOT_REQUIRED);
  });

  test("UVA-06 ACC-021 TST-ACC-13 EC-172 Ist: 1,190 € in March paid 595 € in April and May → Kz 81 = 500 per month, VAT 95 + 95", () => {
    const inv = post(invoice("ist1", "2026-03-10", [{ rateBp: 1900, net: 100000, vat: 19000 }]), "ist");
    const pay = (id: string, date: string, before: number): BusinessEvent => ({
      kind: "payment_received",
      paymentId: id,
      date,
      means: { kind: "cash" },
      amountCents: 59500,
      target: { kind: "salesDocument", id: "ist1", number: "RE-ist1" },
      contactId: "c1",
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: before },
    });
    const entries = [inv, post(pay("p1", "2026-04-02", 0), "ist"), post(pay("p2", "2026-05-04", 59500), "ist")];
    expect(sheetValues(sheet(entries, "2026-03"))).toEqual({ "83": 0 });
    for (const month of ["2026-04", "2026-05"]) {
      const s = sheet(entries, month);
      expect(field(s, "81")).toMatchObject({ valueCents: 50000, bookedTaxCents: 9500, formTaxCents: 9500 });
      expect(s.totalCents).toBe(9500);
    }
  });

  test("TST-TAX-10 EC-124 Soll write-off of 1,190 € in Q2 then 595 € recovered → Kz 50 −1,000 / +500 with VAT −190 / +95", () => {
    const writeOff = post({
      kind: "payment_received",
      paymentId: "wo",
      date: "2026-05-20",
      means: { kind: "none" },
      amountCents: 0,
      target: { kind: "salesDocument", id: "d1", number: "RE-1" },
      contactId: "c1",
      differences: [
        {
          reason: "write_off",
          amountCents: 119000,
          vatCorrection: [{ rateBp: 1900, netCents: 100000, vatCents: 19000 }],
        },
      ],
    });
    const recovery = post({
      kind: "writeoff_recovered",
      paymentId: "rec",
      date: "2026-11-03",
      means: { kind: "cash" },
      recovered: [{ rateBp: 1900, netCents: 50000, vatCents: 9500 }],
      contactId: "c1",
    });
    const may = sheet([writeOff, recovery], "2026-05");
    expect(field(may, "50")).toMatchObject({ valueCents: -100000, bookedTaxCents: -19000 });
    expect(field(may, "81")?.valueCents).toBe(0);
    expect(may.totalCents).toBe(-19000);
    const nov = sheet([writeOff, recovery], "2026-11");
    expect(field(nov, "50")).toMatchObject({ valueCents: 50000, bookedTaxCents: 9500 });
    expect(nov.totalCents).toBe(9500);
  });

  test("TST-TAX-09 EC-173 E-TAX-05 Soll advance paid in Oct → Oct Kz 81; the Schlussrechnung in Nov declares only the remainder", () => {
    const advance = post({
      kind: "advance_payment_received",
      paymentId: "adv",
      date: "2026-10-05",
      means: { kind: "cash" },
      amountCents: 59500,
      advance: {
        documentId: "a1",
        number: "AR-1",
        vatGroups: [{ rateBp: 1900, netCents: 50000, vatCents: 9500 }],
        payableCents: 59500,
        settledBeforeCents: 0,
      },
      contactId: "c1",
    });
    const final = post({
      ...invoice("f1", "2026-11-10", [{ rateBp: 1900, net: 200000, vat: 38000 }]),
      documentType: "final_invoice",
      advanceDeductions: [{ advanceDocumentId: "a1", rateBp: 1900, netCents: 50000, vatCents: 9500 }],
    } as BusinessEvent);
    expect(field(sheet([advance, final], "2026-10"), "81")).toMatchObject({ valueCents: 50000, bookedTaxCents: 9500 });
    expect(field(sheet([advance, final], "2026-11"), "81")).toMatchObject({
      valueCents: 150000,
      bookedTaxCents: 28500,
    });
  });

  test("TST-TAX-22 E-TAX-15 Storno in Oct of a Sept invoice → negative values in Oct, Sept unchanged", () => {
    const original = post(invoice("x", "2026-09-28", [{ rateBp: 1900, net: 10000, vat: 1900 }]));
    const storno = asEntry(
      reversalPosting(
        {
          kind: "invoice_cancelled",
          documentId: "st",
          documentNumber: "ST-1",
          originalDocumentId: "x",
          date: "2026-10-03",
        },
        { lines: original.lines.map((l) => ({ ...l })) as RoleLine[], text: original.text },
        ctxOf(),
      ),
    );
    expect(field(sheet([original, storno], "2026-09"), "81")?.valueCents).toBe(10000);
    expect(field(sheet([original, storno], "2026-10"), "81")).toMatchObject({
      valueCents: -10000,
      bookedTaxCents: -1900,
    });
  });

  test("TST-TAX-20 E-TAX-16 EC-162 a late input-VAT voucher with supply in a submitted period counts in the receipt period", () => {
    const late = post(
      voucher({ supplyDate: { kind: "date", date: "2026-08-20" }, receivedDate: "2026-10-02", date: "2026-10-02" }),
    );
    expect(sheetValues(sheet([late], "2026-08"))).toEqual({ "83": 0 });
    expect(sheetValues(sheet([late], "2026-10"))).toMatchObject({ "66": 1900, "83": -1900 });
  });

  test("UVA-02 E-UVA-08 Kz 39 is deducted only in the December return", () => {
    const e = [post(invoice("d", "2026-12-01", [{ rateBp: 1900, net: 100000, vat: 19000 }]))];
    expect(sheet(e, "2026-12", { svz: 2000_00 }).totalCents).toBe(19000 - 200000);
    const e2 = [post(invoice("n", "2026-11-01", [{ rateBp: 1900, net: 100000, vat: 19000 }]))];
    expect(field(sheet(e2, "2026-11", { svz: 2000_00 }), "39")?.valueCents).toBe(0);
  });

  test("TAX-007 TST-TAX-08 E-UVA-05 deltas between filed values and the recomputation; no delta → nothing to correct", () => {
    expect(kennzahlDeltas({ "81": 100000, "83": 19000 }, { "81": 110000, "83": 20900 })).toEqual([
      { kz: "81", beforeCents: 100000, afterCents: 110000, deltaCents: 10000 },
      { kz: "83", beforeCents: 19000, afterCents: 20900, deltaCents: 1900 },
    ]);
    expect(kennzahlDeltas({ "81": 100000 }, { "81": 100000 })).toEqual([]);
  });

  test("TAX-020 E-UVA-18 the sheet hash changes with any value and with the rule version", async () => {
    const base = { form: "ustva", period: "2026-09", ruleVersions: ["ustva-2026.2"], values: { "81": 100 } };
    const h = await sheetHash(base);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(await sheetHash({ ...base })).toBe(h);
    expect(await sheetHash({ ...base, values: { "81": 200 } })).not.toBe(h);
    expect(await sheetHash({ ...base, ruleVersions: ["ustva-2027.0"] })).not.toBe(h);
  });

  test("TAX-001 filing periods: monthly and quarterly periods and their months", () => {
    expect(filingPeriodOf("2026-08-31", "quarterly")).toBe("2026-Q3");
    expect(monthsOfFilingPeriod("2026-Q4")).toEqual(["2026-10", "2026-11", "2026-12"]);
    expect(monthsOfFilingPeriod("2026-09")).toEqual(["2026-09"]);
  });

  test("TST-TAX-30 E-UVA-20 the 2027 table is not verified yet → banner notice; 2026 is verified", () => {
    const m2027 = ustvaMappingFor(2027);
    expect(M.verifiedAgainstForm).toBeDefined();
    expect(m2027?.verifiedAgainstForm).toBeUndefined();
    const s = computeUstva("2027-01", [], m2027 as NonNullable<typeof m2027>, { ku: false });
    expect(s.verified).toBe(false);
    expect(s.notices).toContain(
      "Die Ausfüllhilfe für Umsatzsteuer-Voranmeldung 2027 ist noch nicht gegen das amtliche Formular geprüft. Bitte Update einspielen.",
    );
  });
});

describe("F08 §5.2/§5.3 tax timing and form edge cases", () => {
  const istPay = (
    id: string,
    date: string,
    amountCents: number,
    before: number,
    over: Record<string, unknown> = {},
  ): BusinessEvent =>
    ({
      kind: "payment_received",
      paymentId: id,
      date,
      means: { kind: "cash" },
      amountCents,
      target: { kind: "salesDocument", id: "i1", number: "RE-i1" },
      contactId: "c1",
      ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: before },
      ...over,
    }) as BusinessEvent;

  test("E-TAX-04 Ist overpayment: only the allocated amount is VAT-relevant; the excess is a credit balance without VAT", () => {
    const inv = post(invoice("i1", "2026-03-10", [{ rateBp: 1900, net: 100000, vat: 19000 }]), "ist");
    const paid = post(istPay("p1", "2026-04-02", 119000, 0), "ist");
    // the 100 € excess of the same transfer goes to the customer's credit (P6), no Ist basis
    const credit = post(
      {
        kind: "payment_received",
        paymentId: "p1-credit",
        date: "2026-04-02",
        means: { kind: "cash" },
        amountCents: 10000,
        target: { kind: "contactCredit", id: "c1" },
        contactId: "c1",
      },
      "ist",
    );
    expect(credit.lines.some((l) => l.role?.startsWith("vat."))).toBe(false);
    const april = sheet([inv, paid, credit], "2026-04");
    expect(field(april, "81")).toMatchObject({ valueCents: 100000, bookedTaxCents: 19000 });
    expect(april.totalCents).toBe(19000);
  });

  test("E-TAX-06 UST-41 advance paid at 19 %, supply after the rate fell to 7 % (restaurant food 2026-01-01): the final declares the new rate and corrects the advance VAT in its own period", () => {
    const advance = post({
      kind: "advance_payment_received",
      paymentId: "adv",
      date: "2025-12-05",
      means: { kind: "cash" },
      amountCents: 119000,
      advance: {
        documentId: "a1",
        number: "AR-1",
        vatGroups: [{ rateBp: 1900, netCents: 100000, vatCents: 19000 }],
        payableCents: 119000,
        settledBeforeCents: 0,
      },
      contactId: "c1",
    });
    const final = post({
      ...invoice("f1", "2026-01-15", [{ rateBp: 700, net: 300000, vat: 21000 }]),
      documentType: "final_invoice",
      advanceDeductions: [{ advanceDocumentId: "a1", rateBp: 1900, netCents: 100000, vatCents: 19000 }],
    } as BusinessEvent);
    const c = [advance, final].flatMap((e) => entryContributions(e, M));
    const of = (p: string) =>
      computeUstva(
        p,
        c.filter((x) => filingPeriodOf(x.taxPointDate, "monthly") === p),
        M,
        { ku: false },
      );
    const dec = of("2025-12");
    expect(sheetValues(dec)).toMatchObject({ "81": 100000 });
    expect(dec.totalCents).toBe(19000);
    const jan = of("2026-01");
    // the whole supply at 7 % (Kz 86), the 19 % advance reversed in Kz 81 of the final's period
    expect(sheetValues(jan)).toMatchObject({ "86": 300000, "81": -100000 });
    expect(field(jan, "86")?.bookedTaxCents).toBe(21000);
    expect(field(jan, "81")?.bookedTaxCents).toBe(-19000);
    expect(jan.totalCents).toBe(21000 - 19000);
  });

  test("E-TAX-07 TST-ACC-15 EC-115 Soll → Ist on 2027-01-01: a 2026 Soll invoice paid in Feb 2027 is not declared again", () => {
    const inv = post(invoice("i1", "2026-12-10", [{ rateBp: 1900, net: 100000, vat: 19000 }]), "soll");
    // finalised under Soll → no „nicht fällig“ VAT → the 2027 payment carries no Ist basis
    expect(inv.lines.some((l) => l.role?.startsWith("vat.output.notdue"))).toBe(false);
    const paid = post(istPay("p1", "2027-02-03", 119000, 0, { ist: undefined }), "ist");
    expect(paid.lines.some((l) => l.role?.startsWith("vat."))).toBe(false);
    const c = [inv, paid].flatMap((e) => entryContributions(e, M));
    expect(c.filter((x) => x.taxPointDate.startsWith("2027"))).toEqual([]);
    expect(c.filter((x) => x.taxPointDate === "2026-12-10").map((x) => [x.kz, x.part, x.cents])).toEqual([
      ["81", "base", 100000],
      ["81", "tax", 19000],
    ]);
  });

  test("E-TAX-12 write-off of an Ist invoice: no UStVA effect, the „nicht fällig“ VAT is cleared", () => {
    const inv = post(invoice("i1", "2026-03-10", [{ rateBp: 1900, net: 100000, vat: 19000 }]), "ist");
    const wo = post(
      istPay("wo", "2026-06-20", 0, 0, {
        means: { kind: "none" },
        differences: [
          {
            reason: "write_off",
            amountCents: 119000,
            vatCorrection: [{ rateBp: 1900, netCents: 100000, vatCents: 19000 }],
          },
        ],
      }),
      "ist",
    );
    const notdue = [inv, wo]
      .flatMap((e) => e.lines)
      .filter((l) => l.role === "vat.output.notdue.19")
      .reduce((s, l) => s + l.creditCents - l.debitCents, 0);
    expect(notdue).toBe(0);
    for (const month of ["2026-03", "2026-06"]) expect(sheetValues(sheet([inv, wo], month))).toEqual({ "83": 0 });
  });

  test("E-UVA-16 TAX-004 tiny amounts: the base truncates to 0 € while VAT > 0 — both shown, Kz 83 per form arithmetic", () => {
    const s = sheet([post(invoice("t", "2026-09-10", [{ rateBp: 1900, net: 40, vat: 8 }]))], "2026-09");
    expect(field(s, "81")).toMatchObject({ valueCents: 0, exactCents: 40, formTaxCents: 0, bookedTaxCents: 8 });
    expect(field(s, "81")?.differenceCents).toBe(-8);
    expect(s.totalCents).toBe(0);
    expect(field(s, "83")?.valueCents).toBe(0);
    expect(elsterCopyString("total", s.totalCents)).toBe("0,00");
  });

  test("E-UVA-17 negative Kz 81 (more credits than sales) is allowed and copied with a leading minus", () => {
    const original = post(invoice("x", "2026-09-28", [{ rateBp: 1900, net: 50000, vat: 9500 }]));
    const storno = asEntry(
      reversalPosting(
        {
          kind: "invoice_cancelled",
          documentId: "st",
          documentNumber: "ST-1",
          originalDocumentId: "x",
          date: "2026-10-03",
        },
        { lines: original.lines.map((l) => ({ ...l })) as RoleLine[], text: original.text },
        ctxOf(),
      ),
    );
    const small = post(invoice("y", "2026-10-05", [{ rateBp: 1900, net: 10000, vat: 1900 }]));
    const oct = sheet([original, storno, small], "2026-10");
    expect(field(oct, "81")).toMatchObject({ valueCents: -40000, formTaxCents: -7600 });
    expect(oct.totalCents).toBe(-7600);
    expect(elsterCopyString("base_computed", -40000)).toBe("-400");
    expect(elsterCopyString("total", oct.totalCents)).toBe("-76,00");
  });

  test("E-UVA-04 E-UVA-06 a submitted period offers only a berichtigte Voranmeldung; a prior-year period warns about the annual return", () => {
    expect(
      submittedPeriodNotices({ submitted: false, periodLabel: "09/2026", period: "2026-09", today: "2026-10-20" }),
    ).toEqual([]);
    expect(
      submittedPeriodNotices({ submitted: true, periodLabel: "09/2026", period: "2026-09", today: "2026-10-20" }),
    ).toEqual([
      "Für 09/2026 wurde bereits eine Voranmeldung übermittelt. Bitte eine berichtigte Voranmeldung erstellen.",
    ]);
    expect(
      submittedPeriodNotices({ submitted: true, periodLabel: "Q4/2025", period: "2025-Q4", today: "2026-10-20" }),
    ).toEqual([
      "Für Q4/2025 wurde bereits eine Voranmeldung übermittelt. Bitte eine berichtigte Voranmeldung erstellen.",
      "Für 2025 ist die Jahreserklärung bereits abgegeben? Dann bitte keine berichtigte Voranmeldung, sondern eine berichtigte Umsatzsteuer-Jahreserklärung in Mein ELSTER übermitteln (Arbeitsblatt USt-Jahreserklärung).",
    ]);
  });

  test("E-TAX-23 MISC-08 a foreign-currency invoice paid at a different rate: FX difference to FX gain/loss, VAT stays at the invoice's EUR VAT", () => {
    // USD invoice booked at the invoice-date rate: 1,000 € net + 190 € VAT; the customer's payment yields 1,170 €
    const fxPay = (method: "soll" | "ist") =>
      post(
        {
          kind: "payment_received",
          paymentId: `fx-${method}`,
          date: "2026-05-04",
          means: { kind: "bank_account", bankAccountId: "bank1" },
          amountCents: 117000,
          target: { kind: "salesDocument", id: "usd1", number: "RE-usd1" },
          contactId: "c1",
          differences: [{ reason: "fx_difference", amountCents: 2000 }],
          ...(method === "ist"
            ? { ist: { notDueVat: [{ rateBp: 1900, vatCents: 19000 }], payableCents: 119000, settledBeforeCents: 0 } }
            : {}),
        } as BusinessEvent,
        method,
      );
    const soll = fxPay("soll");
    expect(soll.lines.filter((l) => l.role === "expense.fx_loss").map((l) => l.debitCents)).toEqual([2000]);
    expect(soll.lines.some((l) => l.role?.startsWith("vat."))).toBe(false);
    expect(sheetValues(sheet([soll], "2026-05"))).toEqual({ "83": 0 });
    // Ist: the whole invoice VAT (190 €) becomes due — the FX loss does not reduce the tax base
    const inv = post(invoice("usd1", "2026-04-10", [{ rateBp: 1900, net: 100000, vat: 19000 }]), "ist");
    const ist = fxPay("ist");
    const may = sheet([inv, ist], "2026-05");
    expect(field(may, "81")).toMatchObject({ valueCents: 100000, bookedTaxCents: 19000 });
  });
});
