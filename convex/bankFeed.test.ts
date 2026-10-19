import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { generateApplicationKey } from "../src/server/bank/keys";
import { ebRow, type FakeBankAccount, FakeEnableBanking } from "../test/fakes/enable-banking";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { patchCompanyProfile } from "./model/companyProfile";
import { makeT, SYSTEM_AUTH, type TestT } from "./test.setup";

/**
 * F07 P2 Enable Banking feed against the fake Enable Banking server (07 §3.3): setup, consent, callback backfill,
 * re-mapping, polling budget, owner-present fetch, pending rows, reminders, disconnect, feed loss (T07-130…145,
 * T-SET-101…105).
 */

const NOW = new Date("2026-10-19T10:00:00Z");
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const IBAN = "LT443250010000000101";
const messageOf = (e: unknown) => (e as { data?: { message?: string } }).data?.message ?? String(e);
const reasonOf = (e: unknown) => (e as { data?: { reason?: string } }).data?.reason;

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
  vi.useRealTimers();
});

const eurAccount = (over: Partial<FakeBankAccount> = {}): FakeBankAccount => ({
  identificationHash: "hash-eur",
  currency: "EUR",
  iban: IBAN,
  name: "Muster Consulting e.K.",
  transactions: [
    ebRow({ entry_reference: "ER-1", date: "2026-10-01", amount: "1190.00", remittance_information: ["RE-2026-0001"] }),
    ebRow({ entry_reference: "ER-2", date: "2026-10-05", amount: "-15.00", remittance_information: ["Plan fee"] }),
    ebRow({ entry_reference: "ER-3", date: "2026-10-12", amount: "-49.90", remittance_information: ["Adobe"] }),
  ],
  balance: { amount: "1125.10", currency: "EUR" },
  ...over,
});

async function setup(opts: { withAccount?: boolean } = {}) {
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
    eur = await owner.mutation(api.banking.createAccount, {
      values: {
        name: "Revolut EUR",
        currency: "EUR",
        iban: IBAN,
        bic: "",
        accountHolder: "Muster Consulting e.K.",
        showOnInvoices: true,
      },
    });
    await t.model(OWNER, async (ctx) => {
      const { auditedPatch } = await import("./model/audit");
      await auditedPatch(
        ctx,
        "bankAccounts",
        eur as Id<"bankAccounts">,
        { openingBalance: { date: "2026-09-30", amountCents: 0 } },
        {
          action: "settings.bank_account.update",
        },
      );
    });
  }
  return { t, owner, eur: eur as Id<"bankAccounts"> };
}

type S = Awaited<ReturnType<typeof setup>>;

async function configure(s: S) {
  const r = await s.owner.action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-1", generateKey: true });
  fake.publicKeyPem = r.publicKeyPem;
  return r;
}

