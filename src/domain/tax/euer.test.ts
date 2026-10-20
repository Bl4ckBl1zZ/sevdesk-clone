import { describe, expect, test } from "vitest";
import type { EuerKey } from "../rules/accounting";
import { SKR04_ACCOUNTS } from "../rules/accounting/skr04";
import { EUER_MAPPINGS, euerMappingFor } from "../rules/euer";
import {
  buildEuerGuide,
  cashBasisItems,
  computeAveuer,
  computeEuer,
  type EuerContext,
  type EuerJournalEntry,
  euerCopyString,
  tenDayYear,
} from "./euer";

// ── fixtures: SKR04 accounts, roles as the posting engine writes them ────────────────────────────────
const KEYS = new Map<string, EuerKey>(SKR04_ACCOUNTS.map((a) => [a.number, a.euerKey]));
const BANK = "1800";

let seq = 0;
const entry = (
  date: string,
  source: EuerJournalEntry["source"],
  lines: [account: string, role: string | undefined, debit: number, credit: number][],
): EuerJournalEntry => ({
  id: `e${++seq}`,
  seq,
  date,
  source,
  text: `${source.kind} ${source.id}`,
  recordedAt: seq,
  lines: lines.map(([account, role, debitCents, creditCents]) => ({
    account,
    ...(role ? { role } : {}),
    debitCents,
    creditCents,
  })),
});

function ctx(over: Partial<EuerContext> = {}): EuerContext {
  return {
    euerKeyOf: (a) => KEYS.get(a) ?? "NONE",
    openItemAccounts: new Set(["1200", "3300"]),
    payments: {},
    openingItems: {},
    assets: {},
    tenDay: {},
    kuOn: () => false,
    ...over,
  };
}

const invoice = (id: string, date: string, net: number, vat = Math.round(net * 0.19)) =>
  entry(date, { kind: "salesDocument", id }, [
    ["1200", "receivable", net + vat, 0],
    ["4400", "revenue.domestic.19", 0, net],
    ["3806", "vat.output.19", 0, vat],
  ]);
const payment = (id: string, date: string, gross: number) =>
  entry(date, { kind: "payment", id }, [
    [BANK, "bank.b1", gross, 0],
    ["1200", "receivable", 0, gross],
  ]);
const voucher = (id: string, date: string, account: string, net: number, vat: number, role?: string) =>
  entry(date, { kind: "voucher", id }, [
    [account, role, net, 0],
    ...(vat ? ([["1406", "vat.input.19", vat, 0]] as const) : []),
    ["3300", "payable", 0, net + vat],
  ] as [string, string | undefined, number, number][]);
const voucherPayment = (id: string, date: string, gross: number, means: [string, string] = [BANK, "bank.b1"]) =>
  entry(date, { kind: "payment", id }, [
    ["3300", "payable", gross, 0],
    [means[0], means[1], 0, gross],
  ]);

const sum = (items: { key: string; cents: number; year: number }[], key: string, year: number) =>
  items.filter((i) => i.key === key && i.year === year).reduce((s, i) => s + i.cents, 0);

