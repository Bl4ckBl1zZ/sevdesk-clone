/**
 * Convex function environment (`pnpm convex env set NAME value`; 08 §5.2, 02 §4.5). Read lazily at call time —
 * module scope runs at push/analyse time where the values may be absent.
 */
export function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

export function isTest(): boolean {
  return env("IS_TEST") === "true";
}

/** Variables Better Auth refuses to run without (F12 AUD-021, E-AUD-20). */
export const REQUIRED_AUTH_ENV = ["BETTER_AUTH_SECRET", "JWKS", "OWNER_EMAIL", "PASSKEY_RP_ID", "SITE_URL"] as const;

export function missingAuthEnv(): string[] {
  return REQUIRED_AUTH_ENV.filter((n) => env(n) === undefined);
}

/** Fail closed (AUD-021): auth functions refuse to run without their secrets. */
export function assertAuthEnv(): void {
  const missing = missingAuthEnv();
  if (missing.length > 0) {
    throw new Error(`${missing.join(", ")} fehlt – Anmeldung verweigert (SEC-01).`);
  }
}

/** `https://app.<BASE_DOMAIN>` — Better Auth baseURL, trusted origin, passkey origin. */
export function siteUrl(): string | undefined {
  return env("SITE_URL");
}

/** Passkey RP ID = BASE_DOMAIN (02 §4.2). */
export function passkeyRpId(): string | undefined {
  return env("PASSKEY_RP_ID") ?? env("BASE_DOMAIN");
}

export function baseDomain(): string | undefined {
  return env("BASE_DOMAIN") ?? env("PASSKEY_RP_ID");
}

/** Issuer of Better Auth JWTs (the backend's CONVEX_SITE_ORIGIN). */
export function betterAuthIssuer(): string | undefined {
  return env("CONVEX_SITE_URL");
}

/** Issuer of server-minted ES256 JWTs (api-key:/mcp: actors): `https://api.<BASE_DOMAIN>` (02 §4.4). */
export function serverJwtIssuer(): string | undefined {
  const domain = env("BASE_DOMAIN");
  return domain ? `https://api.${domain}` : undefined;
}

/** Name used for the audit-chain genesis hash (AUD-004). Must never change for an installation. */
export function instanceName(): string {
  return env("INSTANCE_NAME") ?? "rechnungen";
}

export function appName(): string {
  return env("APP_NAME") ?? "Rechnungen";
}