async function connect(s: S) {
  const { url } = await s.owner.action(api.bankFeedNode.startConsent, {});
  const auth = [...fake.authorizations.values()].at(-1);
  const state = auth?.state as string;
  const code = fake.approve(state);
  const r = await s.owner.action(api.bankFeedNode.completeConsent, { code, state });
  return { url, state, code, r };
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
const poll = (t: TestT) => t.action(internal.bankFeedNode.syncCron, { force: true });

describe("setup (BNK-101, BNK-013, SET-049, BNK-115)", () => {
  test("BNK-101 BNK-013 SET-049 key pair generated, private key encrypted and never returned; checklist + evaluation notice", async () => {
    const s = await setup();
    const before = await s.owner.query(api.bankFeed.connection, {});
    expect(before).toMatchObject({ status: "not_configured", configured: false });
    const r = await configure(s);
    expect(r.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(JSON.stringify(r)).not.toMatch(/PRIVATE KEY/);
    const row = await connectionRow(s.t);
    expect(row.encryptedPrivateKeyPem).toMatch(/^[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(row.encryptedPrivateKeyPem).not.toContain("PRIVATE KEY");
    const view = await s.owner.query(api.bankFeed.connection, {});
    const json = JSON.stringify(view);
    expect(json).not.toContain(row.encryptedPrivateKeyPem as string);
    expect(json).not.toMatch(/PRIVATE KEY|encryptedPrivateKeyPem|encryptedSessionId|stateHash/);
    expect(view).toMatchObject({
      status: "pending_consent",
      configured: true,
      keyStored: true,
      evaluationNotice: "Nutzung im Evaluationsmodus – schriftliche Bestätigung von Enable Banking ausstehend",
    });
    expect(view.checklist.find((c) => c.step === "key")?.done).toBe(true);
    expect(view.checklist.find((c) => c.step === "confirmation")?.done).toBe(false);
    // The audit trail never contains the key either (redacted before hashing).
    const audit = await s.t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(JSON.stringify(audit)).not.toContain(row.encryptedPrivateKeyPem as string);
  });

  test("BNK-115 SET-049 the redirect URL is https://app.<BASE_DOMAIN>/einstellungen/bank/callback", async () => {
    const s = await setup();
    const r = await configure(s);
    expect(r.redirectUrl).toBe("https://app.test.local/einstellungen/bank/callback");
    expect((await s.owner.query(api.bankFeed.connection, {})).redirectUrl).toBe(r.redirectUrl);
  });

  test("BNK-101 an uploaded private key is validated; an invalid key is refused", async () => {
    const s = await setup();
    const e = await s.owner
      .action(api.bankFeedNode.saveSetup, { applicationId: "app-feed-1", privateKeyPem: "nope" })
      .catch((x: unknown) => x);
    expect(messageOf(e)).toMatch(/Der private Schlüssel ist ungültig/);
    expect(await s.t.run((ctx) => ctx.db.query("bankConnections").collect())).toEqual([]);
  });

  test("SET-049 setup, consent and disconnect are owner-only; the bookkeeper and API keys cannot", async () => {
    const s = await setup();
    const bk = await s.t.asUser("bookkeeper");
    expect(
      errorCode(
        await bk
          .action(api.bankFeedNode.saveSetup, { applicationId: "x1234", generateKey: true })
          .catch((x: unknown) => x),
      ),
    ).toBe("forbidden_role");
    const key = await s.t.asApiKey(["banking:write", "banking:read"]);
    expect(errorCode(await key.action(api.bankFeedNode.startConsent, {}).catch((x: unknown) => x))).toBe(
      "forbidden_scope",
    );
  });
});

describe("consent and callback (BNK-102, BNK-103, SET-049a)", () => {
  test("BNK-102 SET-049 POST /auth carries psu_type business, valid_until ≤ 180 days and the redirect URL; POST /sessions stores the session encrypted", async () => {
    const s = await setup();
    await configure(s);
    const { url, r } = await connect(s);
    expect(url).toMatch(/^https:\/\/bank\.example\//);
    const body = fake.callsTo("/auth")[0]?.body as {
      psu_type: string;
      redirect_url: string;
      access: { valid_until: string };
      aspsp: unknown;
    };
    expect(body.psu_type).toBe("business");
    expect(body.aspsp).toEqual({ name: "Revolut", country: "LT" });
    expect(body.redirect_url).toBe("https://app.test.local/einstellungen/bank/callback");
    expect(Date.parse(body.access.valid_until)).toBeLessThanOrEqual(NOW.getTime() + 180 * 86_400_000);
    expect(Date.parse(body.access.valid_until)).toBe(NOW.getTime() + 180 * 86_400_000);
    expect(r).toMatchObject({ mapped: 1, pendingAccounts: 0 });
    const row = await connectionRow(s.t);
    const sessionId = [...fake.sessions.keys()][0] as string;
    expect(row.status).toBe("active");
    expect(row.encryptedSessionId).toBeDefined();
    expect(row.encryptedSessionId).not.toContain(sessionId);
    expect(row.pendingAuth).toBeUndefined();
    expect(JSON.stringify(await s.owner.query(api.bankFeed.connection, {}))).not.toContain(sessionId);
  });

  test("BNK-103 backfill inside the callback: strategy=longest, all continuation pages, from the opening-balance date", async () => {
    const s = await setup();
    await configure(s);
    await connect(s);
    const calls = fake.callsTo("/accounts/").filter((c) => c.path.endsWith("/transactions"));
    expect(calls[0]?.query).toMatchObject({ strategy: "longest", date_from: "2026-09-30" });
    expect(calls).toHaveLength(2); // 3 rows, page size 2
    const booked = await rows(s.t, s.eur);
    expect(booked.map((r) => r.source.entryReference).sort()).toEqual(["ER-1", "ER-2", "ER-3"]);
    expect(booked.every((r) => r.source.kind === "enable_banking" && r.dedupeKey.includes(":er:"))).toBe(true);
    const revs = await s.t.run((ctx) => ctx.db.query("bankTransactionRevisions").collect());
    expect(revs).toHaveLength(3);
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view.backfill).toMatchObject({ ok: true, done: 1, accounts: 1, inserted: 3 });
    expect(view.validity).toBe("gültig bis 17.04.2027, noch 180 Tage");
    expect(view.lastSuccessfulPollAt).toBe(NOW.getTime());
    expect(view.nextPollAt).toBe(Date.parse("2026-10-19T15:30:00Z"));
  });

  test("EC-BNK-88 EC-193 BNK-103 the bank serves only 90 days → callback completes, statement-import to-do for the older range", async () => {
    const s = await setup();
    await s.t.model(OWNER, async (ctx) => {
      const { auditedPatch } = await import("./model/audit");
      await auditedPatch(
        ctx,
        "bankAccounts",
        s.eur,
        { openingBalance: { date: "2026-01-01", amountCents: 0 } },
        { action: "settings.bank_account.update" },
      );
    });
    fake.historyFrom = "2026-07-21";
    fake.accounts = [
      eurAccount({
        transactions: [
          ebRow({ entry_reference: "OLD", date: "2026-03-01" }),
          ebRow({ entry_reference: "NEW", date: "2026-09-01" }),
        ],
      }),
    ];
    await configure(s);
    const { r } = await connect(s);
    expect(r.gaps).toBe(1);
    expect((await rows(s.t, s.eur)).map((x) => x.source.entryReference)).toEqual(["NEW"]);
    const todo = await notifications(s.t, "bank.statement_gap");
    expect(todo[0]?.title).toBe(
      "Ältere Umsätze konnten nicht abgerufen werden. Bitte Kontoauszüge für 01.01.2026–20.07.2026 importieren.",
    );
    expect((await connectionRow(s.t)).status).toBe("active");
  });

  test("EC-BNK-80 BNK-102 missing, reused or foreign state → rejected, nothing stored", async () => {
    const s = await setup();
    await configure(s);
    await s.owner.action(api.bankFeedNode.startConsent, {});
    const state = [...fake.authorizations.values()].at(-1)?.state as string;
    const wrong = await s.owner
      .action(api.bankFeedNode.completeConsent, { code: fake.approve(state), state: "forged" })
      .catch((x: unknown) => x);
    expect(messageOf(wrong)).toBe(
      "Die Bankfreigabe konnte nicht abgeschlossen werden (Sitzung abgelaufen oder ungültig). Bitte ‚Neu verbinden‘ erneut ausführen.",
    );
    expect(fake.callsTo("/sessions")).toHaveLength(0);
    const missing = await s.owner.action(api.bankFeedNode.completeConsent, { code: "x" }).catch((x: unknown) => x);
    expect(reasonOf(missing)).toBe("CONSENT_STATE_INVALID");
    // the genuine state works once …
    await s.owner.action(api.bankFeedNode.completeConsent, { code: fake.approve(state), state });
    // … and not twice
    const reused = await s.owner
      .action(api.bankFeedNode.completeConsent, { code: fake.approve(state), state })
      .catch((x: unknown) => x);
    expect(reasonOf(reused)).toBe("CONSENT_STATE_INVALID");
    expect(fake.sessions.size).toBe(1);
  });

  test("EC-BNK-80 BNK-102 an expired state (> 10 min) is rejected", async () => {
    const s = await setup();
    await configure(s);
    await s.owner.action(api.bankFeedNode.startConsent, {});
    const state = [...fake.authorizations.values()].at(-1)?.state as string;
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60_000));
    const owner = await s.t.asUser("owner");
    const e = await owner
      .action(api.bankFeedNode.completeConsent, { code: fake.approve(state), state })
      .catch((x: unknown) => x);
    expect(reasonOf(e)).toBe("CONSENT_STATE_INVALID");
  });

  test("SET-049a T-SET-104 an aborted authorisation keeps pending_consent with the German error", async () => {
    const s = await setup();
    await configure(s);
    await s.owner.action(api.bankFeedNode.startConsent, {});
    const e = await s.owner
      .action(api.bankFeedNode.completeConsent, { error: "access_denied" })
      .catch((x: unknown) => x);
    expect(messageOf(e)).toBe("Autorisierung abgebrochen oder abgelaufen — bitte erneut verbinden.");
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view).toMatchObject({
      status: "pending_consent",
      lastError: "Autorisierung abgebrochen oder abgelaufen — bitte erneut verbinden.",
    });
  });

  test("EC-BNK-81 BNK-102 Enable Banking rejects the application JWT → German hint, status error", async () => {
    const s = await setup();
    await configure(s);
    fake.publicKeyPem = (await generateApplicationKey()).publicKeyPem;
    const e = await s.owner.action(api.bankFeedNode.startConsent, {}).catch((x: unknown) => x);
    expect(messageOf(e)).toBe("Enable Banking hat die Anmeldung abgelehnt: Anwendungs-ID und Schlüssel prüfen.");
    expect((await connectionRow(s.t)).status).toBe("error");
  });
});

describe("re-mapping and account data (BNK-104, SET-050a, SET-050c)", () => {
  test("EC-BNK-84 EC-159 BNK-104 renewal returns new uids → re-mapped by IBAN / identification hash, no duplicate accounts or rows", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    const firstUid = (await s.t.run((ctx) => ctx.db.get(s.eur)))?.feed?.providerAccountUid;
    fake.expireAllSessions();
    await connect(s);
    const a = await s.t.run((ctx) => ctx.db.get(s.eur));
    expect(a?.feed?.providerAccountUid).toBeDefined();
    expect(a?.feed?.providerAccountUid).not.toBe(firstUid);
    expect(a?.feed?.identificationHash).toBe("hash-eur");
    expect(await s.t.run((ctx) => ctx.db.query("bankAccounts").collect())).toHaveLength(1);
    expect(await rows(s.t, s.eur)).toHaveLength(3);
    // renewal: gap fetch with 10 days overlap from the last booked date (2026-10-12)
    const last = fake
      .callsTo("/accounts/")
      .filter((c) => c.path.endsWith("/transactions"))
      .at(-1);
    expect(last?.query.date_from).toBe("2026-10-02");
    expect((await connectionRow(s.t)).consentPeriods).toHaveLength(2);
  });

  test("EC-BNK-91 EC-BNK-92 SET-050a T-SET-102 a new USD pocket without IBAN prompts; a missing account warns", async () => {
    const s = await setup();
    fake.accounts = [
      eurAccount(),
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
    const { r } = await connect(s);
    expect(r).toMatchObject({ mapped: 1, pendingAccounts: 1 });
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view.pendingAccounts[0]).toMatchObject({
      currency: "USD",
      message: "Neues Konto gefunden (USD) – übernehmen?",
      printable: false,
    });
    const uid = view.pendingAccounts[0]?.uid as string;
    const m = await s.owner.action(api.bankFeedNode.mapAccount, { uid });
    const usd = await s.t.run((ctx) => ctx.db.get(m.accountId));
    expect(usd).toMatchObject({ currency: "USD", showOnInvoices: false, name: "Revolut USD (BBAN 987654321)" });
    expect(usd?.iban).toBeUndefined();
    expect((await rows(s.t, m.accountId)).map((x) => x.source.entryReference)).toEqual(["U-1"]);
    expect((await s.owner.query(api.bankFeed.connection, {})).pendingAccounts).toEqual([]);
    // renewal without the USD pocket → warning, the account stays (statement import)
    fake.accounts = [eurAccount()];
    await connect(s);
    const warn = await notifications(s.t, "bank.feed_account_missing");
    expect(warn[0]?.title).toBe(
      "Konto Revolut USD (BBAN 987654321) ist in der neuen Freigabe nicht enthalten. Bitte bei der Erneuerung auswählen oder Kontoauszüge importieren.",
    );
    expect((await s.t.run((ctx) => ctx.db.get(m.accountId)))?.archivedAt).toBeUndefined();
  });

  test("SET-050c the bank reports a changed holder name and a closed account → updated for future documents, archived, owner notified", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    fake.accounts = [eurAccount({ name: "Muster Consulting e.K. Inh. Max Muster", status: "closed" })];
    await connect(s);
    const a = await s.t.run((ctx) => ctx.db.get(s.eur));
    expect(a?.accountHolder).toBe("Muster Consulting e.K. Inh. Max Muster");
    expect(a?.archivedAt).toBeDefined();
    expect(a?.isDefaultForInvoices).toBe(false);
    const n = await notifications(s.t, "bank.account_closed");
    expect(n[0]?.title).toMatch(/^Das Bankkonto Revolut EUR wurde von der Bank als geschlossen gemeldet/);
    expect((await notifications(s.t, "bank.invoice_account_missing"))[0]?.title).toBe(
      "Es gibt kein Rechnungskonto in EUR mehr. Bitte ein anderes Konto für Rechnungen wählen.",
    );
    const audit = await s.t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(
      audit.some((e) => e.action === "bank.feed_account_update" && e.reason === "Kontoinhaber laut Bank geändert"),
    ).toBe(true);
  });
});

