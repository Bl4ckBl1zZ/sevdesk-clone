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
  };
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
  };
}

/** Test hooks for the fake: inspect/tamper objects, simulate failures. */
export const memoryFailures = { remaining: 0 };
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
