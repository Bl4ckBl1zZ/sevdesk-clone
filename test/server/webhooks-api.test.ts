import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, test, vi } from "vitest";
import { apiTest, call } from "./harness";

/** 05 §5.1 REST `/webhook-endpoints` (owner keys, `webhooks:manage`): outbound endpoint management only. */

vi.mock("../../convex/lib/webhookDns", () => ({
  resolveHost: async () => ["93.184.216.34"],
}));

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  vi.unstubAllGlobals();
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stubReceiver(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("ok", { status: 200 });
    }),
  );
  return sent;
}

describe("REST /webhook-endpoints (05 §5.1)", () => {
  test("API-028 create shows the whsec_ secret once, list/get never; PATCH, test.ping, delivery log, roll secret, delete", async () => {
    const h = apiTest();
    restore = h.restore;
    const sent = stubReceiver();
    const { key } = await h.t.asApiKey(["webhooks:manage"]);

    const created = await call("POST", "/webhook-endpoints", {
      key,
      body: { url: "https://hooks.example.com/rechnung", description: "Website", events: ["invoice.paid"] },
    });
    expect(created.status).toBe(201);
    const ep = (await created.json()) as Record<string, unknown>;
    expect(ep).toMatchObject({
      object: "webhook_endpoint",
      url: "https://hooks.example.com/rechnung",
      description: "Website",
      events: ["invoice.paid"],
      enabled: true,
      disabled_reason: null,
    });
    expect(String(ep.id)).toMatch(/^whe_/);
    const secret = String(ep.secret);
    expect(secret).toMatch(/^whsec_/);
    expect(ep.secret_hint).toBe(`whsec_…${secret.slice(-4)}`);
    expect(created.headers.get("location")).toBe(`/api/v1/webhook-endpoints/${ep.id}`);

    const list = await call("GET", "/webhook-endpoints", { key });
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain(secret);
    expect(JSON.parse(listText).data).toHaveLength(1);
    const got = await call("GET", `/webhook-endpoints/${ep.id}`, { key });
    expect(got.status).toBe(200);
    expect(await got.text()).not.toContain(secret);

    const patched = await call("PATCH", `/webhook-endpoints/${ep.id}`, { key, body: { events: ["*"] } });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toMatchObject({ events: ["*"] });

    const ping = await call("POST", `/webhook-endpoints/${ep.id}/test`, { key });
    expect(ping.status).toBe(202);
    const { delivery_id } = (await ping.json()) as { delivery_id: string };
    expect(delivery_id).toMatch(/^whd_/);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const verified = new Webhook(secret).verify(sent[0]?.body ?? "", sent[0]?.headers ?? {}) as { type: string };
    expect(verified.type).toBe("test.ping");

    const log = await vi.waitFor(async () => {
      const r = (await (await call("GET", `/webhook-endpoints/${ep.id}/deliveries`, { key })).json()) as {
        data: Record<string, unknown>[];
      };
      expect(r.data[0]?.status).toBe("success");
      return r;
    });
    expect(log.data[0]).toMatchObject({
      id: delivery_id,
      object: "webhook_delivery",
      type: "test.ping",
      http_status: 200,
      response_snippet: "ok",
    });
    expect(String(log.data[0]?.event_id)).toMatch(/^evt_/);

    const rolled = await call("POST", `/webhook-endpoints/${ep.id}/roll-secret`, { key });
    expect(rolled.status).toBe(200);
    const roll = (await rolled.json()) as { secret: string; previous_valid_until: string };
    expect(roll.secret).toMatch(/^whsec_/);
    expect(roll.secret).not.toBe(secret);
    expect(roll.previous_valid_until).toMatch(/Z$/);

    const replay = await call("POST", `/webhook-endpoints/${ep.id}/deliveries/${delivery_id}/replay`, { key });
    expect(replay.status).toBe(202);

    const del = await call("DELETE", `/webhook-endpoints/${ep.id}`, { key });
    expect(del.status).toBe(204);
    expect((await call("GET", `/webhook-endpoints/${ep.id}`, { key })).status).toBe(404);
  });

  test("API-031 internal targets are refused with 422 on url; another endpoint's delivery is 404; keys without webhooks:manage get 403", async () => {
    const h = apiTest();
    restore = h.restore;
    stubReceiver();
    const { key } = await h.t.asApiKey(["webhooks:manage"]);
    for (const url of ["https://127.0.0.1/hook", "https://169.254.169.254/latest", "https://localhost/hook"]) {
      const r = await call("POST", "/webhook-endpoints", { key, body: { url, events: ["*"] } });
      expect(r.status, url).toBe(422);
      expect(JSON.stringify(await r.json())).toContain("url");
    }
    const a = (await (
      await call("POST", "/webhook-endpoints", { key, body: { url: "https://a.example.com/h", events: ["*"] } })
    ).json()) as { id: string };
    const b = (await (
      await call("POST", "/webhook-endpoints", { key, body: { url: "https://b.example.com/h", events: ["*"] } })
    ).json()) as { id: string };
    const ping = (await (await call("POST", `/webhook-endpoints/${a.id}/test`, { key })).json()) as {
      delivery_id: string;
    };
    const cross = await call("POST", `/webhook-endpoints/${b.id}/deliveries/${ping.delivery_id}/replay`, { key });
    expect(cross.status).toBe(404);
    expect((await call("GET", "/webhook-endpoints/whe_nichtda", { key })).status).toBe(404);

    const other = await h.t.asApiKey(["settings:read"], { name: "andere" });
    expect((await call("GET", "/webhook-endpoints", { key: other.key })).status).toBe(403);
  });
});
