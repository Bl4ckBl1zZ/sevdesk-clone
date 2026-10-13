import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { ConvexHttpClient } from "convex/browser";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../convex/_generated/api";
import { apiKeyFromBytes, hashApiKey, parseApiKey } from "../../src/domain/api/keys";
import type { Scope } from "../../src/domain/schemas/scopes";
import { handleApiRequest } from "../../src/server/api/dispatch";
import { ROUTES } from "../../src/server/api/resources";
import { handleMcpRequest } from "../../src/server/mcp/handler";
import { type InvariantTarget, useInvariantTarget } from "../invariants";

/**
 * REST and MCP pipelines against the real self-hosted backend (05 §7, 06 §7): the default HTTP backend, a real
 * ES256 server JWT verified by Convex's customJwt provider, and the hash binding of API-006.
 * Prerequisites: scripts/convex-local-backend.sh + `pnpm test:backend` (writes .env.test.local); skipped otherwise.
 */
const url = process.env.CONVEX_SELF_HOSTED_URL;
const adminKey = process.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
const enabled = Boolean(
  url && adminKey && process.env.JWT_PRIVATE_KEY_PEM && process.env.API_ORIGIN && process.env.CONVEX_URL_INTERNAL,
);

function adminClient(): ConvexHttpClient {
  const client = new ConvexHttpClient(url as string);
  (client as unknown as { setAdminAuth(key: string): void }).setAdminAuth(adminKey as string);
  return client;
}

/** Inserts a key the way `apiKeys.create` does (owner action), without needing an owner session. */
async function seedKey(channel: "api" | "mcp" | "both", scopes: readonly Scope[]): Promise<string> {
  const key = apiKeyFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const parsed = parseApiKey(key);
  if (!parsed) throw new Error("generated key does not parse");
  await adminClient().mutation(internal.apiKeys.insert, {
    actorContext: { actor: "user:integration-owner", role: "owner", channel: "ui" },
    name: `integration ${channel}`,
    channel,
    scopes: [...scopes],
    prefix: parsed.publicId,
    last4: parsed.last4,
    hash: await hashApiKey(key),
  });
  return key;
}

const API = "https://api.localhost/api/v1";
const rest = (path: string, key: string, init: RequestInit = {}) =>
  handleApiRequest(
    new Request(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${key}`, ...(init.headers ?? {}) } }),
    ROUTES,
  );

const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

describe.skipIf(!enabled)("REST and MCP against the self-hosted backend (05 §7, 06 §7)", () => {
  beforeEach(() => {
    const admin = adminClient();
    // biome-ignore lint/suspicious/noExplicitAny: internal function via the admin key
    useInvariantTarget({ query: (ref, args) => admin.query(ref as any, args as any) } as InvariantTarget);
  });

  test("API-006 API-016 a real key is exchanged for a server JWT that Convex verifies; /me reflects the stored key", async () => {
    const key = await seedKey("api", ["contacts:read", "products:read"]);
    const me = await rest("/me", key);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { scopes: string[]; rate_limit: { per_minute: number } };
    expect(body.scopes.sort()).toEqual(["contacts:read", "products:read"]);
    expect(me.headers.get("ratelimit-limit")).toBeTruthy();
    // A key that only differs in its secret part has another hash: refused.
    const forged = `${key.slice(0, -4)}${key.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    expect((await rest("/me", forged)).status).toBe(401);
  });

  test("API-005 API-010 API-017 contact create with Idempotency-Key replays; the scope is enforced", async () => {
    const key = await seedKey("api", ["contacts:read", "contacts:write"]);
    const idem = crypto.randomUUID();
    const create = () =>
      rest("/contacts", key, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idem },
        body: JSON.stringify({ kind: "organization", organization_name: `Integration GmbH ${idem.slice(0, 8)}` }),
      });
    // A fresh test backend has no number ranges (setup runs through the owner UI): then the domain refusal is the
    // stored answer. Either way the second request is a replay of the first (non-5xx answers are kept 24 h).
    const first = await create();
    const firstBody = (await first.json()) as { id?: string; code?: string; errors?: { code: string }[] };
    if (first.status === 422) expect(firstBody.errors?.[0]?.code).toBe("range_default_required");
    else expect(first.status, JSON.stringify(firstBody)).toBe(201);
    const again = await create();
    expect(again.status).toBe(first.status);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect(await again.json()).toEqual(firstBody);
    if (firstBody.id) expect((await rest(`/contacts/${firstBody.id}`, key)).status).toBe(200);
    const readOnly = await seedKey("api", ["contacts:read"]);
    const denied = await rest("/contacts", readOnly, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "organization", organization_name: "Nope GmbH" }),
    });
    expect(denied.status).toBe(403);
  });

  test("MCP-001 MCP-003 an MCP key connects, lists only its tools and reads the workspace overview", async () => {
    const key = await seedKey("mcp", ["contacts:read", "settings:read"]);
    const client = new Client({ name: "integration", version: "1.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://api.localhost/api/mcp"), {
        fetch: (input, init) => handleMcpRequest(new Request(input as string | URL, init as RequestInit)),
        requestInit: { headers: { Authorization: `Bearer ${key}` } },
      }),
    );
    clients.push(client);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("contact_search");
    expect(names).not.toContain("contact_upsert");
    const overview = (await client.callTool({ name: "workspace_overview", arguments: {} })) as { isError?: boolean };
    expect(overview.isError ?? false).toBe(false);
  });
});
