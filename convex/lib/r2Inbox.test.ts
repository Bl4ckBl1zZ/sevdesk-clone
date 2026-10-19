import { afterEach, describe, expect, test } from "vitest";
import {
  inboxBucketConfigured,
  inboxBucketFromEnv,
  memoryInbox,
  memoryInboxBucket,
  parseListPage,
  r2InboxClient,
} from "./r2Inbox";

process.env.IS_TEST ??= "true";

const CONFIG = {
  endpoint: "https://acc123.eu.r2.cloudflarestorage.com/",
  bucket: "rechnungen-inbox",
  accessKeyId: "AKIDTEST",
  secretAccessKey: "super-secret-value",
};

const page = (keys: string[], next?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>rechnungen-inbox</Name>${keys
    .map(
      (k, i) =>
        `<Contents><Key>${k}</Key><LastModified>2026-10-19T08:0${i}:00.000Z</LastModified><ETag>"etag-${i}"</ETag><Size>${100 + i}</Size></Contents>`,
    )
    .join("")}<IsTruncated>${next ? "true" : "false"}</IsTruncated>${
    next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""
  }</ListBucketResult>`;

function fakeFetch(handler: (req: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(input, init);
    requests.push(req);
    return handler(req);
  }) as typeof fetch;
  return { requests, fetchImpl };
}

afterEach(() => {
  memoryInbox.reset();
  for (const k of [
    "R2_ACCOUNT_ENDPOINT",
    "R2_INBOX_BUCKET",
    "R2_INBOX_ACCESS_KEY_ID",
    "R2_INBOX_SECRET_ACCESS_KEY",
    "R2_INBOX_FAKE",
  ]) {
    delete process.env[k];
  }
});

describe("INB-049 R2 inbox client (S3 API)", () => {
  test("INB-049 list is signed, uses prefix inbox/ and follows continuation tokens; no PUT is ever issued", async () => {
    const { requests, fetchImpl } = fakeFetch((req) => {
      const url = new URL(req.url);
      return new Response(
        url.searchParams.get("continuation-token") === "tok2"
          ? page(["inbox/3-c.eml"])
          : page(["inbox/1-a.eml", "inbox/2-b&amp;x.eml"], "tok2"),
      );
    });
    const client = r2InboxClient({ ...CONFIG, fetchImpl });
    const r = await client.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.objects.map((o) => o.key)).toEqual(["inbox/1-a.eml", "inbox/2-b&x.eml", "inbox/3-c.eml"]);
    expect(r.objects[0]).toEqual({
      key: "inbox/1-a.eml",
      lastModified: Date.parse("2026-10-19T08:00:00.000Z"),
      size: 100,
      etag: "etag-0",
    });
    expect(requests).toHaveLength(2);
    for (const req of requests) {
      expect(req.method).toBe("GET");
      const url = new URL(req.url);
      expect(url.origin + url.pathname).toBe("https://acc123.eu.r2.cloudflarestorage.com/rechnungen-inbox");
      expect(url.searchParams.get("list-type")).toBe("2");
      expect(url.searchParams.get("prefix")).toBe("inbox/");
      expect(req.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
      expect(req.headers.get("authorization")).not.toContain("super-secret-value");
    }
    expect(requests.some((q) => q.method === "PUT")).toBe(false);
  });

  test("INB-049 GET returns the exact bytes with ETag and LastModified; DELETE treats 404 as done", async () => {
    const body = new Uint8Array([0, 1, 2, 250, 255]);
    const { requests, fetchImpl } = fakeFetch((req) => {
      if (req.method === "GET") {
        return new Response(body, {
          headers: { etag: '"abc"', "last-modified": "Mon, 19 Oct 2026 08:00:00 GMT" },
        });
      }
      return new Response(null, { status: req.url.endsWith("gone.eml") ? 404 : 204 });
    });
    const client = r2InboxClient({ ...CONFIG, fetchImpl });
    const g = await client.get("inbox/1729 x.eml");
    expect(g).toEqual({ ok: true, bytes: body, etag: "abc", lastModified: Date.parse("2026-10-19T08:00:00Z") });
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/rechnungen-inbox/inbox/1729%20x.eml");
    expect(await client.delete("inbox/1-a.eml")).toEqual({ ok: true });
    expect(await client.delete("inbox/gone.eml")).toEqual({ ok: true });
    expect(requests.map((r) => r.method)).toEqual(["GET", "DELETE", "DELETE"]);
  });

  test("INB-052 EC-INB-29 401/403 and network errors are reported as failures with status", async () => {
    const denied = r2InboxClient({
      ...CONFIG,
      fetchImpl: fakeFetch(() => new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 })).fetchImpl,
    });
    const l = await denied.list();
    expect(l).toMatchObject({ ok: false, status: 403 });
    expect(await denied.get("inbox/a.eml")).toMatchObject({ ok: false, status: 403 });
    expect(await denied.delete("inbox/a.eml")).toMatchObject({ ok: false, status: 403 });
    const down = r2InboxClient({
      ...CONFIG,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await down.list()).toEqual({ ok: false, status: 0, detail: "ECONNREFUSED" });
  });

  test("INB-049 parseListPage ignores malformed entries", () => {
    expect(parseListPage("<ListBucketResult><Contents><Key>x</Key></Contents></ListBucketResult>")).toEqual({
      objects: [],
    });
  });
});

describe("INB-049 memory fake and env wiring", () => {
  test("INB-049 EC-INB-27 the fake injects GET/DELETE/LIST failures and records calls", async () => {
    const bucket = memoryInboxBucket();
    memoryInbox.objects.set("inbox/1-a.eml", { bytes: new Uint8Array([1]), lastModified: 1, etag: "e1" });
    memoryInbox.objects.set("other/readme.txt", { bytes: new Uint8Array([2]), lastModified: 2, etag: "e2" });
    memoryInbox.failGet.set("inbox/1-a.eml", 500);
    expect(await bucket.get("inbox/1-a.eml")).toMatchObject({ ok: false, status: 500 });
    memoryInbox.failGet.clear();
    expect(await bucket.get("inbox/1-a.eml")).toMatchObject({ ok: true, etag: "e1" });
    const listed = await bucket.list();
    expect(listed.ok && listed.objects.map((o) => o.key)).toEqual(["inbox/1-a.eml"]);
    memoryInbox.failDelete.add("inbox/1-a.eml");
    expect(await bucket.delete("inbox/1-a.eml")).toMatchObject({ ok: false });
    expect(memoryInbox.objects.has("inbox/1-a.eml")).toBe(true);
    memoryInbox.listStatus = 401;
    expect(await bucket.list()).toMatchObject({ ok: false, status: 401 });
    expect(memoryInbox.calls).toEqual({ list: 2, get: ["inbox/1-a.eml", "inbox/1-a.eml"], delete: ["inbox/1-a.eml"] });
  });

  test("INB-052 SET-110 disabled unless configured; the fake only with IS_TEST and R2_INBOX_FAKE", () => {
    expect(inboxBucketConfigured()).toBe(false);
    expect(inboxBucketFromEnv()).toBeNull();
    process.env.R2_INBOX_FAKE = "true";
    expect(inboxBucketFromEnv()?.bucket).toBe("test-inbox");
    process.env.R2_ACCOUNT_ENDPOINT = CONFIG.endpoint;
    process.env.R2_INBOX_BUCKET = CONFIG.bucket;
    process.env.R2_INBOX_ACCESS_KEY_ID = CONFIG.accessKeyId;
    process.env.R2_INBOX_SECRET_ACCESS_KEY = CONFIG.secretAccessKey;
    expect(inboxBucketConfigured()).toBe(true);
    const real = inboxBucketFromEnv();
    expect(real?.bucket).toBe("rechnungen-inbox");
    expect(JSON.stringify(real)).not.toContain("super-secret-value");
  });
});
