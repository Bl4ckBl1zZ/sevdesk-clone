import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { invoiceEvent, OWNER, post, setupBooks } from "./bookkeeping.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { taxReserveView, vatAccountSet } from "./model/taxReserve";
import { makeT, type TestT } from "./test.setup";
import { header, line, setupCompany, upload } from "./vouchers.fixtures";

/**
 * F08 RPT-010/RPT-011 tax reserve: the branches of the read model (Bilanz accrual profit, legal-form entity, KU,
 * prepayments by subtype, saved vs. override assumptions) and of the assumption setting's guards.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-20T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);

const NOW = Date.parse("2026-10-20T10:00:00Z");

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

/** A finalised tax-payment voucher (TAX-018) through the real voucher path. */
async function taxPaymentVoucher(
  t: TestT,
  owner: Owner,
  subtype: "est_private" | "gewerbesteuer" | "kst" | "ust_prepayment",
  account: string,
  amountCents: number,
  o: { period?: string; documentDate?: string; finalize?: boolean } = {},
): Promise<Id<"vouchers">> {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, {
    id: voucherId,
    input: header({
      kind: "tax_payment",
      supplierName: "Finanzamt Berlin",
      supplierVatId: undefined,
      taxRule: "no_input_vat",
      documentDate: o.documentDate ?? "2026-10-05",
      taxPayment: { subtype, ...(o.period ? { period: o.period } : {}) },
      lines: [line({ account, description: subtype, amountCents, vatRateBp: 0 })],
    }),
  });
  if (o.finalize !== false) await owner.mutation(api.vouchers.finalize, { id: voucherId });
  return voucherId;
}

