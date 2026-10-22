import { describe, expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { lockMonths } from "./model/periodLock";
import { makeT, type TestT } from "./test.setup";
import { header, line, OWNER, setupCompany, TODAY, upload } from "./vouchers.fixtures";

const MONTH = TODAY.slice(0, 7);
const YEAR = Number(TODAY.slice(0, 4));

async function errorOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return { code: errorCode(e) ?? "unknown", message: String(data.message ?? (e as Error).message) };
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

/** Books an expense voucher (net prices, SKR04) with the given lines. */
async function bookVoucher(t: TestT, owner: Owner, lines: Record<string, unknown>[]) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, {
    id: voucherId,
    input: header({ priceMode: "net", lines: lines.map((l) => line(l)) }),
  });
  await owner.mutation(api.vouchers.finalize, { id: voucherId });
  return voucherId;
}

const assetsOf = (t: TestT) => t.run((ctx) => ctx.db.query("assets").collect());
const afaEntries = (t: TestT) =>
  t.run(async (ctx) =>
    (await ctx.db.query("journalEntries").collect()).filter((e) => e.source.kind === "asset_depreciation"),
  );
const balanceOf = (entries: Doc<"journalEntries">[], account: string) =>
  entries
    .flatMap((e) => e.lines)
    .filter((l) => l.account === account)
    .reduce((s, l) => s + l.debitCents - l.creditCents, 0);

