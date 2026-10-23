import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ebRow, type FakeBankAccount, FakeEnableBanking } from "../test/fakes/enable-banking";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { generateApplicationKey } from "./lib/bankKeys";
import { errorCode } from "./lib/errors";
import { auditedPatch } from "./model/audit";
import * as feedModel from "./model/bankFeed";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, type TestT } from "./test.setup";

/**
 * F07 P2 Enable Banking feed — error paths, fallbacks and guards of convex/bankFeedNode.ts and convex/model/bankFeed.ts
 * (BNK-011…117, EC-BNK-06/18/29/80…92, SET-049…050c) against the fake Enable Banking server (07 §3.3).
 */

const NOW = new Date("2026-10-19T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const IBAN = "LT443250010000000101";
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

const NOT_CONFIGURED = "Bitte zuerst Anwendungs-ID und privaten Schlüssel hinterlegen.";
const NO_CONNECTION = "Es besteht keine Bankverbindung.";
const AUTH_ABORTED = "Autorisierung abgebrochen oder abgelaufen — bitte erneut verbinden.";
const JWT_REJECTED = "Enable Banking hat die Anmeldung abgelehnt: Anwendungs-ID und Schlüssel prüfen.";

let fake: FakeEnableBanking;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = new FakeEnableBanking("app-feed-1");
  fake.accounts = [eurAccount()];
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function eurAccount(over: Partial<FakeBankAccount> = {}): FakeBankAccount {
  return {
    identificationHash: "hash-eur",
    currency: "EUR",
    iban: IBAN,
    name: "Muster Consulting e.K.",
    transactions: [
      ebRow({ entry_reference: "ER-1", date: "2026-10-01", amount: "1190.00", remittance_information: ["RE-1"] }),
      ebRow({ entry_reference: "ER-2", date: "2026-10-05", amount: "-15.00", remittance_information: ["Gebühr"] }),
    ],
    balance: { amount: "1175.00", currency: "EUR" },
    ...over,
  };
}

const accountValues = (over: Record<string, unknown> = {}) => ({
  name: "Revolut EUR",
  currency: "EUR",
  iban: IBAN,
  bic: "",
  accountHolder: "Muster Consulting e.K.",
  showOnInvoices: true,
  ...over,
});

async function setup(opts: { withAccount?: boolean; opening?: string | null } = {}) {
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
  let eur: Id<"bankAccounts"> | undefined;
  if (opts.withAccount !== false) {
    eur = await owner.mutation(api.banking.createAccount, { values: accountValues() });
    const opening = opts.opening === undefined ? "2026-09-30" : opts.opening;
    if (opening) await setOpening(t, eur, opening);
  }
  return { t, owner, eur: eur as Id<"bankAccounts"> };
}
type S = Awaited<ReturnType<typeof setup>>;

const setOpening = (t: TestT, id: Id<"bankAccounts">, date: string, amountCents = 0) =>
  t.model(OWNER, (ctx) =>
    auditedPatch(
      ctx,
      "bankAccounts",
      id,
      { openingBalance: { date, amountCents } },
      { action: "settings.bank_account.update" },
    ),
  );

async function configure(s: S, environment?: "production" | "sandbox") {
  const r = await s.owner.action(api.bankFeedNode.saveSetup, {
    applicationId: "app-feed-1",
    generateKey: true,
    ...(environment ? { environment } : {}),
  });
  fake.publicKeyPem = r.publicKeyPem;
  return r;
}

const latestState = () => [...fake.authorizations.values()].at(-1)?.state as string;

async function connect(s: S) {
  await s.owner.action(api.bankFeedNode.startConsent, {});
  const state = latestState();
  return s.owner.action(api.bankFeedNode.completeConsent, { code: fake.approve(state), state });
}

async function connected(opts: Parameters<typeof setup>[0] = {}) {
  const s = await setup(opts);
  await configure(s);
  await connect(s);
  return s;
}

const rows = (t: TestT, accountId: Id<"bankAccounts">) =>
  t.run((ctx) =>
    ctx.db
      .query("bankTransactions")
      .withIndex("by_account_bookingDate", (q) => q.eq("accountId", accountId))
      .collect(),
  );
const connectionRow = (t: TestT) =>
  t.run(async (ctx) => (await ctx.db.query("bankConnections").first()) as Doc<"bankConnections">);
const notifications = (t: TestT, kind: string) =>
  t.run(async (ctx) => (await ctx.db.query("notifications").collect()).filter((n) => n.kind === kind));
const audits = (t: TestT, action: string) =>
  t.run(async (ctx) => (await ctx.db.query("auditLog").collect()).filter((e) => e.action === action));
const account = (t: TestT, id: Id<"bankAccounts">) =>
  t.run(async (ctx) => (await ctx.db.get(id)) as Doc<"bankAccounts">);
const poll = (t: TestT) => t.action(internal.bankFeedNode.syncCron, { force: true });
const txCalls = () => fake.callsTo("/accounts/").filter((c) => c.path.endsWith("/transactions"));
const balanceCalls = () => fake.callsTo("/accounts/").filter((c) => c.path.endsWith("/balances"));
const fail = (e: Promise<unknown>) => e.catch((x: unknown) => x);
/** A bank account id that no longer exists (created, then removed again). */
const danglingAccount = async (s: S) => {
  const id = await s.owner.mutation(api.banking.createAccount, {
    values: accountValues({ name: "Weg", iban: "", showOnInvoices: false }),
  });
  await s.t.run((ctx) => ctx.db.delete(id));
  return id;
};

describe("setup guards (BNK-101, BNK-115, SET-049)", () => {
  test("SET-049 BNK-101 without a stored setup the feed actions refuse with the German hint and the cron does nothing", async () => {
    const s = await setup();
    const list = await fail(s.owner.action(api.bankFeedNode.listAspsps, {}));
    expect(errorCode(list)).toBe("not_configured");
    expect(messageOf(list)).toBe(NOT_CONFIGURED);
    const start = await fail(s.owner.action(api.bankFeedNode.startConsent, {}));
    expect(messageOf(start)).toBe(NOT_CONFIGURED);
    expect(await poll(s.t)).toBeNull();
    expect(await s.t.action(internal.bankFeedNode.syncCron, {})).toBeNull();
    // an aborted callback without any connection only answers with the German error
    const aborted = await fail(s.owner.action(api.bankFeedNode.completeConsent, { error: "access_denied" }));
    expect(messageOf(aborted)).toBe(AUTH_ABORTED);
    expect(reasonOf(aborted)).toBe("CONSENT_ABORTED");
    // disconnecting without a connection: the revoke is skipped, the model refuses
    const disc = await fail(s.owner.action(api.bankFeedNode.disconnect, { deleteKey: false }));
    expect(errorCode(disc)).toBe("not_configured");
    expect(messageOf(disc)).toBe(NO_CONNECTION);
    expect(fake.calls).toEqual([]);
    expect(await s.t.run((ctx) => ctx.db.query("bankConnections").collect())).toEqual([]);
  });

  test("BNK-101 the first setup needs a key and a valid application ID; later saves keep the stored key", async () => {
    const s = await setup();
    const noKey = await fail(s.owner.action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-1" }));
    expect(messageOf(noKey)).toBe(NOT_CONFIGURED);
    const badId = await fail(s.owner.action(api.bankFeedNode.saveSetup, { applicationId: "a b", generateKey: true }));
    expect(messageOf(badId)).toBe("Bitte eine gültige Anwendungs-ID von Enable Banking angeben.");
    expect((badId as { data?: { field?: string } }).data?.field).toBe("applicationId");
    const first = await configure(s);
    const keyBefore = (await connectionRow(s.t)).encryptedPrivateKeyPem;
    const again = await s.owner.action(api.bankFeedNode.saveSetup, {
      applicationId: " app-feed-2 ",
      environment: "production",
    });
    expect(again).toEqual({ publicKeyPem: null, redirectUrl: first.redirectUrl });
    const row = await connectionRow(s.t);
    expect(row).toMatchObject({ applicationId: "app-feed-2", environment: "production", status: "pending_consent" });
    expect(row.encryptedPrivateKeyPem).toBe(keyBefore);
    // after a disconnect that deleted the key, a save without a new key is refused again
    await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: true });
    const gone = await fail(s.owner.action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-2" }));
    expect(messageOf(gone)).toBe(NOT_CONFIGURED);
    expect((gone as { data?: { field?: string } }).data?.field).toBe("privateKey");
  });

  test("BNK-101 an uploaded private key is stored as keySource uploaded and its public key returned", async () => {
    const s = await setup();
    const k = await generateApplicationKey();
    const r = await s.owner.action(api.bankFeedNode.saveSetup, {
      applicationId: "app-feed-1",
      privateKeyPem: `${k.privateKeyPem}\n`,
    });
    expect(r.publicKeyPem).toBe(k.publicKeyPem);
    expect((await connectionRow(s.t)).keySource).toBe("uploaded");
    expect((await s.owner.query(api.bankFeed.connection, {})).keySource).toBe("uploaded");
  });

  test("BNK-115 without BASE_DOMAIN the redirect URL is unknown: setup refused, no URL shown", async () => {
    vi.stubEnv("BASE_DOMAIN", "");
    vi.stubEnv("PASSKEY_RP_ID", "");
    const s = await setup();
    const e = await fail(
      s.owner.action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-1", generateKey: true }),
    );
    expect(errorCode(e)).toBe("not_configured");
    expect(messageOf(e)).toBe("BASE_DOMAIN fehlt – die Weiterleitungs-URL ist unbekannt.");
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view).toMatchObject({ status: "not_configured", redirectUrl: null, applicationId: null, keySource: null });
    expect(view.accounts).toEqual([]);
  });

  test("BNK-100 ENABLE_BANKING_API_URL overrides the API base URL", async () => {
    const s = await setup();
    await configure(s);
    vi.stubEnv("ENABLE_BANKING_API_URL", "https://eb-proxy.example/");
    const hosts: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      hosts.push(new URL(String(input instanceof Request ? input.url : input)).host);
      return fake.fetch(input, init);
    });
    const list = await s.owner.action(api.bankFeedNode.listAspsps, { country: "DE" });
    expect(list.map((a) => `${a.name} ${a.country}`)).toEqual(["Revolut DE"]);
    expect(hosts).toEqual(["eb-proxy.example"]);
  });
});

