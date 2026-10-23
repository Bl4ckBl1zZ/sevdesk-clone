/**
 * Kleinunternehmer and turnover-threshold edge cases of 10-edge-cases §3.5 and §3.2 (EC-029, EC-060…EC-066) on the
 * pure domain: document validation, the KU history guard, the turnover monitors, ER-03 and the UStVA.
 */
import { makeContext, makeDraft, serviceLine } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import type { BusinessEvent, ReversalEvent } from "../accounting/events";
import { type PostingContext, postEvent } from "../accounting/post";
import { validateDocument } from "../documents/validate";
import { requiresERechnung } from "../einvoice/er03";
import { ustvaMappingFor } from "../rules/ustva";
import { calendarDate } from "../time/calendar-date";
import { checkKuHistoryChange, waiverLockOf } from "./ku-history";
import {
  eightHundredKMonitor,
  gesamtumsatzContribution,
  gesamtumsatzOfYear,
  kuMonitor,
  type TurnoverDoc,
} from "./turnover";
import { computeUstva, entryContributions, KU_UVA_NOTICE, sheetValues, type TaxJournalEntry } from "./ustva";

const D = calendarDate;
const KU = { kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }] };
const findings = (draft = makeDraft(), extra: Parameters<typeof makeContext>[0] = {}, company = {}) =>
  validateDocument(draft, makeContext(extra, { ...KU, ...company })).findings;

describe("KU thresholds (KU-01)", () => {
  test("EC-066 founding year with KU: a Gesamtumsatz of 25,000.01 € makes the crossing supply taxable", () => {
    const company = { foundedOn: "2026-03-01", priorYearTurnover: [] };
    const draft = makeDraft({ lines: [serviceLine({ quantityMilli: 1_000, unitPriceMicros: 1_000_000 })] }); // 100,00 €
    // 24,900.01 € before + 100,00 € = 25,000.01 € > 25,000 € (founding-year cap, not 100,000 €)
    const crossing = findings(draft, { kuYearTurnoverCents: 2_490_001 }, company).find(
      (f) => f.code === "ku_threshold_crossed",
    );
    expect(crossing?.severity).toBe("E");
    expect(crossing?.message.replace(/\s/g, " ")).toContain("Umsatzgrenze von 25.000,00 € überschritten");
    // exactly 25,000.00 € is still within the limit
    expect(
      findings(draft, { kuYearTurnoverCents: 2_490_000 }, company).some((f) => f.code === "ku_threshold_crossed"),
    ).toBe(false);
    // outside the founding year the same amount is far below 100,000 €
    expect(
      findings(draft, { kuYearTurnoverCents: 2_490_001 }, { foundedOn: "2024-03-01" }).some(
        (f) => f.code === "ku_threshold_crossed",
      ),
    ).toBe(false);
    expect(
      kuMonitor({ today: D("2026-12-01"), priorYearCents: 0, currentYearCents: 2_500_001, foundedOn: "2026-03-01" })[1],
    ).toMatchObject({ limitCents: 2_500_000, level: "exceeded" });
  });

  test("EC-061 the prior year turns out above 25,000 € after closing: from 1 January KU drafts are blocked and the monitor flags it", () => {
    const stored = { priorYearTurnover: [{ year: 2026, amountCents: 2_500_001 }] };
    const jan = makeDraft({ supplyDate: { kind: "date", date: "2027-01-02" }, documentDate: "2027-01-04" });
    const outdated = findings(jan, { today: D("2027-01-04") }, stored).find((f) => f.code === "ku_status_outdated");
    expect(outdated?.severity).toBe("E");
    expect(outdated?.message.replace(/\s/g, " ")).toContain(
      "die Kleinunternehmerregelung gilt ab 01.01.2027 nicht mehr. Bitte Steuerstatus aktualisieren.",
    );
    // a December 2026 draft is still judged by 2025 and stays a KU invoice
    const dec = makeDraft({ supplyDate: { kind: "date", date: "2026-12-20" }, documentDate: "2026-12-28" });
    expect(
      findings(
        dec,
        { today: D("2026-12-28") },
        { priorYearTurnover: [...stored.priorYearTurnover, { year: 2025, amountCents: 2_000_000 }] },
      ).some((f) => f.code === "ku_status_outdated"),
    ).toBe(false);
    // the dashboard bar of the prior year on 1 January
    expect(kuMonitor({ today: D("2027-01-01"), priorYearCents: 2_500_001, currentYearCents: 0 })[0]).toMatchObject({
      key: "ku_prior_year",
      year: 2026,
      level: "exceeded",
    });
  });

  test("EC-065 selling a fixed asset is not counted towards the Gesamtumsatz (§ 19 Abs. 2 UStG)", () => {
    const doc = (over: Partial<TurnoverDoc> = {}): TurnoverDoc => ({
      type: "invoice",
      status: "finalized",
      supplyEnd: "2026-05-10",
      netCents: 1_500_000,
      currency: "EUR",
      ...over,
    });
    // the sale of the used delivery van (15,000 €) is an invoice, but its proceeds are excluded
    const vanSale = doc({ assetSaleNetCents: 1_500_000 });
    expect(gesamtumsatzContribution(vanSale)).toBe(0);
    // an invoice with the asset plus regular lines counts only the regular part
    expect(gesamtumsatzContribution(doc({ netCents: 1_800_000, assetSaleNetCents: 1_500_000 }))).toBe(300_000);
    // the Storno of the asset sale takes nothing out either
    expect(
      gesamtumsatzContribution(doc({ type: "cancellation", netCents: -1_500_000, assetSaleNetCents: -1_500_000 })),
    ).toBe(0);
    expect(gesamtumsatzOfYear([doc({ netCents: 2_000_000 }), vanSale], 2026)).toBe(2_000_000);
  });
});

