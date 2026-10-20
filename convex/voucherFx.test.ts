import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { makeT } from "./test.setup";
import { header, line, setupCompany, TODAY, upload } from "./vouchers.fixtures";

describe("ACC-023 foreign-currency voucher postings", () => {
  test("ACC-023 a USD voucher posts in EUR and the payable keeps currency, USD amount and rate", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    const { voucherId } = await upload(t, owner);
    await owner.mutation(api.vouchers.updateDraft, {
      id: voucherId,
      input: header({
        currency: "USD",
        fxRateToEur: { rate: "1.19", source: "ecb_daily", date: TODAY },
        lines: [line({ amountCents: 11_900 })],
      }),
    });
    await owner.mutation(api.vouchers.finalize, { id: voucherId });
    const entry = await t.run(async (ctx) =>
      (await ctx.db.query("journalEntries").collect()).find((e) => e.source.kind === "voucher"),
    );
    const payable = entry?.lines.find((l) => l.role === "payable");
    expect(payable).toMatchObject({
      creditCents: 10_000,
      currency: "USD",
      amountFx: 11_900,
      fxRate: { rate: "1.19", source: "ecb_daily", date: TODAY },
    });
    // every other line is plain EUR
    expect(entry?.lines.filter((l) => l.currency !== undefined)).toHaveLength(1);
  });
});
