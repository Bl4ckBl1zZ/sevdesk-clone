import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { finalizedInvoice, invoiceValues } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, setupCompany, upload } from "./vouchers.fixtures";

/** Branch coverage of the asset register (F08 AST-001…AST-013): guards, optional parameters, reads and disposals. */

const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return { code: errorCode(e), message: messageOf(e) };
  }
  throw new Error("expected an error");
};

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

const desk = (over: Record<string, unknown> = {}) => ({
  name: "Schreibtisch",
  account: "0650",
  acquisitionDate: "2026-02-10",
  costCents: 240_000,
  method: "linear" as const,
  usefulLifeMonths: 24,
  inputVatDeducted: true,
  ...over,
});

async function company(t: TestT, opts: { ku?: boolean } = {}) {
  await setupCompany(t, opts);
  return t.asUser("owner");
}

async function bookVoucher(t: TestT, owner: Owner, lines: Record<string, unknown>[]) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, {
    id: voucherId,
    input: header({ documentDate: "2026-03-05", priceMode: "net", lines: lines.map((l) => line(l)) }),
  });
  await owner.mutation(api.vouchers.finalize, { id: voucherId });
  return voucherId;
}

describe("AST-001 AST-003 asset setup guards", () => {
  test("AST-001 invalid date, empty or too long name, a non-depreciable account and a rejected method are refused", async () => {
    const t = makeT();
    const owner = await company(t);
    const create = (over: Record<string, unknown>) => fail(owner.mutation(api.assets.create, desk(over)));
    expect(await create({ acquisitionDate: "2026-02-30" })).toEqual({
      code: "invalid_input",
      message: "Ungültiges Anschaffungsdatum.",
    });
    expect((await create({ name: "  " })).message).toBe("Bitte eine Bezeichnung angeben.");
    expect((await create({ name: "x".repeat(201) })).message).toBe("Bitte eine Bezeichnung angeben.");
    expect(await create({ account: "4400" })).toEqual({
      code: "asset_rejected",
      message: "Dieses Konto ist kein abnutzbares Anlagekonto.",
    });
    // E-AST-02 degressive only for movable assets
    expect(await create({ account: "0135", method: "degressive" })).toEqual({
      code: "asset_rejected",
      message: "Degressive AfA gilt nur für bewegliche Wirtschaftsgüter.",
    });
    // E-AST-11 linear without useful life
    expect((await create({ usefulLifeMonths: undefined })).message).toBe("Bitte Nutzungsdauer angeben (AfA-Tabelle).");
    expect(await t.run((ctx) => ctx.db.query("assets").collect())).toEqual([]);
  });

  test("AST-001 without a company profile the register refuses with setup_incomplete", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    expect((await fail(owner.mutation(api.assets.create, desk()))).code).toBe("setup_incomplete");
    expect((await fail(owner.query(api.assets.list, { year: 2026 }))).code).toBe("setup_incomplete");
  });

  test("AST-004 E-AST-15 degressive AfA stores the rate; optional parameters (key, cost centre, notes, Erinnerungswert) are kept", async () => {
    const t = makeT();
    const owner = await company(t);
    await owner.mutation(api.lookups.saveCostCenter, {
      values: { number: "100", name: "Webdesign", isDefault: false },
    });
    const cc = (await owner.query(api.lookups.listCostCenters, {})).find((c) => c.number === "100")
      ?.costCenterId as Id<"costCenters">;
    const id = await owner.mutation(api.assets.create, {
      ...desk({ method: "degressive", usefulLifeMonths: 120 }),
      usefulLifeKey: "6.13.1",
      costCenterId: cc,
      notes: "  Büro 1  ",
      erinnerungswert: true,
    });
    const a = await t.run((ctx) => ctx.db.get(id));
    expect(a).toMatchObject({
      method: "degressive",
      usefulLifeKey: "6.13.1",
      costCenterId: cc,
      notes: "Büro 1",
      erinnerungswert: true,
      assetClass: "movable",
    });
    expect(a?.degressiveRateBp).toBeGreaterThan(0);
    // E-AST-15 the e-vehicle special AfA needs the qualification
    const ev = await fail(
      owner.mutation(
        api.assets.create,
        desk({ name: "E-Auto", account: "0520", method: "ev_special", evQualified: false }),
      ),
    );
    expect(ev).toEqual({
      code: "asset_rejected",
      message: "Die Sonder-AfA gilt nur für neue, rein elektrische Fahrzeuge.",
    });
    const evId = await owner.mutation(
      api.assets.create,
      desk({ name: "E-Auto", account: "0520", method: "ev_special", evQualified: true, costCents: 4_000_000 }),
    );
    const evAsset = await t.run((ctx) => ctx.db.get(evId));
    expect(evAsset?.evQualified).toBe(true);
    expect(evAsset?.evScheduleBp?.length).toBeGreaterThan(0);
    // the plan of the e-vehicle uses the schedule
    const detail = await owner.query(api.assets.detail, { id: evId });
    expect(detail.plan.length).toBeGreaterThan(0);
    expect(detail.afaRole).toBeTruthy();
  });

  test("AST-003 method options: invalid date, a non-asset account and the year's policy", async () => {
    const t = makeT();
    const owner = await company(t);
    expect(
      await owner.query(api.assets.methodOptions, { account: "0650", acquisitionDate: "kein", costCents: 50_000 }),
    ).toMatchObject({ assetClass: null, methods: [], yearPolicy: null, gwgLimitCents: null });
    const none = await owner.query(api.assets.methodOptions, {
      account: "4400",
      acquisitionDate: "2026-03-01",
      costCents: 50_000,
    });
    expect(none).toMatchObject({ assetClass: null, methods: [], gwgLimitCents: 80_000 });
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { assetPolicy: [{ fiscalYear: 2026, mode250to1000: "pool", erinnerungswert: false }] },
        { action: "settings.asset_policy.update" },
      ),
    );
    const opts = await owner.query(api.assets.methodOptions, {
      account: "0650",
      acquisitionDate: "2026-03-01",
      costCents: 50_000,
    });
    expect(opts.assetClass).toBe("movable");
    expect(opts.yearPolicy).toBe("pool");
    expect(opts.methods.length).toBeGreaterThan(0);
    expect(opts.usefulLives.length).toBeGreaterThan(0);
  });
});