describe("KU waiver lock (KU-04)", () => {
  test("EC-064 switching back to KU within 5 years after a waiver is blocked; with a reason it is allowed (override)", () => {
    for (const [waiverYear, waiverDate, lockEnd] of [
      ["2023", "2023-01-15", "2027-12-31"], // § 19 Abs. 2 UStG a. F.
      ["2026", "2026-02-10", "2030-12-31"], // § 19 Abs. 3 UStG n. F.
    ] as const) {
      const waived = [
        { validFrom: "2020-01-01", isKU: true },
        { validFrom: `${waiverYear}-01-01`, isKU: false, waiverDate },
      ];
      expect(waiverLockOf(waived, `${Number(waiverYear) + 2}-01-01`)).toEqual({ waiverDate, lockEnd });
      const back = [...waived, { validFrom: `${Number(waiverYear) + 2}-01-01`, isKU: true }];
      const blocked = checkKuHistoryChange(waived, back, []);
      expect(blocked.ok).toBe(false);
      expect(!blocked.ok && blocked.error.code).toBe("KU_WAIVER_LOCKED");
      expect(!blocked.ok && blocked.error.message).toContain("Wechsel nur mit Begründung möglich");
      expect(checkKuHistoryChange(waived, back, [], "   ").ok).toBe(false);
      expect(checkKuHistoryChange(waived, back, [], "Widerruf vom Finanzamt zugelassen").ok).toBe(true);
      // after the binding period the switch back needs no reason
      const free = [...waived, { validFrom: `${Number(lockEnd.slice(0, 4)) + 1}-01-01`, isKU: true }];
      expect(checkKuHistoryChange(waived, free, []).ok).toBe(true);
    }
    // leaving KU because the limit was crossed (no waiver) locks nothing
    const crossed = [
      { validFrom: "2020-01-01", isKU: true },
      { validFrom: "2025-07-01", isKU: false },
    ];
    expect(checkKuHistoryChange(crossed, [...crossed, { validFrom: "2027-01-01", isKU: true }], []).ok).toBe(true);
  });
});

