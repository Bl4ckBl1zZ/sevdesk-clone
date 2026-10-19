import { AwsClient } from "aws4fetch";
import { env, isTest } from "./env";

/**
 * R2 receipt-inbox bucket via the S3 API (08 §3.4, F06 INB-049/052, 02 §7 `inbox.pollR2`). The Email Worker
 * `receipts-inbox` writes `inbox/<epochMs>-<uuid>.eml`; the app only LISTS, GETs and DELETEs — it never writes to
 * the bucket (no PUT on any path). Behind an interface so tests use the in-memory fake.
 *
 * Env (Convex, never stored in `integrations`, 02 §4.5): R2_ACCOUNT_ENDPOINT (the `.eu.` endpoint for an EU bucket),
 * R2_INBOX_BUCKET, R2_INBOX_ACCESS_KEY_ID, R2_INBOX_SECRET_ACCESS_KEY (token „Object Read & Write“ on that bucket
 * only — R2 has no delete-only level). Secrets are never logged or returned.
 */

export interface InboxObject {
  key: string;
  /** Epoch ms. */
  lastModified: number;
  size: number;
  etag?: string;
}

export type InboxFailure = { ok: false; status: number; detail: string };

export interface InboxBucketClient {
  readonly bucket: string;
  list(): Promise<{ ok: true; objects: InboxObject[] } | InboxFailure>;
  get(key: string): Promise<{ ok: true; bytes: Uint8Array; etag?: string; lastModified: number } | InboxFailure>;
  delete(key: string): Promise<{ ok: true } | InboxFailure>;
}

/** Objects listed per run at most (the planner then takes the 50 oldest). */
export const LIST_CAP = 1000;
export const INBOX_PREFIX = "inbox/";

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? unescapeXml(m[1] as string) : undefined;
};

const stripQuotes = (etag: string | null | undefined) => etag?.replace(/^"|"$/g, "") || undefined;

