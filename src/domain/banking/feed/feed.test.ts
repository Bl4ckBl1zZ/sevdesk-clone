import { describe, expect, test } from "vitest";
import {
  CALLBACK_PATH,
  classifyFeedError,
  consentValidUntil,
  DAY_MS,
  dueReminder,
  expiryBanner,
  nextConnectionStatus,
  pollingActive,
  redirectUrlFor,
  validityLabel,
} from "./consent";
import {
  backfillStart,
  countFetch,
  isPollSlot,
  olderGap,
  pollDateFrom,
  RATE_LIMIT_BACKOFF_MS,
  remainingUnattended,
  unattendedAllowed,
} from "./polling";
import { redactForLog, redactText } from "./redact";
import { remapAccounts } from "./remap";

const NOW = Date.parse("2026-10-19T10:00:00Z");

describe("consent (BNK-102, BNK-105, BNK-115)", () => {
  test("BNK-115 redirect URL is the public app host of the deployment (public edge mode, 08 §12)", () => {
    expect(redirectUrlFor("8u9yhy8fewf.org")).toBe("https://app.8u9yhy8fewf.org/einstellungen/bank/callback");
    expect(redirectUrlFor("https://example.org/")).toBe(`https://app.example.org${CALLBACK_PATH}`);
  });

  test("BNK-102 valid_until = min(now + maximum_consent_validity, now + 180 days)", () => {
    expect(consentValidUntil(NOW, 365 * 86_400)).toBe(NOW + 180 * DAY_MS);
    expect(consentValidUntil(NOW, 90 * 86_400)).toBe(NOW + 90 * DAY_MS);
    expect(consentValidUntil(NOW, undefined)).toBe(NOW + 180 * DAY_MS);
  });

  test("EC-BNK-83 EC-158 BNK-105 reminders at T−14, T−3, T−0 Berlin days, once each", () => {
    const validUntil = Date.parse("2026-11-02T09:00:00Z");
    expect(dueReminder(validUntil, Date.parse("2026-10-18T07:00:00Z"), [])).toBeNull(); // T−15
    const t14 = dueReminder(validUntil, Date.parse("2026-10-19T07:00:00Z"), []);
    expect(t14).toMatchObject({ daysBefore: 14, alsoHandled: [] });
    expect(t14?.message).toBe("Bankverbindung läuft am 02.11.2026 ab. Bitte jetzt erneuern.");
    expect(dueReminder(validUntil, Date.parse("2026-10-20T07:00:00Z"), [14])).toBeNull();
    expect(dueReminder(validUntil, Date.parse("2026-10-30T07:00:00Z"), [14])).toMatchObject({ daysBefore: 3 });
    expect(dueReminder(validUntil, Date.parse("2026-11-02T07:00:00Z"), [14, 3])).toMatchObject({ daysBefore: 0 });
    // a missed earlier threshold is handled without a second notification
    expect(dueReminder(validUntil, Date.parse("2026-11-01T07:00:00Z"), [])).toMatchObject({
      daysBefore: 3,
      alsoHandled: [14],
    });
    expect(dueReminder(validUntil, Date.parse("2026-11-03T07:00:00Z"), [14, 3])).toBeNull();
  });

  test("BNK-105 banner within 14 days and the validity label", () => {
    const vu = NOW + 10 * DAY_MS;
    expect(expiryBanner(vu, NOW)?.message).toBe("Bankverbindung läuft am 29.10.2026 ab – jetzt erneuern");
    expect(expiryBanner(NOW + 30 * DAY_MS, NOW)).toBeNull();
    expect(validityLabel(NOW + 180 * DAY_MS, NOW)).toBe("gültig bis 17.04.2027, noch 180 Tage");
  });

  test("BNK-105 EC-BNK-81 EC-BNK-82 EC-BNK-86 error classification", () => {
    expect(classifyFeedError({ status: 422, error: "EXPIRED_SESSION" })).toBe("reauth");
    expect(classifyFeedError({ status: 401 })).toBe("reauth");
    expect(classifyFeedError({ status: 403 })).toBe("reauth");
    expect(classifyFeedError({ status: 429, error: "ASPSP_RATE_LIMIT_EXCEEDED" })).toBe("rate_limited");
    expect(classifyFeedError({ status: 401, error: "INVALID_JWT" })).toBe("jwt_rejected");
    expect(classifyFeedError({ status: 503 })).toBe("transient");
    expect(classifyFeedError({})).toBe("transient");
    expect(classifyFeedError({ status: 400, error: "WRONG_REQUEST_PARAMETERS" })).toBe("client");
  });

  test("BNK-105 state machine §4.1", () => {
    expect(nextConnectionStatus("not_configured", "setup_saved")).toBe("pending_consent");
    expect(nextConnectionStatus("pending_consent", "consent_completed")).toBe("active");
    expect(nextConnectionStatus("active", "expired")).toBe("reauth_required");
    expect(nextConnectionStatus("reauth_required", "consent_started")).toBe("pending_consent");
    expect(nextConnectionStatus("active", "transient")).toBe("error");
    expect(nextConnectionStatus("error", "poll_ok")).toBe("active");
    expect(nextConnectionStatus("active", "disconnect")).toBe("disconnected");
    expect(nextConnectionStatus("not_configured", "consent_started")).toBeNull();
    expect(pollingActive("reauth_required")).toBe(false);
    expect(pollingActive("active")).toBe(true);
  });
});

