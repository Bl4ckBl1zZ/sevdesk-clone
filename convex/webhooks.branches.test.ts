import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Id, TableNames } from "./_generated/dataModel";
import { finalizedInvoice } from "./invoices.fixtures";
import { errorCode } from "./lib/errors";
import {
  claimDelivery,
  deleteEndpoint,
  deliveryIdOf,
  emitBankTransactionEvent,
  emitCashMovementEvent,
  emitDocumentEvent,
  emitDunningCaseEvent,
  emitSettingsEvent,
  emitVoucherEvent,
  endpointIdOf,
  endpointView,
  getEndpoint,
  hostOf,
  insertEndpoint,
  listDeliveries,
  purgeWebhookLog,
  recordAttempt,
  replayDelivery,
  rollEndpointSecret,
  sendTestPing,
  updateEndpoint,
  WEBHOOK_MESSAGES,
} from "./model/webhooks";
import { makeT, modelCtx, type TestT } from "./test.setup";

/**
 * 05 §5 outbound webhooks — model branches: emit helpers for missing records, the claim/attempt bookkeeping for
 * deleted endpoints/events, endpoint validation and limits, the delivery log view. The delivery worker itself is
 * covered end to end in webhooks.test.ts; here the scheduled calls never run (all timers faked).
 */

const NOW = new Date("2026-10-23T10:00:00Z");
const DAY = 24 * 3600 * 1000;
const SYS = { actor: "system:test", channel: "system" } as const;
const OWNER = { actor: "user:test-owner", role: "owner", channel: "ui" } as const;
const HOOK = "https://shop.example.com/hooks/rechnung";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 204 })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function catching(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected an error");
}
const messageOf = (e: unknown) => String((e as { data?: { message?: string } }).data?.message ?? e);

/** An id of `table` that does not exist (convex-test id format: zero-padded counter + table name). */
const ghost = <T extends TableNames>(table: T) => `${"9".repeat(32 - table.length)}${table}` as Id<T>;

const addEndpoint = (t: TestT, values: Partial<Parameters<typeof insertEndpoint>[1]> = {}) =>
  t.model(OWNER, (ctx) =>
    insertEndpoint(ctx, {
      url: HOOK,
      events: ["*"],
      enabled: true,
      encryptedSecret: "enc:current",
      secretHint: "whsec_…abcd",
      ...values,
    }),
  );
const events = (t: TestT) => t.run((ctx) => ctx.db.query("webhookEvents").collect());
const deliveries = (t: TestT) => t.run((ctx) => ctx.db.query("webhookDeliveries").collect());