describe("cash basis (AO-02, TAX-015, F08 §4.4/§4.6)", () => {
  test("AO-02 TAX-015 RI-28 an invoice of 2026 paid in 2027 is income of 2027, never by invoice date", () => {
    const entries = [invoice("d1", "2026-12-15", 100000), payment("p1", "2027-01-20", 119000)];
    const items = cashBasisItems(entries, ctx({ payments: { p1: { target: { kind: "salesDocument", id: "d1" } } } }));
    expect(sum(items, "BE.STPFL", 2026)).toBe(0);
    expect(sum(items, "BE.STPFL", 2027)).toBe(100000);
    expect(sum(items, "BE.UST_VEREINNAHMT", 2027)).toBe(19000);
    expect(items.every((i) => i.date === "2027-01-20")).toBe(true);
  });

  test("AO-02 partial payments split pro rata by the document's composition; Σ over all payments = document (F08 §4.4 property)", () => {
    const entries = [
      invoice("d1", "2026-03-01", 100001, 19000),
      payment("p1", "2026-04-01", 33333),
      payment("p2", "2026-12-30", 33333),
      payment("p3", "2027-02-01", 52335),
    ];
    const pay = (id: string) => ({ target: { kind: "salesDocument" as const, id } });
    const items = cashBasisItems(entries, ctx({ payments: { p1: pay("d1"), p2: pay("d1"), p3: pay("d1") } }));
    const income = sum(items, "BE.STPFL", 2026) + sum(items, "BE.STPFL", 2027);
    const vat = sum(items, "BE.UST_VEREINNAHMT", 2026) + sum(items, "BE.UST_VEREINNAHMT", 2027);
    expect(income).toBe(100001);
    expect(vat).toBe(19000);
    expect(sum(items, "BE.STPFL", 2026) + sum(items, "BE.UST_VEREINNAHMT", 2026)).toBe(66666);
  });

  test("AO-02 Skonto, bank fees and dunning fees in a payment entry: cash-basis result equals the money received", () => {
    // invoice 1,000.00 + 190.00; customer pays 1,166.20 after 2 % Skonto (20.00 net + 3.80 VAT)
    const entries = [
      invoice("d1", "2026-05-01", 100000),
      entry("2026-05-10", { kind: "payment", id: "p1" }, [
        [BANK, "bank.b1", 116620, 0],
        ["4736", "skonto.granted.19", 2000, 0],
        ["3806", "vat.output.19", 380, 0],
        ["1200", "receivable", 0, 119000],
      ]),
    ];
    const items = cashBasisItems(entries, ctx({ payments: { p1: { target: { kind: "salesDocument", id: "d1" } } } }));
    expect(sum(items, "BE.STPFL", 2026)).toBe(98000);
    expect(sum(items, "BE.UST_VEREINNAHMT", 2026)).toBe(18620);
  });

  test("AO-02 a write-off brings no income (Forderungsverlust = income never received)", () => {
    const entries = [
      invoice("d1", "2026-05-01", 100000),
      entry("2026-11-10", { kind: "payment", id: "w1" }, [
        ["6936", "writeoff.19", 100000, 0],
        ["3806", "vat.output.19", 19000, 0],
        ["1200", "receivable", 0, 119000],
      ]),
    ];
    const items = cashBasisItems(
      entries,
      ctx({
        payments: {
          w1: { target: { kind: "salesDocument", id: "d1" }, writeOff: { grossCents: 119000, vatCents: 19000 } },
        },
      }),
    );
    for (const key of ["BE.STPFL", "BE.UST_VEREINNAHMT"]) expect(sum(items, key, 2026)).toBe(0);
  });

  test("AO-02 a voucher paid privately is an expense of the payment date plus a private deposit (T7)", () => {
    const entries = [
      voucher("v1", "2026-02-01", "6815", 5000, 950),
      voucherPayment("vp1", "2026-02-03", 5950, ["2180", "private.deposit"]),
    ];
    const items = cashBasisItems(entries, ctx({ payments: { vp1: { target: { kind: "voucher", id: "v1" } } } }));
    expect(sum(items, "BA.ARBEITSMITTEL", 2026)).toBe(5000);
    expect(sum(items, "BA.VORSTEUER", 2026)).toBe(950);
    expect(sum(items, "PRIVAT.EINLAGE", 2026)).toBe(5950);
  });

  test("KU-05 AO-02 a KU §13b voucher: the self-assessed VAT is paid with the UStVA, not with the supplier invoice", () => {
    const entries = [
      entry("2026-03-01", { kind: "voucher", id: "v1" }, [
        ["5923", "expense.13b_eu.19", 10000, 0],
        ["6860", "expense.vat_nondeductible", 1900, 0],
        ["3837", "vat.output.13b.19", 0, 1900],
        ["3300", "payable", 0, 10000],
      ]),
      voucherPayment("vp1", "2026-03-05", 10000),
    ];
    const items = cashBasisItems(entries, ctx({ payments: { vp1: { target: { kind: "voucher", id: "v1" } } } }));
    expect(sum(items, "BA.FREMDLEISTUNGEN", 2026)).toBe(10000);
    expect(sum(items, "BA.SONSTIGE", 2026)).toBe(0);
  });

  test("AO-02 AfA comes from the depreciation runs by asset class (immaterielle vs bewegliche, GWG)", () => {
    const entries = [
      entry("2026-01-31", { kind: "asset_depreciation", id: "a1:2026-01" }, [
        ["6200", "afa.intangible", 1000, 0],
        ["0135", undefined, 0, 1000],
      ]),
      entry("2026-06-30", { kind: "asset_depreciation", id: "a2:2026-06" }, [
        ["6260", "afa.gwg", 50000, 0],
        ["0670", undefined, 0, 50000],
      ]),
      entry("2026-01-31", { kind: "asset_depreciation", id: "a3:2026-01" }, [
        ["6220", "afa.tangible", 2000, 0],
        ["0650", undefined, 0, 2000],
      ]),
    ];
    const items = cashBasisItems(
      entries,
      ctx({
        assets: {
          a1: { assetClass: "intangible", method: "linear" },
          a2: { assetClass: "movable", method: "gwg" },
          a3: { assetClass: "immovable", method: "linear" },
        },
      }),
    );
    expect(sum(items, "BA.AFA_IMMATERIELL", 2026)).toBe(1000);
    expect(sum(items, "BA.GWG", 2026)).toBe(50000);
    expect(sum(items, "BA.AFA_UNBEWEGLICH", 2026)).toBe(2000);
  });

  test("RI-28 manual entries on receivable/payable accounts are flagged (accrual dating cannot be checked)", () => {
    const entries = [
      entry("2026-04-01", { kind: "manual", id: "m1" }, [
        ["1200", undefined, 500, 0],
        ["4830", undefined, 0, 500],
      ]),
    ];
    const items = cashBasisItems(entries, ctx());
    const r = computeEuer(2026, items, euerMappingFor(2026), { ku: false });
    expect(r.notices.some((n) => n.includes("Manuelle Buchungen"))).toBe(false);
    const flagged = computeEuer(2026, items, euerMappingFor(2026), { ku: false, manualOpenItemEntries: 1 });
    expect(flagged.notices).toContain(
      "1 manuelle Buchung(en) auf Forderungs- oder Verbindlichkeitskonten sind in der EÜR zum Buchungsdatum enthalten – bitte prüfen, ob der Zahlungszeitpunkt gemeint ist.",
    );
  });
});

