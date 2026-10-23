"use node";

import { lookup } from "node:dns/promises";

/**
 * DNS resolution for the webhook SSRF guard (05 §5.1, API-031). Node runtime only (convex/webhooksNode.ts). Every
 * address the host resolves to is checked before each attempt; a separate module so tests can replace it.
 */
export async function resolveHost(host: string): Promise<string[]> {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
}
