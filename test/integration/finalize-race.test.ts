import { ConvexHttpClient } from "convex/browser";
import { beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { BERLIN, createValues, orgForm } from "../../convex/catalog.fixtures";
import { apiKeyFromBytes, hashApiKey, parseApiKey } from "../../src/domain/api/keys";
import type { DraftValues } from "../../src/domain/schemas/documents";
import type { Scope } from "../../src/domain/schemas/scopes";
import { berlinCalendarDate } from "../../src/domain/time/berlin";
import type { CalendarDate } from "../../src/domain/time/calendar-date";
import { httpBackend } from "../../src/server/api/backend";
import type { Caller } from "../factories/refund-race";
import { type InvariantTarget, useInvariantTarget } from "../invariants";

/**
 * 10-edge-cases EC-001 against the real self-hosted backend (real OCC): many drafts are finalised at the same time
 * from several clients. Every commit increments the shared counter of the invoice range; conflicting commits are
 * retried by Convex, so every document gets a distinct number and no number is issued twice (UST-06). The invariant
 * hook checks the register afterwards (RI-02/RI-03). The serialised variant runs in convex/edgeCases.finalisation.test.ts.
 *
 * Spec: 1,000 parallel finalisations (`FINALIZE_RACE_COUNT`, default 1000; `FINALIZE_RACE_IN_FLIGHT` at once, default one per client). Prerequisites as in refund-race.test.ts
 * (scripts/convex-local-backend.sh + `pnpm test:backend`); skipped otherwise.
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
const enabled = Boolean(
  url && adminKey && process.env.JWT_PRIVATE_KEY_PEM && process.env.API_ORIGIN && process.env.CONVEX_URL_INTERNAL,
);
const COUNT = Number(process.env.FINALIZE_RACE_COUNT ?? 1000);
const CLIENTS = 10;
/** Finalisations in flight at once. Each request mints its own 60 s server JWT when it is dispatched, like a REST
 * request does; with all 1,000 queued at once a slow box processes the last ones after their token expired. */
const IN_FLIGHT = Number(process.env.FINALIZE_RACE_IN_FLIGHT ?? CLIENTS);
const SCOPES: readonly Scope[] = [
  "contacts:read",
  "contacts:write",
  "documents:read",
  "documents:write",
  "invoices:finalize",
];

function adminClient(): ConvexHttpClient {
  const client = new ConvexHttpClient(url as string);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey as string);
  return client;
}

/** Inserts an API key and returns a factory: every call is a fresh caller (fresh JWT), as one REST request is. */
async function apiKeyPrincipal(): Promise<() => Caller> {
  const key = apiKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const parsed = parseApiKey(key);
  if (!parsed) throw new Error("generated key does not parse");
  const hash = await hashApiKey(key);
  // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
  await adminClient().mutation(internal.apiKeys.insert as any, {
    actorContext: { actor: "user:integration-owner", role: "owner", channel: "ui" },
    name: "integration finalise race",
    channel: "api",
    scopes: [...SCOPES],
    prefix: parsed.publicId,
    last4: parsed.last4,
    hash,
  });
  return () =>
    httpBackend({ kind: "api-key", publicId: parsed.publicId, keyHash: hash, requestId: crypto.randomUUID() });
}

/** Runs `tasks` with at most `limit` in flight; results keep the input order (like Promise.allSettled). */
async function settledPool<T>(tasks: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await (tasks[i] as () => Promise<T>)() };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

function draft(contactId: string, today: string): DraftValues {
  return {
    type: "invoice",
    contactId,
    supplyDateMode: "explicit",
    supplyDate: { kind: "date", date: today as CalendarDate },
    currency: "EUR",
    priceMode: "net",
    paymentTerms: { dueDays: 30 },
    showEpcQr: false,
    language: "de",
    einvoiceFormat: "none",
    lines: [
      {
        kind: "item",
        productType: "service",
        name: "Beratung",
        quantityMilli: 1_000,
        unitCode: "HUR",
        unitPriceMicros: 1_000_000,
        vatRateKey: "standard",
      },
    ],
  };
}

describe.skipIf(!enabled)("EC-001 parallel finalisations on the self-hosted backend (real OCC)", () => {
  beforeEach(() => {
    const admin = adminClient();
    // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
    useInvariantTarget({ action: (ref, args) => admin.action(ref as any, args as any) } as InvariantTarget);
  });

  test(`EC-001 ${COUNT} drafts finalised at the same time get distinct numbers; none is issued twice`, {
    timeout: 900_000,
  }, async (ctx) => {
    // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
    if ((await adminClient().mutation(internal.testFixtures.ensureInvoicingSetup as any, {})) === null) ctx.skip();
    const setupKey = await apiKeyPrincipal();
    const setup = setupKey();
    const today = berlinCalendarDate(Date.now());
    const label = crypto.randomUUID().slice(0, 8);
    // A consumer-free B2B buyer; format `none` keeps the sidecar out of the race (EC-007 exception).
    const contact = await setup.mutation(api.contacts.create, {
      values: createValues(orgForm(`Race ${label} GmbH`), {
        address: { ...BERLIN },
        email: `race-${label}@example.test`,
      }),
    });
    const ids: Id<"salesDocuments">[] = [];
    for (let i = 0; i < COUNT; i++) {
      ids.push((await setupKey().mutation(api.invoices.createDraft, { values: draft(contact.id, today) })).id);
    }
    // CLIENTS API keys; every finalisation is its own request with a JWT minted at dispatch (server JWTs live 60 s).
    const principals = await Promise.all(Array.from({ length: CLIENTS }, () => apiKeyPrincipal()));
    const results = await settledPool(
      ids.map(
        (id, i) => () =>
          (principals[i % CLIENTS] as () => Caller)().action(api.invoices.finalize, { id, version: 1 }) as Promise<{
            number: string;
          }>,
      ),
      IN_FLIGHT,
    );
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.map((r) => String((r as PromiseRejectedResult).reason)).slice(0, 3)).toEqual([]);
    const numbers = results.map((r) => (r as PromiseFulfilledResult<{ number: string }>).value.number);
    expect(new Set(numbers).size).toBe(COUNT);
    // Consecutive: the counters of this race form one block unless other tests finalised in between; in any case the
    // highest minus the lowest counter is at least COUNT − 1 and every number was returned exactly once.
    const counters = numbers.map((n) => Number(/(\d+)$/.exec(n)?.[1])).sort((a, b) => a - b);
    expect((counters.at(-1) ?? 0) - (counters[0] ?? 0)).toBeGreaterThanOrEqual(COUNT - 1);
    for (const id of ids.slice(0, 20)) {
      const head = await setupKey().query(api.documentsApi.head, { id });
      expect(head?.number && numbers.includes(head.number)).toBe(true);
    }
  });
});