describe("outbox emit helpers (API-030, SND-15, PAY-060, BNK-080)", () => {
  test("API-030 a missing record or a document event the catalog lacks writes nothing", async () => {
    const t = makeT();
    vi.useRealTimers(); // the finalisation pipeline runs scheduled functions; no endpoint exists yet
    const { id } = await finalizedInvoice(t);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await addEndpoint(t);
    await t.model(SYS, async (ctx) => {
      expect(await emitDocumentEvent(ctx, ghost("salesDocuments"), "paid")).toBeNull();
      expect(await emitDocumentEvent(ctx, id, "exploded")).toBeNull();
      expect(await emitVoucherEvent(ctx, "voucher.created", ghost("vouchers"))).toBeNull();
      expect(await emitBankTransactionEvent(ctx, "bank_transaction.imported", ghost("bankTransactions"))).toBeNull();
      expect(await emitCashMovementEvent(ctx, ghost("cashTransfers"))).toBeNull();
      expect(await emitDunningCaseEvent(ctx, "dunning_case.paused", ghost("dunningCases"))).toBeNull();
    });
    expect(await events(t)).toEqual([]);
  });

  test("BNK-080 cash_movement.recorded carries the bank account, bank transaction and reversal IDs when set, null otherwise", async () => {
    const t = makeT();
    await t.asUser("owner");
    await addEndpoint(t);
    const objects = await t.run(async (ctx) => {
      const mctx = modelCtx(ctx, SYS);
      // transient rows (removed again in the same transaction) — only the event payload is under test
      const base = {
        date: "2026-10-20",
        amountCents: 5000,
        journalEntryIds: [],
        recordedAt: Date.now(),
        actor: "user:test-owner" as const,
      };
      const plain = await ctx.db.insert("cashTransfers", { ...base, kind: "private_withdrawal" });
      const linked = await ctx.db.insert("cashTransfers", {
        ...base,
        kind: "deposit_to_bank",
        bankAccountId: ghost("bankAccounts"),
        bankTransactionId: ghost("bankTransactions"),
        reversalOfId: plain,
      });
      const a = await emitCashMovementEvent(mctx, plain);
      const b = await emitCashMovementEvent(mctx, linked);
      const out = [await ctx.db.get(a as Id<"webhookEvents">), await ctx.db.get(b as Id<"webhookEvents">)];
      await ctx.db.delete(linked);
      await ctx.db.delete(plain);
      return out.map((e) => e?.object as Record<string, unknown>);
    });
    expect(objects[0]).toMatchObject({
      object: "cash_movement",
      kind: "private_withdrawal",
      bank_account_id: null,
      bank_transaction_id: null,
      reversal_of: null,
    });
    expect(objects[1]?.bank_account_id).toMatch(/^ba/);
    expect(objects[1]?.bank_transaction_id).toEqual(expect.any(String));
    expect(objects[1]?.reversal_of).toEqual(expect.any(String));
  });

  test("API-030 a settings event without changed fields (only the version moved) has no `previous`", async () => {
    const t = makeT();
    await t.asUser("owner");
    await addEndpoint(t);
    await t.model(SYS, async (ctx) => {
      await emitSettingsEvent(ctx, "settings.company.updated", ["version"]);
      await emitSettingsEvent(ctx, "settings.tax.updated", ["kleinunternehmer", "version"], { effective: "2027" });
    });
    const [company, tax] = await events(t);
    expect(company).toMatchObject({ type: "settings.company.updated", object: { id: "settings_company" } });
    expect(company?.previous).toBeUndefined();
    expect(tax).toMatchObject({
      object: { section: "tax", effective: "2027" },
      previous: { changed_fields: ["kleinunternehmer"] },
    });
  });

  test("API-030 an endpoint subscribed to other events gets no delivery; a disabled endpoint neither", async () => {
    const t = makeT();
    await t.asUser("owner");
    await addEndpoint(t, { events: ["invoice.paid"] });
    await addEndpoint(t, { enabled: false });
    expect(await t.model(SYS, (ctx) => emitSettingsEvent(ctx, "settings.company.updated", ["name"]))).toBeNull();
    expect(await deliveries(t)).toEqual([]);
  });
});