describe("polling (BNK-106, BNK-107, BNK-111)", () => {
  async function connected() {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    return s;
  }
  const txCalls = () => fake.callsTo("/accounts/").filter((c) => c.path.endsWith("/transactions"));

  test("EC-BNK-86 EC-191 BNK-106 the 5th unattended fetch within a day is not sent; balances at most once per day", async () => {
    const s = await connected();
    const before = txCalls().length;
    for (let i = 0; i < 5; i++) await poll(s.t);
    expect(txCalls().length - before).toBe(4);
    expect(fake.callsTo("/accounts/").filter((c) => c.path.endsWith("/balances"))).toHaveLength(1);
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view.accounts[0]).toMatchObject({ unattendedToday: 4, remaining: 0 });
    // window = last booked date − 10 days
    expect(txCalls().at(-1)?.query).toMatchObject({ date_from: "2026-10-02", strategy: "default" });
  });

  test("EC-BNK-86 BNK-106 429 → no unattended call for 6 hours", async () => {
    const s = await connected();
    fake.failNext("/accounts/", { status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" });
    await poll(s.t);
    const n = txCalls().length;
    vi.setSystemTime(new Date(NOW.getTime() + 5 * 3_600_000));
    await poll(s.t);
    expect(txCalls().length).toBe(n);
    vi.setSystemTime(new Date(NOW.getTime() + 6 * 3_600_000 + 1000));
    await poll(s.t);
    expect(txCalls().length).toBe(n + 1);
    expect((await notifications(s.t, "bank.feed_rate_limited"))[0]?.title).toMatch(
      /^Abruflimit der Bank erreicht – nächster automatischer Abruf ab 19\.10\.2026 18:00 Uhr\.$/,
    );
  });

  test("EC-147 EC-BNK-06 BNK-106 provider outage → status error with the German notice, retry within the budget, recovery fills the gap", async () => {
    const s = await connected();
    fake.failNext("/accounts/", { status: 503 }, 2);
    await poll(s.t);
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view.status).toBe("error");
    expect(view.lastError).toBe(
      "Enable Banking nicht erreichbar seit 19.10.2026 12:00 Uhr. Wird automatisch wiederholt; fehlende Zeiträume bitte per Kontoauszug importieren.",
    );
    expect(view.accounts[0]?.unattendedToday).toBe(2); // first try + one retry
    fake.accounts[0]?.transactions.push(ebRow({ entry_reference: "ER-4", date: "2026-10-18" }));
    await poll(s.t);
    expect((await s.owner.query(api.bankFeed.connection, {})).status).toBe("active");
    expect((await rows(s.t, s.eur)).map((r) => r.source.entryReference)).toContain("ER-4");
  });

  test("EC-157 EC-BNK-85 BNK-109 overlapping windows insert each booked row once even when transaction_id changes", async () => {
    const s = await connected();
    for (const t of fake.accounts[0]?.transactions ?? []) t.transaction_id = `changed-${Math.random()}`;
    await poll(s.t);
    await poll(s.t);
    expect(await rows(s.t, s.eur)).toHaveLength(3);
  });

  test("BNK-111 RI-10 EC-BNK-60 EC-140 EC-153 pending rows are provisional: separate store, replaced every poll, never matched", async () => {
    const s = await connected();
    fake.accounts[0]?.transactions.push(
      ebRow({
        status: "PDNG",
        entry_reference: null,
        booking_date: null,
        transaction_date: "2026-10-19",
        amount: "-50.00",
        creditor: { name: "Tankstelle" },
      }),
    );
    await poll(s.t);
    let pending = await s.owner.query(api.bankFeed.pending, { accountId: s.eur });
    expect(pending).toEqual([
      expect.objectContaining({ amountCents: -5000, counterpartyName: "Tankstelle", bookingDate: "2026-10-19" }),
    ]);
    expect(await rows(s.t, s.eur)).toHaveLength(3);
    const unmatched = await s.owner.query(api.banking.unmatched, {});
    expect(unmatched.some((u: { amountCents: number }) => u.amountCents === -5000)).toBe(false);
    // booked with a different amount (EC-140): pending row gone, booked row inserted with its own amount
    const acc = fake.accounts[0] as FakeBankAccount;
    acc.transactions = acc.transactions.filter((t) => t.status !== "PDNG");
    acc.transactions.push(
      ebRow({ entry_reference: "ER-5", date: "2026-10-19", amount: "-52.30", creditor: { name: "Tankstelle" } }),
    );
    await poll(s.t);
    pending = await s.owner.query(api.bankFeed.pending, { accountId: s.eur });
    expect(pending).toEqual([]);
    expect((await rows(s.t, s.eur)).find((r) => r.source.entryReference === "ER-5")?.amountCents).toBe(-5230);
  });

  test("EC-BNK-87 BNK-107 „Jetzt abrufen“ sends PSU headers and does not use the budget; API keys and MCP cannot fetch", async () => {
    const s = await connected();
    for (let i = 0; i < 4; i++) await poll(s.t);
    const n = fake.calls.length;
    await s.owner.action(api.bankFeedNode.syncNow, { psuIpAddress: "203.0.113.9", psuUserAgent: "Firefox/140" });
    const call = fake.calls.slice(n).find((c) => c.path.endsWith("/transactions"));
    expect(call?.headers).toMatchObject({ "psu-ip-address": "203.0.113.9", "psu-user-agent": "Firefox/140" });
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.unattendedToday).toBe(4);
    const key = await s.t.asApiKey(["banking:write"]);
    expect(errorCode(await key.action(api.bankFeedNode.syncNow, {}).catch((x: unknown) => x))).toBe("forbidden_scope");
    const mcp = await s.t.asMcp(["banking:write"]);
    expect(errorCode(await mcp.action(api.bankFeedNode.syncNow, {}).catch((x: unknown) => x))).toBe("forbidden_scope");
    const viewer = await s.t.asUser("viewer");
    expect(errorCode(await viewer.action(api.bankFeedNode.syncNow, {}).catch((x: unknown) => x))).toBe(
      "forbidden_role",
    );
  });

  test("BNK-107 Q-06 without a PSU IP the owner-present fetch counts against the unattended budget", async () => {
    const s = await connected();
    await s.owner.action(api.bankFeedNode.syncNow, {});
    expect((await s.owner.query(api.bankFeed.connection, {})).accounts[0]?.unattendedToday).toBe(1);
  });

  test("EC-BNK-18 RI-27 BNK-106 the daily balance differs from the booked balance → warning", async () => {
    const s = await connected();
    (fake.accounts[0] as FakeBankAccount).balance = { amount: "1000.00", currency: "EUR" };
    await poll(s.t);
    const n = await notifications(s.t, "bank.balance_mismatch");
    expect(n[0]?.title).toBe("Kontostand laut Bank (1.000,00 €) weicht vom gebuchten Stand (1.125,10 €) ab.");
  });
});

