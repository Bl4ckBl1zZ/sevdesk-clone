/**
 * Enable Banking implementation of `BankFeedProvider` (F07 BNK-100…107, BNK-011, BNK-013; research 13 §3.1).
 *
 *  - Every request carries a JWT **minted per request**: RS256 signed with the application's private key, header
 *    `kid` = application ID, `iss` "enablebanking.com", `aud` "api.enablebanking.com", TTL 1 h; never stored.
 *  - `GET /aspsps`, `POST /auth`, `POST /sessions`, `GET /sessions/{id}`, `GET /accounts/{uid}/transactions`
 *    (all pages via `continuation_key`), `GET /accounts/{uid}/balances`, `DELETE /sessions/{id}`.
 *  - Owner-present calls send `Psu-Ip-Address` / `Psu-User-Agent` (BNK-107).
 *  - Error texts are redacted (no JWT, key, code or session id, BNK-013).
 */
import { importPKCS8, SignJWT } from "jose";
import { redactText } from "../../domain/banking/feed/redact";
import type { EbAccount, EbTransaction } from "../../domain/banking/sources/enable-banking";
import {
  type Aspsp,
  type Balance,
  type BankFeedProvider,
  type ConsentSession,
  type ConsentStart,
  type ConsentStatus,
  FeedHttpError,
  type FetchOptions,
  type FetchResult,
  type PsuHeaders,
} from "./feed";

export const ENABLE_BANKING_API_URL = "https://api.enablebanking.com";
export const JWT_TTL_SECONDS = 3600;
/** Safety cap for continuation pages of one logical fetch. */
const MAX_PAGES = 500;

