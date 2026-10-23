import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { errorCode } from "./lib/errors";
import { emitEvent } from "./model/webhooks";
import { makeT, type TestT } from "./test.setup";

/** 05 §5 outbound webhooks: endpoints, outbox, delivery worker (Standard Webhooks), retries, disable, SSRF guard. */

const dns = vi.hoisted(() => ({ map: {} as Record<string, string[]> }));
vi.mock("./lib/webhookDns", () => ({
  resolveHost: async (host: string) => dns.map[host] ?? ["93.184.216.34"],
}));

const NOW = new Date("2026-10-23T10:00:00Z");
const S = 1000;
const H = 3600 * S;
const SYS = { actor: "system:test", channel: "system" } as const;

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
  at: number;
}
let calls: Call[] = [];
let respond: (call: Call) => Response | Promise<Response> = () => new Response(null, { status: 204 });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  calls = [];
  dns.map = {};
  respond = () => new Response(null, { status: 204 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: Call["init"]) => {
      const call = { url, init, at: Date.now() };
      calls.push(call);
      return respond(call);
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
const run = (t: TestT) => t.finishAllScheduledFunctions(vi.runAllTimers);
/** Runs only the attempts due now (the retries they schedule stay pending). */
async function once(t: TestT) {
  vi.runOnlyPendingTimers();
  await t.finishInProgressScheduledFunctions();
}

async function withEndpoint(t: TestT, values: Record<string, unknown> = {}) {
  const owner = await t.asUser("owner");
  const created = await owner.action(api.webhooks.create, {
    values: { url: "https://shop.example.com/hooks/rechnung", events: ["*"], description: "Website", ...values },
  });
  return { owner, ...created };
}
const emitPaid = (t: TestT) =>
  t.model(SYS, (ctx) =>
    emitEvent(
      ctx,
      "invoice.paid",
      { id: "inv_abc", object: "invoice", payment_status: "paid", updated_at: NOW.toISOString() },
      { payment_status: "partially_paid" },
    ),
  );
const deliveries = (t: TestT) => t.run((ctx) => ctx.db.query("webhookDeliveries").collect());
const endpointRow = (t: TestT, id: Id<"webhookEndpoints">) => t.run((ctx) => ctx.db.get(id));

describe("webhook endpoints (05 §5.1)", () => {
  test("API-028 the owner adds an endpoint: whsec_ secret shown once, stored encrypted, redacted in the audit log", async () => {
    const t = makeT();
    const { owner, endpointId, secret } = await withEndpoint(t);
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    const list = await owner.query(api.webhooks.list, {});
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      url: "https://shop.example.com/hooks/rechnung",
      description: "Website",
      events: ["*"],
      enabled: true,
      secretHint: `whsec_…${secret.slice(-4)}`,
    });
    expect(JSON.stringify(list)).not.toContain(secret);
    const row = await endpointRow(t, endpointId);
    expect(row?.encryptedSecret).not.toContain(secret.slice(6));
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    const entry = audit.find((a) => a.action === "webhook.endpoint.create");
    expect((entry?.diff as { after?: { encryptedSecret?: string } } | undefined)?.after?.encryptedSecret).toBe(
      "[redacted]",
    );
    expect(JSON.stringify(audit)).not.toContain(secret);
  });

  test("API-028 HTTPS is required in production, unknown or reserved events are refused, and only the owner manages webhooks", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    const err = await catching(
      owner.action(api.webhooks.create, { values: { url: "http://shop.example.com/x", events: ["*"] } }),
    );
    expect(messageOf(err)).toBe("Webhook-URLs müssen in der Produktion HTTPS verwenden.");
    expect(
      messageOf(
        await catching(
          owner.action(api.webhooks.create, {
            values: { url: "https://shop.example.com/x", events: ["quote.viewed"] },
          }),
        ),
      ),
    ).toBe("Das Ereignis quote.viewed ist für das Kundenportal reserviert und wird nicht gesendet.");
    const bookkeeper = await t.asUser("bookkeeper");
    expect(
      errorCode(
        await catching(
          bookkeeper.action(api.webhooks.create, { values: { url: "https://shop.example.com/x", events: ["*"] } }),
        ),
      ),
    ).toBe("forbidden_role");
    expect(errorCode(await catching(bookkeeper.query(api.webhooks.list, {})))).toBe("forbidden_role");
  });

  test("API-031 an endpoint URL naming a private, loopback or metadata address is refused at save time", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://127.0.0.1/x",
      "https://10.0.0.5/x",
      "https://localhost/x",
    ]) {
      const err = await catching(owner.action(api.webhooks.create, { values: { url, events: ["*"] } }));
      expect(messageOf(err), url).toContain("Interne Adressen");
    }
  });

  test("API-028 the `webhooks:manage` scope grants the endpoints over REST/MCP keys; other scopes do not", async () => {
    const t = makeT();
    await withEndpoint(t);
    const key = await t.asApiKey(["webhooks:manage"]);
    expect(await key.query(api.webhooks.list, {})).toHaveLength(1);
    const created = await key.action(api.webhooks.create, {
      values: { url: "https://n8n.example.org/webhook/1", events: ["invoice.paid"] },
    });
    expect(created.secret).toMatch(/^whsec_/);
    const other = await t.asApiKey(["settings:write"]);
    expect(errorCode(await catching(other.query(api.webhooks.list, {})))).toBe("forbidden_scope");
  });
});

