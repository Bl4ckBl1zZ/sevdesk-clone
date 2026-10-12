import { getAuthConfigProvider } from "@convex-dev/better-auth/auth-config";
import type { AuthConfig } from "convex/server";

/**
 * Two JWT providers (02 §4.4):
 *  1. Better Auth (`applicationID: "convex"`, RS256, static JWKS from the Convex env `JWKS` — the backend never
 *     fetches its own public URL to verify tokens).
 *  2. Server JWT (`applicationID: "rechnungen-server"`, ES256) minted by `web` for REST API keys (`api-key:<id>`)
 *     and MCP (`mcp:<id>`) after verifying the key; public keys as a JWKS in the Convex env `SERVER_JWKS`
 *     (no fetch). Issuer `https://api.<BASE_DOMAIN>`.
 *
 * Kept self-contained (no imports from ./lib): this file is evaluated when functions are pushed, and Convex refuses
 * the push unless every env variable referenced here (JWKS, SERVER_JWKS, BASE_DOMAIN) is set — fail closed.
 */
const serverJwks = process.env.SERVER_JWKS?.trim();
const baseDomain = process.env.BASE_DOMAIN?.trim();
const serverIssuer = baseDomain ? `https://api.${baseDomain}` : undefined;

export default {
  providers: [
    getAuthConfigProvider({ jwks: process.env.JWKS?.trim() || undefined }),
    ...(serverJwks && serverIssuer
      ? [
          {
            type: "customJwt" as const,
            applicationID: "rechnungen-server",
            issuer: serverIssuer,
            algorithm: "ES256" as const,
            jwks: `data:text/plain;charset=utf-8;base64,${btoa(serverJwks)}`,
          },
        ]
      : []),
  ],
} satisfies AuthConfig;
