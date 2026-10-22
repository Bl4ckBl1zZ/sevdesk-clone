/**
 * F08 §5.2 / §5.5 edge cases whose rule lives in another feature's domain module (F01 settings, F04 document
 * validation, F05 payments, F06 voucher tax rules) — one implementation, exercised here with the F08 IDs.
 */
import { makeContext, makeDraft } from "@test/factories/documents";
import { describe, expect, test } from "vitest";
import { validateDocument } from "../documents/validate";
import { formatEuro } from "../money";
import { planPayment, type TargetFacts, targetKey } from "../payments/plan";
import { taxDefaults, taxSchema } from "../schemas/settings";
import { calendarDate } from "../time/calendar-date";
import { checkTaxRule } from "../vouchers/tax-rules";
import { eightHundredKMonitor, kuMonitor, ossBlock } from "./turnover";

const D = calendarDate;
/** formatEuro uses a narrow no-break space before „€“. */
const nb = (s: string) => s.replace(/ | /g, " ");

describe("KU and 800k monitors (TAX-012, TAX-013)", () => {
  const company = {
    kleinunternehmer: [{ validFrom: "2025-01-01", isKU: true }],
    priorYearTurnover: [{ year: 2025, amountCents: 2_000_000 }],
  };
  const findingOf = (kuYearTurnoverCents: number, code: string, extra: Record<string, unknown> = {}) =>
    validateDocument(makeDraft(), makeContext({ kuYearTurnoverCents }, { ...company, ...extra })).findings.find(
      (f) => f.code === code,
    );

  test("E-TAX-10 KU-01 the invoice that would cross 100,000 € is blocked: it and all later invoices are taxed; earlier ones stay KU", () => {
    const crossing = findingOf(9_995_000, "ku_threshold_crossed");
    expect(crossing?.severity).toBe("E");
    expect(nb(crossing?.message ?? "")).toBe(
      "Mit dieser Rechnung wird die Umsatzgrenze von 100.000,00 € überschritten. Diese und alle folgenden Rechnungen müssen mit Umsatzsteuer ausgestellt werden. Steuerstatus jetzt umstellen?",
    );
    // an invoice that stays below the limit is a normal KU invoice (no correction of earlier invoices)
    expect(findingOf(5_000_000, "ku_threshold_crossed")).toBeUndefined();
  });

  test("E-RPT-10 KU 80 % / 95 % of 100,000 € warn with the amount", () => {
    const at80 = validateDocument(makeDraft(), makeContext({ kuYearTurnoverCents: 8_000_000 }, company)).findings.find(
      (f) => f.code.startsWith("ku_threshold_"),
    );
    expect(at80?.code).toBe("ku_threshold_80");
    expect(at80?.severity).toBe("W");
    expect(nb(at80?.message ?? "")).toMatch(/^Kleinunternehmergrenze zu 80 % erreicht \(.+ € von 100\.000,00 €\)\.$/);
    const at95 = validateDocument(makeDraft(), makeContext({ kuYearTurnoverCents: 9_500_000 }, company)).findings.find(
      (f) => f.code.startsWith("ku_threshold_"),
    );
    expect(at95?.code).toBe("ku_threshold_95");
    // dashboard bars use the same thresholds
    const [, current] = kuMonitor({ today: D("2026-10-12"), priorYearCents: 0, currentYearCents: 7_999_999 });
    expect(current?.level).toBe("ok");
    expect(kuMonitor({ today: D("2026-10-12"), priorYearCents: 0, currentYearCents: 8_000_000 })[1]?.level).toBe(
      "warn_80",
    );
    expect(kuMonitor({ today: D("2026-10-12"), priorYearCents: 0, currentYearCents: 9_500_000 })[1]?.level).toBe(
      "warn_95",
    );
  });

  test("E-RPT-11 founding year: the 25,000 € cap blocks like E-TAX-10", () => {
    const founding = findingOf(2_495_000, "ku_threshold_crossed", {
      foundedOn: `${makeContext().today.slice(0, 4)}-02-01`,
    });
    expect(founding?.severity).toBe("E");
    expect(nb(founding?.message ?? "")).toContain("Umsatzgrenze von 25.000,00 € überschritten");
    expect(
      kuMonitor({ today: D("2026-10-12"), priorYearCents: 0, currentYearCents: 2_500_001, foundedOn: "2026-03-01" })[1],
    ).toMatchObject({ limitCents: 2_500_000, level: "exceeded" });
  });

  test("E-RPT-12 AO-01 ER-03 UVA-06 prior-year turnover above 800,000 €: bookkeeping info, ER-03 and the end of Ist", () => {
    const base = { today: D("2026-10-12"), currentYearCents: 0, bookkeepingDuty: false };
    expect(eightHundredKMonitor({ ...base, priorYearCents: 80_000_000, taxationMethod: "ist" })).toEqual([]);
    const notices = eightHundredKMonitor({ ...base, priorYearCents: 80_000_001, taxationMethod: "ist" });
    expect(notices.map((n) => n.code)).toEqual(["bookkeeping_duty_info", "ist_limit_exceeded"]);
    expect(nb(notices[0]?.message ?? "")).toContain(
      "Eine Buchführungspflicht beginnt erst nach Mitteilung durch das Finanzamt.",
    );
    // ER-03: the 2026 turnover above 800,000 € makes E-Rechnungen mandatory from 2027
    const er = eightHundredKMonitor({
      ...base,
      priorYearCents: 0,
      currentYearCents: 80_000_001,
      taxationMethod: "soll",
    });
    expect(nb(er.find((n) => n.code === "er03_mandatory_next_year")?.message ?? "")).toContain(
      "Ab 01.01.2027 müssen Sie B2B-Rechnungen im Inland als E-Rechnung ausstellen.",
    );
  });
});

