"use client";

import { ConvexBetterAuthProvider } from "@convex-dev/better-auth/react";
import { useConvexAuth } from "convex/react";
import * as React from "react";
import { authClient } from "@/lib/auth-client";
import { getConvexClient } from "@/lib/convex-client";

const ConvexAvailable = React.createContext(false);

/**
 * The provider types `authClient` against a generic plugin list; with our concrete plugins (passkey, emailOTP,
 * twoFactor) the inferred `useSession().data` no longer matches (`never`). Runtime shape is identical.
 */
const providerAuthClient = authClient as unknown as React.ComponentProps<typeof ConvexBetterAuthProvider>["authClient"];

/**
 * Convex + Better Auth (02 §4.2): `ConvexBetterAuthProvider` keeps the Convex JWT of the Better Auth session on
 * the client and refreshes it (15 min). Server and browser render the same tree (see getConvexClient); without
 * NEXT_PUBLIC_CONVEX_URL the children render without Convex; components that need it are wrapped in <ConvexGuard>.
 */
export function ConvexClientProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => getConvexClient());
  if (!client) return <ConvexAvailable.Provider value={false}>{children}</ConvexAvailable.Provider>;
  return (
    <ConvexAvailable.Provider value={true}>
      <ConvexBetterAuthProvider client={client} authClient={providerAuthClient}>
        {children}
      </ConvexBetterAuthProvider>
    </ConvexAvailable.Provider>
  );
}

export function useConvexAvailable(): boolean {
  return React.useContext(ConvexAvailable);
}

/**
 * Renders `children` only in the browser with a Convex client (after hydration, so server and client markup
 * match); otherwise `fallback`.
 */
export function ConvexGuard({ children, fallback = null }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const available = useConvexAvailable();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return <>{mounted && available ? children : fallback}</>;
}

/** Signed in towards Convex (the JWT is set): queries can run. */
export function useBackendAuth(): { isLoading: boolean; isAuthenticated: boolean } {
  return useConvexAuth();
}
