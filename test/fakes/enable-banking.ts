/**
 * In-memory fake of the Enable Banking API (07 §3.3: MSW-style mock of the provider, F07 T07-131…144). Routes requests
 * by method + path like the real API, verifies the RS256 application JWT against the registered public key, pages
 * transactions with `continuation_key`, and lets a test program failures (503, 429, `EXPIRED_SESSION`), expire
 * sessions and re-issue account `uid`s on re-consent (stable `identification_hash`). Install with
 * `vi.stubGlobal("fetch", fake.fetch)`.
 */
import { importSPKI, jwtVerify } from "jose";
import type { EbTransaction } from "../../src/domain/banking/sources/enable-banking";

export const FAKE_EB_URL = "https://api.enablebanking.com";

export interface FakeBankAccount {
  identificationHash: string;
  currency: string;
  iban?: string;
  other?: { identification: string; scheme_name: string };
  name?: string;
  product?: string;
  status?: string;
  transactions: EbTransaction[];
  balance?: { amount: string; currency: string };
}

export interface FakeCall {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: unknown;
}

interface Session {
  id: string;
  status: "AUTHORIZED" | "EXPIRED" | "REVOKED";
  validUntil: string;
  uids: Map<string, string>; // uid → identificationHash
}

type Failure = { status: number; error?: string; message?: string };

export class FakeEnableBanking {
  applicationId: string;
  publicKeyPem: string | null = null;
  maximumConsentValidity = 180 * 86_400;
  pageSize = 2;
  /** Only rows booked on/after this date are served (the bank's history limit), unless `longestAllowed`. */
  historyFrom: string | null = null;
  calls: FakeCall[] = [];
  accounts: FakeBankAccount[] = [];
  readonly authorizations = new Map<
    string,
    { state: string; validUntil: string; redirectUrl: string; body: unknown }
  >();
  readonly codes = new Map<string, string>(); // code → state
  readonly sessions = new Map<string, Session>();
  private failures: { match: (c: FakeCall) => boolean; failure: Failure; times: number }[] = [];
  private seq = 0;

  constructor(applicationId = "app-1234") {
    this.applicationId = applicationId;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    return this.handle(req);
  };

  /** Program the next `times` matching calls to fail. */
  failNext(match: string | ((c: FakeCall) => boolean), failure: Failure, times = 1) {
    const m = typeof match === "string" ? (c: FakeCall) => c.path.startsWith(match) : match;
    this.failures.push({ match: m, failure, times });
  }

  /** The owner approves the consent at the bank: returns the authorisation `code` the redirect carries. */
  approve(state: string): string {
    const code = `code-${++this.seq}-${Math.random().toString(36).slice(2, 10)}`;
    this.codes.set(code, state);
    return code;
  }

  expireAllSessions(status: "EXPIRED" | "REVOKED" = "EXPIRED") {
    for (const s of this.sessions.values()) s.status = status;
  }

  callsTo(prefix: string, method?: string) {
    return this.calls.filter((c) => c.path.startsWith(prefix) && (!method || c.method === method));
  }

