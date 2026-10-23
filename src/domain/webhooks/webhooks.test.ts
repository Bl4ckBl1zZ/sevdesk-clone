import { Webhook } from "standardwebhooks";
import { describe, expect, test } from "vitest";
import {
  classifyAttempt,
  eventBody,
  MAX_ATTEMPTS,
  nextAttemptDelay,
  parseRetryAfter,
  RETRY_DELAYS_MS,
  shouldDisableForFailures,
  snippet,
} from "./delivery";
import {
  documentEvent,
  endpointSubscribes,
  normaliseSubscriptions,
  RESERVED_EVENT_TYPES,
  SECURITY_EVENT_TYPES,
  SUBSCRIBABLE_EVENT_TYPES,
  settlementEvent,
} from "./events";
import { secretFromBytes, secretHint, signPayload, webhookHeaders } from "./signature";
import { addressAllowed, checkEndpointUrl, classifyAddress, isProductionSite } from "./url";

const S = 1000;
const H = 3600 * S;

describe("webhook event catalog (05 §5.3)", () => {
  test("API-030 portal and online-payment events (F10) are reserved: not subscribable and refused in a subscription", () => {
    expect(RESERVED_EVENT_TYPES).toEqual(
      expect.arrayContaining(["quote.viewed", "invoice.viewed", "payment.failed", "sepa.returned"]),
    );
    for (const r of RESERVED_EVENT_TYPES) expect(SUBSCRIBABLE_EVENT_TYPES).not.toContain(r);
    const res = normaliseSubscriptions(["invoice.paid", "payment.disputed"]);
    expect(res).toEqual({
      ok: false,
      error: "Das Ereignis payment.disputed ist für das Kundenportal reserviert und wird nicht gesendet.",
    });
  });

  test("API-028 subscriptions: `*` alone wins, unknown events are refused, the list is deduplicated and sorted", () => {
    expect(normaliseSubscriptions(["invoice.paid", "*"])).toEqual({ ok: true, events: ["*"] });
    expect(normaliseSubscriptions(["payment.recorded", "invoice.paid", "invoice.paid"])).toEqual({
      ok: true,
      events: ["invoice.paid", "payment.recorded"],
    });
    expect(normaliseSubscriptions(["invoice.bezahlt"])).toEqual({ ok: false, error: "Unbekanntes Ereignis: invoice.bezahlt" });
    expect(normaliseSubscriptions(["test.ping"]).ok).toBe(false);
    expect(normaliseSubscriptions([]).ok).toBe(false);
  });

  test("AUD-015 EC-186 security events reach every `*` endpoint; test.ping is never fanned out", () => {
    expect(SECURITY_EVENT_TYPES).toEqual(["integrity.check_failed", "api_key.revoked"]);
    expect(endpointSubscribes(["*"], "api_key.revoked")).toBe(true);
    expect(endpointSubscribes(["*"], "integrity.check_failed")).toBe(true);
    expect(endpointSubscribes(["invoice.paid"], "api_key.revoked")).toBe(false);
    expect(endpointSubscribes(["*"], "test.ping")).toBe(false);
  });

  test("SND-15 document events by type: invoices, quotes and reminders get *.sent; delivery notes only *.finalized", () => {
    expect(documentEvent("invoice", "sent")).toBe("invoice.sent");
    expect(documentEvent("final_invoice", "sent_retracted")).toBe("invoice.sent_retracted");
    expect(documentEvent("quote", "sent")).toBe("quote.sent");
    expect(documentEvent("reminder", "sent")).toBe("reminder.sent");
    expect(documentEvent("delivery_note", "finalized")).toBe("delivery_note.finalized");
    expect(documentEvent("delivery_note", "sent")).toBeNull();
    expect(documentEvent("proforma", "finalized")).toBeNull();
    expect(documentEvent("cancellation", "finalized")).toBeNull();
  });

  test("PAY-060 settlement events: paid / partially_paid only for receivables and only on a change", () => {
    expect(settlementEvent("invoice", "open", "paid")).toBe("invoice.paid");
    expect(settlementEvent("invoice", "open", "partially_paid")).toBe("invoice.partially_paid");
    expect(settlementEvent("invoice", "paid", "paid")).toBeNull();
    expect(settlementEvent("invoice", "paid", "open")).toBeNull();
    expect(settlementEvent("reminder", "open", "paid")).toBeNull();
  });
});