describe("tax reserve read model branches (RPT-010, RPT-011)", () => {
  test("RPT-010 an invalid year is refused; without a company profile the setup is incomplete", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const bad = await owner.query(api.reports.taxReserve, { year: 1999 }).catch((e: unknown) => e);
    expect(errorCode(bad)).toBe("invalid_input");
    expect(messageOf(bad)).toBe("Ungültiges Jahr.");
    const frac = await owner.query(api.reports.taxReserve, { year: 2026.5 }).catch((e: unknown) => e);
    expect(errorCode(frac)).toBe("invalid_input");
    const none = await owner.query(api.reports.taxReserve, { year: 2026 }).catch((e: unknown) => e);
    expect(errorCode(none)).toBe("setup_incomplete");
  });

  test("RPT-010 a Bilanz company: the YTD profit is the accrual result of revenue and expense accounts of the year", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { profitMethod: [{ validFromFiscalYear: 2025, method: "bilanz" }] },
        { action: "settings.tax.update" },
      ),
    );
    // an invoice of the previous year does not count; the unpaid 2026 invoice does (accrual, not cash)
    await post(t, invoiceEvent(b.customer, "d0", "2025-11-10", 50_000));
    await post(t, invoiceEvent(b.customer, "d1", "2026-03-10", 300_000));
    const viewer = await t.asUser("viewer");
    const r = await viewer.query(api.reports.taxReserve, { year: 2026, hebesatzBp: 40_000 });
    expect(r.profit).toMatchObject({ ytdCents: 300_000, basis: "annualised", monthsElapsed: 10 });
    expect(r.assumptions.join(" ")).toContain("Soll-Ergebnis");
    // the open USt of both invoices (19 % of 3 500 €) is the VAT account balance on today
    expect(r.ust.openCents).toBe(66_500);
    expect(r.notices).toEqual([]);
  });

  test("RPT-010 a past year is computed up to 31.12.; a year without an EÜR mapping falls back to the latest mapping", async () => {
    const t = makeT();
    const b = await setupBooks(t, { ku: true, chart: "SKR04" });
    const viewer = await t.asUser("viewer");
    await post(
      t,
      invoiceEvent(b.customer, "k1", "2025-05-10", 100_000, {
        taxCase: "kleinunternehmer",
        vatGroups: [{ category: "E", rateBp: 0, netCents: 100_000, vatCents: 0 }],
      }),
    );
    const past = await viewer.query(api.reports.taxReserve, { year: 2025 });
    // no payment → EÜR income 0; the full year elapsed; a KU company has no open USt
    expect(past.profit).toMatchObject({ ytdCents: 0, monthsElapsed: 12 });
    expect(past.monthsLeft).toBe(0);
    expect(past.monthlyCents).toBe(0);
    expect(past.ust.openCents).toBe(0);
    expect(past.profit.basis).toBe("annualised");
    const future = await viewer.query(api.reports.taxReserve, { year: 2027 });
    expect(future.profit.ytdCents).toBe(0);
    expect(future.banner).toBe("Tarif 2027 noch nicht hinterlegt – Berechnung mit Tarif 2026.");
  });

  test("RPT-010 a GmbH is taxed as a corporation (KSt + Soli, GewSt without allowance); KSt and GewSt prepayment vouchers of the year count, a draft does not", async () => {
    const t = makeT();
    await setupCompany(t, { legalForm: "gmbh" });
    const owner = await t.asUser("owner");
    await taxPaymentVoucher(t, owner, "kst", "7600", 100_000);
    await taxPaymentVoucher(t, owner, "gewerbesteuer", "7610", 50_000);
    await taxPaymentVoucher(t, owner, "kst", "7600", 999_00, { finalize: false });
    const r = await owner.query(api.reports.taxReserve, { year: 2026, profitOverrideCents: 10_000_000 });
    expect(r.legalForm).toBe("gmbh");
    expect(r.persons).toEqual([]);
    expect(r.kst).toEqual({ kstCents: 1_500_000, soliCents: 82_500 });
    expect(r.gewst?.gewerbeertragCents).toBe(10_000_000);
    expect(r.prepaidCents).toBe(150_000);
    expect(r.assumptions).toContain(
      "Körperschaft: Körperschaftsteuer 15 % zzgl. Solidaritätszuschlag 5,5 %, Gewerbesteuer ohne Freibetrag.",
    );
    expect(r.notices).toContain(
      "Hebesatz nicht hinterlegt – 400 % angenommen. Bitte den Hebesatz Ihrer Gemeinde eintragen.",
    );
  });

  test("RPT-010 ESt prepayments of the year (by period, else by document date) reduce the remainder; a Freiberufler pays no GewSt", async () => {
    const t = makeT();
    await setupCompany(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { legalForm: "freiberufler" }, { action: "settings.tax.update" }),
    );
    const owner = await t.asUser("owner");
    await taxPaymentVoucher(t, owner, "est_private", "2150", 120_000);
    await taxPaymentVoucher(t, owner, "est_private", "2150", 80_000, { documentDate: "2026-09-10" });
    const r = await owner.query(api.reports.taxReserve, {
      year: 2026,
      profitOverrideCents: 6_000_000,
      splitting: true,
      churchTaxBp: 900,
      deductionsCents: 500_000,
    });
    expect(r.gewst).toBeNull();
    expect(r.prepaidCents).toBe(200_000);
    expect(r.persons).toHaveLength(1);
    expect(r.persons[0]).toMatchObject({ name: "Inhaber/in", shareBp: 10_000, zveCents: 5_500_000 });
    expect(r.persons[0]?.churchTaxCents).toBeGreaterThan(0);
    expect(r.assumptions).toEqual(
      expect.arrayContaining([
        "Zusammenveranlagung (Splittingtarif).",
        "Keine Gewerbesteuer (freiberufliche Tätigkeit).",
      ]),
    );
    expect(r.assumptions.find((a) => a.startsWith("Vorauszahlungen 2026"))?.replace(/\s/g, " ")).toBe(
      "Vorauszahlungen 2026 laut erfassten Steuerzahlungen: 2.000,00 €.",
    );
    // no Hebesatz notice without GewSt
    expect(r.notices).toEqual([]);
  });

  test("RPT-010 a partnership splits the profit by the saved partner shares; saved deductions, splitting and church tax apply", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    await t.model(OWNER, (ctx) => patchCompanyProfile(ctx, { legalForm: "gbr" }, { action: "settings.tax.update" }));
    const owner = await t.asUser("owner");
    await owner.mutation(api.taxes.saveTaxReserveInputs, {
      year: 2026,
      profitOverrideCents: 8_000_000,
      deductionsCents: 100_000,
      splitting: true,
      churchTaxBp: 800,
      gewerbesteuerHebesatzBp: 41_000,
      partners: [
        { name: "Anna", shareBp: 6000 },
        { name: "Ben", shareBp: 4000 },
      ],
    });
    const r = await owner.query(api.reports.taxReserve, { year: 2026 });
    expect(r.persons.map((p) => [p.name, p.profitCents, p.zveCents])).toEqual([
      ["Anna", 4_800_000, 4_700_000],
      ["Ben", 3_200_000, 3_100_000],
    ]);
    expect(r.saved).toMatchObject({ year: 2026, churchTaxBp: 800, gewerbesteuerHebesatzBp: 41_000 });
    expect(r.assumptions.join(" ")).toContain("Gewinnverteilung: Anna 60 %, Ben 40 %");
    expect(r.assumptions).toContain("Gewerbesteuer: Hebesatz 410 %, keine Hinzurechnungen oder Kürzungen.");
  });

  test("RPT-010 the open UStVA periods up to the current month are listed; the VAT account set can leave out the prepayment account", async () => {
    const t = makeT();
    const b = await setupBooks(t, { chart: "SKR04" });
    await post(t, invoiceEvent(b.customer, "d1", "2026-09-10", 100_000));
    const r = await t.run((ctx) => taxReserveView(ctx, 2026, NOW, {}));
    expect(r.ust.periods).toEqual(expect.arrayContaining(["01/2026", "09/2026"]));
    expect(r.ust.periods).not.toContain("11/2026");
    const profile = await t.run((ctx) => ctx.db.query("companyProfile").first());
    if (!profile) throw new Error("no profile");
    const all = await t.run(async (ctx) => [...(await vatAccountSet(ctx, profile, "2026-10-20"))]);
    const noPrepay = await t.run(async (ctx) => [
      ...(await vatAccountSet(ctx, profile, "2026-10-20", { withPrepayments: false })),
    ]);
    // SKR04 3820 = USt-Vorauszahlungen (BA.UST_GEZAHLT) is left out; Umsatzsteuer and Vorsteuer stay
    expect(all).toContain("3820");
    expect(noPrepay).not.toContain("3820");
    expect(noPrepay).toContain("3806");
    expect(noPrepay).toContain("1406");
  });
});

