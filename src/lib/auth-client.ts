// TEMP (ui branch) — replaced by the convex/auth branch
import { passkeyClient } from "@better-auth/passkey/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { emailOTPClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/** Better Auth browser client (02 §4.2): passkey first, e-mail OTP fallback, Convex JWT bridge. */
export const authClient = createAuthClient({
  plugins: [passkeyClient(), emailOTPClient(), convexClient()],
});