describe("10-day rule (TAX-016, AO-02, E-RPT-03…05)", () => {
  test("TAX-016 EC-177 E-RPT-03 TST-TAX-17 December UStVA paid 08.01., due 10.01. (no Dauerfrist) → expense of the previous year", () => {
    expect(tenDayYear("2027-01-08", "2027-01-10", 2026)).toBe(2026);
  });
  test("TAX-016 E-RPT-04 with Dauerfristverlängerung (due 10.02.) → expense of the payment year", () => {
    expect(tenDayYear("2027-01-08", "2027-02-10", 2026)).toBe(2027);
  });
  test("TAX-016 E-RPT-05 due 10.01. but paid late on 12.01. → outside the window → payment year", () => {
    expect(tenDayYear("2027-01-12", "2027-01-10", 2026)).toBe(2027);
  });
  test("TAX-016 a January rent paid on 28.12. and due 01.01. belongs to the next year; window edges 22.12./10.01.", () => {
    expect(tenDayYear("2026-12-28", "2027-01-01", 2027)).toBe(2027);
    expect(tenDayYear("2026-12-22", "2026-12-31", 2027)).toBe(2027);
    expect(tenDayYear("2026-12-21", "2026-12-31", 2027)).toBe(2026);
    expect(tenDayYear("2027-01-10", "2027-01-10", 2026)).toBe(2026);
    expect(tenDayYear("2027-01-11", "2027-01-10", 2026)).toBe(2027);
    // economically two years away: no shift
    expect(tenDayYear("2027-01-05", "2027-01-10", 2025)).toBe(2027);
  });

  test("TAX-016 AO-02 the engine applies the rule to tax payments and recurring vouchers via their payment", () => {
    const entries = [
      entry("2026-12-01", { kind: "voucher", id: "ust12" }, [
        ["3820", "vat.prepayment", 50000, 0],
        ["3300", "payable", 0, 50000],
      ]),
      voucherPayment("vp1", "2027-01-08", 50000),
    ];
    const items = cashBasisItems(
      entries,
      ctx({
        payments: { vp1: { target: { kind: "voucher", id: "ust12" } } },
        tenDay: { ust12: { dueDate: "2027-01-10", economicYear: 2026, reason: "UStVA 12/2026" } },
      }),
    );
    expect(sum(items, "BA.UST_GEZAHLT", 2026)).toBe(50000);
    expect(items.find((i) => i.key === "BA.UST_GEZAHLT")).toMatchObject({
      date: "2027-01-08",
      year: 2026,
      tenDayRule: "UStVA 12/2026",
    });
  });

  test("TAX-015 a refund from the Finanzamt is „erstattete Umsatzsteuer“ (Zeile 18), not a negative payment", () => {
    const entries = [
      entry("2026-08-12", { kind: "voucher", id: "r1" }, [
        ["3820", "vat.prepayment", 0, 30000],
        ["3300", "payable", 30000, 0],
      ]),
      entry("2026-08-20", { kind: "payment", id: "rp1" }, [
        ["3300", "payable", 0, 30000],
        [BANK, "bank.b1", 30000, 0],
      ]),
    ];
    const items = cashBasisItems(entries, ctx({ payments: { rp1: { target: { kind: "voucher", id: "r1" } } } }));
    expect(sum(items, "BE.UST_ERSTATTET", 2026)).toBe(30000);
    expect(sum(items, "BA.UST_GEZAHLT", 2026)).toBe(0);
  });
});