describe("consent lifecycle (BNK-105)", () => {
  test("EC-BNK-83 EC-158 BNK-105 reminders at T−14, T−3 and T−0, once each", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    const validUntil = (await connectionRow(s.t)).validUntil as number;
    const remind = () => s.t.mutation(internal.bankFeed.consentExpiryReminderCron, { force: true });
    const at = (daysBefore: number) => vi.setSystemTime(new Date(validUntil - daysBefore * 86_400_000 - 3_600_000));
    at(20);
    expect(await remind()).toMatchObject({ notified: null });
    at(14);
    expect(await remind()).toMatchObject({ notified: 14 });
    expect(await remind()).toMatchObject({ notified: null });
    at(3);
    expect(await remind()).toMatchObject({ notified: 3 });
    vi.setSystemTime(new Date(validUntil - 3_600_000));
    expect(await remind()).toMatchObject({ notified: 0 });
    const n = await notifications(s.t, "bank.consent_expiring");
    expect(n).toHaveLength(3);
    expect(n[0]?.title).toBe("Bankverbindung läuft am 17.04.2027 ab. Bitte jetzt erneuern.");
    const owner = await s.t.asUser("owner");
    expect((await owner.query(api.bankFeed.connection, {})).banner?.message).toBe(
      "Bankverbindung läuft am 17.04.2027 ab – jetzt erneuern",
    );
    vi.setSystemTime(new Date(validUntil + 1000));
    expect(await remind()).toMatchObject({ expired: true });
    expect((await connectionRow(s.t)).status).toBe("reauth_required");
  });

  test("EC-BNK-82 EC-158 BNK-105 SET-049a EXPIRED_SESSION → reauth_required, polling paused, notification; renewal resumes", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    fake.expireAllSessions();
    await poll(s.t);
    const row = await connectionRow(s.t);
    expect(row.status).toBe("reauth_required");
    expect((await notifications(s.t, "bank.feed_reauth"))[0]?.title).toBe(
      "Bankverbindung muss erneuert werden. Seit 19.10.2026 12:00 Uhr werden keine Umsätze abgerufen – Kontoauszug-Import bleibt möglich.",
    );
    const n = fake.calls.length;
    expect(await poll(s.t)).toMatchObject({ skipped: "inactive" });
    expect(fake.calls.length).toBe(n);
    await connect(s);
    expect((await connectionRow(s.t)).status).toBe("active");
    expect((await notifications(s.t, "bank.feed_reauth"))[0]?.resolvedAt).toBeDefined();
  });
});

