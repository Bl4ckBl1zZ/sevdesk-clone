import { ConvexHttpClient } from "convex/browser";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { apiKeyFromBytes, hashApiKey, parseApiKey } from "../../src/domain/api/keys";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import { httpBackend } from "../../src/server/api/backend";
import {
  type Caller,
  cashPaidCreditCorrection,
  errorData,
  OPEN_REFUND_CENTS,
  REFUND_RACE_SCOPES,
  raceCashRefunds,
  tillTo,
} from "../factories/refund-race";
import { type InvariantTarget, useInvariantTarget } from "../invariants";

/**
 * F05 T05-163 (second half) against the real self-hosted backend: two cash refunds („Bar erstattet“) on the same
 * Rechnungskorrektur are sent at the same time from two clients. Convex runs both mutations optimistically; the
 * conflicting one is retried and then sees the other's refund and cash movement, so the correction is never
 * over-refunded (EC-PAY-33) and the till never goes negative (PAY-062, EC-149, RI-11 — the invariant hook checks
 * RI-11 after each test). The same scenario runs serialised in convex-test (convex/correctionRefunds.test.ts).
 *
 * Prerequisites (skipped otherwise): scripts/convex-local-backend.sh + `pnpm test:backend` (.env.test.local with
 * IS_TEST=true). The IS_TEST-only `testFixtures.ensureInvoicingSetup` fills the company setup if it is missing; the
 * calls themselves run as an API key through the normal wrappers (server JWT, scopes, audit).
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
const enabled = Boolean(
  url && adminKey && process.env.JWT_PRIVATE_KEY_PEM && process.env.API_ORIGIN && process.env.CONVEX_URL_INTERNAL,
);

function adminClient(): ConvexHttpClient {
  const client = new ConvexHttpClient(url as string);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey as string);
  return client;
}

/** A stored API key (as `apiKeys.create` does) and a caller with its own HTTP client and server JWT. */
async function keyCaller(): Promise<Caller> {
  const key = apiKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const parsed = parseApiKey(key);
  if (!parsed) throw new Error("generated key does not parse");
  const hash = await hashApiKey(key);
  // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
  await adminClient().mutation(internal.apiKeys.insert as any, {
    actorContext: { actor: "user:integration-owner", role: "owner", channel: "ui" },
    name: "integration refund race",
    channel: "api",
    scopes: [...REFUND_RACE_SCOPES],
    prefix: parsed.publicId,
    last4: parsed.last4,
    hash,
  });
  return httpBackend({ kind: "api-key", publicId: parsed.publicId, keyHash: hash, requestId: crypto.randomUUID() });
}

/**
 * Two fresh callers for the race itself: `httpBackend` mints its 60-second server JWT on the first call, so the
 * racers get theirs right before the race, independent of how long the setup took on a slow backend.
 */
async function racers(): Promise<readonly [Caller, Caller]> {
  return [await keyCaller(), await keyCaller()] as const;
}

/** IS_TEST-only setup; null when the backend is not a test deployment. */
async function ensureSetup(): Promise<boolean> {
  // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
  const r = await adminClient().mutation(internal.testFixtures.ensureInvoicingSetup as any, {});
  return r !== null;
}

async function correctionOf(caller: Caller, id: Id<"salesDocuments">) {
  const r = await caller.query(api.payments.forDocument, { documentId: id });
  return r.settlement;
}

describe.skipIf(!enabled)("concurrent cash refunds on the self-hosted backend (F05 T05-163, real OCC)", () => {
  beforeEach(() => {
    const admin = adminClient();
    // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
    useInvariantTarget({ query: (ref, args) => admin.query(ref as any, args as any) } as InvariantTarget);
  });

  test("T05-163 EC-PAY-33 two simultaneous cash refunds above the open refund: exactly one is booked", async (ctx) => {
    if (!(await ensureSetup())) ctx.skip();
    const a = await keyCaller();
    const today = berlinCalendarDate(Date.now());
    const { correctionId } = await cashPaidCreditCorrection(a, { today });
    expect((await correctionOf(a, correctionId)).openAmountCents).toBe(-OPEN_REFUND_CENTS);

    // 200,00 + 200,00 > 238,00 open refund; the till holds at least the 1.190,00 cash receipt of this invoice.
    const results = await raceCashRefunds(await racers(), correctionId, [20_000, 20_000], today);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(errorData(lost.reason)).toMatchObject({ reason: "REFUND_EXCEEDS" });
    expect(await correctionOf(a, correctionId)).toMatchObject({ openAmountCents: -3_800 });
  });

  test("T05-163 PAY-062 EC-149 RI-11 two simultaneous cash refunds that only jointly exceed the till: exactly one is booked", async (ctx) => {
    if (!(await ensureSetup())) ctx.skip();
    const a = await keyCaller();
    const today = berlinCalendarDate(Date.now());
    const { correctionId } = await cashPaidCreditCorrection(a, { today });
    // The till is shared by all runs on this backend: deposit the surplus so exactly 150,00 remain.
    await tillTo(a, today, 15_000);

    // 119,00 + 119,00 = the open refund, but only 150,00 are in the till.
    const results = await raceCashRefunds(await racers(), correctionId, [11_900, 11_900], today);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(errorData(lost.reason)).toMatchObject({ code: "cash_negative" });
    expect(await correctionOf(a, correctionId)).toMatchObject({ openAmountCents: -11_900 });
    expect((await a.query(api.cash.overview, {})).balanceCents).toBe(3_100);
  });
});