describe("outbox (05 §5.2)", () => {
  test("API-030 without a subscribed endpoint nothing is written; an aborted transaction leaves no event", async () => {
    const t = makeT();
    expect(await emitPaid(t)).toBeNull();
    expect(await t.run((ctx) => ctx.db.query("webhookEvents").collect())).toHaveLength(0);
    await withEndpoint(t, { events: ["payment.recorded"] });
    expect(await emitPaid(t)).toBeNull(); // not subscribed
    await withEndpoint(t, { url: "https://b.example.com/x", events: ["invoice.paid"] });
    await expect(
      t.model(SYS, async (ctx) => {
        await emitEvent(ctx, "invoice.paid", { id: "inv_1", object: "invoice", updated_at: NOW.toISOString() });
        throw new Error("state change failed");
      }),
    ).rejects.toThrow("state change failed");
    expect(await t.run((ctx) => ctx.db.query("webhookEvents").collect())).toHaveLength(0);
    expect(await emitPaid(t)).not.toBeNull();
    expect(await deliveries(t)).toHaveLength(1);
  });

  test("API-030 portal events (F10) are reserved and are never emitted", async () => {
    const t = makeT();
    await withEndpoint(t);
    await expect(
      t.model(SYS, (ctx) => emitEvent(ctx, "invoice.viewed", { id: "inv_1", object: "invoice", updated_at: "" })),
    ).rejects.toThrow("not emitted");
    await expect(
      t.model(SYS, (ctx) => emitEvent(ctx, "payment.failed", { id: "pay_1", object: "payment", updated_at: "" })),
    ).rejects.toThrow("not emitted");
  });
});