describe("AST-001 AST-002 updates of voucher-linked and voided assets", () => {
  test("AST-001 a voucher-linked asset keeps account, cost and date; GWG/Sammelposten stay with the voucher; a voided asset cannot be changed", async () => {
    const t = makeT();
    const owner = await company(t);
    const voucherId = await bookVoucher(t, owner, [
      { account: "0650", description: "Regal", amountCents: 240_000, assetDecision: "asset" },
      { account: "0650", description: "Stuhl", amountCents: 70_000, assetDecision: "gwg" },
    ]);
    const assets = await t.run((ctx) => ctx.db.query("assets").collect());
    const regal = assets.find((a) => a.name === "Regal");
    const stuhl = assets.find((a) => a.name === "Stuhl");
    if (!regal || !stuhl) throw new Error("assets missing");
    const update = (id: Id<"assets">, over: Record<string, unknown>) =>
      owner.mutation(api.assets.update, {
        id,
        ...desk({ name: "Regal", acquisitionDate: regal.acquisitionDate, costCents: 240_000 }),
        ...over,
      });
    expect(await fail(update(regal._id, { costCents: 200_000 }))).toEqual({
      code: "invalid_input",
      message: "Konto, Anschaffungskosten und -datum kommen aus dem Beleg. Bitte den Beleg korrigieren.",
    });
    expect((await fail(update(regal._id, { method: "gwg" }))).message).toBe(
      "GWG und Sammelposten werden im Beleg festgelegt. Bitte den Beleg korrigieren.",
    );
    expect(
      (
        await fail(
          update(stuhl._id, {
            name: "Stuhl",
            account: stuhl.account,
            costCents: stuhl.costCents,
            acquisitionDate: stuhl.acquisitionDate,
            method: "pool",
          }),
        )
      ).message,
    ).toBe("GWG und Sammelposten werden im Beleg festgelegt. Bitte den Beleg korrigieren.");
    await update(regal._id, { erinnerungswert: true });
    expect((await t.run((ctx) => ctx.db.get(regal._id)))?.erinnerungswert).toBe(true);
    // the detail shows the voucher number
    const detail = await owner.query(api.assets.detail, { id: regal._id });
    expect(detail.voucher).toMatchObject({ _id: voucherId, number: expect.stringMatching(/^BE-/) });
    // cancel the voucher → assets voided → no update, no disposal, status „Storniert“
    await owner.mutation(api.vouchers.cancel, { id: voucherId, reason: "Falscher Lieferant" });
    expect((await fail(update(regal._id, {}))).message).toBe("Die Anlage wurde storniert.");
    expect(
      (await fail(owner.mutation(api.assets.dispose, { id: regal._id, date: "2026-04-01", kind: "scrap" }))).message,
    ).toBe("Die Anlage wurde storniert.");
    const list = await owner.query(api.assets.list, { year: 2026 });
    expect(list.find((r) => r._id === regal._id)).toMatchObject({
      bookValueCents: 0,
      status: { key: "voided", label: "Storniert" },
      voucherId,
    });
    expect(await owner.query(api.assets.anlagenspiegel, { year: 2026 })).toMatchObject({ assets: [] });
  });

  test("AST-001 unknown asset ids and empty notes", async () => {
    const t = makeT();
    const owner = await company(t);
    const id = await owner.mutation(api.assets.create, desk({ notes: "Altbau" }));
    await owner.mutation(api.assets.setNotes, { id, notes: "   " });
    expect((await t.run((ctx) => ctx.db.get(id)))?.notes).toBeUndefined();
    const ghost = await t.run(async (ctx) => {
      const a = await ctx.db.get(id);
      if (!a) throw new Error("x");
      const { _id, _creationTime, ...rest } = a;
      const g = await ctx.db.insert("assets", { ...rest, inventoryNumber: "tmp" });
      await ctx.db.delete(g);
      return g;
    });
    expect(await fail(owner.query(api.assets.detail, { id: ghost }))).toEqual({
      code: "not_found",
      message: "Die Anlage existiert nicht.",
    });
    expect((await fail(owner.mutation(api.assets.setNotes, { id: ghost, notes: "x" }))).code).toBe("not_found");
  });

  test("AST-009 an invalid month is refused; assets acquired after the run month are skipped; setup-open assets cannot be disposed", async () => {
    const t = makeT();
    const owner = await company(t);
    expect(await fail(owner.mutation(api.assets.depreciateNow, { through: "2026-1" }))).toEqual({
      code: "invalid_input",
      message: "Ungültiger Monat.",
    });
    expect((await fail(owner.mutation(api.assets.depreciateNow, { through: "2099-01" }))).message).toBe(
      "AfA kann nicht für künftige Monate gebucht werden.",
    );
    await owner.mutation(api.assets.create, desk({ acquisitionDate: "2026-05-02" }));
    expect(await owner.mutation(api.assets.depreciateNow, { through: "2026-04" })).toEqual({ posted: 0, findings: [] });
    await bookVoucher(t, owner, [
      { account: "0650", description: "Tisch", amountCents: 300_000, assetDecision: "asset" },
    ]);
    const open = (await t.run((ctx) => ctx.db.query("assets").collect())).find((a) => a.setupRequired);
    if (!open) throw new Error("no setup-open asset");
    expect(await fail(owner.mutation(api.assets.dispose, { id: open._id, date: "2026-04-01", kind: "scrap" }))).toEqual(
      { code: "invalid_input", message: "Bitte Nutzungsdauer angeben (AfA-Tabelle)." },
    );
    const list = await owner.query(api.assets.list, { year: 2026 });
    expect(list.find((r) => r._id === open._id)?.status).toEqual({ key: "setup", label: "Einrichtung offen" });
    expect(list.find((r) => r.name === "Schreibtisch")?.status).toEqual({ key: "active", label: "Aktiv" });
  });
});

