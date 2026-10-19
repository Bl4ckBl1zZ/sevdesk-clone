import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";
import { header, line, setupCompany, upload } from "./vouchers.fixtures";

async function errorOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const data = ((e as { data?: Record<string, unknown> }).data ?? {}) as Record<string, unknown>;
    return String(data.message ?? errorCode(e) ?? (e as Error).message);
  }
  throw new Error("expected an error");
}

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function book(t: TestT, owner: Owner, account: string) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, {
    id: voucherId,
    input: header({ lines: [line({ account, description: "Abo" })] }),
  });
  return owner.mutation(api.vouchers.finalize, { id: voucherId });
}

describe("ACC-009 custom accounts", () => {
  test("ACC-009 E-ACC-07 E-ACC-06 create a custom account, post to it, archive it, then postings are refused", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    expect(
      await errorOf(owner.mutation(api.accounting.createAccount, { number: "1234", name: "X", type: "expense" })),
    ).toBe("Kontonummer 1234 liegt nicht im zulässigen Bereich für Aufwandskonto (SKR04).");
    await owner.mutation(api.accounting.createAccount, { number: "6999", name: "Software-Abos", type: "expense" });
    expect(
      await errorOf(owner.mutation(api.accounting.createAccount, { number: "6999", name: "Y", type: "expense" })),
    ).toBe("Konto 6999 ist bereits vorhanden.");
    const chart = await owner.query(api.accounting.chartOfAccounts, {});
    expect(chart.accounts.find((a) => a.number === "6999")).toMatchObject({ name: "Software-Abos", custom: true });

    await book(t, owner, "6999");
    const entry = await t.run(async (ctx) =>
      (await ctx.db.query("journalLines").collect()).find((l) => l.account === "6999"),
    );
    expect(entry?.debitCents).toBe(10_000);

    expect(await owner.mutation(api.accounting.removeAccount, { number: "6999" })).toEqual({ action: "archive" });
    expect(
      (await owner.query(api.accounting.chartOfAccounts, {})).accounts.find((a) => a.number === "6999")?.archived,
    ).toBe(true);
    await expect(book(t, owner, "6999")).rejects.toThrow();
  });

  test("ACC-009 an unused custom account is deleted; an account assigned to a bank account cannot be archived", async () => {
    const t = makeT();
    await setupCompany(t);
    const owner = await t.asUser("owner");
    await owner.mutation(api.accounting.createAccount, { number: "6998", name: "Testkonto", type: "expense" });
    expect(await owner.mutation(api.accounting.removeAccount, { number: "6998" })).toEqual({ action: "delete" });
    expect(await t.run((ctx) => ctx.db.query("ledgerAccounts").collect())).toHaveLength(0);
    expect(await errorOf(owner.mutation(api.accounting.removeAccount, { number: "1800" }))).toBe(
      "Konto 1800 ist dem Bankkonto „Revolut EUR“ zugeordnet. Bitte zuerst die Zuordnung ändern.",
    );
  });
});
