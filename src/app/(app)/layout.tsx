import { api } from "@convex/_generated/api";
import type { Route } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { FreshActionProvider } from "@/components/auth/fresh-action";
import { SessionProvider } from "@/components/auth/session-provider";
import { fetchAuthQuery, requireSession } from "@/lib/auth-server";

/** F01 SET-001: routes reachable before the setup is complete. */
const BEFORE_SETUP = [
  /^\/einrichtung(\/|\?|$)/,
  /^\/einstellungen(\/|\?|$)/,
  /^\/kontakte(\/|\?|$)/,
  /^\/produkte(\/|\?|$)/,
  /^\/konto(\/|\?|$)/,
];

/**
 * Signed-in area. `proxy.ts` only redirects optimistically (cookie present); this layout checks the session and
 * the member authoritatively for every page (02 §4.1 step 5) and sends the owner to the setup wizard until the
 * setup is complete (F01 SET-001). Convex re-checks role and permission in every function.
 */
export default async function SignedInLayout({ children }: { children: React.ReactNode }) {
  const path = (await headers()).get("x-pathname") ?? "/";
  const me = await requireSession(path);
  if (me.role === "owner" && !BEFORE_SETUP.some((re) => re.test(path))) {
    const status = await fetchAuthQuery(api.settings.setupStatus, {}).catch(() => null);
    if (status && !status.setupCompleted) redirect("/einrichtung" as Route);
  }
  return (
    <SessionProvider>
      <FreshActionProvider>{children}</FreshActionProvider>
    </SessionProvider>
  );
}