  /** uid of an account (by identification hash) in the newest session. */
  uidOf(identificationHash: string): string | undefined {
    const sessions = [...this.sessions.values()];
    for (let i = sessions.length - 1; i >= 0; i--) {
      for (const [uid, h] of (sessions[i] as Session).uids) if (h === identificationHash) return uid;
    }
    return undefined;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  private async verifyJwt(auth: string | null): Promise<string | null> {
    if (!auth?.startsWith("Bearer ")) return "missing JWT";
    if (!this.publicKeyPem) return "no application key registered";
    try {
      const key = await importSPKI(this.publicKeyPem, "RS256");
      const { payload, protectedHeader } = await jwtVerify(auth.slice(7), key, {
        issuer: "enablebanking.com",
        audience: "api.enablebanking.com",
      });
      if (protectedHeader.kid !== this.applicationId) return "unknown application";
      if ((payload.exp ?? 0) - (payload.iat ?? 0) > 86_400) return "JWT lifetime too long";
      return null;
    } catch (e) {
      return `JWT invalid: ${(e as Error).message}`;
    }
  }

  private accountByUid(uid: string): { account: FakeBankAccount; session: Session } | null {
    for (const s of this.sessions.values()) {
      const hash = s.uids.get(uid);
      if (hash) {
        const account = this.accounts.find((a) => a.identificationHash === hash);
        if (account) return { account, session: s };
      }
    }
    return null;
  }

  private accountResource(uid: string, a: FakeBankAccount) {
    return {
      uid,
      identification_hash: a.identificationHash,
      account_id: { ...(a.iban ? { iban: a.iban } : {}), ...(a.other ? { other: a.other } : {}) },
      currency: a.currency,
      ...(a.name ? { name: a.name } : {}),
      ...(a.product ? { product: a.product } : {}),
      ...(a.status ? { status: a.status } : {}),
    };
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const text = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
    const call: FakeCall = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers,
      ...(text ? { body: JSON.parse(text) } : {}),
    };
    this.calls.push(call);
    const jwtError = await this.verifyJwt(req.headers.get("authorization"));
    if (jwtError) return this.json(401, { code: 401, error: "INVALID_JWT", message: jwtError });
    const f = this.failures.find((x) => x.times > 0 && x.match(call));
    if (f) {
      f.times--;
      return this.json(f.failure.status, {
        code: f.failure.status,
        ...(f.failure.error ? { error: f.failure.error } : {}),
        message: f.failure.message ?? "programmed failure",
      });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    const body = (call.body ?? {}) as Record<string, unknown>;

    if (req.method === "GET" && parts[0] === "aspsps") {
      return this.json(200, {
        aspsps: [
          {
            name: "Revolut",
            country: "LT",
            psu_types: ["business", "personal"],
            maximum_consent_validity: this.maximumConsentValidity,
          },
          {
            name: "Revolut",
            country: "DE",
            psu_types: ["business"],
            maximum_consent_validity: this.maximumConsentValidity,
          },
        ].filter((a) => !url.searchParams.get("country") || a.country === url.searchParams.get("country")),
      });
    }
    if (req.method === "POST" && parts[0] === "auth") {
      const state = String(body.state ?? "");
      const id = `auth-${++this.seq}`;
      const access = body.access as { valid_until?: string } | undefined;
      this.authorizations.set(id, {
        state,
        validUntil: String(access?.valid_until ?? ""),
        redirectUrl: String(body.redirect_url ?? ""),
        body,
      });
      return this.json(200, { url: `https://bank.example/approve?authorization=${id}`, authorization_id: id });
    }
    if (req.method === "POST" && parts[0] === "sessions") {
      const code = String(body.code ?? "");
      const state = this.codes.get(code);
      if (state === undefined)
        return this.json(422, { code: 422, error: "AUTHORIZATION_NOT_FOUND", message: "code unknown or used" });
      this.codes.delete(code);
      const auth = [...this.authorizations.values()].find((a) => a.state === state);
      const id = `sess-${++this.seq}-${Math.random().toString(36).slice(2, 10)}`;
      const uids = new Map<string, string>();
      for (const a of this.accounts) uids.set(`uid-${++this.seq}`, a.identificationHash);
      const session: Session = { id, status: "AUTHORIZED", validUntil: auth?.validUntil ?? "", uids };
      this.sessions.set(id, session);
      return this.json(200, {
        session_id: id,
        accounts: [...uids.entries()].map(([uid, h]) =>
          this.accountResource(uid, this.accounts.find((a) => a.identificationHash === h) as FakeBankAccount),
        ),
        aspsp: { name: "Revolut", country: "LT" },
        psu_type: "business",
        access: { valid_until: session.validUntil },
      });
    }
    if (parts[0] === "sessions" && parts[1]) {
      const s = this.sessions.get(parts[1]);
      if (!s) return this.json(404, { code: 404, error: "SESSION_DOES_NOT_EXIST", message: "no session" });
      if (req.method === "DELETE") {
        s.status = "REVOKED";
        return this.json(200, {});
      }
      return this.json(200, {
        status: s.status,
        accounts: [...s.uids.keys()],
        accounts_data: [...s.uids.entries()].map(([uid, h]) =>
          this.accountResource(uid, this.accounts.find((a) => a.identificationHash === h) as FakeBankAccount),
        ),
        access: { valid_until: s.validUntil },
      });
    }
    if (req.method === "GET" && parts[0] === "accounts" && parts[1]) {
      const hit = this.accountByUid(parts[1]);
      if (!hit) return this.json(404, { code: 404, error: "ACCOUNT_DOES_NOT_EXIST", message: "unknown uid" });
      if (hit.session.status !== "AUTHORIZED")
        return this.json(401, { code: 401, error: "EXPIRED_SESSION", message: "session expired" });
      if (parts[2] === "balances") {
        return this.json(200, {
          balances: hit.account.balance
            ? [{ name: "Booked", balance_amount: hit.account.balance, balance_type: "CLBD" }]
            : [],
        });
      }
      if (parts[2] === "transactions") {
        const from = url.searchParams.get("date_from") ?? "0000-00-00";
        const floor = this.historyFrom && this.historyFrom > from ? this.historyFrom : from;
        const rows = hit.account.transactions.filter((t) => {
          const d = t.booking_date ?? t.transaction_date ?? t.value_date ?? "9999-12-31";
          return d >= floor;
        });
        const offset = Number(url.searchParams.get("continuation_key") ?? "0");
        const page = rows.slice(offset, offset + this.pageSize);
        const next = offset + this.pageSize < rows.length ? String(offset + this.pageSize) : null;
        return this.json(200, { transactions: page, continuation_key: next });
      }
    }
    return this.json(404, { code: 404, error: "NOT_FOUND", message: `${req.method} ${url.pathname}` });
  }
}

/** A booked feed row with sensible defaults. */
export function ebRow(over: Partial<EbTransaction> & { amount?: string; date?: string } = {}): EbTransaction {
  const { amount, date, ...rest } = over;
  const amt = amount ?? "100.00";
  const neg = amt.startsWith("-");
  return {
    entry_reference: `ER-${Math.random().toString(36).slice(2, 10)}`,
    transaction_id: `tid-${Math.random().toString(36).slice(2, 10)}`,
    status: "BOOK",
    credit_debit_indicator: neg ? "DBIT" : "CRDT",
    transaction_amount: { currency: "EUR", amount: neg ? amt.slice(1) : amt },
    booking_date: date ?? "2026-10-01",
    value_date: date ?? "2026-10-01",
    remittance_information: ["Zahlung"],
    ...rest,
  };
}
