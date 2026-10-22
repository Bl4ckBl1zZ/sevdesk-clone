import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { makeT, type TestT } from "./test.setup";
import { header, setupCompany, upload } from "./vouchers.fixtures";

type Owner = Awaited<ReturnType<TestT["asUser"]>>;

async function bookPrivatelyPaid(t: TestT, owner: Owner) {
  const { voucherId } = await upload(t, owner);
  await owner.mutation(api.vouchers.updateDraft, { id: voucherId, input: header() });
  return {
    voucherId,
    run: () => owner.mutation(api.vouchers.finalize, { id: voucherId, payment: { method: "private" } }),
  };
}

const paymentLines = async (t: TestT, voucherId: Id<"vouchers">) => {
  const [p] = await t.run((ctx) =>
    ctx.db
      .query("payments")
      .withIndex("by_target", (q) => q.eq("target.kind", "voucher").eq("target.id", voucherId))
      .collect(),
  );
  const entries = await t.run((ctx) =>
    ctx.db
      .query("journalEntries")
      .withIndex("by_source", (q) => q.eq("source.kind", "payment").eq("source.id", p?._id as string))
      .collect(),
  );
  return (entries[0] as Doc<"journalEntries">).lines.map(
    (l) => [l.account, l.debitCents > 0 ? "S" : "H", l.debitCents || l.creditCents] as const,
  );
};

describe("Verrechnungskonto Gesellschafter (F01 SET-045a, F08 ACC-028, E-ACC-30)", () => {
  test("SET-045a T-SET-110 a GmbH with two shareholders gets two accounts, the role is mapped (audited) and „privat bezahlt“ posts to it", async () => {
    const t = makeT();
    await setupCompany(t, { legalForm: "gmbh" });
    const owner = await t.asUser("owner");
    expect(await owner.query(api.accounting.shareholderClearing, {})).toEqual({
      applies: true,
      mappedAccount: null,
      accounts: [],
    });
    // unmapped: the voucher „privat bezahlt“ is blocked (E-ACC-30)
    const blocked = await bookPrivatelyPaid(t, owner);
    expect(errorCode(await blocked.run().catch((e: unknown) => e))).toBe("role_unmapped");

    const plan = await owner.mutation(api.accounting.setupShareholderAccounts, {
      shareholders: [{ name: "Max Muster" }, { name: "Erika Beispiel" }],
    });
    expect(plan.map((p) => p.number)).toEqual(["3510", "3511"]);
    const status = await owner.query(api.accounting.shareholderClearing, {});
    expect(status).toEqual({
      applies: true,
      mappedAccount: "3510",
      accounts: [
        { number: "3510", name: "Verrechnungskonto Gesellschafter Muster" },
        { number: "3511", name: "Verr.-Kto. Ges. Erika Beispiel" },
      ],
    });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.filter((a) => a.action === "ledger_account.create")).toHaveLength(2);
    expect(audit.find((a) => a.action === "rule_override.add")?.reason).toContain("SET-045a");

    // the voucher that was blocked now books against the shareholder account instead of Privateinlagen
    await blocked.run();
    expect(await paymentLines(t, blocked.voucherId)).toEqual([
      ["3300", "S", 11_900],
      ["3510", "H", 11_900],
    ]);
  });

  test("SET-045a a sole proprietor sees no shareholder step and cannot create one; „privat bezahlt“ stays Privateinlage", async () => {
    const t = makeT();
    await setupCompany(t, { legalForm: "einzelunternehmen" });
    const owner = await t.asUser("owner");
    expect(await owner.query(api.accounting.shareholderClearing, {})).toEqual({
      applies: false,
      mappedAccount: null,
      accounts: [],
    });
    const err = await owner
      .mutation(api.accounting.setupShareholderAccounts, { shareholders: [{ name: "Max Muster" }] })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("invalid_input");
    expect(await t.run((ctx) => ctx.db.query("ledgerAccounts").collect())).toHaveLength(0);
    const v = await bookPrivatelyPaid(t, owner);
    await v.run();
    expect(await paymentLines(t, v.voucherId)).toEqual([
      ["3300", "S", 11_900],
      ["2180", "H", 11_900],
    ]);
  });

  test("SET-045a only the owner/bookkeeper role mapping permission may create the accounts", async () => {
    const t = makeT();
    await setupCompany(t, { legalForm: "gmbh" });
    const viewer = await t.asUser("viewer");
    const err = await viewer
      .mutation(api.accounting.setupShareholderAccounts, { shareholders: [{ name: "Max Muster" }] })
      .catch((e: unknown) => e);
    expect(errorCode(err)).toBe("forbidden_role");
  });
});