describe("AST-002 assets from booked vouchers", () => {
  test("AST-002 AST-007 TST-AST-03 GWG line on booking → asset AV-00001 (linked to the line), written off in its month, GWG list", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const voucherId = await bookVoucher(t, owner, [
      { account: "0650", description: "Laptop", amountCents: 79_900, assetDecision: "gwg" },
    ]);
    const [asset] = await assetsOf(t);
    expect(asset).toMatchObject({
      inventoryNumber: "AV-00001",
      name: "Laptop",
      account: "0670",
      method: "gwg",
      costCents: 79_900,
      acquisitionDate: TODAY,
      voucherId,
      inputVatDeducted: true,
    });
    const lines = await t.run((ctx) =>
      ctx.db
        .query("voucherLines")
        .withIndex("by_voucher", (q) => q.eq("voucherId", voucherId))
        .collect(),
    );
    expect(lines[0]?.assetId).toBe(asset?._id);

    const run = await owner.mutation(api.assets.depreciateNow, { through: MONTH });
    expect(run.posted).toBe(1);
    const [entry] = await afaEntries(t);
    expect(entry?.explanation).toBe("D2");
    expect(entry?.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([
      ["6260", 79_900, 0],
      ["0670", 0, 79_900],
    ]);
    const list = await owner.query(api.assets.gwgList, { year: YEAR });
    expect(list.map((r) => [r.inventoryNumber, r.costCents, r.voucherNumber])).toEqual([
      ["AV-00001", 79_900, `BE-${YEAR}-00001`],
    ]);
    const rows = await owner.query(api.assets.list, { year: YEAR });
    expect(rows[0]).toMatchObject({ bookValueCents: 0, afaYearCents: 79_900, status: { key: "written_off" } });
  });

  test("AST-009 TST-AST-09 E-AST-13 the depreciation run executed twice for a month posts no duplicates", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await bookVoucher(t, owner, [
      { account: "0650", description: "Monitor", amountCents: 50_000, assetDecision: "gwg" },
    ]);
    expect((await owner.mutation(api.assets.depreciateNow, { through: MONTH })).posted).toBe(1);
    expect((await owner.mutation(api.assets.depreciateNow, { through: MONTH })).posted).toBe(0);
    expect(await afaEntries(t)).toHaveLength(1);
    const runs = await t.run((ctx) => ctx.db.query("depreciationRuns").collect());
    expect(runs).toHaveLength(1);
    expect(runs[0]?.entries[0]).toMatchObject({ period: MONTH, amountCents: 50_000 });
  });

  test("AST-002 E-AST-11 AST-001 E-AST-10 AST-011 an „Anlage“ line needs the useful life; after the first AfA cost and useful life are frozen", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await bookVoucher(t, owner, [
      { account: "0650", description: "Schreibtisch", amountCents: 360_000, assetDecision: "asset" },
    ]);
    const [asset] = await assetsOf(t);
    expect(asset).toMatchObject({ setupRequired: true, account: "0650", costCents: 360_000 });
    const run = await owner.mutation(api.assets.depreciateNow, { through: MONTH });
    expect(run.posted).toBe(0);
    expect(run.findings[0]).toMatchObject({ code: "E-AST-11" });
    const id = asset?._id as Id<"assets">;
    await owner.mutation(api.assets.update, {
      id,
      name: "Schreibtisch",
      account: "0650",
      acquisitionDate: TODAY,
      costCents: 360_000,
      method: "linear",
      usefulLifeMonths: 156,
      inputVatDeducted: true,
    });
    expect((await owner.mutation(api.assets.depreciateNow, { through: MONTH })).posted).toBe(1);
    // AST-001 E-AST-10: no change after the first AfA (notes stay editable).
    const err = await errorOf(
      owner.mutation(api.assets.update, {
        id,
        name: "Schreibtisch",
        account: "0650",
        acquisitionDate: TODAY,
        costCents: 360_000,
        method: "linear",
        usefulLifeMonths: 120,
        inputVatDeducted: true,
      }),
    );
    expect(err.message).toBe("Anschaffungskosten können nach der ersten AfA nicht mehr geändert werden.");
    await owner.mutation(api.assets.setNotes, { id, notes: "Büro 2" });
    expect((await t.run((ctx) => ctx.db.get(id)))?.notes).toBe("Büro 2");
  });

  test("AST-008 TST-AST-05 E-AST-04 the year's Sammelposten choice blocks a GWG booking of 600 € in the same year", async () => {
    const t = makeT();
    await setupCompany(t);
    await t.model(OWNER, (ctx) =>
      patchCompanyProfile(
        ctx,
        { assetPolicy: [{ fiscalYear: YEAR, mode250to1000: "pool", erinnerungswert: false }] },
        { action: "settings.asset_policy.update" },
      ),
    );
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({
        priceMode: "net",
        lines: [line({ account: "0650", amountCents: 60_000, assetDecision: "gwg" })],
      }),
    });
    const err = await errorOf(owner.mutation(api.vouchers.finalize, { id: voucherId }));
    expect(err.message).toBe(
      `Für ${YEAR} wurde bereits Sammelposten gewählt. Die Wahl gilt einheitlich für alle Wirtschaftsgüter von 250,01 € bis 1.000 €.`,
    );
    expect(await assetsOf(t)).toHaveLength(0);
    expect((await t.run((ctx) => ctx.db.get(voucherId)))?.status).toBe("draft");
  });

  test("AST-008 the first 250,01–1.000 € item fixes the year's choice", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await bookVoucher(t, owner, [{ account: "0650", amountCents: 90_000, assetDecision: "pool" }]);
    const profile = await t.run((ctx) => ctx.db.query("companyProfile").first());
    expect(profile?.assetPolicy).toEqual([{ fiscalYear: YEAR, mode250to1000: "pool", erinnerungswert: false }]);
    expect((await assetsOf(t))[0]).toMatchObject({ method: "pool", poolYear: YEAR, account: "0675" });
  });

  test("AST-002 cancelling a voucher voids its assets; after AfA the cancellation is blocked", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const first = await bookVoucher(t, owner, [{ account: "0650", amountCents: 70_000, assetDecision: "gwg" }]);
    await owner.mutation(api.vouchers.cancel, { id: first, reason: "Doppelt erfasst" });
    expect((await assetsOf(t))[0]?.voidedAt).toBeDefined();

    const second = await bookVoucher(t, owner, [{ account: "0650", amountCents: 70_000, assetDecision: "gwg" }]);
    await owner.mutation(api.assets.depreciateNow, { through: MONTH });
    const err = await errorOf(owner.mutation(api.vouchers.cancel, { id: second, reason: "Doppelt erfasst" }));
    expect(err.message).toContain("Anlagen mit gebuchter AfA");
  });
});

