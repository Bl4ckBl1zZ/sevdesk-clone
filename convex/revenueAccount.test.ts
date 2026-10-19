import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { productForm } from "./catalog.fixtures";
import { b2bBuyer, invoiceValues, setupInvoicing } from "./invoices.fixtures";
import { makeT } from "./test.setup";

const NOW = new Date("2026-10-12T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const dataOf = (e: unknown) => (e as { data?: Record<string, unknown> }).data ?? {};

describe("PRD-050..PRD-053 revenue account override", { timeout: 30_000 }, () => {
  test("PRD-050 PRD-052 T-PRD-017 the product save checks the account against the chart (SKR03) and the key's rate", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const notRevenue = await owner
      .mutation(api.products.create, { values: productForm("Beratung", { revenueAccountOverride: "1200" }) })
      .catch((x: unknown) => x);
    expect(dataOf(notRevenue)).toMatchObject({ reason: "REVENUE_ACCOUNT_INVALID", field: "revenueAccountOverride" });
    const mismatch = await owner
      .mutation(api.products.create, { values: productForm("Beratung", { revenueAccountOverride: "8300" }) })
      .catch((x: unknown) => x);
    expect(dataOf(mismatch).reason).toBe("REVENUE_ACCOUNT_RATE_MISMATCH");
    const ok = await owner.mutation(api.products.create, {
      values: productForm("Fachbuch", { vatRateKey: "reduced", revenueAccountOverride: "8300" }),
    });
    const stored = await t.run((ctx) => ctx.db.get(ok.id as Id<"products">));
    expect(stored?.revenueAccountOverride).toBe("8300");
    const options = await owner.query(api.products.revenueAccounts, {});
    expect(options.chart).toBe("SKR03");
    expect(options.accounts.map((a) => a.number)).toContain("8300");
  });

  test("PRD-053 the line copies the override; PRD-052 finalisation blocks a line account that no longer fits", async () => {
    const t = makeT();
    const { owner } = await setupInvoicing(t);
    const { personId } = await b2bBuyer(owner);
    const p = await owner.mutation(api.products.create, {
      values: productForm("Fachbuch", { vatRateKey: "reduced", revenueAccountOverride: "8300" }),
    });
    const line = await owner.query(api.invoices.productLine, {
      productId: p.id as Id<"products">,
      referenceDate: "2026-10-12",
      priceMode: "net",
      currency: "EUR",
    });
    expect(line.line.revenueAccount).toBe("8300");

    // Changed per line in the draft (here to a 7 % automatic account on a 19 % line) → blocking finding.
    const base = invoiceValues(personId);
    const values = {
      ...base,
      lines: base.lines.map((l) => (l.kind === "item" ? { ...l, revenueAccount: "8300" } : l)),
    };
    const { id } = await owner.mutation(api.invoices.createDraft, { values });
    const detail = await owner.query(api.invoices.get, { id });
    const codes = ((detail as { findings?: { code: string }[] } | null)?.findings ?? []).map((f) => f.code);
    expect(codes).toContain("revenue_account_rate_mismatch");
    const e = await owner.action(api.invoices.finalize, { id, version: 1 }).catch((x: unknown) => x);
    expect(((dataOf(e).findings ?? []) as { code: string }[]).map((f) => f.code)).toContain(
      "revenue_account_rate_mismatch",
    );

    // The default 19 % account fits the line.
    await owner.mutation(api.invoices.updateDraft, {
      id,
      version: 1,
      values: { ...base, lines: base.lines.map((l) => (l.kind === "item" ? { ...l, revenueAccount: "8400" } : l)) },
    });
    const after = await owner.query(api.invoices.get, { id });
    const after2 = ((after as { findings?: { code: string }[] } | null)?.findings ?? []).map((f) => f.code);
    expect(after2).not.toContain("revenue_account_rate_mismatch");
  });
});