describe("AST-002 voucher lines with quantities", () => {
  test("AST-002 a GWG line with quantity 2 creates two assets; only the first is linked to the line", async () => {
    const t = makeT();
    const owner = await company(t);
    const voucherId = await bookVoucher(t, owner, [
      { account: "0650", description: "Stuhl", amountCents: 60_000, quantityMilli: 2_000, assetDecision: "gwg" },
    ]);
    const assets = await t.run((ctx) => ctx.db.query("assets").collect());
    expect(assets).toHaveLength(2);
    expect(assets.every((a) => a.voucherId === voucherId && a.method === "gwg" && a.account === "0670")).toBe(true);
    expect(assets.every((a) => a.name.startsWith("Stuhl"))).toBe(true);
    const [vl] = await t.run((ctx) =>
      ctx.db
        .query("voucherLines")
        .withIndex("by_voucher", (q) => q.eq("voucherId", voucherId))
        .collect(),
    );
    expect(vl?.assetId).toBe(assets[0]?._id);
  });
});

describe("AST-010 disposal guards and kinds", () => {
  test("AST-010 invalid and future dates, a sale by unknown number or with a draft invoice are refused; a sale by invoice number works", async () => {
    const t = makeT();
    const inv = await finalizedInvoice(t);
    const owner = inv.owner;
    const id = await owner.mutation(api.assets.create, { ...desk(), account: "0420", acquisitionDate: "2026-01-10" });
    const dispose = (over: Record<string, unknown>) =>
      owner.mutation(api.assets.dispose, { id, date: "2026-06-15", kind: "sale", ...over } as never);
    expect((await fail(dispose({ date: "15.06.2026" }))).message).toBe("Ungültiges Abgangsdatum.");
    expect((await fail(dispose({ date: "2099-01-01" }))).message).toBe(
      "Das Abgangsdatum darf nicht in der Zukunft liegen.",
    );
    expect((await fail(dispose({ documentNumber: "RE-9999" }))).message).toBe(
      "Die Rechnung RE-9999 wurde nicht gefunden.",
    );
    const { id: draft } = await owner.mutation(api.invoices.createDraft, { values: invoiceValues(inv.personId) });
    expect((await fail(dispose({ documentId: draft, proceedsCents: 100_000 }))).message).toBe(
      "Bitte eine fertiggestellte Ausgangsrechnung verknüpfen.",
    );
    const r = await dispose({ documentNumber: ` ${inv.number} `, proceedsCents: 300_000 });
    expect(r.rbwCents).toBeGreaterThan(0);
    expect(r.journalEntryId).toBeDefined();
    const a = await t.run((ctx) => ctx.db.get(id));
    expect(a?.disposal).toMatchObject({ kind: "sale", documentId: inv.id, proceedsCents: 300_000 });
    expect((await fail(dispose({ documentId: inv.id }))).message).toBe(
      "Für diese Anlage ist bereits ein Abgang erfasst.",
    );
    // reads after the disposal
    const detail = await owner.query(api.assets.detail, { id });
    expect(detail.disposalEntry).not.toBeNull();
    expect(detail.plan.at(-1)?.period).toBe("2026-06");
    expect(detail.plan.every((p) => p.posted !== null)).toBe(true);
    const list = await owner.query(api.assets.list, { year: 2026 });
    expect(list.find((x) => x._id === id)?.status).toEqual({ key: "disposed", label: "Abgegangen" });
    const spiegel = await owner.query(api.assets.anlagenspiegel, { year: 2026 });
    expect(spiegel.total.disposalsCents).toBe(240_000);
  });

  test("AST-010 a private withdrawal with input VAT deducted posts USt on the Teilwert; in a KU year no USt", async () => {
    const t = makeT();
    const owner = await company(t);
    const id = await owner.mutation(api.assets.create, desk());
    await owner.mutation(api.assets.dispose, { id, date: "2026-04-20", kind: "withdrawal", teilwertCents: 150_000 });
    const a = await t.run((ctx) => ctx.db.get(id));
    expect(a?.disposal).toMatchObject({ kind: "withdrawal", teilwertCents: 150_000, vatCents: 28_500 });
    const runs = await t.run((ctx) => ctx.db.query("depreciationRuns").collect());
    expect(runs.map((r) => r.trigger)).toEqual(["disposal"]);

    const t2 = makeT();
    const owner2 = await company(t2, { ku: true });
    const id2 = await owner2.mutation(api.assets.create, desk());
    await owner2.mutation(api.assets.dispose, {
      id: id2,
      date: "2026-04-20",
      kind: "withdrawal",
      teilwertCents: 150_000,
    });
    const a2 = await t2.run((ctx) => ctx.db.get(id2));
    expect(a2?.disposal?.vatCents).toBeUndefined();
    expect(a2?.disposal?.teilwertCents).toBe(150_000);
  });

  test("AST-008 E-AST-07 disposing a Sammelposten item leaves the pool unchanged (info); pools and GWG list", async () => {
    const t = makeT();
    const owner = await company(t);
    const poolId = await owner.mutation(api.assets.create, {
      ...desk({
        name: "Drucker",
        account: "0675",
        method: "pool",
        costCents: 60_000,
        usefulLifeMonths: undefined,
        acquisitionDate: "2025-03-10",
      }),
    });
    const r = await owner.mutation(api.assets.dispose, { id: poolId, date: "2026-05-01", kind: "scrap" });
    expect(r).toEqual({ info: "Der Sammelposten wird unverändert fortgeführt (§ 6 Abs. 2a EStG).", rbwCents: 0 });
    const pools = await owner.query(api.assets.pools, { year: 2026 });
    expect(pools[0]?.list).toEqual([expect.objectContaining({ id: poolId, poolYear: 2025, disposed: true })]);
    // GWG: below the recording limit (≤ 250 €) not listed, above listed without voucher
    await owner.mutation(
      api.assets.create,
      desk({ name: "Maus", account: "0670", method: "gwg", costCents: 20_000, usefulLifeMonths: undefined }),
    );
    const gwgId = await owner.mutation(
      api.assets.create,
      desk({
        name: "Monitor",
        account: "0670",
        method: "gwg",
        costCents: 70_000,
        usefulLifeMonths: undefined,
        acquisitionDate: "2026-03-03",
      }),
    );
    const gwg = await owner.query(api.assets.gwgList, { year: 2026 });
    expect(JSON.stringify(gwg)).toContain(String(gwgId));
    expect(JSON.stringify(gwg)).not.toContain("Maus");
    const spiegel = await owner.query(api.assets.anlagenspiegel, { year: 2026 });
    expect(spiegel.assets.find((x) => x.id === poolId)).toBeDefined();
  });
});

describe("ACC-014 AST-012 assets acquired before the Buchungsbeginn", () => {
  test("ACC-014 AST-012 plan months before the Buchungsbeginn count as pre-book AfA in the register and the detail", async () => {
    const t = makeT();
    const owner = await company(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(ctx, { bookkeepingStartDate: "2026-04-01" }, { action: "settings.bookkeeping.update" }),
    );
    const id = await owner.mutation(
      api.assets.create,
      desk({ acquisitionDate: "2026-01-15", costCents: 120_000, usefulLifeMonths: 12 }),
    );
    const r = await owner.mutation(api.assets.depreciateNow, { through: "2026-05" });
    expect(r.posted).toBe(2);
    const detail = await owner.query(api.assets.detail, { id });
    expect(detail.plan.filter((p) => p.preBook).map((p) => p.period)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(detail.plan.filter((p) => p.posted).map((p) => p.period)).toEqual(["2026-04", "2026-05"]);
    const list = await owner.query(api.assets.list, { year: 2026 });
    expect(list[0]).toMatchObject({ afaYearCents: 50_000, bookValueCents: 70_000 });
  });
});
