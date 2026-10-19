import { decodeJwt, decodeProtectedHeader } from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { ebRow, FakeEnableBanking } from "../../../test/fakes/enable-banking";
import { createEnableBankingProvider } from "./enable-banking";
import { FeedHttpError } from "./feed";
import { generateApplicationKey, publicKeyOf } from "./keys";

let key: { privateKeyPem: string; publicKeyPem: string };
beforeAll(async () => {
  key = await generateApplicationKey();
});

function setup() {
  const fake = new FakeEnableBanking("app-42");
  fake.publicKeyPem = key.publicKeyPem;
  fake.accounts = [
    {
      identificationHash: "h-eur",
      currency: "EUR",
      iban: "LT121000011101001000",
      transactions: [1, 2, 3, 4, 5].map((i) => ebRow({ date: `2026-10-0${i}`, entry_reference: `ER-${i}` })),
    },
  ];
  const provider = createEnableBankingProvider({
    applicationId: "app-42",
    privateKeyPem: key.privateKeyPem,
    fetch: fake.fetch,
  });
  return { fake, provider };
}

describe("Enable Banking provider (BNK-100)", () => {
  test("BNK-100 BNK-013 every request carries a fresh RS256 JWT (kid = application ID, TTL ≤ 1 h)", async () => {
    const { fake, provider } = setup();
    await provider.listAspsps("LT");
    await provider.listAspsps("LT");
    const [a, b] = fake.calls.map((c) => c.headers.authorization?.slice(7) ?? "");
    expect(decodeProtectedHeader(a as string)).toMatchObject({ alg: "RS256", kid: "app-42" });
    const p = decodeJwt(a as string);
    expect(p).toMatchObject({ iss: "enablebanking.com", aud: "api.enablebanking.com" });
    expect((p.exp ?? 0) - (p.iat ?? 0)).toBeLessThanOrEqual(3600);
    expect(b).toBeTruthy();
  });

  test("BNK-102 consent: GET /aspsps, POST /auth with psu_type business, POST /sessions with the code", async () => {
    const { fake, provider } = setup();
    const aspsps = await provider.listAspsps("LT");
    expect(aspsps[0]).toMatchObject({ name: "Revolut", country: "LT", maximumConsentValidity: 180 * 86_400 });
    const start = await provider.startConsent({
      aspsp: { name: "Revolut", country: "LT" },
      validUntil: Date.parse("2027-04-17T10:00:00Z"),
      redirectUrl: "https://app.example.org/einstellungen/bank/callback",
      state: "nonce-1",
      psuType: "business",
    });
    expect(start.url).toMatch(/^https:\/\/bank\.example\//);
    expect(fake.callsTo("/auth")[0]?.body).toMatchObject({
      psu_type: "business",
      redirect_url: "https://app.example.org/einstellungen/bank/callback",
      state: "nonce-1",
      access: { valid_until: "2027-04-17T10:00:00.000Z" },
    });
    const session = await provider.completeConsent(fake.approve("nonce-1"));
    expect(session.accounts).toEqual([expect.objectContaining({ identification_hash: "h-eur", currency: "EUR" })]);
    await expect(provider.completeConsent("unknown-code")).rejects.toBeInstanceOf(FeedHttpError);
  });

  test("BNK-103 transactions: all continuation_key pages, strategy and date_from passed", async () => {
    const { fake, provider } = setup();
    const s = await provider.completeConsent(fake.approve(""));
    const uid = s.accounts[0]?.uid as string;
    const pages: number[] = [];
    const r = await provider.fetchTransactions(uid, {
      dateFrom: "2026-10-02",
      strategy: "longest",
      onPage: (p) => {
        pages.push(p.length);
      },
    });
    expect(r).toMatchObject({ pages: 2, complete: true });
    expect(r.transactions.map((t) => t.entry_reference)).toEqual(["ER-2", "ER-3", "ER-4", "ER-5"]);
    expect(pages).toEqual([2, 2]);
    const q = fake.callsTo(`/accounts/${uid}/transactions`);
    expect(q[0]?.query).toMatchObject({ date_from: "2026-10-02", strategy: "longest" });
    expect(q[1]?.query.continuation_key).toBe("2");
  });

  test("BNK-107 owner-present calls send PSU headers", async () => {
    const { fake, provider } = setup();
    const s = await provider.completeConsent(fake.approve(""));
    await provider.fetchTransactions(s.accounts[0]?.uid as string, {
      dateFrom: "2026-10-01",
      strategy: "default",
      psu: { ipAddress: "203.0.113.7", userAgent: "Firefox" },
    });
    expect(fake.calls.at(-1)?.headers).toMatchObject({ "psu-ip-address": "203.0.113.7", "psu-user-agent": "Firefox" });
  });

  test("EC-BNK-81 a wrong application key is rejected and the error carries no secret", async () => {
    const { fake } = setup();
    const other = await generateApplicationKey();
    const provider = createEnableBankingProvider({
      applicationId: "app-42",
      privateKeyPem: other.privateKeyPem,
      fetch: fake.fetch,
    });
    const e = await provider.listAspsps().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(FeedHttpError);
    expect((e as FeedHttpError).status).toBe(401);
    expect((e as FeedHttpError).error).toBe("INVALID_JWT");
    expect((e as Error).message).not.toMatch(/eyJ|PRIVATE KEY/);
  });

  test("BNK-011 DELETE /sessions/{id} revokes the session", async () => {
    const { fake, provider } = setup();
    const s = await provider.completeConsent(fake.approve(""));
    await provider.revokeSession(s.sessionId);
    expect(fake.callsTo("/sessions/", "DELETE")).toHaveLength(1);
    expect((await provider.consentStatus(s.sessionId)).status).toBe("REVOKED");
  });

  test("BNK-101 an uploaded private key is validated and its public key derived", async () => {
    expect(await publicKeyOf(key.privateKeyPem)).toBe(key.publicKeyPem);
    await expect(publicKeyOf("not a key")).rejects.toThrow(/Der private Schlüssel ist ungültig/);
  });
});
