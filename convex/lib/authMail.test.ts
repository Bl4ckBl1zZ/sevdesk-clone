import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { makeT } from "../test.setup";
import { type AuthMail, cloudflareSender, mapCloudflareError, parseFrom } from "./authMail";

const MAIL: AuthMail = {
  to: "owner@example.test",
  kind: "test",
  subject: "Betreff",
  text: "Text",
  html: "<p>Text</p>",
};
const CONFIG = { accountId: "acc123", apiToken: "tok", from: "Rechnungen <noreply@mail.example.de>" };

function fakeFetch(status: number, body: unknown, calls: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

describe("Cloudflare Email Sending transport (02 §9, F01 §5.9)", () => {
  test("SET-009a posts {from, to, subject, text, html} with the bearer token to the account endpoint", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const res = await cloudflareSender({ ...CONFIG, fetchImpl: fakeFetch(200, { success: true }, calls) }).send(MAIL);
    expect(res).toEqual({ ok: true, transport: "cloudflare" });
    expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc123/email/sending/send");
    const call = calls[0];
    if (!call) throw new Error("no request");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(JSON.parse(call.init.body as string)).toEqual({
      from: { name: "Rechnungen", address: "noreply@mail.example.de" },
      to: "owner@example.test",
      subject: "Betreff",
      text: "Text",
      html: "<p>Text</p>",
    });
  });

  test("SET-009a missing configuration is reported without a request (EMAIL_NOT_CONFIGURED)", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const res = await cloudflareSender({ ...CONFIG, apiToken: undefined, fetchImpl: fakeFetch(200, {}, calls) }).send(
      MAIL,
    );
    expect(res).toMatchObject({
      ok: false,
      code: "EMAIL_NOT_CONFIGURED",
      message: "E-Mail-Versand ist nicht eingerichtet (Cloudflare-Zugang fehlt).",
    });
    expect(calls).toHaveLength(0);
  });

  test.each([
    [403, [{ code: 10000, message: "Authentication error" }], "EMAIL_TOKEN_REJECTED"],
    [400, [{ code: 10102 }], "EMAIL_TOKEN_REJECTED"],
    [400, [{ code: 10105, message: "plan" }], "EMAIL_PLAN_REQUIRED"],
    [400, [{ code: 10203 }], "EMAIL_SENDING_DISABLED"],
    [429, [], "EMAIL_THROTTLED"],
    [400, [{ code: 1, message: "Sender domain is not onboarded" }], "EMAIL_SENDER_NOT_ONBOARDED"],
    [500, [{ code: 1, message: "boom" }], "EMAIL_ERROR"],
  ] as const)("SET-009a HTTP %i %j maps to %s", (status, errors, code) => {
    expect(mapCloudflareError(status, [...errors])).toBe(code);
  });

  test("SET-009a an error response yields the German message with the sender domain", async () => {
    const res = await cloudflareSender({
      ...CONFIG,
      fetchImpl: fakeFetch(400, { success: false, errors: [{ code: 1, message: "domain not verified" }] }),
    }).send(MAIL);
    expect(res).toMatchObject({
      ok: false,
      code: "EMAIL_SENDER_NOT_ONBOARDED",
      message: "Die Absenderdomain mail.example.de ist bei Cloudflare Email Service nicht eingerichtet.",
    });
  });

  test("SET-009a network failures and timeouts are EMAIL_UNREACHABLE", async () => {
    const hang = ((_url: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      )) as typeof fetch;
    const res = await cloudflareSender({ ...CONFIG, fetchImpl: hang, timeoutMs: 10 }).send(MAIL);
    expect(res).toMatchObject({
      ok: false,
      code: "EMAIL_UNREACHABLE",
      message: "Cloudflare ist nicht erreichbar. Ausgehende Verbindung des Servers prüfen.",
    });
  });

  test("SET-009a AUTH_MAIL_FROM accepts a bare address or 'Name <address>'", () => {
    expect(parseFrom("noreply@x.de", "App")).toEqual({ name: "App", address: "noreply@x.de" });
    expect(parseFrom("Firma GmbH <noreply@x.de>", "App")).toEqual({ name: "Firma GmbH", address: "noreply@x.de" });
  });
});

describe("test mail (F01 SET-107)", () => {
  const saved = process.env.AUTH_MAIL_SENDER;
  afterEach(() => {
    process.env.AUTH_MAIL_SENDER = saved;
  });

  test("SET-107 the owner sends a test mail to their own address; the result is stored on integrations[cloudflare_email]", async () => {
    const t = makeT();
    const owner = await t.asUser("owner", { email: "chefin@example.test" });
    const res = await owner.action(api.authMail.sendTest, {});
    expect(res).toEqual({ ok: true, message: "Testnachricht an chefin@example.test gesendet.", transport: "memory" });
    expect(await t.query(internal.signup.latestMailFor, { to: "chefin@example.test" })).toMatchObject({ kind: "test" });
    const row = await t.run((ctx) =>
      ctx.db
        .query("integrations")
        .withIndex("by_kind", (q) => q.eq("kind", "cloudflare_email"))
        .first(),
    );
    expect(row).toMatchObject({ lastTestOk: true, lastTestDetail: "ok (memory)" });
  });

  test("SET-107 a failing transport is reported in German and recorded; non-owners may not send", async () => {
    const t = makeT();
    const owner = await t.asUser("owner");
    process.env.AUTH_MAIL_SENDER = "cloudflare";
    const res = await owner.action(api.authMail.sendTest, {});
    expect(res).toMatchObject({
      ok: false,
      message: "E-Mail-Versand ist nicht eingerichtet (Cloudflare-Zugang fehlt).",
      transport: "cloudflare",
    });
    const row = await t.run((ctx) => ctx.db.query("integrations").first());
    expect(row?.lastTestDetail).toMatch(/^EMAIL_NOT_CONFIGURED: /);
    const viewer = await t.asUser("viewer");
    await expect(viewer.action(api.authMail.sendTest, {})).rejects.toThrow();
  });
});