describe("tax reserve assumptions setting (RPT-010)", () => {
  test("RPT-010 amounts must be whole cents, deductions not negative, the Hebesatz between 200 % and 1.500 %", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    const save = (over: Record<string, unknown>) =>
      owner
        .mutation(api.taxes.saveTaxReserveInputs, { year: 2026, splitting: false, ...over })
        .catch((e: unknown) => e);
    const frac = await save({ profitOverrideCents: 10.5 });
    expect(errorCode(frac)).toBe("invalid_input");
    expect(messageOf(frac)).toBe("Beträge müssen ganze Cent sein.");
    const neg = await save({ deductionsCents: -1 });
    expect(messageOf(neg)).toBe("Abzüge dürfen nicht negativ sein.");
    const low = await save({ gewerbesteuerHebesatzBp: 19_999 });
    expect(messageOf(low)).toBe("Der Hebesatz muss zwischen 200 % und 1.500 % liegen.");
    const high = await save({ gewerbesteuerHebesatzBp: 150_001 });
    expect(errorCode(high)).toBe("invalid_input");
    expect(await t.run((ctx) => ctx.db.query("taxReserveInputs").collect())).toEqual([]);
  });

  test("RPT-010 saving again updates the row of the year; null clears an override and the estimate annualises again", async () => {
    const t = makeT();
    await setupBooks(t, { chart: "SKR04" });
    const owner = await t.asUser("owner");
    await owner.mutation(api.taxes.saveTaxReserveInputs, {
      year: 2026,
      profitOverrideCents: 5_000_000,
      deductionsCents: 10_000,
      splitting: false,
      gewerbesteuerHebesatzBp: 40_000,
    });
    await owner.mutation(api.taxes.saveTaxReserveInputs, {
      year: 2026,
      profitOverrideCents: null,
      deductionsCents: null,
      gewerbesteuerHebesatzBp: null,
      splitting: true,
    });
    const rows = await t.run((ctx) => ctx.db.query("taxReserveInputs").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ year: 2026, splitting: true });
    expect(rows[0]?.profitOverrideCents).toBeUndefined();
    expect(rows[0]?.deductionsCents).toBeUndefined();
    expect(rows[0]?.gewerbesteuerHebesatzBp).toBeUndefined();
    const r = await owner.query(api.reports.taxReserve, { year: 2026 });
    expect(r.profit.basis).toBe("annualised");
    expect(r.assumptions).toContain("Zusammenveranlagung (Splittingtarif).");
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((e) => e.action === "settings.tax_reserve.update")).toHaveLength(2);
  });
});