describe("polling (BNK-106, BNK-103, BNK-107)", () => {
  const DAY = "2026-10-19";
  test("BNK-106 poll slots 05:30/11:30/17:30/23:30 Europe/Berlin", () => {
    expect([5, 11, 17, 23].every((hour) => isPollSlot({ hour, minute: 30 }))).toBe(true);
    expect(isPollSlot({ hour: 6, minute: 30 })).toBe(false);
    expect(isPollSlot({ hour: 5, minute: 0 })).toBe(false);
  });

  test("EC-BNK-86 EC-191 BNK-106 ≤ 4 unattended transaction fetches per day, balances ≤ 1, 429 → 6 h backoff", () => {
    let state = {};
    for (let i = 0; i < 4; i++) {
      expect(unattendedAllowed(state, "transactions", NOW, DAY)).toEqual({ ok: true });
      state = { unattendedFetches: countFetch(state, "transactions", DAY) };
    }
    expect(unattendedAllowed(state, "transactions", NOW, DAY)).toEqual({ ok: false, reason: "budget" });
    expect(remainingUnattended(state, DAY)).toBe(0);
    // a new Berlin day resets the counter
    expect(unattendedAllowed(state, "transactions", NOW, "2026-10-20")).toEqual({ ok: true });
    const b = { unattendedFetches: countFetch({}, "balances", DAY) };
    expect(unattendedAllowed(b, "balances", NOW, DAY)).toEqual({ ok: false, reason: "budget" });
    const until = NOW + RATE_LIMIT_BACKOFF_MS;
    expect(unattendedAllowed({ backoffUntil: until }, "transactions", NOW + 1000, DAY)).toEqual({
      ok: false,
      reason: "backoff",
      until,
    });
    expect(unattendedAllowed({ backoffUntil: until }, "transactions", until, DAY)).toEqual({ ok: true });
  });

  test("BNK-106 window = last booked date − 10 days, never before the start", () => {
    expect(pollDateFrom("2026-10-15", "2026-01-01")).toBe("2026-10-05");
    expect(pollDateFrom(undefined, "2026-03-01")).toBe("2026-03-01");
    expect(pollDateFrom("2026-03-05", "2026-03-01")).toBe("2026-03-01");
  });

  test("BNK-103 backfill start: day after the last booked row, else the opening-balance date (never earlier)", () => {
    expect(backfillStart({ lastBookedDate: "2026-09-30", fallback: "2026-01-01" })).toBe("2026-10-01");
    expect(backfillStart({ openingBalanceDate: "2026-02-01", fallback: "2026-01-01" })).toBe("2026-02-01");
    expect(backfillStart({ fallback: "2026-01-01" })).toBe("2026-01-01");
  });

  test("EC-BNK-88 EC-193 BNK-103 older gap → statement to-do range", () => {
    // bank delivered only 90 days although the start is 2026-01-01
    expect(olderGap({ start: "2026-01-01", today: DAY, earliestDelivered: "2026-07-21", complete: true })).toEqual({
      from: "2026-01-01",
      to: "2026-07-20",
    });
    // timeout: everything older than 90 days is a to-do
    expect(olderGap({ start: "2026-01-01", today: DAY, complete: false })).toEqual({
      from: "2026-01-01",
      to: "2026-07-20",
    });
    expect(olderGap({ start: "2026-01-01", today: DAY, earliestDelivered: "2026-01-01", complete: true })).toBeNull();
    expect(olderGap({ start: "2026-09-01", today: DAY, complete: false })).toBeNull();
  });
});