describe("tax timing rules in other features (E-TAX-13, E-TAX-17, E-TAX-18, E-TAX-20, E-TAX-21)", () => {
  test("E-TAX-13 PAY-025 a write-off without a reason is blocked", () => {
    const inv: TargetFacts = {
      ref: { kind: "salesDocument", id: "inv1" },
      contactId: "c1",
      number: "RE-2026-0001",
      docType: "invoice",
      status: "sent",
      paymentStatus: "open",
      currency: "EUR",
      documentDate: "2026-03-09",
      dueDate: "2026-04-08",
      payableCents: 119000,
      openAmountCents: 119000,
      groups: [{ category: "S", rateBp: 1900, grossCents: 119000 }],
      taxedAs: "soll",
      methodOnDate: "soll",
    };
    const r = planPayment(
      {
        source: { kind: "adjustment" },
        date: "2026-10-13",
        allocations: [{ target: inv.ref, amountCents: 0, differences: [{ reason: "write_off", amountCents: 119000 }] }],
      },
      {
        today: "2026-10-13",
        closedPeriods: new Set(),
        source: { kind: "clearing", clearing: { currency: "EUR" } },
        targets: new Map([[targetKey(inv.ref), inv]]),
      },
    );
    expect(!r.ok && r.error.code).toBe("write_off_reason");
    expect(!r.ok && r.error.message).toBe(
      "Bitte den Grund des Forderungsausfalls angeben (Insolvenz, uneinbringlich, verjährt, Verzicht).",
    );
  });

  test("E-TAX-17 an igE voucher without the supplier's EU USt-IdNr is blocked (reverse-charge services only warn)", () => {
    const ige = checkTaxRule({ taxRule: "intra_community_acquisition", vatShownCents: 0, ownVatId: "DE123456788" });
    expect(ige.errors.map((e) => [e.code, e.message])).toEqual([
      [
        "supplier_vat_id_missing",
        "Für einen innergemeinschaftlichen Erwerb ist die USt-IdNr des Lieferanten erforderlich.",
      ],
    ]);
    const deSupplier = checkTaxRule({
      taxRule: "intra_community_acquisition",
      vatShownCents: 0,
      ownVatId: "DE123456788",
      supplierVatId: "DE123456789",
    });
    expect(deSupplier.errors.map((e) => e.code)).toEqual(["supplier_vat_id_missing"]);
    const ok = checkTaxRule({
      taxRule: "intra_community_acquisition",
      vatShownCents: 0,
      ownVatId: "DE123456788",
      supplierVatId: "ATU12345678",
    });
    expect(ok.errors).toEqual([]);
    // §13b EU service without a supplier VAT ID stays a ⚑ warning (EC-VOU-13)
    const rc = checkTaxRule({ taxRule: "reverse_charge_eu", vatShownCents: 0 });
    expect(rc.errors).toEqual([]);
    expect(rc.warnings.map((w) => w.code)).toEqual(["supplier_vat_id_not_eu"]);
  });

  test("E-TAX-18 EC-VOU-12 a reverse-charge voucher with VAT shown by the supplier is blocked", () => {
    for (const taxRule of ["reverse_charge_eu", "reverse_charge_non_eu", "reverse_charge_13b_de"] as const) {
      const r = checkTaxRule({ taxRule, vatShownCents: 1900, supplierVatId: "ATU12345678" });
      expect(r.errors.map((e) => [e.code, e.message])).toContainEqual([
        "reverse_charge_vat_shown",
        "Bei Reverse Charge darf der Lieferant keine Umsatzsteuer ausweisen. Bitte Steuerregel oder Beträge prüfen.",
      ]);
    }
  });

  test("E-TAX-20 UVA-07 a B2C EU invoice that would exceed 10,000 € EU-wide is blocked", () => {
    const date = D("2026-10-12");
    expect(ossBlock({ thisNetEurCents: 10_000, priorYearEurCents: 0, currentYearEurCents: 990_000, date })).toBeNull();
    const over = ossBlock({ thisNetEurCents: 20_000, priorYearEurCents: 0, currentYearEurCents: 990_000, date });
    expect(over?.code).toBe("oss_threshold_exceeded");
    expect(nb(over?.message ?? "")).toBe(
      `Ihre EU-Fernverkäufe an Privatkunden überschreiten ${nb(formatEuro(1_000_000))}. Das OSS-Verfahren wird erst in einer späteren Version unterstützt; diese Rechnung kann nicht mit deutscher Umsatzsteuer ausgestellt werden.`,
    );
  });

  test("E-TAX-21 TAX-014 a Bilanz legal form cannot select the EÜR", () => {
    for (const [legalForm, label] of [
      ["gmbh", "GmbH"],
      ["ug", "UG (haftungsbeschränkt)"],
      ["kg", "KG"],
    ] as const) {
      const r = taxSchema.safeParse({ ...taxDefaults(legalForm), vatId: "DE123456788", profitMethod: "euer" });
      expect(r.success).toBe(false);
      const msg = r.success ? "" : r.error.issues.find((i) => i.path[0] === "profitMethod")?.message;
      expect(msg).toBe(
        `Für ${label} ist die Einnahmen-Überschuss-Rechnung nicht zulässig (Buchführungspflicht nach HGB).`,
      );
    }
    expect(taxSchema.safeParse({ ...taxDefaults("gmbh"), vatId: "DE123456788", profitMethod: "bilanz" }).success).toBe(
      true,
    );
  });
});
