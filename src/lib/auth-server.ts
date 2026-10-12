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

function auth(): Helpers {
  if (!helpers) {
    const convexUrl = process.env.CONVEX_URL_INTERNAL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
    const convexSiteUrl = process.env.CONVEX_SITE_URL_INTERNAL;
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
 * TODO(P0 follow-up, 02 §4.2): reject TOTP-pending sessions with `totp_required` (see docs/adr/0002).
 */
export async function requireRole(permission: Permission): Promise<CurrentMember> {
  const decision = checkAccess(await currentMember(), permission, Date.now());
  if (decision.ok) return decision.member;
  if (decision.reason === "unauthenticated") redirect("/anmelden");
  throw new AccessError(decision.reason, decision.message);
}