describe("delivery bookkeeping (API-029)", () => {
  async function pending(t: TestT) {
    await t.asUser("owner");
    const endpointId = await addEndpoint(t);
    await t.model(SYS, (ctx) => emitSettingsEvent(ctx, "settings.company.updated", ["name"]));
    const [d] = await deliveries(t);
    if (!d) throw new Error("no delivery");
    return { endpointId, deliveryId: d._id, eventId: d.eventId };
  }

  test("API-029 a delivery is claimed once; not yet due, already leased, unknown or finished deliveries are not", async () => {
    const t = makeT();
    const { deliveryId } = await pending(t);
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, ghost("webhookDeliveries")))).toBeNull();
    const claim = await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId));
    expect(claim).toMatchObject({ url: HOOK, encryptedSecrets: ["enc:current"], attempt: 1 });
    expect(JSON.parse(claim?.body ?? "{}")).toMatchObject({ type: "settings.company.updated" });
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId))).toBeNull(); // leased
    // a retry: the stored request snippet is kept, the claim runs again once due
    const retry = await t.model(SYS, (ctx) =>
      recordAttempt(ctx, deliveryId, { status: 500, durationMs: 10, retryAfterMs: null, error: "x".repeat(900) }, 0.5),
    );
    expect(retry.outcome).toBe("retry");
    const failed = (await deliveries(t))[0];
    expect(failed?.error?.length).toBe(500);
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId))).toBeNull(); // not yet due
    vi.setSystemTime(NOW.getTime() + (retry.retryInMs ?? 0));
    const again = await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId));
    expect(again?.attempt).toBe(2);
    expect((await deliveries(t))[0]?.requestSnippet).toBe(failed?.requestSnippet);
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 204, durationMs: 5, retryAfterMs: null })),
    ).toEqual({ outcome: "success" });
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId))).toBeNull(); // done
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 204, durationMs: 5, retryAfterMs: null })),
    ).toEqual({ outcome: "ignored" });
  });

  test("API-029 a delivery whose endpoint was deleted, whose event expired or whose endpoint is disabled is cancelled at claim time", async () => {
    const t = makeT();
    const { deliveryId, endpointId, eventId } = await pending(t);
    await t.model(OWNER, (ctx) => updateEndpoint(ctx, endpointId, { enabled: false }));
    // disabling already cancelled it; put it back to pending to check the claim-time guard
    await t.model(SYS, (ctx) => ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending", error: undefined }));
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId))).toBeNull();
    expect((await deliveries(t))[0]).toMatchObject({ status: "cancelled", error: "Endpunkt deaktiviert" });

    await t.model(OWNER, (ctx) => updateEndpoint(ctx, endpointId, { enabled: true }));
    await t.model(SYS, async (ctx) => {
      await ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending", error: undefined });
      await ctx.db.delete("webhookEvents", eventId);
    });
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId))).toBeNull();
    expect((await deliveries(t))[0]).toMatchObject({ status: "cancelled", error: "Ereignis abgelaufen" });

    await t.model(SYS, (ctx) => ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending" }));
    await t.model(OWNER, (ctx) => deleteEndpoint(ctx, endpointId));
    // deleting cancelled it too; reopen once more for the claim-time guard
    await t.model(SYS, (ctx) => ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending" }));
    expect(await t.model(SYS, (ctx) => claimDelivery(ctx, deliveryId))).toBeNull();
    expect((await deliveries(t))[0]).toMatchObject({ status: "cancelled", error: "Endpunkt gelöscht" });
  });

  test("API-029 attempts for a deleted endpoint: success, 410 and failures are recorded without touching an endpoint", async () => {
    const t = makeT();
    const { deliveryId, endpointId } = await pending(t);
    await t.model(OWNER, (ctx) => deleteEndpoint(ctx, endpointId));
    const reopen = () =>
      t.model(SYS, (ctx) => ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending", nextAttemptAt: 0 }));
    await reopen();
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 200, durationMs: 1, retryAfterMs: null })),
    ).toEqual({ outcome: "success" });
    await reopen();
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 410, durationMs: 1, retryAfterMs: null })),
    ).toEqual({ outcome: "gone" });
    await reopen();
    const r = await t.model(SYS, (ctx) =>
      recordAttempt(ctx, deliveryId, { status: null, error: "timeout", durationMs: 15_000, retryAfterMs: null }),
    );
    expect(r.outcome).toBe("retry");
    expect(await t.run((ctx) => ctx.db.query("notifications").collect())).toEqual([]);
  });

  test("API-029 a 410 for an already disabled endpoint does not disable it again; the last scheduled attempt gives up", async () => {
    const t = makeT();
    const { deliveryId, endpointId } = await pending(t);
    await t.model(OWNER, (ctx) => updateEndpoint(ctx, endpointId, { enabled: false }));
    await t.model(SYS, (ctx) => ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending" }));
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 410, durationMs: 1, retryAfterMs: null })),
    ).toEqual({ outcome: "gone" });
    expect((await t.model(SYS, (ctx) => getEndpoint(ctx, endpointId))).disabledReason).toBe("manual");

    // a disabled endpoint never reaches the 3-day disable; past the retry schedule the delivery gives up
    await t.model(SYS, (ctx) =>
      ctx.db.patch("webhookDeliveries", deliveryId, { status: "pending", attempts: 50, nextAttemptAt: 0 }),
    );
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 503, durationMs: 1, retryAfterMs: null })),
    ).toEqual({ outcome: "gave_up" });
    expect((await deliveries(t))[0]).toMatchObject({ status: "gave_up", httpStatus: 503 });
  });

  test("API-028 a failed test ping is one-shot: no retry and no failure streak on the endpoint", async () => {
    const t = makeT();
    await t.asUser("owner");
    const endpointId = await addEndpoint(t);
    const deliveryId = await t.model(OWNER, (ctx) => sendTestPing(ctx, endpointId));
    expect(
      await t.model(SYS, (ctx) => recordAttempt(ctx, deliveryId, { status: 500, durationMs: 1, retryAfterMs: null })),
    ).toEqual({ outcome: "gave_up" });
    const ep = await t.model(SYS, (ctx) => getEndpoint(ctx, endpointId));
    expect(ep.failingSince).toBeUndefined();
  });

  test("API-028 the log purge keeps pending deliveries older than 30 days and removes the rest", async () => {
    const t = makeT();
    const { deliveryId } = await pending(t);
    const later = NOW.getTime() + 31 * DAY;
    // pending (lost) delivery: kept; its event is removed with the outbox
    expect(await t.model(SYS, (ctx) => purgeWebhookLog(ctx, later))).toBe(1);
    expect((await deliveries(t)).map((d) => d._id)).toEqual([deliveryId]);
    await t.model(SYS, (ctx) => ctx.db.patch("webhookDeliveries", deliveryId, { status: "cancelled" }));
    expect(await t.model(SYS, (ctx) => purgeWebhookLog(ctx, later))).toBe(1);
    expect(await deliveries(t)).toEqual([]);
  });
});

