import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ebRow, FakeEnableBanking } from "../test/fakes/enable-banking";
import { api, internal } from "./_generated/api";
import { auditedPatch } from "./model/audit";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT } from "./test.setup";

/**
 * F07 BNK-106 cron `bank.sync`: two registrations (03:30/09:30/15:30/21:30 UTC and one hour later) cover the four
 * Europe/Berlin poll slots 05:30 / 11:30 / 17:30 / 23:30 in summer and winter time; the action gates on the Berlin
 * wall clock. Test deployments (IS_TEST) skip the unforced cron.
 */

const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const IBAN = "LT443250010000000101";

let fake: FakeEnableBanking;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
  fake = new FakeEnableBanking("app-feed-1");
  fake.accounts = [
    {
      identificationHash: "hash-eur",
      currency: "EUR",
      iban: IBAN,
      name: "Muster Consulting e.K.",
      transactions: [ebRow({ entry_reference: "ER-1", date: "2026-10-01", amount: "1190.00" })],
      balance: { amount: "1190.00", currency: "EUR" },
    },
  ];
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function connected() {
  const t = makeT();
  await t.model(OWNER, (ctx) =>
    patchCompanyProfile(
      ctx,
      {
        name: "Muster Consulting e.K.",
        legalForm: "einzelunternehmen",
        chartOfAccounts: [{ validFromFiscalYear: 2026, chart: "SKR04" }],
        taxationMethod: [{ validFrom: "2026-01-01", method: "ist" }],
        ustvaPeriod: [{ year: 2026, period: "monthly", dauerfrist: false }],
      },
      { action: "settings.tax.update" },
    ),
  );
  const owner = await t.asUser("owner");
  const eur = await owner.mutation(api.banking.createAccount, {
    values: {
      name: "Revolut EUR",
      currency: "EUR",
      iban: IBAN,
      bic: "",
      accountHolder: "Muster Consulting e.K.",
      showOnInvoices: true,
    },
  });
  await t.model(OWNER, (ctx) =>
    auditedPatch(
      ctx,
      "bankAccounts",
      eur,
      { openingBalance: { date: "2026-09-30", amountCents: 0 } },
      { action: "settings.bank_account.update" },
    ),
  );
  const r = await owner.action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-1", generateKey: true });
  fake.publicKeyPem = r.publicKeyPem;
  await owner.action(api.bankFeedNode.startConsent, {});
  const state = [...fake.authorizations.values()].at(-1)?.state as string;
  await owner.action(api.bankFeedNode.completeConsent, { code: fake.approve(state), state });
  return t;
}

const txCalls = () => fake.callsTo("/accounts/").filter((c) => c.path.endsWith("/transactions")).length;

describe("BNK-106 the scheduled bank polling", () => {
  test("BNK-106 the unforced cron polls at the Berlin slots in summer (CEST) and winter (CET) time and skips other hours", async () => {
    const t = await connected();
    const run = async (iso: string) => {
      vi.setSystemTime(new Date(iso));
      const before = txCalls();
      const r = await t.action(internal.bankFeedNode.syncCron, {});
      return { r, polled: txCalls() > before };
    };
    // test deployments skip the unforced cron even in a slot
    expect(await run("2026-10-19T09:30:00Z")).toEqual({ r: null, polled: false });
    vi.stubEnv("IS_TEST", "false");
    // summer time: 09:30 UTC = 11:30 CEST (slot); the CET registration at 10:30 UTC = 12:30 CEST is no slot
    expect((await run("2026-10-19T09:30:00Z")).polled).toBe(true);
    expect(await run("2026-10-19T10:30:00Z")).toEqual({ r: null, polled: false });
    // winter time: 10:30 UTC = 11:30 CET (slot); the CEST registration at 09:30 UTC = 10:30 CET is no slot
    expect(await run("2026-11-02T09:30:00Z")).toEqual({ r: null, polled: false });
    expect((await run("2026-11-02T10:30:00Z")).polled).toBe(true);
    // 23:30 Berlin in winter = 22:30 UTC (slot), outside the minute window = no slot
    expect((await run("2026-11-03T22:30:00Z")).polled).toBe(true);
    expect(await run("2026-11-04T22:50:00Z")).toEqual({ r: null, polled: false });
  });
});