describe("consent errors (BNK-102, EC-BNK-80, EC-BNK-81)", () => {
  test("EC-BNK-81 BNK-102 the bank list call: a rejected JWT and an outage come back as bank_feed_error with reason", async () => {
    const s = await setup();
    await configure(s);
    fake.failNext("/aspsps", { status: 401, error: "INVALID_JWT", message: "bad jwt" });
    const jwt = await fail(s.owner.action(api.bankFeedNode.listAspsps, {}));
    expect(errorCode(jwt)).toBe("bank_feed_error");
    expect(messageOf(jwt)).toBe(JWT_REJECTED);
    expect(reasonOf(jwt)).toBe("JWT_REJECTED");
    fake.failNext("/aspsps", { status: 503, message: "maintenance" });
    const down = await fail(s.owner.action(api.bankFeedNode.listAspsps, {}));
    expect(reasonOf(down)).toBe("TRANSIENT");
    expect(messageOf(down)).toBe("Enable Banking GET aspsps: maintenance");
  });

  test("BNK-102 a bank Enable Banking does not offer is refused; a POST /auth outage keeps the status", async () => {
    const s = await setup();
    await configure(s);
    const none = await fail(s.owner.action(api.bankFeedNode.startConsent, { aspsp: { name: "N26", country: "DE" } }));
    expect(errorCode(none)).toBe("invalid_input");
    expect(messageOf(none)).toBe("N26 (DE) wird von Enable Banking nicht angeboten.");
    fake.failNext("/auth", { status: 503 });
    const down = await fail(s.owner.action(api.bankFeedNode.startConsent, {}));
    expect(reasonOf(down)).toBe("TRANSIENT");
    const row = await connectionRow(s.t);
    expect(row.status).toBe("pending_consent");
    expect(row.pendingAuth).toBeUndefined();
    // the German branch is selectable explicitly (case-insensitive name)
    const { url } = await s.owner.action(api.bankFeedNode.startConsent, { aspsp: { name: "revolut", country: "DE" } });
    expect(url).toMatch(/^https:\/\/bank\.example\//);
    expect((await connectionRow(s.t)).aspsp).toEqual({ name: "Revolut", country: "DE" });
  });

  test("SET-049a EC-BNK-80 POST /sessions fails: an unknown code aborts, a rejected JWT says so; state is consumed", async () => {
    const s = await setup();
    await configure(s);
    await s.owner.action(api.bankFeedNode.startConsent, {});
    const state = latestState();
    const bad = await fail(s.owner.action(api.bankFeedNode.completeConsent, { code: "unknown-code", state }));
    expect(messageOf(bad)).toBe(AUTH_ABORTED);
    expect(reasonOf(bad)).toBe("CONSENT_ABORTED");
    const row = await connectionRow(s.t);
    expect(row).toMatchObject({ status: "pending_consent", lastError: AUTH_ABORTED });
    expect(row.pendingAuth).toBeUndefined();
    await s.owner.action(api.bankFeedNode.startConsent, {});
    const state2 = latestState();
    const code = fake.approve(state2);
    fake.publicKeyPem = (await generateApplicationKey()).publicKeyPem;
    const jwt = await fail(s.owner.action(api.bankFeedNode.completeConsent, { code, state: state2 }));
    expect(messageOf(jwt)).toBe(JWT_REJECTED);
    expect(reasonOf(jwt)).toBe("JWT_REJECTED");
    expect((await connectionRow(s.t)).lastError).toBe(JWT_REJECTED);
  });

  test("EC-BNK-88 BNK-103 the backfill fails inside the callback → the consent completes, backfill marked failed with a gap to-do", async () => {
    const s = await setup({ opening: "2026-01-01" });
    await configure(s);
    fake.failNext((c) => c.path.endsWith("/transactions"), { status: 503, message: "backend down" });
    const r = await connect(s);
    expect(r).toMatchObject({ mapped: 1, inserted: 0, gaps: 1 });
    const row = await connectionRow(s.t);
    expect(row.status).toBe("active");
    expect(row.backfill).toMatchObject({ ok: false, done: 1, error: "Enable Banking GET accounts: backend down" });
    expect(await rows(s.t, s.eur)).toEqual([]);
    expect((await notifications(s.t, "bank.statement_gap"))[0]?.title).toBe(
      "Ältere Umsätze konnten nicht abgerufen werden. Bitte Kontoauszüge für 01.01.2026–20.07.2026 importieren.",
    );
  });
});

describe("re-mapping on consent (BNK-104, SET-050a, SET-050c, EC-BNK-91, EC-BNK-92, EC-114)", () => {
  test("SET-050c BNK-104 a changed IBAN for the same identification hash updates the account for future documents", async () => {
    const s = await connected();
    fake.expireAllSessions();
    fake.accounts = [eurAccount({ iban: "DE89370400440532013000" })];
    await connect(s);
    expect((await account(s.t, s.eur)).iban).toBe("DE89370400440532013000");
    const changed = await audits(s.t, "bank.feed_account_update");
    expect(changed.map((e) => e.reason)).toContain("IBAN laut Bank geändert");
    expect(await s.t.run((ctx) => ctx.db.query("bankAccounts").collect())).toHaveLength(1);
  });

  test("EC-114 SET-050c a closed default account hands the invoice default to the next EUR account", async () => {
    const s = await setup();
    const second = await s.owner.mutation(api.banking.createAccount, {
      values: accountValues({ name: "Revolut EUR 2", iban: "DE89370400440532013000" }),
    });
    await setOpening(s.t, second, "2026-09-30");
    expect((await account(s.t, s.eur)).isDefaultForInvoices).toBe(true);
    fake.accounts = [
      eurAccount(),
      { identificationHash: "hash-eur2", currency: "EUR", iban: "DE89370400440532013000", transactions: [] },
    ];
    await configure(s);
    await connect(s);
    fake.accounts = [eurAccount({ status: "closed" }), fake.accounts[1] as FakeBankAccount];
    await connect(s);
    expect((await account(s.t, s.eur)).archivedAt).toBeDefined();
    expect((await account(s.t, second)).isDefaultForInvoices).toBe(true);
    expect((await notifications(s.t, "bank.account_closed"))[0]?.body).toBeUndefined();
    expect(await notifications(s.t, "bank.invoice_account_missing")).toEqual([]);
    // a third consent still reporting it closed does not archive twice (archived accounts are not re-mapped)
    await connect(s);
    expect(await notifications(s.t, "bank.account_closed")).toHaveLength(1);
  });

  test("EC-BNK-92 BNK-104 archived accounts are ignored; a linked account without uid or hash is reported missing", async () => {
    const s = await connected();
    const old = await s.owner.mutation(api.banking.createAccount, {
      values: accountValues({ name: "Alt", iban: "DE89370400440532013000" }),
    });
    const c = await connectionRow(s.t);
    await s.t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankAccounts", old, { archivedAt: NOW.getTime() }, { action: "settings.bank_account.update" }),
    );
    const orphan = await s.owner.mutation(api.banking.createAccount, {
      values: accountValues({ name: "Ohne Hash", iban: "", showOnInvoices: false }),
    });
    await s.t.model(OWNER, (ctx) =>
      auditedPatch(ctx, "bankAccounts", orphan, { feed: { connectionId: c._id } }, { action: "bank.feed_account_map" }),
    );
    fake.accounts = [
      eurAccount(),
      { identificationHash: "hash-x", currency: "EUR", iban: "DE89370400440532013000", transactions: [] },
    ];
    const r = await connect(s);
    // the archived account with the same IBAN is not reused → the pocket waits for the owner
    expect(r).toMatchObject({ mapped: 1, pendingAccounts: 1, missing: 1 });
    expect((await account(s.t, old)).feed).toBeUndefined();
    expect((await account(s.t, orphan)).feed?.missingSince).toBe(NOW.getTime());
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view.accounts.find((a) => a.id === orphan)).toMatchObject({ linked: false, missing: true });
  });

  test("SET-050a EC-BNK-91 a new pocket: unknown uid, archived or foreign-currency targets are refused; created with name and opening balance", async () => {
    const s = await setup();
    const usd = await s.owner.mutation(api.banking.createAccount, {
      values: accountValues({ name: "USD manuell", currency: "USD", iban: "", showOnInvoices: false }),
    });
    fake.accounts = [
      eurAccount(),
      {
        identificationHash: "hash-gbp",
        currency: "GBP",
        iban: "GB82WEST12345698765432",
        name: "Muster Consulting Ltd",
        product: "Business GBP",
        transactions: [],
      },
      {
        identificationHash: "hash-usd",
        currency: "USD",
        other: { identification: "987654321", scheme_name: "BBAN" },
        transactions: [
          ebRow({
            entry_reference: "U-1",
            date: "2026-10-03",
            transaction_amount: { currency: "USD", amount: "10.00" },
          }),
        ],
      },
    ];
    await configure(s);
    const r = await connect(s);
    expect(r).toMatchObject({ mapped: 1, pendingAccounts: 2 });
    const pending = (await s.owner.query(api.bankFeed.connection, {})).pendingAccounts;
    const gbp = pending.find((p) => p.currency === "GBP");
    expect(gbp).toMatchObject({
      iban: "GB82WEST12345698765432",
      name: "Business GBP",
      holderName: "Muster Consulting Ltd",
      identificationHash: "hash-gbp",
      printable: true,
    });
    const usdUid = pending.find((p) => p.currency === "USD")?.uid as string;
    const unknown = await fail(s.owner.action(api.bankFeedNode.mapAccount, { uid: "nope" }));
    expect(errorCode(unknown)).toBe("not_found");
    expect(messageOf(unknown)).toBe("Dieses Konto wartet nicht auf eine Zuordnung.");
    const wrongCcy = await fail(
      s.owner.action(api.bankFeedNode.mapAccount, { uid: gbp?.uid as string, accountId: s.eur }),
    );
    expect(messageOf(wrongCcy)).toBe("Das Konto führt EUR, die Bank meldet GBP.");
    const archived = await s.owner.mutation(api.banking.createAccount, {
      values: accountValues({ name: "Archiv", currency: "GBP", iban: "", showOnInvoices: false }),
    });
    await s.t.model(OWNER, (ctx) =>
      auditedPatch(
        ctx,
        "bankAccounts",
        archived,
        { archivedAt: NOW.getTime() },
        { action: "settings.bank_account.update" },
      ),
    );
    const gone = await fail(
      s.owner.action(api.bankFeedNode.mapAccount, { uid: gbp?.uid as string, accountId: archived }),
    );
    expect(messageOf(gone)).toBe("Das Bankkonto existiert nicht.");
    // map the USD pocket onto the existing USD account → backfilled into it
    const m1 = await s.owner.action(api.bankFeedNode.mapAccount, { uid: usdUid, accountId: usd });
    expect(m1.accountId).toBe(usd);
    expect((await rows(s.t, usd)).map((x) => x.source.entryReference)).toEqual(["U-1"]);
    // create a GBP account with own name and opening balance; holder from the bank
    const m2 = await s.owner.action(api.bankFeedNode.mapAccount, {
      uid: gbp?.uid as string,
      name: "GBP Konto",
      openingBalance: { date: "2026-10-01", amountCents: 5000 },
    });
    expect(await account(s.t, m2.accountId)).toMatchObject({
      name: "GBP Konto",
      currency: "GBP",
      iban: "GB82WEST12345698765432",
      accountHolder: "Muster Consulting Ltd",
      openingBalance: { date: "2026-10-01", amountCents: 5000 },
      showOnInvoices: false,
    });
    expect((await s.owner.query(api.bankFeed.connection, {})).pendingAccounts).toEqual([]);
  });

  test("BNK-104 BNK-106 a renewal keeps the poll state (last poll, 429 backoff) of a re-linked account", async () => {
    const s = await connected();
    fake.failNext("/accounts/", { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" });
    await poll(s.t);
    const before = (await account(s.t, s.eur)).feed;
    expect(before?.backoffUntil).toBe(NOW.getTime() + 6 * 3_600_000);
    fake.expireAllSessions();
    await connect(s);
    const after = (await account(s.t, s.eur)).feed;
    expect(after?.backoffUntil).toBe(before?.backoffUntil);
    expect(after?.lastPolledAt).toBe(NOW.getTime());
    expect(after?.providerAccountUid).not.toBe(before?.providerAccountUid);
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.backoffUntil).toBe(before?.backoffUntil);
  });
});

