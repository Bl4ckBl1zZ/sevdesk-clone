import { AwsClient } from "aws4fetch";
import { type LatestObject, latestOf, parseListObjects } from "../../src/domain/system/backups";
import { env, isTest } from "./env";

/**
 * Read-only bucket listing for the backup status (F12 AUD-026, 08 §8 `R2_BACKUP_READONLY_*`): the newest object
 * under a prefix. Disabled (null) unless the read-only credentials are configured; tests use the in-memory fake.
 */
export interface BucketLister {
  readonly bucket: string;
  latest(prefix: string): Promise<LatestObject | null>;
}

/** Test fake: bucket → objects. */
export const memoryBuckets = new Map<string, LatestObject[]>();

function memoryLister(bucket: string): BucketLister {
  return {
    bucket,
    async latest(prefix) {
      return latestOf((memoryBuckets.get(bucket) ?? []).filter((o) => o.key.startsWith(prefix)));
    },
  };
}

export function r2Lister(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchImpl?: typeof fetch;
}): BucketLister {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const base = `${config.endpoint.replace(/\/$/, "")}/${encodeURIComponent(config.bucket)}`;
  const send = async (req: Request) =>
    config.fetchImpl ? config.fetchImpl(await client.sign(req)) : client.fetch(req);
  return {
    bucket: config.bucket,
    async latest(prefix) {
      const all: LatestObject[] = [];
      let token: string | null = null;
      for (let page = 0; page < 50; page++) {
        const q = new URLSearchParams({ "list-type": "2", prefix, "max-keys": "1000" });
        if (token) q.set("continuation-token", token);
        const res = await send(new Request(`${base}?${q.toString()}`, { method: "GET" }));
        if (!res.ok) throw new Error(`R2 LIST ${prefix}: HTTP ${res.status}`);
        const parsed = parseListObjects(await res.text());
        all.push(...parsed.objects);
        token = parsed.next;
        if (!token) break;
      }
      return latestOf(all);
    },
  };
}

export function backupListerFromEnv(): BucketLister | null {
  const endpoint = env("R2_ACCOUNT_ENDPOINT");
  const bucket = env("R2_BACKUP_BUCKET");
  const accessKeyId = env("R2_BACKUP_READONLY_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_BACKUP_READONLY_SECRET_ACCESS_KEY");
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return r2Lister({ endpoint, bucket, accessKeyId, secretAccessKey });
  }
  return isTest() ? memoryLister("backups") : null;
}

/** The checkpoint bucket is listed with its own (bucket-scoped) token. */
export function checkpointListerFromEnv(): BucketLister | null {
  const endpoint = env("R2_ACCOUNT_ENDPOINT");
  const bucket = env("R2_CHECKPOINT_BUCKET");
  const accessKeyId = env("R2_CHECKPOINT_ACCESS_KEY_ID");
  const secretAccessKey = env("R2_CHECKPOINT_SECRET_ACCESS_KEY");
  if (endpoint && bucket && accessKeyId && secretAccessKey) {
    return r2Lister({ endpoint, bucket, accessKeyId, secretAccessKey });
  }
  return isTest() ? memoryLister("checkpoints") : null;
}