describe("disconnect, feed loss, provider record (BNK-011, BNK-117, BNK-116)", () => {
  test("BNK-011 T07-017 T-SET-105 disconnect revokes the session, deletes session data (and the key on request), keeps transactions", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    const r = await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: true });
    expect(r.revoked).toBe(true);
    expect(fake.callsTo("/sessions/", "DELETE")).toHaveLength(1);
    const row = await connectionRow(s.t);
    expect(row).toMatchObject({ status: "disconnected" });
    expect(row.encryptedSessionId).toBeUndefined();
    expect(row.encryptedPrivateKeyPem).toBeUndefined();
    expect(await rows(s.t, s.eur)).toHaveLength(3);
    const a = await s.t.run((ctx) => ctx.db.get(s.eur));
    expect(a?.archivedAt).toBeUndefined();
    expect(a?.feed?.providerAccountUid).toBeUndefined();
    const audit = await s.t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((e) => e.action === "bank.disconnect" && e.entity.table === "bankConnections")).toBe(true);
    expect(await poll(s.t)).toBeNull();
  });

  test("BNK-011 an unreachable Enable Banking does not block the disconnect", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    fake.failNext("/sessions/", { status: 503 });
    expect((await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: false })).revoked).toBe(false);
    expect((await connectionRow(s.t)).encryptedPrivateKeyPem).toBeDefined();
  });

  test("EC-BNK-90 EC-194 BNK-117 feed lost → disconnected with notice; a later statement import dedupes the feed rows", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    await s.owner.action(api.bankFeedNode.disconnect, {
      deleteKey: false,
      feedLost: "Schreiben von Enable Banking vom 15.10.2026",
    });
    const view = await s.owner.query(api.bankFeed.connection, {});
    expect(view.feedLostMessage).toBe(
      "Bankdaten nur per Kontoauszug-Import – die automatische Verbindung ist nicht mehr verfügbar.",
    );
    expect((await notifications(s.t, "bank.feed_lost"))[0]?.title).toBe(view.feedLostMessage);
    // the statement re-delivers ER-1 (same bank ID) → merged into the feed row, not inserted again (BNK-110)
    const { ingestFeedRows } = await import("./model/bankFeed");
    const { planStatementImport } = await import("./model/bankImport");
    expect(typeof ingestFeedRows).toBe("function");
    const camt = camtWith("ER-1", "2026-10-01", "1190.00");
    const plan = await s.t.run((ctx) =>
      planStatementImport(ctx as never, { accountId: s.eur, content: camt, fileName: "eur.camt053.xml" }),
    );
    expect(plan.preview.counts).toMatchObject({ new: 0, merged: 1 });
  });

  test("BNK-116 T07-145 the Verfahrensdokumentation „Bankdaten“ lists provider, consent periods and the confirmation status", async () => {
    const s = await setup();
    fake.accounts = [eurAccount()];
    await configure(s);
    await connect(s);
    await s.owner.mutation(api.bankFeed.recordEvaluationConfirmation, {
      status: "confirmed",
      note: "E-Mail vom 18.10.2026",
    });
    const doc = await s.owner.query(api.bankFeed.verfahrensdoku, {});
    expect(doc).toMatchObject({
      provider: expect.stringMatching(/^Enable Banking Oy/),
      applicationId: "app-feed-1",
      consentPeriods: [{ from: "2026-10-19", until: "2027-04-17" }],
      confirmation: {
        status: "confirmed",
        label: "Schriftlich bestätigt",
        note: "E-Mail vom 18.10.2026",
        recordedAt: "2026-10-19",
      },
    });
    expect((await s.owner.query(api.bankFeed.connection, {})).evaluationNotice).toBeNull();
  });
});

