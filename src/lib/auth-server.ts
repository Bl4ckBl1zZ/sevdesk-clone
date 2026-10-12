import "server-only";
import { api } from "@convex/_generated/api";
import { convexBetterAuthNextJs } from "@convex-dev/better-auth/nextjs";
import { redirect } from "next/navigation";
import type { Permission } from "@/domain/access/permissions";
import { type CurrentMember, checkAccess } from "./auth-access";

/**
 * Server-side Better Auth helpers for Next (02 §4.1/§4.2). `web` talks to Convex over the internal network:
 * CONVEX_URL_INTERNAL (backend:3210) and CONVEX_SITE_URL_INTERNAL (backend:3211, Better Auth HTTP actions).
 *
 *   const token = await getToken();                     // Convex JWT of the current session (or undefined)
 *   const me = await requireSession();                  // Server Component: redirects to /anmelden if signed out
 *   const me = await requireRole("members.manage");     // Server Action / page: throws AccessError (German message)
 *   await fetchAuthMutation(api.invites.create, {...}); // Convex call with the session token
 *
 * These checks are a convenience for rendering; Convex re-checks role/permission in every function.
 */
type Helpers = ReturnType<typeof convexBetterAuthNextJs>;
let helpers: Helpers | undefined;

const siteUrlInternal = () => process.env.CONVEX_SITE_URL_INTERNAL ?? process.env.NEXT_PUBLIC_CONVEX_SITE_URL;

function auth(): Helpers {
  if (!helpers) {
    const convexUrl = process.env.CONVEX_URL_INTERNAL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
    const convexSiteUrl = siteUrlInternal();
    if (!convexUrl) throw new Error("CONVEX_URL_INTERNAL fehlt.");
    helpers = convexBetterAuthNextJs({ convexUrl, convexSiteUrl: convexSiteUrl ?? "" });
  }
  return helpers;
}

/** Route handler for src/app/api/auth/[...all]/route.ts (proxies to Better Auth in Convex). */
export const handler = {
  GET: (request: Request) => auth().handler.GET(request),
  POST: (request: Request) => auth().handler.POST(request),
};

export const getToken: Helpers["getToken"] = () => auth().getToken();
export const isAuthenticated: Helpers["isAuthenticated"] = () => auth().isAuthenticated();
export const fetchAuthQuery: Helpers["fetchAuthQuery"] = (query, ...args) => auth().fetchAuthQuery(query, ...args);
export const fetchAuthMutation: Helpers["fetchAuthMutation"] = (mutation, ...args) =>
  auth().fetchAuthMutation(mutation, ...args);
export const fetchAuthAction: Helpers["fetchAuthAction"] = (action, ...args) => auth().fetchAuthAction(action, ...args);
export const preloadAuthQuery: Helpers["preloadAuthQuery"] = (query, ...args) =>
  auth().preloadAuthQuery(query, ...args);

/** Thrown by `requireRole` when the member may not perform the action; `message` is German UI text. */
export class AccessError extends Error {
  constructor(
    readonly code: "member_expired" | "forbidden_role",
    message: string,
  ) {
    super(message);
    this.name = "AccessError";
  }
}

async function currentMember(): Promise<CurrentMember | null> {
  if (!(await isAuthenticated())) return null;
  try {
    return (await fetchAuthQuery(api.members.me, {})) as CurrentMember | null;
  } catch {
    // not a member / disabled / session revoked → treat as signed out
    return null;
  }
}

/** The signed-in member, or a redirect to /anmelden. */
export async function requireSession(weiter?: string): Promise<CurrentMember> {
  const member = await currentMember();
  if (!member) redirect(weiter ? `/anmelden?weiter=${encodeURIComponent(weiter)}` : "/anmelden");
  return member;
}

/**
 * Role/permission check for Server Components and every Server Action (replaces the former assertGate()).
 * Signed out → redirect to /anmelden; expired or forbidden → AccessError.
 * TOTP (02 §4.2): an e-mail-code sign-in of a member with TOTP creates no session until `twoFactor.verifyTotp`
 * succeeded (convex/auth.ts `totpForEmailCodeSignIns`), so a "TOTP-pending" caller is simply signed out here.
 */
export async function requireRole(permission: Permission): Promise<CurrentMember> {
  const decision = checkAccess(await currentMember(), permission, Date.now());
  if (decision.ok) return decision.member;
  if (decision.reason === "unauthenticated") redirect("/anmelden");
  throw new AccessError(decision.reason, decision.message);
}

/**
 * 02 §4.3 / 04 §4.9: true while no user exists ("Ersteinrichtung" on /anmelden). Read from the Better Auth endpoint
 * `GET /api/auth/rechnungen/first-run` on the internal site URL — no public Convex function, no admin key in `web`.
 * Fails safe: unreachable backend → false (the notice is hidden; the sign-up gate is enforced server-side anyway).
 */
export async function isFirstRun(): Promise<boolean> {
  const base = siteUrlInternal();
  if (!base) return false;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/auth/rechnungen/first-run`, {
      cache: "no-store",
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return false;
    return ((await res.json()) as { firstRun?: unknown }).firstRun === true;
  } catch {
    return false;
  }
}