export interface EnableBankingConfig {
  applicationId: string;
  privateKeyPem: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

type Json = Record<string, unknown>;

export function createEnableBankingProvider(config: EnableBankingConfig): BankFeedProvider {
  const baseUrl = (config.baseUrl ?? ENABLE_BANKING_API_URL).replace(/\/+$/, "");
  const doFetch = config.fetch ?? fetch;
  const now = config.now ?? Date.now;
  let keyPromise: Promise<CryptoKey> | null = null;
  const key = () => {
    keyPromise ??= importPKCS8(config.privateKeyPem.replace(/\\n/g, "\n"), "RS256") as Promise<CryptoKey>;
    return keyPromise;
  };

  async function jwt(): Promise<string> {
    const iat = Math.floor(now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: config.applicationId })
      .setIssuer("enablebanking.com")
      .setAudience("api.enablebanking.com")
      .setIssuedAt(iat)
      .setExpirationTime(iat + JWT_TTL_SECONDS)
      .sign(await key());
  }

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | undefined>; body?: Json; psu?: PsuHeaders; secrets?: string[] } = {},
  ): Promise<Json> {
    const url = new URL(baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const headers: Record<string, string> = { Authorization: `Bearer ${await jwt()}`, Accept: "application/json" };
    if (opts.body) headers["Content-Type"] = "application/json";
    if (opts.psu?.ipAddress) headers["Psu-Ip-Address"] = opts.psu.ipAddress;
    if (opts.psu?.userAgent) headers["Psu-User-Agent"] = opts.psu.userAgent;
    let res: Response;
    try {
      res = await doFetch(url.toString(), {
        method,
        headers,
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      });
    } catch (e) {
      throw new FeedHttpError(
        redactText(`Enable Banking nicht erreichbar: ${e instanceof Error ? e.message : String(e)}`, opts.secrets),
        {},
      );
    }
    const text = await res.text();
    let json: Json = {};
    try {
      json = text ? (JSON.parse(text) as Json) : {};
    } catch {
      json = {};
    }
    if (!res.ok) {
      const error = typeof json.error === "string" ? json.error : undefined;
      const message = typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
      throw new FeedHttpError(redactText(`Enable Banking ${method} ${path.split("/")[1]}: ${message}`, opts.secrets), {
        status: res.status,
        ...(error ? { error } : {}),
      });
    }
    return json;
  }

  const validUntilOf = (j: Json): number | undefined => {
    const access = j.access as { valid_until?: string } | undefined;
    const raw = access?.valid_until ?? (j.valid_until as string | undefined);
    const t = raw ? Date.parse(raw) : Number.NaN;
    return Number.isFinite(t) ? t : undefined;
  };

  return {
    kind: "enable_banking",

    async listAspsps(country) {
      const j = await call("GET", "/aspsps", { query: { country, psu_type: "business" } });
      return ((j.aspsps as Json[] | undefined) ?? []).map(
        (a): Aspsp => ({
          name: String(a.name),
          country: String(a.country),
          ...(typeof a.maximum_consent_validity === "number"
            ? { maximumConsentValidity: a.maximum_consent_validity }
            : {}),
          ...(Array.isArray(a.psu_types) ? { psuTypes: a.psu_types as string[] } : {}),
          ...(typeof a.sandbox === "boolean" ? { sandbox: a.sandbox } : {}),
          ...(typeof a.beta === "boolean" ? { beta: a.beta } : {}),
        }),
      );
    },

    async startConsent(input: ConsentStart) {
      const j = await call("POST", "/auth", {
        body: {
          access: { valid_until: new Date(input.validUntil).toISOString() },
          aspsp: input.aspsp,
          state: input.state,
          redirect_url: input.redirectUrl,
          psu_type: input.psuType,
        },
        secrets: [input.state],
      });
      if (typeof j.url !== "string") throw new FeedHttpError("Enable Banking: keine Freigabe-URL erhalten.", {});
      return {
        url: j.url,
        ...(typeof j.authorization_id === "string" ? { authorizationId: j.authorization_id } : {}),
      };
    },

    async completeConsent(code: string): Promise<ConsentSession> {
      const j = await call("POST", "/sessions", { body: { code }, secrets: [code] });
      if (typeof j.session_id !== "string") throw new FeedHttpError("Enable Banking: keine Sitzung erhalten.", {});
      const vu = validUntilOf(j);
      const aspsp = j.aspsp as { name?: string; country?: string } | undefined;
      return {
        sessionId: j.session_id,
        accounts: (j.accounts as EbAccount[] | undefined) ?? [],
        ...(vu ? { validUntil: vu } : {}),
        ...(aspsp?.name && aspsp.country ? { aspsp: { name: aspsp.name, country: aspsp.country } } : {}),
      };
    },

    async listAccounts(sessionId) {
      const j = await call("GET", `/sessions/${encodeURIComponent(sessionId)}`, { secrets: [sessionId] });
      const data = (j.accounts_data as EbAccount[] | undefined) ?? [];
      if (data.length > 0) return data;
      // Older responses list only the uids; the details come from /accounts/{uid}/details.
      const uids = ((j.accounts as unknown[]) ?? []).filter((u): u is string => typeof u === "string");
      const out: EbAccount[] = [];
      for (const uid of uids) {
        const d = await call("GET", `/accounts/${encodeURIComponent(uid)}/details`, { secrets: [sessionId] });
        out.push({ ...(d as EbAccount), uid });
      }
      return out;
    },

    async fetchTransactions(accountUid, options: FetchOptions): Promise<FetchResult> {
      const all: EbTransaction[] = [];
      let continuation: string | undefined;
      let pages = 0;
      do {
        if (options.deadline !== undefined && pages > 0 && now() >= options.deadline) {
          return { transactions: all, pages, complete: false };
        }
        const j = await call("GET", `/accounts/${encodeURIComponent(accountUid)}/transactions`, {
          query: {
            date_from: options.dateFrom,
            date_to: options.dateTo,
            strategy: options.strategy,
            continuation_key: continuation,
          },
          ...(options.psu ? { psu: options.psu } : {}),
        });
        const page = (j.transactions as EbTransaction[] | undefined) ?? [];
        all.push(...page);
        if (options.onPage) await options.onPage(page, pages);
        pages++;
        continuation = typeof j.continuation_key === "string" && j.continuation_key ? j.continuation_key : undefined;
      } while (continuation && pages < MAX_PAGES);
      return { transactions: all, pages, complete: continuation === undefined };
    },

    async fetchBalances(accountUid, psu): Promise<Balance[]> {
      const j = await call("GET", `/accounts/${encodeURIComponent(accountUid)}/balances`, psu ? { psu } : {});
      return ((j.balances as Json[] | undefined) ?? []).map((b) => ({
        ...(typeof b.name === "string" ? { name: b.name } : {}),
        balanceAmount: b.balance_amount as Balance["balanceAmount"],
        ...(typeof b.balance_type === "string" ? { balanceType: b.balance_type } : {}),
        ...(typeof b.reference_date === "string" ? { referenceDate: b.reference_date } : {}),
      }));
    },

    async consentStatus(sessionId): Promise<ConsentStatus> {
      const j = await call("GET", `/sessions/${encodeURIComponent(sessionId)}`, { secrets: [sessionId] });
      const vu = validUntilOf(j);
      return {
        status: String(j.status ?? "UNKNOWN"),
        ...(vu ? { validUntil: vu } : {}),
        accounts: ((j.accounts as unknown[]) ?? []).filter((u): u is string => typeof u === "string"),
      };
    },

    async revokeSession(sessionId) {
      await call("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, { secrets: [sessionId] });
    },
  };
}
