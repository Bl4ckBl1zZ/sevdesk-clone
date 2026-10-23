import { getFunctionName, makeFunctionReference } from "convex/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SCOPES } from "@/domain/schemas/scopes";

const fake = vi.hoisted(() => ({
  clients: [] as {
    url: string;
    options: unknown;
    auth?: string;
    calls: { op: string; name: string; args: unknown }[];
  }[],
  mints: [] as Record<string, unknown>[],
}));
vi.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    state: (typeof fake.clients)[number];
    constructor(url: string, options: unknown) {
      this.state = { url, options, calls: [] };
      fake.clients.push(this.state);
    }
    setAuth(token: string) {
      this.state.auth = token;
    }
    async query(ref: unknown, args: unknown) {
      return this.record("query", ref, args);
    }
    async mutation(ref: unknown, args: unknown) {
      return this.record("mutation", ref, args);
    }
    async action(ref: unknown, args: unknown) {
      return this.record("action", ref, args);
    }
    record(op: string, ref: unknown, args: unknown) {
      this.state.calls.push({ op, name: getFunctionName(ref as never), args });
      return { op };
    }
  },
}));
vi.mock("@/lib/server-jwt", () => ({
  mintServerJwt: async (claims: Record<string, unknown>) => {
    fake.mints.push(claims);
    return `jwt-${fake.mints.length}`;
  },
}));

const { actorOf, backendFor, httpBackend, setBackendFactory } = await import("./backend");

const ENV = ["CONVEX_URL_INTERNAL", "NEXT_PUBLIC_CONVEX_URL"] as const;
const saved: Partial<Record<(typeof ENV)[number], string>> = {};
beforeEach(() => {
  fake.clients.length = 0;
  fake.mints.length = 0;
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const principal = { kind: "api-key" as const, publicId: "key_abcd1234", keyHash: "h".repeat(64), requestId: "req-1" };
const q = makeFunctionReference<"query">("contacts:list");
const m = makeFunctionReference<"mutation">("contacts:create");
const a = makeFunctionReference<"action">("exports:run");

test("API-006 one request mints one server JWT for `<kind>:<publicId>` with all scopes and the key hash, then reuses the client", async () => {
  process.env.CONVEX_URL_INTERNAL = "http://backend:3210";
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://convex.example.org";
  const caller = httpBackend(principal);
  expect(fake.clients).toHaveLength(0); // lazy: nothing happens before the first call
  expect(await caller.query(q, {} as never)).toEqual({ op: "query" });
  expect(await caller.mutation(m, { name: "x" } as never)).toEqual({ op: "mutation" });
  expect(await caller.action(a, {} as never)).toEqual({ op: "action" });
  expect(fake.clients).toHaveLength(1);
  expect(fake.clients[0]).toMatchObject({ url: "http://backend:3210", options: { logger: false }, auth: "jwt-1" });
  expect(fake.clients[0]?.calls.map((c) => `${c.op} ${c.name}`)).toEqual([
    "query contacts:list",
    "mutation contacts:create",
    "action exports:run",
  ]);
  expect(fake.mints).toEqual([
    { actor: "api-key:key_abcd1234", scopes: SCOPES, keyHash: principal.keyHash, requestId: "req-1" },
  ]);
});

test("MCP-001 an MCP principal carries user agent and client info into the JWT; the public URL is the fallback", async () => {
  process.env.NEXT_PUBLIC_CONVEX_URL = "https://convex.example.org";
  const mcp = {
    ...principal,
    kind: "mcp" as const,
    userAgent: "claude-code/2.1",
    client: { name: "claude-code", version: "2.1" },
  };
  expect(actorOf(mcp)).toBe("mcp:key_abcd1234");
  await httpBackend(mcp).query(q, {} as never);
  expect(fake.clients[0]?.url).toBe("https://convex.example.org");
  expect(fake.mints[0]).toMatchObject({
    actor: "mcp:key_abcd1234",
    userAgent: "claude-code/2.1",
    client: { name: "claude-code", version: "2.1" },
  });
});

test("API-006 without a Convex URL the call is refused (German error), no JWT is minted", async () => {
  await expect(httpBackend(principal).query(q, {} as never)).rejects.toThrow("CONVEX_URL_INTERNAL fehlt");
  expect(fake.mints).toEqual([]);
});

test("SMOKE setBackendFactory swaps the backend for tests and the restore function puts the previous one back", async () => {
  process.env.CONVEX_URL_INTERNAL = "http://backend:3210";
  const stub = { query: vi.fn(async () => "stub"), mutation: vi.fn(), action: vi.fn() };
  const restore = setBackendFactory(() => stub as never);
  expect(await backendFor(principal).query(q, {} as never)).toBe("stub");
  expect(fake.clients).toHaveLength(0);
  restore();
  await backendFor(principal).query(q, {} as never);
  expect(fake.clients).toHaveLength(1);
});