/** Parses one ListObjectsV2 page. */
export function parseListPage(xml: string): { objects: InboxObject[]; next?: string } {
  const objects: InboxObject[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1] as string;
    const key = tag(block, "Key");
    const lastModified = Date.parse(tag(block, "LastModified") ?? "");
    if (!key || Number.isNaN(lastModified)) continue;
    const etag = stripQuotes(tag(block, "ETag"));
    objects.push({ key, lastModified, size: Number(tag(block, "Size") ?? 0), ...(etag ? { etag } : {}) });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  const next = truncated ? tag(xml, "NextContinuationToken") : undefined;
  return next ? { objects, next } : { objects };
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function r2InboxClient(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
}): InboxBucketClient {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}`;
  const objectUrl = (key: string) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const send = async (url: string, method: "GET" | "DELETE") => {
    const req = new Request(url, { method });
    return config.fetchImpl ? config.fetchImpl(await client.sign(req)) : client.fetch(req);
  };
  const failure = async (res: Response): Promise<InboxFailure> => ({
    ok: false,
    status: res.status,
    detail: `HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`,
  });
  return {
    bucket: config.bucket,
    async list() {
      const objects: InboxObject[] = [];
      let token: string | undefined;
      try {
        do {
          const params = new URLSearchParams({ "list-type": "2", prefix: INBOX_PREFIX, "max-keys": "1000" });
          if (token) params.set("continuation-token", token);
          const res = await send(`${base}?${params.toString()}`, "GET");
          if (!res.ok) return failure(res);
          const page = parseListPage(await res.text());
          objects.push(...page.objects);
          token = page.next;
        } while (token && objects.length < LIST_CAP);
      } catch (e) {
        return { ok: false, status: 0, detail: short(e) };
      }
      return { ok: true, objects: objects.slice(0, LIST_CAP) };
    },
    async get(key) {
      try {
        const res = await send(objectUrl(key), "GET");
        if (!res.ok) return failure(res);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const lastModified = Date.parse(res.headers.get("last-modified") ?? "");
        const etag = stripQuotes(res.headers.get("etag"));
        return {
          ok: true,
          bytes,
          lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
          ...(etag ? { etag } : {}),
        };
      } catch (e) {
        return { ok: false, status: 0, detail: short(e) };
      }
    },
    async delete(key) {
      try {
        const res = await send(objectUrl(key), "DELETE");
        if (res.ok || res.status === 404) return { ok: true };
        return failure(res);
      } catch (e) {
        return { ok: false, status: 0, detail: short(e) };
      }
    },
  };
}

// ── in-memory fake (tests) ────────────────────────────────────────────────────────────────────────────

interface MemoryObject {
  bytes: Uint8Array;
  lastModified: number;
  etag: string;
}

/** Test hooks of the fake. Module state: shared by all actions of one convex-test process. */
export const memoryInbox = {
  objects: new Map<string, MemoryObject>(),
  /** key → HTTP status returned by GET (e.g. 500). */
  failGet: new Map<string, number>(),
  /** keys whose DELETE fails with 500. */
  failDelete: new Set<string>(),
  /** status returned by LIST (e.g. 401), null = ok. */
  listStatus: null as number | null,
  calls: { list: 0, get: [] as string[], delete: [] as string[] },
  reset() {
    this.objects.clear();
    this.failGet.clear();
    this.failDelete.clear();
    this.listStatus = null;
    this.calls = { list: 0, get: [], delete: [] };
  },
};

export function memoryInboxBucket(bucket = "test-inbox"): InboxBucketClient {
  return {
    bucket,
    async list() {
      memoryInbox.calls.list++;
      if (memoryInbox.listStatus !== null) {
        return { ok: false, status: memoryInbox.listStatus, detail: `HTTP ${memoryInbox.listStatus}` };
      }
      const objects = [...memoryInbox.objects.entries()]
        .filter(([key]) => key.startsWith(INBOX_PREFIX))
        .map(([key, o]) => ({ key, lastModified: o.lastModified, size: o.bytes.byteLength, etag: o.etag }))
        .slice(0, LIST_CAP);
      return { ok: true, objects };
    },
    async get(key) {
      memoryInbox.calls.get.push(key);
      const status = memoryInbox.failGet.get(key);
      if (status !== undefined) return { ok: false, status, detail: `HTTP ${status}` };
      const o = memoryInbox.objects.get(key);
      if (!o) return { ok: false, status: 404, detail: "HTTP 404" };
      return { ok: true, bytes: o.bytes.slice(), lastModified: o.lastModified, etag: o.etag };
    },
    async delete(key) {
      memoryInbox.calls.delete.push(key);
      if (memoryInbox.failDelete.has(key)) return { ok: false, status: 500, detail: "HTTP 500" };
      memoryInbox.objects.delete(key);
      return { ok: true };
    },
  };
}

/** E-mail-in is configured when all four Convex env values are set (SET-110 „konfiguriert / fehlt“). */
export function inboxBucketConfigured(): boolean {
  return (
    !!env("R2_ACCOUNT_ENDPOINT") &&
    !!env("R2_INBOX_BUCKET") &&
    !!env("R2_INBOX_ACCESS_KEY_ID") &&
    !!env("R2_INBOX_SECRET_ACCESS_KEY")
  );
}

/** Real R2 client when configured; the fake only with IS_TEST and R2_INBOX_FAKE=true; otherwise null (disabled). */
export function inboxBucketFromEnv(): InboxBucketClient | null {
  const endpoint = env("R2_ACCOUNT_ENDPOINT");
  const bucket = env("R2_INBOX_BUCKET");
  const accessKeyId = env("R2_INBOX_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_INBOX_SECRET_ACCESS_KEY");
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return r2InboxClient({ endpoint, bucket, accessKeyId, secretAccessKey });
  }
  return isTest() && env("R2_INBOX_FAKE") === "true" ? memoryInboxBucket() : null;
}