describe("polling branches (BNK-106, BNK-107, BNK-109, EC-BNK-06, EC-BNK-18)", () => {
  test("BNK-109 whole booking days per batch: > 200 rows of one day stay in one batch; value date stands in for a missing booking date", async () => {
    const s = await setup();
    await configure(s);
    fake.pageSize = 1000;
    const day1 = Array.from({ length: 201 }, (_, i) =>
      ebRow({ entry_reference: `D1-${i}`, date: "2026-10-02", amount: "1.00" }),
    );
    fake.accounts = [
      eurAccount({
        transactions: [
          ebRow({ entry_reference: "D2", date: "2026-10-03", amount: "2.00" }),
          ...day1,
          ebRow({ entry_reference: "VD", booking_date: null, value_date: "2026-10-04", amount: "3.00" }),
          ebRow({ entry_reference: "NODATE", booking_date: null, value_date: null, amount: "4.00" }),
        ],
      }),
    ];
    const r = await connect(s);
    expect(r.inserted).toBe(203);
    const booked = await rows(s.t, s.eur);
    expect(booked).toHaveLength(203);
    expect(booked.find((x) => x.source.entryReference === "VD")?.bookingDate).toBe("2026-10-04");
    expect(booked.some((x) => x.source.entryReference === "NODATE")).toBe(false);
    const imports = await s.t.run((ctx) => ctx.db.query("bankImports").collect());
    expect(imports.reduce((n, i) => n + i.counts.inserted, 0)).toBe(203);
    expect(imports.reduce((n, i) => n + i.counts.rejected, 0)).toBe(1);
  });

  test("EC-BNK-81 BNK-106 a rejected JWT during the poll stops it with status error", async () => {
    const s = await connected();
    fake.failNext("/accounts/", { status: 401, error: "INVALID_JWT", message: "kid unknown" });
    expect(await poll(s.t)).toMatchObject({ skipped: "jwt_rejected" });
    const row = await connectionRow(s.t);
    expect(row).toMatchObject({ status: "error", lastError: JWT_REJECTED });
  });

  test("BNK-106 a client error (4xx) is not retried and does not mark an outage", async () => {
    const s = await connected();
    const before = txCalls().length;
    fake.failNext((c) => c.path.endsWith("/transactions"), { status: 400, error: "WRONG_REQUEST_PARAMETERS" });
    const r = await poll(s.t);
    expect(r).toMatchObject({ skipped: null });
    expect(txCalls().length - before).toBe(1);
    expect((await connectionRow(s.t)).status).toBe("active");
  });

  test("EC-BNK-06 BNK-106 a network failure counts as transient; a second outage the same day keeps the counters and the outage start", async () => {
    const s = await connected();
    await poll(s.t); // one unattended fetch today
    let broken = 2;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/transactions") && broken-- > 0) return Promise.reject(new TypeError("fetch failed"));
      return fake.fetch(input, init);
    });
    await poll(s.t);
    let row = await connectionRow(s.t);
    expect(row.status).toBe("error");
    expect(row.lastError).toBe(
      "Enable Banking nicht erreichbar seit 19.10.2026 12:00 Uhr. Wird automatisch wiederholt; fehlende Zeiträume bitte per Kontoauszug importieren.",
    );
    const since = row.outageSince;
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.unattendedToday).toBe(3);
    vi.setSystemTime(new Date(NOW.getTime() + 3_600_000));
    broken = 1;
    fake.failNext((c) => c.path.endsWith("/transactions"), { status: 503 });
    await poll(s.t);
    row = await connectionRow(s.t);
    expect(row.status).toBe("error");
    expect(row.outageSince).toBe(since);
  });

  test("BNK-107 an owner-present fetch retries a transient failure regardless of the unattended budget", async () => {
    const s = await connected();
    const before = txCalls().length;
    fake.failNext((c) => c.path.endsWith("/transactions"), { status: 503 });
    const r = await s.owner.action(api.bankFeedNode.syncNow, { accountId: s.eur, psuIpAddress: "203.0.113.9" });
    expect(r).toMatchObject({ skipped: null, accounts: [{ accountId: s.eur }] });
    expect(txCalls().length - before).toBe(2);
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.unattendedToday).toBe(0);
    expect((await connectionRow(s.t)).status).toBe("active");
  });

  test("BNK-107 „Jetzt abrufen“ for one account with only a User-Agent counts as unattended", async () => {
    const s = await connected();
    const r = await s.owner.action(api.bankFeedNode.syncNow, { accountId: s.eur, psuUserAgent: "Safari/18" });
    expect(r.accounts).toHaveLength(1);
    expect(txCalls().at(-1)?.headers["psu-user-agent"]).toBe("Safari/18");
    expect(txCalls().at(-1)?.headers["psu-ip-address"]).toBeUndefined();
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.unattendedToday).toBe(1);
  });

  test("EC-BNK-06 BNK-106 a last booked row older than 90 days → statement-import to-do for the gap", async () => {
    const s = await setup({ opening: "2026-04-30" });
    fake.accounts = [eurAccount({ transactions: [ebRow({ entry_reference: "OLD", date: "2026-05-01" })] })];
    await configure(s);
    await connect(s);
    const r = await poll(s.t);
    expect(r).toMatchObject({ skipped: null });
    const todo = await notifications(s.t, "bank.statement_gap");
    expect(todo.map((n) => n.title)).toContain(
      "Ältere Umsätze konnten nicht abgerufen werden. Bitte Kontoauszüge für 02.05.2026–20.07.2026 importieren.",
    );
    expect(todo[0]?.body).toBe("Revolut EUR");
  });

  test("EC-BNK-18 BNK-035 no balance, an unreadable balance or a failed balance call skip the continuity check", async () => {
    const s = await connected();
    const acc = fake.accounts[0] as FakeBankAccount;
    delete acc.balance;
    await s.owner.action(api.bankFeedNode.syncNow, { psuIpAddress: "203.0.113.9" });
    acc.balance = { amount: "abc", currency: "EUR" };
    await s.owner.action(api.bankFeedNode.syncNow, { psuIpAddress: "203.0.113.9" });
    fake.failNext((c) => c.path.endsWith("/balances"), { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" });
    await s.owner.action(api.bankFeedNode.syncNow, { psuIpAddress: "203.0.113.9" });
    expect(balanceCalls()).toHaveLength(3);
    expect((await connectionRow(s.t)).lastBalanceCheck).toBeUndefined();
    expect(await notifications(s.t, "bank.balance_mismatch")).toEqual([]);
    expect((await account(s.t, s.eur)).feed?.backoffUntil).toBe(NOW.getTime() + 6 * 3_600_000);
  });

  test("BNK-011 disconnect without a session (never connected) revokes nothing", async () => {
    const s = await setup();
    await configure(s);
    const r = await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: false, feedLost: "   " });
    expect(r.revoked).toBe(false);
    expect(fake.callsTo("/sessions")).toEqual([]);
    const row = await connectionRow(s.t);
    expect(row.status).toBe("disconnected");
    expect(row.feedLost).toBeUndefined();
    const e = (await audits(s.t, "bank.disconnect")).find((x) => x.entity.table === "bankConnections");
    expect(e?.reason).toBe("Sitzung nicht erreichbar");
  });
});