describe("secrets hygiene (BNK-013)", () => {
  test("BNK-013 T07-018 logs contain no private key, JWT, code, session id, state or PSU header values", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    });
    try {
      const s = await setup();
      fake.accounts = [eurAccount()];
      await configure(s);
      const { state, code } = await connect(s);
      await s.owner.action(api.bankFeedNode.syncNow, {
        psuIpAddress: "198.51.100.77",
        psuUserAgent: "SecretAgent/1.0",
      });
      fake.failNext("/accounts/", {
        status: 401,
        error: "EXPIRED_SESSION",
        message: `session ${[...fake.sessions.keys()][0]} expired`,
      });
      await poll(s.t);
      await s.owner.action(api.bankFeedNode.disconnect, { deleteKey: false });
      const all = lines.join("\n");
      const jwts = fake.calls.map((c) => c.headers.authorization?.slice(7) ?? "");
      for (const secret of [state, code, ...fake.sessions.keys(), "198.51.100.77", "SecretAgent/1.0", ...jwts]) {
        expect(all).not.toContain(secret);
      }
      expect(all).not.toMatch(/PRIVATE KEY|eyJ[A-Za-z0-9_-]{10,}\./);
      const conn = await connectionRow(s.t);
      expect(JSON.stringify(conn.lastError ?? "")).not.toMatch(/sess-/);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

void SYSTEM_AUTH;

/** A one-entry CAMT.053 for the account (entry reference = AcctSvcrRef). */
function camtWith(ref: string, date: string, amount: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02"><BkToCstmrStmt><GrpHdr><MsgId>m1</MsgId><CreDtTm>2026-11-01T00:00:00Z</CreDtTm></GrpHdr>
<Stmt><Id>st-1</Id><FrToDt><FrDtTm>2026-10-01T00:00:00Z</FrDtTm><ToDtTm>2026-10-31T23:59:59Z</ToDtTm></FrToDt>
<Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">0.00</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-09-30</Dt></Dt></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Dt><Dt>2026-10-31</Dt></Dt></Bal>
<Ntry><Amt Ccy="EUR">${amount}</Amt><CdtDbtInd>CRDT</CdtDbtInd><Sts>BOOK</Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt><AcctSvcrRef>${ref}</AcctSvcrRef>
<NtryDtls><TxDtls><RmtInf><Ustrd>RE-2026-0001</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>
</Stmt></BkToCstmrStmt></Document>`;
}