describe("Anlage EÜR sheet (TAX-015, TAX-022)", () => {
  const year = 2025;
  const entries = [
    invoice("d1", "2025-02-01", 1000000),
    payment("p1", "2025-02-15", 1190000),
    voucher("v1", "2025-03-01", "6640", 7000, 1330, "expense.entertainment"),
    entry("2025-03-01", { kind: "voucher", id: "v1b" }, [
      ["6644", "expense.entertainment.nd", 3000, 0],
      ["3300", "payable", 0, 3000],
    ]),
    voucherPayment("vp1", "2025-03-02", 8330),
    voucherPayment("vp1b", "2025-03-02", 3000),
    voucher("v2", "2025-05-01", "7610", 40000, 0),
    voucherPayment("vp2", "2025-05-15", 40000),
    entry("2025-06-01", { kind: "bankTransaction", id: "t1" }, [
      ["2100", "private.withdrawal", 20000, 0],
      [BANK, "bank.b1", 0, 20000],
    ]),
  ];
  const c = ctx({
    payments: {
      p1: { target: { kind: "salesDocument", id: "d1" } },
      vp1: { target: { kind: "voucher", id: "v1" } },
      vp1b: { target: { kind: "voucher", id: "v1b" } },
      vp2: { target: { kind: "voucher", id: "v2" } },
    },
  });
  const items = cashBasisItems(entries, c);
  const sheet = computeEuer(year, items, EUER_MAPPINGS[2025] ?? null, { ku: false });

  test("TAX-015 MISC-05 RI-28 TST-TAX-18 Bewirtung 30 % and Gewerbesteuer are shown „nicht abziehbar“ and added back; Gewinn = Σ BE − Σ abziehbare BA", () => {
    const v = (kz: string) => sheet.lines.find((l) => l.kz === kz)?.valueCents ?? 0;
    expect(v("112")).toBe(1000000);
    expect(v("140")).toBe(190000);
    expect(v("175")).toBe(7000);
    expect(v("165")).toBe(3000);
    expect(v("168")).toBe(40000);
    expect(v("185")).toBe(1330);
    expect(v("122")).toBe(20000);
    expect(sheet.sums.einnahmenCents).toBe(1190000);
    expect(sheet.sums.ausgabenCents).toBe(7000 + 1330);
    expect(sheet.sums.nichtAbziehbarCents).toBe(43000);
    expect(sheet.sums.gewinnCents).toBe(1190000 - 8330);
    expect(sheet.values).toEqual({
      "112": 1000000,
      "140": 190000,
      "159": 1190000,
      "175": 7000,
      "165": 3000,
      "168": 40000,
      "185": 1330,
      "199": 8330,
      "219": 1181670,
      "122": 20000,
    });
    expect(sheet.verified).toBe(true);
  });

  test("TAX-015 RPT-001 every line drills down to the journal entries and the source document behind the payment", () => {
    const line = sheet.lines.find((l) => l.kz === "112");
    expect(line?.drillDown).toEqual([
      expect.objectContaining({ seq: expect.any(Number), date: "2025-02-15", cents: 1000000 }),
    ]);
    expect(line?.drillDown[0]?.via).toEqual({ kind: "salesDocument", id: "d1" });
  });

  test("TAX-015 KU: all Betriebseinnahmen in Zeile 12, non-taxable ones also in Zeile 13 (nachrichtlich)", () => {
    const ku = computeEuer(
      2025,
      [
        {
          key: "BE.KU",
          cents: 50000,
          date: "2025-01-02",
          year: 2025,
          entryId: "x",
          seq: 1,
          source: { kind: "payment", id: "a" },
        },
        {
          key: "BE.SONSTIGE",
          cents: 700,
          date: "2025-01-03",
          year: 2025,
          entryId: "y",
          seq: 2,
          source: { kind: "payment", id: "b" },
          ku: true,
        },
      ],
      EUER_MAPPINGS[2025] ?? null,
      { ku: true },
    );
    expect(ku.values).toMatchObject({ "111": 50700, "119": 700, "159": 50700 });
    expect(ku.values["103"]).toBeUndefined();
  });

  test("TAX-015 E-UVA-20 the 2026 table is not verified against the official Vordruck: banner, guide blocked", () => {
    const s = computeEuer(2026, [], euerMappingFor(2026), { ku: false });
    expect(s.verified).toBe(false);
    expect(s.notices).toContain(
      "Zeilen gegen amtlichen Vordruck prüfen – die Zuordnung für 2026 ist noch nicht geprüft.",
    );
    expect(computeEuer(2030, [], euerMappingFor(2030), { ku: false }).notices).toContain(
      "Die Zeilenzuordnung der Anlage EÜR für 2030 ist noch nicht hinterlegt. Bitte Update einspielen.",
    );
  });

  test("TAX-015 Schuldzinsen above 2,050 € need the Anlage SZ, which the app does not compute → blocker", () => {
    const s = computeEuer(
      2025,
      [
        {
          key: "BA.ZINSEN",
          cents: 205001,
          date: "2025-05-01",
          year: 2025,
          entryId: "z",
          seq: 1,
          source: { kind: "payment", id: "z" },
        },
      ],
      EUER_MAPPINGS[2025] ?? null,
      { ku: false },
    );
    expect(s.blockers[0]).toContain("Anlage SZ");
  });
});

