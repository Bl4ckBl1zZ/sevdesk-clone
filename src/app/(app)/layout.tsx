import { SessionProvider } from "@/components/auth/session-provider";

/**
 * Signed-in area. `proxy.ts` redirects requests without a session cookie to /anmelden (optimistic); the
 * authoritative checks happen in Server Components, Server Actions and Convex (02 §4.1).
 * TODO(auth branch): wrap in ConvexBetterAuthProvider once the Convex client exists.
 */
export default function SignedInLayout({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
