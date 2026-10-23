import { AwsClient } from "aws4fetch";
import { env, isTest } from "./env";

/**
 * Off-host store for signed checkpoints (02 §4.6, F12 AUD-016): the dedicated Cloudflare R2 checkpoint bucket via
 * the S3 API (`aws4fetch` signing). Behind an interface so tests use the in-memory fake.
 *
 * Env: R2_ACCOUNT_ENDPOINT (e.g. https://<account>.eu.r2.cloudflarestorage.com), R2_CHECKPOINT_BUCKET,
 * R2_CHECKPOINT_ACCESS_KEY_ID, R2_CHECKPOINT_SECRET_ACCESS_KEY (token limited to this bucket).
 */
export interface CheckpointStore {
  readonly name: string;
  /** `r2://<bucket>/<key>` style location for `integrityCheckpoints.exportedTo`. */
  location(key: string): string;
  put(key: string, body: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  get(key: string): Promise<string | null>;
  delete(key: string): Promise<{ ok: true } | { ok: false; detail: string }>;
  /** F01 SET-115: is a bucket-lock retention rule visible to this token? (`unknown` when it cannot be read.) */
  bucketLock(): Promise<"present" | "absent" | "unknown">;
}

export function checkpointKey(date: string): string {
  const [y, m, d] = date.split("-");
  return `checkpoints/${y}/${m}/${d}.jws`;
}

export function r2CheckpointStore(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
}): CheckpointStore {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const url = (key: string) => `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}/${key}`;
  const send = async (req: Request) =>
    config.fetchImpl ? config.fetchImpl(await client.sign(req)) : client.fetch(req);
  return {
    name: "r2",
    location: (key) => `r2://${config.bucket}/${key}`,
    async put(key, body) {
      try {
        const res = await send(
          new Request(url(key), { method: "PUT", body, headers: { "content-type": "application/jose" } }),
        );
        if (res.ok) return { ok: true };
        return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      } catch (e) {
        return { ok: false, detail: String(e).slice(0, 300) };
      }
    },
    async get(key) {
      const res = await send(new Request(url(key), { method: "GET" }));
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`R2 GET ${key}: HTTP ${res.status}`);
      return res.text();
    },
    async delete(key) {
      try {
        const res = await send(new Request(url(key), { method: "DELETE" }));
        if (res.ok || res.status === 404) return { ok: true };
        return { ok: false, detail: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
      } catch (e) {
        return { ok: false, detail: String(e).slice(0, 300) };
      }
    },
    async bucketLock() {
      // R2 exposes bucket locks through the Cloudflare API; a bucket-scoped S3 token usually cannot read them.
      try {
        const res = await send(new Request(`${url("").replace(/\/$/, "")}?object-lock`, { method: "GET" }));
        if (!res.ok) return "unknown";
        const body = await res.text();
        return /<(Rule|ObjectLockEnabled)>/.test(body) ? "present" : "absent";
      } catch {
        return "unknown";
      }
    },
  };
}

/** Latest object under `prefix` (S3 ListObjectsV2) — used for "Dokploy backups seen" (F01 SET-009b). */
export async function r2LatestObject(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}): Promise<{ ok: true; latest: { key: string; lastModified: string } | null } | { ok: false; detail: string }> {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const listUrl = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}?list-type=2&prefix=${encodeURIComponent(config.prefix)}&max-keys=1000`;
  try {
    const res = await client.fetch(listUrl);
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const xml = await res.text();
    const items = [
      ...xml.matchAll(
        /<Contents>[\s\S]*?<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>[\s\S]*?<\/Contents>/g,
      ),
    ].map((m) => ({ key: m[1] as string, lastModified: m[2] as string }));
    items.sort((a, b) => a.lastModified.localeCompare(b.lastModified));
    return { ok: true, latest: items.at(-1) ?? null };
  } catch (e) {
    return { ok: false, detail: String(e).slice(0, 300) };
  }
}

/** In-memory fake (tests). Module state: shared by all actions of one convex-test process. */
const memoryObjects = new Map<string, string>();

export function memoryCheckpointStore(bucket = "test-checkpoints"): CheckpointStore {
  return {
    name: "memory",
    location: (key) => `memory://${bucket}/${key}`,
    async put(key, body) {
      if (memoryFailures.remaining > 0) {
        memoryFailures.remaining--;
        return { ok: false, detail: "simulated upload failure" };
      }
      memoryObjects.set(key, body);
      return { ok: true };
    },
    async get(key) {
      return memoryObjects.get(key) ?? null;
    },
    async delete(key) {
      memoryObjects.delete(key);
      return { ok: true };
    },
    async bucketLock() {
      return memoryBucketLock.value;
    },
  };
}

/** Test hooks for the fake: inspect/tamper objects, simulate failures, the bucket-lock answer (E-AUD-45). */
export const memoryFailures = { remaining: 0 };
export const memoryBucketLock: { value: "present" | "absent" | "unknown" } = { value: "unknown" };
export const memoryCheckpointObjects = memoryObjects;

/** R2 when configured; the fake only with IS_TEST; otherwise null (upload fails → `uploadStatus: failed`). */
export function checkpointStoreFromEnv(): CheckpointStore | null {
  const endpoint = env("R2_ACCOUNT_ENDPOINT");
  const bucket = env("R2_CHECKPOINT_BUCKET");
  const accessKeyId = env("R2_CHECKPOINT_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_CHECKPOINT_SECRET_ACCESS_KEY");
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return r2CheckpointStore({ endpoint, bucket, accessKeyId, secretAccessKey });
  }
  return isTest() ? memoryCheckpointStore() : null;
}