describe("webhook delivery rules (05 §5.2)", () => {
  test("API-029 success is any 2xx; 410 disables; 3xx (no redirects), 4xx, 5xx and network errors are retried", () => {
    expect(classifyAttempt(200)).toBe("success");
    expect(classifyAttempt(204)).toBe("success");
    expect(classifyAttempt(299)).toBe("success");
    expect(classifyAttempt(410)).toBe("gone");
    for (const s of [301, 302, 400, 404, 429, 500, 503]) expect(classifyAttempt(s)).toBe("retry");
    expect(classifyAttempt(null)).toBe("retry");
  });

  test("API-029 retry schedule: immediately, 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 14 h, 20 h, 24 h with ±10 % jitter", () => {
    expect(RETRY_DELAYS_MS).toEqual([5 * S, 300 * S, 1800 * S, 2 * H, 5 * H, 10 * H, 14 * H, 20 * H, 24 * H]);
    expect(MAX_ATTEMPTS).toBe(10);
    expect(nextAttemptDelay(1, 0.5)).toBe(5 * S);
    expect(nextAttemptDelay(1, 0)).toBe(4.5 * S);
    expect(nextAttemptDelay(1, 0.999999)).toBe(5.5 * S);
    expect(nextAttemptDelay(9, 0.5)).toBe(24 * H);
    expect(nextAttemptDelay(10, 0.5)).toBeNull();
  });

  test("API-029 Retry-After (seconds or HTTP date) postpones the next attempt, never shortens it, capped at 24 h", () => {
    const now = Date.UTC(2026, 9, 23, 10, 0, 0);
    expect(parseRetryAfter("120", now)).toBe(120 * S);
    expect(parseRetryAfter(new Date(now + 60 * S).toUTCString(), now)).toBe(60 * S);
    expect(parseRetryAfter("bald", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(nextAttemptDelay(1, 0.5, 120 * S)).toBe(120 * S);
    expect(nextAttemptDelay(2, 0.5, 1 * S)).toBe(300 * S);
    expect(nextAttemptDelay(1, 0.5, 72 * H)).toBe(24 * H);
  });

  test("API-029 an endpoint failing for 3 days is disabled", () => {
    const t0 = 1_000_000;
    expect(shouldDisableForFailures(undefined, t0 + 10 * 24 * H)).toBe(false);
    expect(shouldDisableForFailures(t0, t0 + 72 * H - 1)).toBe(false);
    expect(shouldDisableForFailures(t0, t0 + 72 * H)).toBe(true);
  });

  test("API-029 body per Standard Webhooks; snippets are cut at 1 KB", () => {
    const body = eventBody({
      type: "invoice.paid",
      eventId: "evt_1",
      createdAt: Date.UTC(2026, 9, 23, 8, 0, 0),
      object: { id: "inv_1", object: "invoice" },
      previous: { payment_status: "open" },
    });
    expect(body).toEqual({
      type: "invoice.paid",
      id: "evt_1",
      created_at: "2026-10-23T08:00:00.000Z",
      data: { object: { id: "inv_1", object: "invoice" }, previous: { payment_status: "open" } },
    });
    expect(eventBody({ type: "test.ping", eventId: "e", createdAt: 0, object: {}, previous: {} }).data).toEqual({ object: {} });
    expect(snippet("x".repeat(2000))?.length).toBe(1025);
    expect(snippet("")).toBeUndefined();
  });
});

describe("webhook signatures (05 §5.2/§5.4)", () => {
  const secret = secretFromBytes(new Uint8Array(24).map((_, i) => i + 7));

  test("API-029 the signature verifies with the standardwebhooks library the website uses (05 §5.4)", async () => {
    const body = JSON.stringify({ type: "invoice.paid", id: "evt_abc", data: { object: { id: "inv_1" } } });
    const ts = Math.floor(Date.now() / 1000);
    const headers = await webhookHeaders([secret], "evt_abc", ts, body);
    expect(headers["webhook-id"]).toBe("evt_abc");
    expect(headers["webhook-timestamp"]).toBe(String(ts));
    expect(headers["webhook-signature"]).toMatch(/^v1,[A-Za-z0-9+/]+=*$/);
    expect(new Webhook(secret).verify(body, headers)).toMatchObject({ type: "invoice.paid" });
    expect(() => new Webhook(secret).verify(`${body} `, headers)).toThrow();
  });

  test("API-028 during a secret roll both signatures are sent and either secret verifies", async () => {
    const old = secretFromBytes(new Uint8Array(24).fill(3));
    const body = '{"type":"test.ping"}';
    const ts = Math.floor(Date.now() / 1000);
    const headers = await webhookHeaders([secret, old], "evt_x", ts, body);
    expect(headers["webhook-signature"].split(" ")).toHaveLength(2);
    expect(headers["webhook-signature"].split(" ")[0]).toBe(await signPayload(secret, "evt_x", ts, body));
    expect(new Webhook(secret).verify(body, headers)).toBeTruthy();
    expect(new Webhook(old).verify(body, headers)).toBeTruthy();
  });

  test("API-028 the secret is whsec_ + base64 of 24 bytes; the list shows only a hint", () => {
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    expect(secretHint(secret)).toBe(`whsec_…${secret.slice(-4)}`);
    expect(() => secretFromBytes(new Uint8Array(8))).toThrow();
  });
});

describe("webhook SSRF guard (05 §5.1)", () => {
  test("API-031 private, loopback, link-local, metadata and reserved addresses are refused in production", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.10",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "192.0.2.1",
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "64:ff9b::a00:1",
      "2002:c0a8:0101::1",
      "ff02::1",
      "[::1]",
    ]) {
      expect(addressAllowed(ip, true), ip).toBe(false);
    }
    expect(classifyAddress("169.254.169.254")).toBe("link_local");
    expect(classifyAddress("::ffff:10.0.0.1")).toBe("private");
  });

  test("API-031 public addresses and the tailnet (100.64.0.0/10, Tailscale ULA) are allowed — 05 §5.1 internet or tailnet", () => {
    for (const ip of ["93.184.216.34", "1.1.1.1", "2606:4700::1111", "100.64.0.1", "100.101.102.103", "fd7a:115c:a1e0::1"]) {
      expect(addressAllowed(ip, true), ip).toBe(true);
    }
    expect(classifyAddress("100.100.100.100")).toBe("tailnet");
    expect(classifyAddress("100.128.0.1")).toBe("public");
    expect(addressAllowed("not-an-ip", true)).toBe(false);
  });

  test("API-031 development allows local receivers; production needs HTTPS and refuses local names and IP literals", () => {
    expect(addressAllowed("127.0.0.1", false)).toBe(true);
    expect(checkEndpointUrl("http://hooks.example.com/x", true)).toEqual({
      ok: false,
      error: "Webhook-URLs müssen in der Produktion HTTPS verwenden.",
    });
    expect(checkEndpointUrl("http://localhost:3000/x", false)).toEqual({ ok: true, url: "http://localhost:3000/x" });
    expect(checkEndpointUrl("https://localhost/x", true).ok).toBe(false);
    expect(checkEndpointUrl("https://printer.local/x", true).ok).toBe(false);
    expect(checkEndpointUrl("https://metadata.google.internal/x", true).ok).toBe(false);
    expect(checkEndpointUrl("https://169.254.169.254/latest", true).ok).toBe(false);
    expect(checkEndpointUrl("https://[::1]/x", true).ok).toBe(false);
    expect(checkEndpointUrl("https://user:pw@hooks.example.com/x", true)).toEqual({
      ok: false,
      error: "Die URL darf keine Zugangsdaten enthalten.",
    });
    expect(checkEndpointUrl("ftp://hooks.example.com", true).ok).toBe(false);
    expect(checkEndpointUrl("kein url", true).ok).toBe(false);
    expect(checkEndpointUrl(" https://shop.example.com/api/rechnung#x ", true)).toEqual({
      ok: true,
      url: "https://shop.example.com/api/rechnung",
    });
    expect(checkEndpointUrl("https://web.tail1234.ts.net/hook", true).ok).toBe(true);
  });

  test("API-031 production is every site except the local development hosts", () => {
    expect(isProductionSite("https://app.8u9yhy8fewf.org")).toBe(true);
    expect(isProductionSite("https://app.test.local")).toBe(true);
    expect(isProductionSite(undefined)).toBe(true);
    expect(isProductionSite("https://app.localtest.me")).toBe(false);
    expect(isProductionSite("http://localhost:3000")).toBe(false);
  });
});