describe("AST-010 disposal (EC-176)", () => {
  async function linearAsset(_t: TestT, owner: Owner) {
    return owner.mutation(api.assets.create, {
      name: "Notebook",
      account: "0420",
      acquisitionDate: `${YEAR}-01-10`,
      costCents: 360_000,
      method: "linear",
      usefulLifeMonths: 36,
      inputVatDeducted: true,
    });
  }

  test("AST-010 TST-AST-07 EC-176 linear 3,600 € sold mid-June for 3,000 €: AfA Jan–Jun 600 €, RBW 3,000 €, D5", async () => {
    const t = makeT();
    const { owner, id: invoiceId } = await finalizedInvoice(t);
    const id = await linearAsset(t, owner);
    await owner.mutation(api.assets.depreciateNow, { through: `${YEAR}-03` });
    const r = await owner.mutation(api.assets.dispose, {
      id,
      date: `${YEAR}-06-15`,
      kind: "sale",
      documentId: invoiceId,
      proceedsCents: 300_000,
    });
    expect(r.rbwCents).toBe(300_000);
    const entries = await afaEntries(t);
    const afa = entries.filter((e) => e.explanation === "D1");
    expect(afa.map((e) => e.period)).toEqual([1, 2, 3, 4, 5, 6].map((m) => `${YEAR}-0${m}`));
    expect(afa.reduce((s, e) => s + (e.lines[0]?.debitCents ?? 0), 0)).toBe(60_000);
    const rbw = entries.find((e) => e.explanation === "D5");
    expect(rbw?.lines.map((l) => [l.account, l.debitCents, l.creditCents])).toEqual([
      ["2310", 300_000, 0],
      ["0420", 0, 300_000],
    ]);
    expect(balanceOf(entries, "0420")).toBe(-360_000);
    const asset = await t.run((ctx) => ctx.db.get(id));
    expect(asset?.disposal).toMatchObject({
      kind: "sale",
      date: `${YEAR}-06-15`,
      rbwCents: 300_000,
      documentId: invoiceId,
    });
    // A sale needs the outgoing invoice.
    const other = await linearAsset(t, owner);
    const err = await errorOf(
      owner.mutation(api.assets.dispose, { id: other, date: `${YEAR}-06-15`, kind: "sale", proceedsCents: 1 }),
    );
    expect(err.message).toBe("Ein Verkauf braucht die Ausgangsrechnung über den Erlös.");
  });

  test("AST-010 TST-AST-08 EC-170 E-AST-09 disposal in a locked month: RBW late-posted, the asset keeps the real date", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    const id = await linearAsset(t, owner);
    await t.model(OWNER, (ctx) =>
      lockMonths(
        ctx,
        [1, 2, 3, 4, 5, 6].map((m) => `${YEAR}-0${m}`),
        "manual",
      ),
    );
    await owner.mutation(api.assets.dispose, { id, date: `${YEAR}-06-15`, kind: "scrap" });
    const rbw = (await afaEntries(t)).find((e) => e.explanation === "D6");
    expect(rbw?.period).toBe(`${YEAR}-07`);
    expect(rbw?.originalDate).toBe(`${YEAR}-06-15`);
    expect(rbw?.latePosting).toBeDefined();
    expect((await t.run((ctx) => ctx.db.get(id)))?.disposal?.date).toBe(`${YEAR}-06-15`);
    const runs = await t.run((ctx) => ctx.db.query("depreciationRuns").collect());
    expect(runs[0]?.findings[0]?.message).toBe(
      `AfA 01/${YEAR} konnte wegen Festschreibung nicht gebucht werden und wurde im 07/${YEAR} nachgeholt.`,
    );
  });

  test("E-AST-14 AST-009 the AfA run hits locked months: skipped with a finding, caught up in the first open month with the late-posting flag", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    await linearAsset(t, owner);
    await t.model(OWNER, (ctx) => lockMonths(ctx, [`${YEAR}-01`, `${YEAR}-02`], "manual"));
    const r = await owner.mutation(api.assets.depreciateNow, { through: `${YEAR}-03` });
    expect(r.posted).toBe(3);
    const entries = (await afaEntries(t)).sort((a, b) => a.seq - b.seq);
    expect(entries.map((e) => [e.source.id.split(":")[1], e.period, e.originalDate ?? null])).toEqual([
      [`${YEAR}-01`, `${YEAR}-03`, `${YEAR}-01-31`],
      [`${YEAR}-02`, `${YEAR}-03`, `${YEAR}-02-${new Date(Date.UTC(YEAR, 2, 0)).getUTCDate()}`],
      [`${YEAR}-03`, `${YEAR}-03`, null],
    ]);
    expect(entries.slice(0, 2).every((e) => e.latePosting !== undefined)).toBe(true);
    expect(entries[2]?.latePosting).toBeUndefined();
    expect(r.findings.map((f) => f.message)).toEqual([
      `AfA 01/${YEAR} konnte wegen Festschreibung nicht gebucht werden und wurde im 03/${YEAR} nachgeholt.`,
      `AfA 02/${YEAR} konnte wegen Festschreibung nicht gebucht werden und wurde im 03/${YEAR} nachgeholt.`,
    ]);
    // idempotent: a second run posts nothing (E-AST-13)
    expect((await owner.mutation(api.assets.depreciateNow, { through: `${YEAR}-03` })).posted).toBe(0);
  });

  test("AST-010 E-AST-08 disposal before the last posted AfA month is blocked", async () => {
    const t = makeT();
    const { owner } = await finalizedInvoice(t);
    const id = await linearAsset(t, owner);
    await owner.mutation(api.assets.depreciateNow, { through: `${YEAR}-05` });
    const err = await errorOf(owner.mutation(api.assets.dispose, { id, date: `${YEAR}-03-15`, kind: "scrap" }));
    expect(err.message).toBe(`Abgangsdatum liegt vor der letzten gebuchten AfA (05/${YEAR}).`);
  });
});