describe("account re-mapping (BNK-104, SET-050a, SET-050c)", () => {
  const existing = [
    {
      id: "acc-eur",
      name: "Revolut EUR",
      currency: "EUR",
      iban: "LT12 1000 0111 0100 1000",
      accountHolder: "Muster GmbH",
      feed: { connectionId: "c1", identificationHash: "hash-eur" },
    },
    {
      id: "acc-usd",
      name: "Revolut USD",
      currency: "USD",
      feed: { connectionId: "c1", identificationHash: "hash-usd" },
    },
    {
      id: "acc-gbp",
      name: "Revolut GBP",
      currency: "GBP",
      feed: { connectionId: "c1", identificationHash: "hash-gbp" },
    },
  ];

  test("EC-BNK-84 EC-159 BNK-104 new uids are re-mapped by IBAN, then identification_hash — never by uid", () => {
    const r = remapAccounts({
      connectionId: "c1",
      existing,
      sessionAccounts: [
        {
          uid: "new-uid-1",
          identification_hash: "changed",
          account_id: { iban: "LT121000011101001000" },
          currency: "EUR",
        },
        {
          uid: "acc-usd", // a uid that happens to equal an account id must not be used
          identification_hash: "hash-usd",
          account_id: { other: { identification: "123456789", scheme_name: "BBAN" } },
          currency: "USD",
        },
      ],
    });
    expect(r.proposals).toEqual([
      expect.objectContaining({ uid: "new-uid-1", kind: "matched", accountId: "acc-eur", by: "iban" }),
      expect.objectContaining({ uid: "acc-usd", kind: "matched", accountId: "acc-usd", by: "identification_hash" }),
    ]);
    // EC-BNK-92 the GBP account is missing from the new consent
    expect(r.missing).toEqual([
      {
        accountId: "acc-gbp",
        message:
          "Konto Revolut GBP ist in der neuen Freigabe nicht enthalten. Bitte bei der Erneuerung auswählen oder Kontoauszüge importieren.",
      },
    ]);
  });

  test("EC-BNK-91 SET-050a a new pocket prompts; a pocket without IBAN keeps its local account details", () => {
    const r = remapAccounts({
      connectionId: "c1",
      existing: [],
      sessionAccounts: [
        {
          uid: "u-chf",
          identification_hash: "hash-chf",
          currency: "CHF",
          account_id: { other: { identification: "40-1234", scheme_name: "BBAN" } },
        },
      ],
    });
    expect(r.proposals[0]).toMatchObject({ kind: "new", message: "Neues Konto gefunden (CHF) – übernehmen?" });
    expect(r.proposals[0]?.account.iban).toBeUndefined();
    expect(r.proposals[0]?.account.localDetails).toEqual([{ scheme: "BBAN", identification: "40-1234" }]);
  });

  test("SET-050c changed IBAN / holder name and a closed account are reported", () => {
    const r = remapAccounts({
      connectionId: "c1",
      existing,
      sessionAccounts: [
        {
          uid: "u1",
          identification_hash: "hash-eur",
          account_id: { iban: "DE89370400440532013000" },
          name: "Muster Handels GmbH",
          currency: "EUR",
          status: "closed",
        },
      ],
    });
    expect(r.changes).toEqual([
      { accountId: "acc-eur", field: "iban", before: "LT12 1000 0111 0100 1000", after: "DE89370400440532013000" },
      { accountId: "acc-eur", field: "accountHolder", before: "Muster GmbH", after: "Muster Handels GmbH" },
    ]);
    expect(r.closed).toEqual(["acc-eur"]);
  });
});

describe("log redaction (BNK-013)", () => {
  test("BNK-013 PEM, JWT, code, session id, state and PSU headers never survive", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----";
    const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJlbmFibGViYW5raW5nLmNvbSJ9.c2lnbmF0dXJl";
    const logged = redactForLog(
      {
        url: "https://app.x/einstellungen/bank/callback?code=abc123secret&state=nonce-1",
        headers: { Authorization: `Bearer ${jwt}`, "Psu-Ip-Address": "100.64.0.1", "Psu-User-Agent": "Firefox" },
        body: { code: "abc123secret", session_id: "sess-123456" },
        note: `key ${pem} and ${jwt} in sess-123456`,
      },
      ["sess-123456"],
    );
    const s = JSON.stringify(logged);
    for (const secret of ["abc123secret", "nonce-1", jwt, "MIIEv", "100.64.0.1", "Firefox", "sess-123456"]) {
      expect(s).not.toContain(secret);
    }
    expect(redactText("plain text")).toBe("plain text");
  });
});