describe("delivery (05 §5.2, Standard Webhooks)", () => {
  test("API-029 one POST with webhook-id / webhook-timestamp / webhook-signature that verifies with the receiver's library", async () => {
    const t = makeT();
    const { secret, owner, endpointId } = await withEndpoint(t);
    const eventId = await emitPaid(t);
    await run(t);
    expect(calls).toHaveLength(1);
    const call = calls[0] as Call;
    expect(call.url).toBe("https://shop.example.com/hooks/rechnung");
    expect(call.init.method).toBe("POST");
    expect(call.init.redirect).toBe("manual");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    expect(call.init.headers["webhook-id"]).toBe(`evt_${eventId}`);
    expect(call.init.headers["webhook-timestamp"]).toBe(String(Math.floor(NOW.getTime() / 1000)));
    const body = String(call.init.body);
    const verified = new Webhook(secret).verify(body, call.init.headers) as Record<string, unknown>;
    expect(verified).toEqual({
      type: "invoice.paid",
      id: `evt_${eventId}`,
      created_at: NOW.toISOString(),
      data: {
        object: { id: "inv_abc", object: "invoice", payment_status: "paid", updated_at: NOW.toISOString() },
        previous: { payment_status: "partially_paid" },
      },
    });
    const log = await owner.query(api.webhooks.deliveries, { endpointId });
    expect(log[0]).toMatchObject({ type: "invoice.paid", status: "success", attempts: 1, httpStatus: 204 });
    expect(log[0]?.requestSnippet).toContain('"type":"invoice.paid"');
    expect((await endpointRow(t, endpointId))?.lastSuccessAt).toBe(NOW.getTime());
  });

  test("API-029 every 2xx is a success; the response snippet is kept (1 KB)", async () => {
    const t = makeT();
    const { owner, endpointId } = await withEndpoint(t);
    respond = () => new Response(`ok ${"x".repeat(3000)}`, { status: 202 });
    await emitPaid(t);
    await run(t);
    const [d] = await owner.query(api.webhooks.deliveries, { endpointId });
    expect(d).toMatchObject({ status: "success", httpStatus: 202 });
    expect(d?.responseSnippet?.length).toBe(1025);
  });

  test("API-029 retries follow 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h; after 3 days of failures the endpoint is disabled and the owner notified", async () => {
    const t = makeT();
    const { owner, endpointId } = await withEndpoint(t);
    respond = () => new Response("kaputt", { status: 500 });
    await emitPaid(t);
    await run(t);
    expect(calls).toHaveLength(10);
    const gaps = calls.slice(1).map((c, i) => c.at - (calls[i] as Call).at);
    expect(gaps).toEqual([5 * S, 300 * S, 1800 * S, 2 * H, 5 * H, 10 * H, 14 * H, 20 * H, 24 * H]);
    const ep = await owner.query(api.webhooks.get, { endpointId });
    expect(ep).toMatchObject({ enabled: false, disabledReason: "failing" });
    const [d] = await deliveries(t);
    expect(d).toMatchObject({ status: "gave_up", attempts: 10, httpStatus: 500, responseSnippet: "kaputt" });
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.find((n) => n.kind === "webhook.disabled")).toMatchObject({
      severity: "error",
      title: "Webhook deaktiviert: shop.example.com",
      link: "/einstellungen/webhooks",
    });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((a) => a.action === "webhook.endpoint.disable")).toMatchObject({
      actor: "system:webhooks.deliver",
      reason: "Zustellungen sind seit 3 Tagen fehlgeschlagen.",
    });
    // a new event is not sent to the disabled endpoint
    expect(await emitPaid(t)).toBeNull();
  });

  test("API-029 the retry delay carries ±10 % jitter", async () => {
    const t = makeT();
    await withEndpoint(t);
    vi.spyOn(Math, "random").mockReturnValue(0);
    respond = () => new Response(null, { status: 503 });
    await emitPaid(t);
    await once(t);
    const [d] = await deliveries(t);
    expect(d).toMatchObject({ status: "pending", attempts: 1, nextAttemptAt: NOW.getTime() + 4.5 * S });
  });

  test("API-029 Retry-After is honoured for the next attempt", async () => {
    const t = makeT();
    await withEndpoint(t);
    respond = () => new Response(null, { status: 429, headers: { "retry-after": "120" } });
    await emitPaid(t);
    await once(t);
    const [d] = await deliveries(t);
    expect(d).toMatchObject({
      status: "pending",
      attempts: 1,
      httpStatus: 429,
      nextAttemptAt: NOW.getTime() + 120 * S,
    });
  });

  test("API-029 410 Gone disables the endpoint at once, without retries, and notifies the owner", async () => {
    const t = makeT();
    const { owner, endpointId } = await withEndpoint(t);
    respond = () => new Response(null, { status: 410 });
    await emitPaid(t);
    await run(t);
    expect(calls).toHaveLength(1);
    expect(await owner.query(api.webhooks.get, { endpointId })).toMatchObject({
      enabled: false,
      disabledReason: "gone",
    });
    expect((await deliveries(t))[0]).toMatchObject({ status: "failed", httpStatus: 410 });
    const notes = await t.run((ctx) => ctx.db.query("notifications").collect());
    expect(notes.filter((n) => n.kind === "webhook.disabled")).toHaveLength(1);
  });

  test("API-029 redirects are not followed: a 3xx is a failed attempt", async () => {
    const t = makeT();
    await withEndpoint(t);
    respond = () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });
    await emitPaid(t);
    await once(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.redirect).toBe("manual");
    const [d] = await deliveries(t);
    expect(d).toMatchObject({
      status: "pending",
      attempts: 1,
      httpStatus: 302,
      error: "Weiterleitung (302) wird nicht verfolgt.",
    });
  });

  test("API-029 a timeout (15 s) is a failed attempt", async () => {
    const t = makeT();
    await withEndpoint(t);
    respond = () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    };
    await emitPaid(t);
    await once(t);
    expect((await deliveries(t))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Zeitüberschreitung (15 s).",
    });
  });

  test("API-031 a host resolving to a private or metadata address is refused after DNS resolution — no request is sent", async () => {
    const t = makeT();
    await withEndpoint(t, { url: "https://rebind.example.net/hook" });
    dns.map["rebind.example.net"] = ["93.184.216.34", "169.254.169.254"];
    await emitPaid(t);
    await once(t);
    expect(calls).toHaveLength(0);
    expect((await deliveries(t))[0]).toMatchObject({
      status: "pending",
      attempts: 1,
      error: "Adresse nicht erlaubt (internes Netz) – Zustellung verweigert.",
    });
  });

  test("API-031 a tailnet receiver (100.64.0.0/10) is allowed — 05 §5.1 over the internet or the tailnet", async () => {
    const t = makeT();
    await withEndpoint(t, { url: "https://website.tail1234.ts.net/hook" });
    dns.map["website.tail1234.ts.net"] = ["100.101.102.103"];
    await emitPaid(t);
    await run(t);
    expect(calls).toHaveLength(1);
    expect((await deliveries(t))[0]).toMatchObject({ status: "success" });
  });
});