describe("endpoints (API-028)", () => {
  test("API-028 invalid URLs and subscriptions are refused with the field; at most 20 endpoints", async () => {
    const t = makeT();
    await t.asUser("owner");
    const badUrl = await catching(addEndpoint(t, { url: "ftp://example.com/x" }));
    expect(errorCode(badUrl)).toBe("invalid_input");
    expect((badUrl as { data: { field: string } }).data.field).toBe("url");
    const badEvents = await catching(addEndpoint(t, { events: ["gibt.es.nicht"] }));
    expect((badEvents as { data: { field: string } }).data.field).toBe("events");
    for (let i = 0; i < 20; i++) await addEndpoint(t, { description: i === 0 ? `  ${"d".repeat(600)}  ` : "   " });
    const first = (await t.run((ctx) => ctx.db.query("webhookEndpoints").collect()))[0];
    expect(first?.description?.length).toBe(500);
    expect((await t.run((ctx) => ctx.db.query("webhookEndpoints").collect()))[1]?.description).toBeUndefined();
    const tooMany = await catching(addEndpoint(t));
    expect(messageOf(tooMany)).toBe(WEBHOOK_MESSAGES.tooMany);
  });

  test("API-028 updates: description set and cleared, enabling an enabled endpoint changes nothing, unknown IDs are not found", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await addEndpoint(t, { description: "Shop" });
    await t.model(OWNER, (ctx) => updateEndpoint(ctx, id, { description: "  Neuer Shop  " }));
    expect((await t.model(SYS, (ctx) => getEndpoint(ctx, id))).description).toBe("Neuer Shop");
    await t.model(OWNER, (ctx) => updateEndpoint(ctx, id, { description: null, enabled: true }));
    const ep = await t.model(SYS, (ctx) => getEndpoint(ctx, id));
    expect(ep.description).toBeUndefined();
    expect(ep.enabled).toBe(true);
    // disabling twice: the second call keeps the first disable time
    await t.model(OWNER, (ctx) => updateEndpoint(ctx, id, { enabled: false }));
    const at = (await t.model(SYS, (ctx) => getEndpoint(ctx, id))).disabledAt;
    vi.setSystemTime(NOW.getTime() + 1000);
    await t.model(OWNER, (ctx) => updateEndpoint(ctx, id, { enabled: false, description: "" }));
    expect((await t.model(SYS, (ctx) => getEndpoint(ctx, id))).disabledAt).toBe(at);

    const missing = await catching(t.model(OWNER, (ctx) => updateEndpoint(ctx, ghost("webhookEndpoints"), {})));
    expect(errorCode(missing)).toBe("not_found");
    expect(messageOf(missing)).toBe(WEBHOOK_MESSAGES.notFound);
    expect(messageOf(await catching(t.run(async (ctx) => endpointIdOf(ctx, "kaputt"))))).toBe(
      WEBHOOK_MESSAGES.notFound,
    );
    expect(messageOf(await catching(t.run(async (ctx) => deliveryIdOf(ctx, "kaputt"))))).toBe(
      WEBHOOK_MESSAGES.deliveryNotFound,
    );
  });

  test("API-028 the endpoint view shows the rolling secret only during the 24 h overlap and nulls for unset fields", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await addEndpoint(t, { enabled: false });
    let ep = await t.model(SYS, (ctx) => getEndpoint(ctx, id));
    expect(endpointView(ep, Date.now())).toMatchObject({
      description: null,
      enabled: false,
      disabledReason: "manual",
      disabledAt: null,
      secretRollingUntil: null,
      failingSince: null,
      lastSuccessAt: null,
      lastFailureAt: null,
    });
    const { previousValidUntil } = await t.model(OWNER, (ctx) =>
      rollEndpointSecret(ctx, id, { encryptedSecret: "enc:next", secretHint: "whsec_…efgh" }),
    );
    ep = await t.model(SYS, (ctx) => getEndpoint(ctx, id));
    expect(endpointView(ep, Date.now()).secretRollingUntil).toBe(previousValidUntil);
    expect(endpointView(ep, previousValidUntil).secretRollingUntil).toBeNull();
    // a test ping is claimed even while disabled and signs with both secrets during the overlap
    const ping = await t.model(OWNER, (ctx) => sendTestPing(ctx, id));
    const claim = await t.model(SYS, (ctx) => claimDelivery(ctx, ping));
    expect(claim?.encryptedSecrets).toEqual(["enc:next", "enc:current"]);
  });

  test("API-028 replay: another endpoint's delivery, an unknown delivery or an expired event is not found", async () => {
    const t = makeT();
    await t.asUser("owner");
    const a = await addEndpoint(t);
    const b = await addEndpoint(t, { url: "https://other.example.com/hook" });
    await t.model(SYS, (ctx) => emitSettingsEvent(ctx, "settings.company.updated", ["name"]));
    const all = await deliveries(t);
    const ofA = all.find((d) => d.endpointId === a);
    if (!ofA) throw new Error("no delivery");
    const wrong = await catching(t.model(OWNER, (ctx) => replayDelivery(ctx, ofA._id, b)));
    expect(messageOf(wrong)).toBe(WEBHOOK_MESSAGES.deliveryNotFound);
    expect(errorCode(await catching(t.model(OWNER, (ctx) => replayDelivery(ctx, ghost("webhookDeliveries")))))).toBe(
      "not_found",
    );
    const replayed = await t.model(OWNER, (ctx) => replayDelivery(ctx, ofA._id, a));
    expect((await t.run((ctx) => ctx.db.get(replayed)))?.replayOf).toBe(ofA._id);
    await t.model(SYS, (ctx) => ctx.db.delete("webhookEvents", ofA.eventId));
    const expired = await catching(t.model(OWNER, (ctx) => replayDelivery(ctx, ofA._id)));
    expect(messageOf(expired)).toBe(WEBHOOK_MESSAGES.deliveryNotFound);
  });

  test("API-028 the delivery log shows the next attempt only while pending, nulls for unset fields, limit clamped", async () => {
    const t = makeT();
    await t.asUser("owner");
    const id = await addEndpoint(t);
    await t.model(SYS, async (ctx) => {
      await emitSettingsEvent(ctx, "settings.company.updated", ["name"]);
      await emitSettingsEvent(ctx, "settings.tax.updated", ["name"]);
    });
    const [first] = await deliveries(t);
    if (!first) throw new Error("no delivery");
    await t.model(SYS, (ctx) =>
      recordAttempt(ctx, first._id, { status: 201, durationMs: 3, retryAfterMs: null, responseSnippet: "ok" }),
    );
    const log = await t.run((ctx) => listDeliveries(ctx, id, Date.now(), 0));
    expect(log).toHaveLength(1); // limit clamped to at least 1
    const full = await t.run((ctx) => listDeliveries(ctx, id, Date.now(), 1000));
    const pendingRow = full.find((d) => d.status === "pending");
    const done = full.find((d) => d.status === "success");
    expect(pendingRow).toMatchObject({
      nextAttemptAt: NOW.getTime(),
      lastAttemptAt: null,
      httpStatus: null,
      error: null,
      durationMs: null,
      requestSnippet: null,
      responseSnippet: null,
      replayOf: null,
    });
    expect(done).toMatchObject({ nextAttemptAt: null, httpStatus: 201, durationMs: 3, responseSnippet: "ok" });
  });

  test("API-028 hostOf falls back to the raw text for an unparsable URL", () => {
    expect(hostOf("https://shop.example.com:8443/x")).toBe("shop.example.com:8443");
    expect(hostOf("kein url")).toBe("kein url");
  });
});
