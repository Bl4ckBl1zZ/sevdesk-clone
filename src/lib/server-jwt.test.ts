import {
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { beforeAll, describe, expect, test } from "vitest";
import { resolveIdentity, SERVER_JWT_AUDIENCE } from "@/domain/access/identity";
import { mintServerJwt, SERVER_JWT_TTL_SECONDS } from "./server-jwt";

const API_ORIGIN = "https://api.example.de";
let pem: string;
let jwks: { keys: Record<string, unknown>[] };

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  pem = await exportPKCS8(privateKey);
  const jwk = await exportJWK(publicKey);
  jwks = { keys: [{ ...jwk, kid: await calculateJwkThumbprint(jwk), alg: "ES256", use: "sig" }] };
});

describe("server JWT for REST/MCP callers (02 §4.4)", () => {
  test("AUD-001 the token verifies against SERVER_JWKS with iss = API origin and aud = rechnungen-server", async () => {
    const token = await mintServerJwt(
      { actor: "api-key:key_abc", scopes: ["invoices:read"], keyName: "Website" },
      { privateKeyPem: pem, apiOrigin: API_ORIGIN, now: 1_790_000_000 },
    );
    const { payload, protectedHeader } = await jwtVerify(token, createLocalJWKSet(jwks as never), {
      issuer: API_ORIGIN,
      audience: SERVER_JWT_AUDIENCE,
      currentDate: new Date(1_790_000_010_000),
    });
    expect(protectedHeader).toMatchObject({ alg: "ES256", kid: jwks.keys[0]?.kid, typ: "JWT" });
    expect(payload).toMatchObject({
      sub: "api-key:key_abc",
      scopes: ["invoices:read"],
      keyName: "Website",
      iat: 1_790_000_000,
    });
    expect(payload.exp).toBe(1_790_000_000 + SERVER_JWT_TTL_SECONDS);
  });

  test("AUD-001 the verified claims map to the api-key / mcp actor (identity → actor)", async () => {
    const token = await mintServerJwt(
      {
        actor: "mcp:key_m1",
        scopes: ["audit:read", "not-a-scope"],
        keyName: "Claude",
        client: { name: "claude-code", version: "2.1" },
      },
      { privateKeyPem: pem, apiOrigin: API_ORIGIN },
    );
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as never), {
      issuer: API_ORIGIN,
      audience: SERVER_JWT_AUDIENCE,
    });
    const resolved = resolveIdentity(
      { ...payload, issuer: API_ORIGIN, subject: payload.sub as string },
      { user: "https://convex", server: API_ORIGIN },
    );
    expect(resolved).toEqual({
      kind: "mcp",
      actor: "mcp:key_m1",
      keyId: "key_m1",
      scopes: ["audit:read"],
      keyName: "Claude",
      client: { name: "claude-code", version: "2.1" },
    });
  });

  test("API-006 API-008 the token carries the key hash, the request id and the user agent", async () => {
    const token = await mintServerJwt(
      {
        actor: "api-key:key_abc",
        scopes: ["contacts:read"],
        keyHash: "ab".repeat(32),
        requestId: "req_1",
        userAgent: "website/1.0",
      },
      { privateKeyPem: pem, apiOrigin: API_ORIGIN },
    );
    const { payload } = await jwtVerify(token, createLocalJWKSet(jwks as never), {
      issuer: API_ORIGIN,
      audience: SERVER_JWT_AUDIENCE,
    });
    expect(payload).toMatchObject({ keyHash: "ab".repeat(32), requestId: "req_1", ua: "website/1.0" });
    const resolved = resolveIdentity(
      { ...payload, issuer: API_ORIGIN, subject: payload.sub as string },
      { user: "https://convex", server: API_ORIGIN },
    );
    expect(resolved).toMatchObject({ keyHash: "ab".repeat(32), requestId: "req_1", userAgent: "website/1.0" });
  });

  test("AUD-001 only api-key and mcp actors can be minted", async () => {
    await expect(
      mintServerJwt({ actor: "user:u1" as never, scopes: [] }, { privateKeyPem: pem, apiOrigin: API_ORIGIN }),
    ).rejects.toThrow("api-key");
  });

  test("AUD-001 a missing JWT_PRIVATE_KEY_PEM fails closed", async () => {
    await expect(
      mintServerJwt({ actor: "api-key:k", scopes: [] }, { privateKeyPem: "", apiOrigin: API_ORIGIN }),
    ).rejects.toThrow("JWT_PRIVATE_KEY_PEM");
  });

  test("AUD-001 kid is the RFC 7638 thumbprint of the public key", async () => {
    const token = await mintServerJwt(
      { actor: "api-key:k", scopes: [] },
      { privateKeyPem: pem, apiOrigin: API_ORIGIN },
    );
    expect(decodeProtectedHeader(token).kid).toBe(jwks.keys[0]?.kid);
  });
});