describe("AST-012 Anlagenspiegel and AST-009 cron", () => {
  test("AST-012 TST-AST-11 Buchwert 31.12. equals the journal balance of the asset accounts", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await bookVoucher(t, owner, [
      { account: "0650", description: "Laptop", amountCents: 79_900, assetDecision: "gwg" },
      { account: "0650", description: "Regal", amountCents: 240_000, assetDecision: "asset" },
    ]);
    const regal = (await assetsOf(t)).find((a) => a.name === "Regal") as Doc<"assets">;
    await owner.mutation(api.assets.update, {
      id: regal._id,
      name: "Regal",
      account: "0650",
      acquisitionDate: regal.acquisitionDate,
      costCents: 240_000,
      method: "linear",
      usefulLifeMonths: 24,
      inputVatDeducted: true,
    });
    await owner.mutation(api.assets.depreciateNow, { through: MONTH });
    const spiegel = await owner.query(api.assets.anlagenspiegel, { year: YEAR });
    const all = await t.run((ctx) => ctx.db.query("journalEntries").collect());
    const journal = balanceOf(all, "0650") + balanceOf(all, "0670");
    expect(spiegel.total.bookValueEndCents).toBe(journal);
    expect(spiegel.total.akStartCents + spiegel.total.additionsCents - spiegel.total.disposalsCents).toBe(
      spiegel.total.akEndCents,
    );
    expect(spiegel.total.additionsCents).toBe(319_900);
    expect(spiegel.groups.map((g) => g.account)).toEqual(["0650", "0670"]);
  });

  test("AST-009 the monthly cron posts the previous month (idempotent)", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const prev =
      Number(MONTH.slice(5, 7)) === 1
        ? `${YEAR - 1}-12`
        : `${YEAR}-${String(Number(MONTH.slice(5, 7)) - 1).padStart(2, "0")}`;
    await owner.mutation(api.assets.create, {
      name: "Drucker",
      account: "0670",
      acquisitionDate: `${prev}-03`,
      costCents: 40_000,
      method: "gwg",
      inputVatDeducted: true,
    });
    expect((await t.mutation(internal.assets.depreciateCron, {})).posted).toBe(0);
    expect((await t.mutation(internal.assets.depreciateCron, { force: true })).posted).toBe(1);
    expect((await t.mutation(internal.assets.depreciateCron, { force: true })).posted).toBe(0);
    expect((await afaEntries(t))[0]?.period).toBe(prev);
  });
});
