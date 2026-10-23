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
 * Spec: 1,000 parallel finalisations (`FINALIZE_RACE_COUNT`, default 1000). Prerequisites as in refund-race.test.ts
 * (scripts/convex-local-backend.sh + `pnpm test:backend`); skipped otherwise.
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
const enabled = Boolean(
  url && adminKey && process.env.JWT_PRIVATE_KEY_PEM && process.env.API_ORIGIN && process.env.CONVEX_URL_INTERNAL,
);
const COUNT = Number(process.env.FINALIZE_RACE_COUNT ?? 1000);
const CLIENTS = 10;
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

async function keyCaller(): Promise<Caller> {
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
  return httpBackend({ kind: "api-key", publicId: parsed.publicId, keyHash: hash, requestId: crypto.randomUUID() });
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
    const setup = await keyCaller();
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
      ids.push((await setup.mutation(api.invoices.createDraft, { values: draft(contact.id, today) })).id);
    }
    // Fresh callers right before the race (their server JWT lives 60 s).
    const callers = await Promise.all(Array.from({ length: CLIENTS }, () => keyCaller()));
    const results = await Promise.allSettled(
      ids.map((id, i) => (callers[i % CLIENTS] as Caller).action(api.invoices.finalize, { id, version: 1 })),
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
      const head = await setup.query(api.documentsApi.head, { id });
      expect(head?.number && numbers.includes(head.number)).toBe(true);
    }
  });
});
