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

  test("TST-TAX-09 EC-173 Soll advance paid in Oct → Oct Kz 81; the Schlussrechnung in Nov declares only the remainder", () => {
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