describe("KU and VAT on the documents (KU-03, KU-05)", () => {
  test("EC-063 a KU company cannot put VAT on an invoice, not even with a tax-case override or a line category (ku_vat_not_allowed)", () => {
    const viaOverride = makeDraft({ taxCaseOverride: { taxCase: "domestic", reason: "API-Import" } });
    const viaLine = makeDraft({ lines: [serviceLine({ vatCategoryOverride: "S" })] });
    for (const draft of [viaOverride, viaLine]) {
      const f = findings(draft).find((x) => x.code === "ku_vat_not_allowed");
      expect(f?.severity).toBe("E");
      expect(f?.message).toContain("§ 19 UStG");
    }
    expect(findings(makeDraft()).some((f) => f.code === "ku_vat_not_allowed")).toBe(false);
  });

  test("EC-062 a KU company receiving a domestic §13b service owes the VAT: the UStVA is offered with Kz 84/85, KU invoices stay VAT-free", () => {
    const mapping = ustvaMappingFor(2026);
    if (!mapping) throw new Error("mapping 2026 missing");
    const ctx: PostingContext = {
      taxationMethod: "soll",
      legalForm: "einzelunternehmen",
      ustvaPeriod: [{ year: 2026, period: "monthly" }],
    };
    let seq = 0;
    const post = (e: BusinessEvent): TaxJournalEntry => {
      const r = postEvent(e as Exclude<BusinessEvent, ReversalEvent>, ctx);
      if (!r.ok || r.value.kind !== "entry") throw new Error(`no entry: ${JSON.stringify(r)}`);
      seq++;
      return {
        id: `e${seq}`,
        seq,
        date: r.value.posting.date,
        recordedAt: seq,
        source: r.value.posting.source,
        text: r.value.posting.text,
        lines: r.value.posting.lines.map((l) => ({ ...l, account: l.account ?? "" })),
      };
    };
    const kuInvoice = post({
      kind: "invoice_finalised",
      documentId: "ku1",
      documentNumber: "RE-2026-0001",
      documentType: "invoice",
      date: "2026-09-03",
      supplyDate: { kind: "date", date: "2026-09-03" },
      taxCase: "kleinunternehmer",
      contactId: "c1",
      vatGroups: [{ category: "KU", rateBp: 0, netCents: 50_000, vatCents: 0 }],
    });
    const rc13b = post({
      kind: "voucher_booked",
      voucherId: "v1",
      number: "BE-2026-00001",
      direction: "expense",
      voucherKind: "standard",
      taxRule: "reverse_charge_13b_de",
      companyIsKu: true,
      date: "2026-09-15",
      supplyDate: { kind: "date", date: "2026-09-10" },
      receivedDate: "2026-09-12",
      lines: [{ account: "3120", netCents: 100_000, vatCents: 0, vatRateBp: 1900, selfAssessedVatCents: 19_000 }],
    });
    const contributions = [kuInvoice, rc13b].flatMap((e) => entryContributions(e, mapping));
    const sheet = computeUstva("2026-09", contributions, mapping, { ku: true });
    expect(sheet.required).toBe(true);
    expect(sheet.notices).toContain(KU_UVA_NOTICE);
    // § 13b Abs. 2 Nr. 4 base and tax, payable in full (no input VAT deduction for a KU)
    expect(sheetValues(sheet)).toEqual({ "84": 100_000, "85": 19_000, "83": 19_000 });
    // the KU invoice contributes no output VAT
    expect(sheet.fields.some((f) => f.kz === "81")).toBe(false);
  });
});

describe("ER-03 threshold year (10 §3.2)", () => {
  const er03 = (cents: number, final: boolean) =>
    requiresERechnung({
      docType: "invoice",
      taxCase: "domestic",
      issuer: { isKleinunternehmer: false, priorYearTurnover: { cents, final } },
      recipient: { countryCode: "DE", isConsumer: false, isPublicAuthority: false },
      refDate: "2027-02-10",
      grossEurCents: 119_000,
    });

  test("EC-029 a 2027 B2B invoice uses the final 2026 Gesamtumsatz, else the running total with a warning; December warns when approaching 800k", () => {
    expect(er03(79_000_000, true)).toMatchObject({ decision: "PDF_NEEDS_CONSENT", warnings: [] });
    expect(er03(80_000_001, true)).toMatchObject({ decision: "MUST_E", warnings: [] });
    // year not closed yet: running total, flagged as provisional
    expect(er03(75_000_000, false)).toMatchObject({
      decision: "PDF_NEEDS_CONSENT",
      warnings: ["turnover_provisional"],
    });
    expect(er03(81_000_000, false)).toMatchObject({ decision: "MUST_E", warnings: ["turnover_provisional"] });

    const base = { priorYearCents: 0, taxationMethod: "soll" as const, bookkeepingDuty: false };
    // the 2026 total crosses 800k only in late December: the owner is warned before the year ends …
    const approaching = eightHundredKMonitor({ ...base, today: D("2026-12-01"), currentYearCents: 74_000_000 });
    expect(approaching.map((n) => n.code)).toEqual(["er03_threshold_approaching"]);
    expect(approaching[0]?.message.replace(/\s/g, " ")).toBe(
      "Gesamtumsatz 2026: 740.000,00 € (Grenze 800.000,00 €). Wird die Grenze bis 31.12.2026 überschritten, müssen Sie ab 01.01.2027 B2B-Rechnungen im Inland als E-Rechnung ausstellen.",
    );
    // … only in December and only near the limit
    expect(eightHundredKMonitor({ ...base, today: D("2026-11-30"), currentYearCents: 74_000_000 })).toEqual([]);
    expect(eightHundredKMonitor({ ...base, today: D("2026-12-01"), currentYearCents: 50_000_000 })).toEqual([]);
    // once crossed, the mandatory notice replaces the approaching one
    expect(
      eightHundredKMonitor({ ...base, today: D("2026-12-28"), currentYearCents: 80_000_001 }).map((n) => n.code),
    ).toEqual(["er03_mandatory_next_year"]);
  });
});