describe("Mein ELSTER guide for the Anlage EÜR (TAX-020, TAX-022, AO-02)", () => {
  test("TAX-022 TAX-020 copy strings in euro and cent; zero lines are not listed; sums always shown", () => {
    expect(euerCopyString(123456, false)).toBe("1234,56");
    expect(euerCopyString(-1230, false)).toBe("-12,30");
    expect(euerCopyString(0, false)).toBeNull();
    expect(euerCopyString(0, true)).toBe("0,00");
  });

  test("TAX-022 TST-TAX-33 the guide orders fields by Zeile, has the Feststellung path for partnerships and an AVEÜR step only with assets", () => {
    const sheet = computeEuer(
      2025,
      [
        {
          key: "BE.STPFL",
          cents: 100000,
          date: "2025-03-01",
          year: 2025,
          entryId: "a",
          seq: 1,
          source: { kind: "payment", id: "p" },
        },
      ],
      EUER_MAPPINGS[2025] ?? null,
      { ku: false },
    );
    const guide = buildEuerGuide(sheet, null, {
      legalForm: "einzelunternehmen",
      today: "2026-03-01",
      sheetHash: "h",
    });
    expect(guide.navigation.join(" › ")).toContain("Einkommensteuererklärung 2025");
    expect(guide.steps.map((s) => s.title)).not.toContain("Anlage AVEÜR");
    expect(guide.steps.flatMap((s) => s.fields.map((f) => f.kz))).toEqual(["112", "159", "199", "219"]);
    expect(guide.blocked).toBe(false);
    const aveuer = computeAveuer(
      EUER_MAPPINGS[2025]?.aveuer ?? null,
      2025,
      [
        {
          group: "buero",
          akCents: 120000,
          bookValueStartCents: 0,
          additionsCents: 120000,
          afaCents: 20000,
          disposalsCents: 0,
          bookValueEndCents: 100000,
        },
      ],
      [],
    );
    const partnership = buildEuerGuide(sheet, aveuer, { legalForm: "gbr", today: "2026-03-01", sheetHash: "h" });
    expect(partnership.navigation.join(" › ")).toContain("Feststellung");
    const avStep = partnership.steps.find((s) => s.title === "Anlage AVEÜR");
    expect(avStep?.fields.map((f) => [f.kz, f.copy])).toEqual([
      ["410", "1200,00"],
      ["412", "1200,00"],
      ["414", "200,00"],
      ["416", "1000,00"],
    ]);
    expect(partnership.formYearWarning).toBe("Achtung: Formular 2025 wählen, nicht 2026.");
  });

  test("TAX-022 E-UVA-20 the unverified 2026 table blocks the guide", () => {
    const sheet = computeEuer(2026, [], euerMappingFor(2026), { ku: false });
    const guide = buildEuerGuide(sheet, null, { legalForm: "einzelunternehmen", today: "2027-03-01", sheetHash: "h" });
    expect(guide.blocked).toBe(true);
  });
});
