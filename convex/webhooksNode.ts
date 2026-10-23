"use node";

import { v } from "convex/values";
import { DELIVERY_TIMEOUT_MS, parseRetryAfter, SNIPPET_CHARS } from "../src/domain/webhooks/delivery";
import { webhookHeaders } from "../src/domain/webhooks/signature";
import { addressAllowed, isIpLiteral } from "../src/domain/webhooks/url";
import { internal } from "./_generated/api";
import { systemAction } from "./functions";
import { decryptSecret } from "./lib/secrets";
import { resolveHost } from "./lib/webhookDns";
import { type ClaimedDelivery, webhookProduction } from "./model/webhooks";

/**
 * Delivery worker `webhooks.deliver` (05 §5.2, 02 §7): one attempt of one delivery.
 *
 *  1. claim (serialisable; returns the URL, the encrypted secrets and the body),
 *  2. SSRF guard: the host's addresses are resolved and every one must be public or tailnet in production
 *     (src/domain/webhooks/url.ts) — checked again before every attempt,
 *  3. POST with the Standard Webhooks headers (both signatures during a secret roll), 15 s timeout, redirects not
 *     followed (`redirect: "manual"` → a 3xx counts as a failure),
 *  4. record the outcome (retry schedule, 410 → disabled, 3 days → disabled + owner notification).
 * Residual risk (documented in 05 §5.1): DNS could change between the check and fetch's own resolution (rebinding);
 * the window is milliseconds and responses are only stored as 1 KB snippets in the owner's log.
 */
export const REFUSED_ADDRESS = "Adresse nicht erlaubt (internes Netz) – Zustellung verweigert.";

async function guardHost(url: string): Promise<string | null> {
  const production = webhookProduction();
  const host = new URL(url).hostname;
  const bare = host.startsWith("[") ? host.slice(1, -1) : host;
  const addresses = isIpLiteral(bare) ? [bare] : await resolveHost(bare);
  if (addresses.length === 0) return "Host nicht auflösbar.";
  return addresses.every((a) => addressAllowed(a, production)) ? null : REFUSED_ADDRESS;
}

async function readSnippet(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    return text ? text.slice(0, SNIPPET_CHARS + 1) : undefined;
  } catch {
    return undefined;
  }
}

export const deliver = systemAction({
  job: "webhooks.deliver",
  args: { deliveryId: v.id("webhookDeliveries") },
  // Explicit types: the handler's result must not be inferred from `internal` (circular api types).
  handler: async (ctx, { deliveryId }): Promise<{ outcome: string; retryInMs?: number } | null> => {
    const claim: ClaimedDelivery | null = await ctx.runMutation(internal.webhooks.claim, { deliveryId });
    if (!claim) return null;
    const started = Date.now();
    let status: number | null = null;
    let error: string | undefined;
    let responseSnippet: string | undefined;
    let retryAfterMs: number | null = null;
    try {
      const refused = await guardHost(claim.url);
      if (refused) {
        error = refused;
      } else {
        const secrets = await Promise.all(claim.encryptedSecrets.map((s) => decryptSecret(s)));
        const headers = await webhookHeaders(secrets, claim.msgId, Math.floor(Date.now() / 1000), claim.body);
        const res = await fetch(claim.url, {
          method: "POST",
          headers: { ...headers, "user-agent": "Rechnungen-Webhooks/1" },
          body: claim.body,
          redirect: "manual",
          signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        status = res.status;
        responseSnippet = await readSnippet(res);
        retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
        if (res.status >= 300 && res.status < 400) error = `Weiterleitung (${res.status}) wird nicht verfolgt.`;
      }
    } catch (e) {
      const name = (e as { name?: string }).name;
      error =
        name === "TimeoutError" || name === "AbortError"
          ? "Zeitüberschreitung (15 s)."
          : `Verbindung fehlgeschlagen: ${(e as Error).message ?? String(e)}`.slice(0, 300);
    }
    return ctx.runMutation(internal.webhooks.record, {
      deliveryId,
      status,
      ...(error ? { error } : {}),
      durationMs: Date.now() - started,
      ...(responseSnippet ? { responseSnippet } : {}),
      retryAfterMs,
    });
  },
});
