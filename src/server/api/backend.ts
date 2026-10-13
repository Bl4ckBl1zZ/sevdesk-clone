import "server-only";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { SCOPES } from "@/domain/schemas/scopes";
import { mintServerJwt } from "@/lib/server-jwt";

/**
 * How `web` calls Convex for REST and MCP requests (02 §4.4, 05 §7): after the key was recognised, every Convex call
 * runs with a short-lived server JWT for `api-key:<id>` / `mcp:<id>` through the normal wrappers (scope check,
 * audit, triggers). The JWT carries every scope; Convex intersects it with the stored key (authoritative), so a
 * scope removed in the UI takes effect on the next call. Tests swap the factory for a convex-test adapter.
 */
export interface Principal {
  kind: "api-key" | "mcp";
  /** `key_<8>` — the actor id. */
  publicId: string;
  /** SHA-256 of the presented key; Convex refuses the token unless it matches the stored hash (API-006). */
  keyHash: string;
  requestId: string;
  userAgent?: string;
  /** MCP client info (clientInfo of the handshake), audited with MCP writes. */
  client?: { name: string; version: string };
}

export interface ConvexCaller {
  query<Q extends FunctionReference<"query">>(ref: Q, args: FunctionArgs<Q>): Promise<FunctionReturnType<Q>>;
  mutation<M extends FunctionReference<"mutation">>(ref: M, args: FunctionArgs<M>): Promise<FunctionReturnType<M>>;
  action<A extends FunctionReference<"action">>(ref: A, args: FunctionArgs<A>): Promise<FunctionReturnType<A>>;
}

export type BackendFactory = (principal: Principal) => ConvexCaller;

export const actorOf = (p: Principal) => `${p.kind}:${p.publicId}` as const;

function convexUrl(): string {
  const url = process.env.CONVEX_URL_INTERNAL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("CONVEX_URL_INTERNAL fehlt – Aufruf verweigert.");
  return url;
}

/** Production: ConvexHttpClient with a freshly minted server JWT (60 s; one per request). */
export const httpBackend: BackendFactory = (p) => {
  let client: Promise<ConvexHttpClient> | undefined;
  const ready = () => {
    client ??= (async () => {
      const c = new ConvexHttpClient(convexUrl(), { logger: false });
      c.setAuth(
        await mintServerJwt({
          actor: actorOf(p),
          scopes: SCOPES,
          keyHash: p.keyHash,
          requestId: p.requestId,
          ...(p.userAgent ? { userAgent: p.userAgent } : {}),
          ...(p.client ? { client: p.client } : {}),
        }),
      );
      return c;
    })();
    return client;
  };
  return {
    query: async (ref, args) => (await ready()).query(ref, args),
    mutation: async (ref, args) => (await ready()).mutation(ref, args),
    action: async (ref, args) => (await ready()).action(ref, args),
  };
};

let current: BackendFactory = httpBackend;

/** Tests only: route Convex calls through convex-test. Returns a restore function. */
export function setBackendFactory(factory: BackendFactory): () => void {
  const previous = current;
  current = factory;
  return () => {
    current = previous;
  };
}

export function backendFor(principal: Principal): ConvexCaller {
  return current(principal);
}
