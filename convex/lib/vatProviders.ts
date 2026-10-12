import type { EvatrRequest, ViesRequest } from "../../src/domain/contacts/vat-check";
import { env } from "./env";

/**
 * Outbound VAT-ID check providers (F02 CON-051/052, research 06 §B). Behind an interface so the action stays
 * testable: tests replace `fetch` (MSW-style handlers) and assert the request bodies (T-CON-034/035).
 *
 *  - BZSt eVatR REST: `POST {EVATR_BASE_URL}/app/v1/abfrage` (default https://api.evatr.vies.bzst.de)
 *  - EU VIES REST:    `POST {VIES_BASE_URL}/check-vat-number` (default https://ec.europa.eu/taxation_customs/vies/rest-api)
 *
 * Network errors and the 10-second timeout (§4.2 step 4) are returned as `httpStatus: 0` with the error text in the
 * body, which the domain maps to "unavailable".
 */
export interface ProviderResponse {
  httpStatus: number;
  body: unknown;
}

export interface VatProviderTransport {
  evatr(request: EvatrRequest): Promise<ProviderResponse>;
  vies(request: ViesRequest): Promise<ProviderResponse>;
}

export const EVATR_DEFAULT_BASE = "https://api.evatr.vies.bzst.de";
export const VIES_DEFAULT_BASE = "https://ec.europa.eu/taxation_customs/vies/rest-api";
export const PROVIDER_TIMEOUT_MS = 10_000;

async function postJson(url: string, body: unknown): Promise<ProviderResponse> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // keep the raw text as evidence
    }
    return { httpStatus: res.status, body: parsed };
  } catch (e) {
    return { httpStatus: 0, body: { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } };
  }
}

export function httpVatTransport(): VatProviderTransport {
  const evatrBase = (env("EVATR_BASE_URL") ?? EVATR_DEFAULT_BASE).replace(/\/$/, "");
  const viesBase = (env("VIES_BASE_URL") ?? VIES_DEFAULT_BASE).replace(/\/$/, "");
  return {
    evatr: (request) => postJson(`${evatrBase}/app/v1/abfrage`, request),
    vies: (request) => postJson(`${viesBase}/check-vat-number`, request),
  };
}