describe("secret roll, test ping, replay, log retention (05 §5.1)", () => {
  test("API-028 rolling the secret signs with both secrets for 24 h, then only with the new one", async () => {
    const t = makeT();
    const { owner, endpointId, secret: oldSecret } = await withEndpoint(t);
    const rolled = await owner.action(api.webhooks.rollSecret, { endpointId });
    expect(rolled.secret).not.toBe(oldSecret);
    expect(rolled.previousValidUntil).toBe(NOW.getTime() + 24 * H);
    expect((await owner.query(api.webhooks.get, { endpointId })).secretRollingUntil).toBe(NOW.getTime() + 24 * H);
    await emitPaid(t);
    await run(t);
    const first = calls[0] as Call;
    expect(String(first.init.headers["webhook-signature"]).split(" ")).toHaveLength(2);
    expect(new Webhook(rolled.secret).verify(String(first.init.body), first.init.headers)).toBeTruthy();
    expect(new Webhook(oldSecret).verify(String(first.init.body), first.init.headers)).toBeTruthy();

    vi.setSystemTime(NOW.getTime() + 24 * H + S);
    await emitPaid(t);
    await run(t);
    const second = calls[1] as Call;
    expect(String(second.init.headers["webhook-signature"]).split(" ")).toHaveLength(1);
    expect(() => new Webhook(oldSecret).verify(String(second.init.body), second.init.headers)).toThrow();
    expect(new Webhook(rolled.secret).verify(String(second.init.body), second.init.headers)).toBeTruthy();
  });

  test("API-028 „Test senden“ delivers test.ping to that endpoint only, also while it is disabled", async () => {
    const t = makeT();
    const { owner, endpointId, secret } = await withEndpoint(t, { enabled: false });
    await withEndpoint(t, { url: "https://other.example.com/x" });
    await owner.mutation(api.webhooks.sendTest, { endpointId });
    await run(t);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://shop.example.com/hooks/rechnung");
    expect(new Webhook(secret).verify(String(calls[0]?.init.body), calls[0]?.init.headers ?? {})).toMatchObject({
      type: "test.ping",
    });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "webhook.endpoint.test")).toBe(true);
  });

  test("API-028 „Erneut senden“ replays a delivery with the same webhook-id", async () => {
    const t = makeT();
    const { owner, endpointId } = await withEndpoint(t);
    respond = () => new Response(null, { status: 410 });
    await emitPaid(t);
    await run(t);
    await owner.mutation(api.webhooks.update, { endpointId, values: { enabled: true } });
    respond = () => new Response(null, { status: 200 });
    const [failed] = await owner.query(api.webhooks.deliveries, { endpointId });
    await owner.mutation(api.webhooks.replay, { deliveryId: failed?.deliveryId as Id<"webhookDeliveries"> });
    await run(t);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.init.headers["webhook-id"]).toBe(calls[0]?.init.headers["webhook-id"]);
    const log = await owner.query(api.webhooks.deliveries, { endpointId });
    expect(log.map((d) => d.status)).toEqual(["success", "failed"]);
    expect(log[0]?.replayOf).toBe(failed?.deliveryId);
  });

  test("API-028 disabling an endpoint by hand cancels its pending deliveries; deleting removes it", async () => {
    const t = makeT();
    const { owner, endpointId } = await withEndpoint(t);
    respond = () => new Response(null, { status: 500 });
    await emitPaid(t);
    await once(t);
    await owner.mutation(api.webhooks.update, { endpointId, values: { enabled: false } });
    expect((await deliveries(t))[0]).toMatchObject({ status: "cancelled", error: "Endpunkt deaktiviert" });
    expect(await owner.query(api.webhooks.get, { endpointId })).toMatchObject({
      enabled: false,
      disabledReason: "manual",
    });
    await owner.mutation(api.webhooks.remove, { endpointId });
    expect(await owner.query(api.webhooks.list, {})).toHaveLength(0);
  });

  test("API-028 the delivery log keeps 30 days; the sweep re-schedules a delivery whose scheduled call was lost", async () => {
    const t = makeT();
    const { owner, endpointId } = await withEndpoint(t);
    await emitPaid(t);
    await run(t);
    // a pending delivery without a scheduled call (crash between commit and delivery)
    const eventId = await t.run((ctx) =>
      ctx.db.insert("webhookEvents", { type: "invoice.paid", object: { id: "inv_x" }, createdAt: Date.now() }),
    );
    await t.run((ctx) =>
      ctx.db.insert("webhookDeliveries", {
        eventId,
        endpointId,
        type: "invoice.paid",
        status: "pending",
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: Date.now(),
      }),
    );
    expect(await t.mutation(internal.webhooks.sweep, { force: true })).toMatchObject({ scheduled: 1, purged: 0 });
    await run(t);
    expect(calls).toHaveLength(2);
    vi.setSystemTime(NOW.getTime() + 31 * 24 * H);
    expect(await t.mutation(internal.webhooks.sweep, { force: true })).toMatchObject({ purged: 4 });
    expect(await owner.query(api.webhooks.deliveries, { endpointId })).toHaveLength(0);
  });
});