describe("model guards (convex/model/bankFeed.ts)", () => {
  test("SET-049 model calls without a connection: required ones refuse, notices are no-ops", async () => {
    const s = await setup();
    const req = await fail(s.t.model(OWNER, (ctx) => feedModel.requireConnection(ctx)));
    expect(messageOf(req)).toBe(NO_CONNECTION);
    const start = await fail(
      s.t.model(OWNER, (ctx) =>
        feedModel.recordConsentStart(ctx, { stateHash: "h", expiresAt: 1, aspsp: { name: "Revolut", country: "LT" } }),
      ),
    );
    expect(errorCode(start)).toBe("not_configured");
    expect(await s.t.model(OWNER, (ctx) => feedModel.recordPollOutcome(ctx, { outcome: "transient" }))).toBeNull();
    expect(await s.t.model(OWNER, (ctx) => feedModel.recordConsentFailure(ctx, "x"))).toBeNull();
    expect(await s.t.model(OWNER, (ctx) => feedModel.pollTargets(ctx))).toEqual({ connection: null, accounts: [] });
    expect(
      await s.t.model(OWNER, (ctx) =>
        feedModel.recordBalanceCheck(ctx, { accountId: s.eur, providerCents: 1, currency: "EUR" }),
      ),
    ).toBeNull();
    // recordFetch on an account without feed link changes nothing
    await s.t.model(OWNER, (ctx) =>
      feedModel.recordFetch(ctx, { accountId: s.eur, endpoint: "transactions", unattended: true, ok: true }),
    );
    expect((await account(s.t, s.eur)).feed).toBeUndefined();
    const doc = await s.owner.query(api.bankFeed.verfahrensdoku, {});
    expect(doc).toMatchObject({
      provider: null,
      applicationId: null,
      status: null,
      confirmation: null,
      feedLost: null,
    });
    expect(doc.accounts).toEqual([
      { name: "Revolut EUR", currency: "EUR", iban: IBAN, source: "Kontoauszug-Import", archived: false },
    ]);
  });

  test("BNK-101 a connection without key cannot start a consent; backfill progress without a running backfill is ignored", async () => {
    const s = await setup();
    await configure(s);
    await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: true });
    const e = await fail(
      s.t.model(OWNER, (ctx) =>
        feedModel.recordConsentStart(ctx, { stateHash: "h", expiresAt: 1, aspsp: { name: "Revolut", country: "LT" } }),
      ),
    );
    expect(messageOf(e)).toBe(NOT_CONFIGURED);
    await s.t.model(OWNER, (ctx) => feedModel.recordBackfillProgress(ctx, { done: 1 }));
    expect((await connectionRow(s.t)).backfill).toBeUndefined();
  });

  test("EC-BNK-81 BNK-101 saving a new key after a rejected JWT resets the error connection to pending_consent", async () => {
    const s = await connected();
    await s.t.model(OWNER, (ctx) => feedModel.recordPollOutcome(ctx, { outcome: "jwt_rejected" }));
    expect((await connectionRow(s.t)).status).toBe("error");
    await s.t.model(OWNER, (ctx) =>
      feedModel.saveSetup(ctx, {
        applicationId: "app-feed-1",
        encryptedPrivateKeyPem: "iv:cipher",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----",
        redirectUrl: "https://app.test.local/einstellungen/bank/callback",
      }),
    );
    const row = await connectionRow(s.t);
    expect(row).toMatchObject({
      status: "pending_consent",
      encryptedPrivateKeyPem: "iv:cipher",
      keySource: "generated",
      environment: "production",
    });
    expect(row.lastError).toBeUndefined();
  });

  test("EC-BNK-88 BNK-103 backfill progress adds up inserted rows and stores the redacted error", async () => {
    const s = await connected();
    await s.t.model(OWNER, (ctx) => feedModel.recordBackfillProgress(ctx, { inserted: 5 }));
    await s.t.model(OWNER, (ctx) =>
      feedModel.recordBackfillProgress(ctx, { finished: { ok: false, error: "Zeitüberschreitung" } }),
    );
    expect((await connectionRow(s.t)).backfill).toMatchObject({ inserted: 7, ok: false, error: "Zeitüberschreitung" });
  });

  test("EC-BNK-82 EC-BNK-81 status transitions: reauth before any consent, JWT rejection after a disconnect", async () => {
    const s = await setup();
    await configure(s);
    await s.t.model(OWNER, (ctx) => feedModel.recordPollOutcome(ctx, { outcome: "reauth" }));
    const c = await connectionRow(s.t);
    expect(c.status).toBe("pending_consent");
    const n = await notifications(s.t, "bank.feed_reauth");
    expect(n[0]?.dedupeKey).toBe(`bank.feed_reauth:${c._id}:0`);
    await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: false });
    await s.t.model(OWNER, (ctx) => feedModel.recordPollOutcome(ctx, { outcome: "jwt_rejected" }));
    const after = await connectionRow(s.t);
    expect(after).toMatchObject({ status: "disconnected", lastError: JWT_REJECTED });
  });

  test("EC-BNK-29 EC-BNK-18 the balance check is skipped for sandbox data, without opening balance and for another currency", async () => {
    const s = await setup({ opening: null });
    await configure(s, "sandbox");
    const check = (currency: string) =>
      s.t.model(OWNER, (ctx) => feedModel.recordBalanceCheck(ctx, { accountId: s.eur, providerCents: 100, currency }));
    expect(await check("EUR")).toBeNull(); // sandbox
    await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: false });
    await s.owner.action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-1", environment: "production" });
    expect(await check("EUR")).toBeNull(); // no opening balance
    await setOpening(s.t, s.eur, "2026-09-30", 100);
    expect(await check("USD")).toBeNull(); // other currency
    expect(await check("EUR")).toBe(0);
    expect((await connectionRow(s.t)).lastBalanceCheck).toMatchObject({
      ok: true,
      diffs: [{ accountId: s.eur, diffCents: 0 }],
    });
  });

  test("BNK-109 BNK-111 ingest and pending replacement refuse an unknown account; a gap to-do for it has no body", async () => {
    const s = await connected();
    const gone = await danglingAccount(s);
    const ing = await fail(s.t.model(OWNER, (ctx) => feedModel.ingestFeedRows(ctx, { accountId: gone, rows: [] })));
    expect(errorCode(ing)).toBe("not_found");
    const pend = await fail(s.t.model(OWNER, (ctx) => feedModel.replacePendingRows(ctx, gone, [])));
    expect(errorCode(pend)).toBe("not_found");
    await s.t.model(OWNER, (ctx) => feedModel.gapTodo(ctx, { accountId: gone, from: "2026-01-01", to: "2026-03-31" }));
    const todo = (await notifications(s.t, "bank.statement_gap")).find((n) => n.link === `/bank/${gone}`);
    expect(todo?.title).toBe(
      "Ältere Umsätze konnten nicht abgerufen werden. Bitte Kontoauszüge für 01.01.2026–31.03.2026 importieren.",
    );
    expect(todo?.body).toBeUndefined();
  });

  test("BNK-109 a poll with only unreadable rows still records the import (rejected count, today as period)", async () => {
    const s = await connected();
    const r = await s.t.model(OWNER, (ctx) =>
      feedModel.ingestFeedRows(ctx, {
        accountId: s.eur,
        rows: [ebRow({ entry_reference: "BAD", transaction_amount: { currency: "EUR", amount: "zwölf" } })],
      }),
    );
    expect(r).toMatchObject({ insertedIds: [], rejected: 1 });
    expect(r.earliest).toBeUndefined();
    const imp = (await s.t.run((ctx) => ctx.db.query("bankImports").collect())).at(-1);
    expect(imp).toMatchObject({
      periodFrom: "2026-10-19",
      periodTo: "2026-10-19",
      counts: { rejected: 1, inserted: 0 },
    });
  });

  test("BNK-111 pending rows keep an entry reference and work without date or counterparty", async () => {
    const s = await connected();
    const n = await s.t.model(OWNER, (ctx) =>
      feedModel.replacePendingRows(ctx, s.eur, [
        ebRow({
          status: "PDNG",
          entry_reference: "P-1",
          booking_date: null,
          value_date: null,
          amount: "-7.00",
          remittance_information: ["Vormerkung"],
        }),
      ]),
    );
    expect(n).toBe(1);
    const pending = await s.owner.query(api.bankFeed.pending, { accountId: s.eur });
    expect(pending).toEqual([expect.objectContaining({ amountCents: -700, purpose: "Vormerkung" })]);
    const raw = await s.t.run((ctx) => ctx.db.query("bankPendingTransactions").collect());
    expect(raw[0]).toMatchObject({ entryReference: "P-1" });
    expect(raw[0]?.bookingDate).toBeUndefined();
    expect(raw[0]?.counterpartyName).toBeUndefined();
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.pending).toBe(1);
  });

  test("BNK-106 poll targets skip archived, foreign and unlinked accounts and can be narrowed to one account", async () => {
    const s = await connected();
    const c = await connectionRow(s.t);
    const mk = async (name: string, feed: Doc<"bankAccounts">["feed"], archived = false) => {
      const id = await s.owner.mutation(api.banking.createAccount, {
        values: accountValues({ name, iban: "", showOnInvoices: false }),
      });
      await s.t.model(OWNER, (ctx) =>
        auditedPatch(
          ctx,
          "bankAccounts",
          id,
          { ...(feed ? { feed } : {}), ...(archived ? { archivedAt: NOW.getTime() } : {}) },
          { action: "bank.feed_account_map" },
        ),
      );
      return id;
    };
    await mk("Archiviert", { connectionId: c._id, providerAccountUid: "uid-arch" }, true);
    await mk("Ohne uid", { connectionId: c._id });
    const second = await mk("Zweites", { connectionId: c._id, providerAccountUid: "uid-2" });
    const all = await s.t.model(OWNER, (ctx) => feedModel.pollTargets(ctx));
    expect(all.accounts.map((a) => a.name).sort()).toEqual(["Revolut EUR", "Zweites"]);
    expect(all.accounts.find((a) => a.name === "Zweites")).toMatchObject({
      openingBalance: null,
      lastBooked: null,
      dateFrom: "2026-01-01",
    });
    const one = await s.t.model(OWNER, (ctx) => feedModel.pollTargets(ctx, second));
    expect(one.accounts.map((a) => a.accountId)).toEqual([second]);
  });

  test("BNK-116 the evaluation confirmation keeps its file when only the status changes; Verfahrensdoku lists feed loss", async () => {
    const s = await connected();
    const storageId = await s.t.run((ctx) => ctx.storage.store(new Blob(["%PDF-1.4"], { type: "application/pdf" })));
    const file = { storageId, sha256: "a".repeat(64), bytes: 8, mime: "application/pdf", name: "Bestaetigung.pdf" };
    let doc = await s.owner.query(api.bankFeed.verfahrensdoku, {});
    expect(doc.confirmation).toMatchObject({ status: "pending", recordedAt: null, note: null, fileName: null });
    await s.t.model(OWNER, (ctx) => feedModel.recordConfirmation(ctx, { status: "quoted", note: "  ", file }));
    await s.t.model(OWNER, (ctx) => feedModel.recordConfirmation(ctx, { status: "confirmed" }));
    const row = await connectionRow(s.t);
    expect(row.evaluationConfirmation).toMatchObject({ status: "confirmed", file: { name: "Bestaetigung.pdf" } });
    expect(row.evaluationConfirmation.note).toBeUndefined();
    expect((await s.owner.query(api.bankFeed.connection, {})).confirmation.fileName).toBe("Bestaetigung.pdf");
    await s.owner.action(api.bankFeedNode.disconnect, {
      deleteKey: false,
      feedLost: " Kündigung durch Enable Banking ",
    });
    doc = await s.owner.query(api.bankFeed.verfahrensdoku, {});
    expect(doc.feedLost).toEqual({ at: "2026-10-19", reason: "Kündigung durch Enable Banking" });
    expect(doc.confirmation?.fileName).toBe("Bestaetigung.pdf");
    expect(doc.accounts[0]).toMatchObject({ source: "Kontoauszug-Import" });
  });
});
