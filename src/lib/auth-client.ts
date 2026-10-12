"use client";

import { passkeyClient } from "@better-auth/passkey/client";
import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { emailOTPClient, twoFactorClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/**
 * Better Auth browser client (02 §4.2, F01 §3.1). Requests go to `/api/auth/*` on the app origin
 * (src/app/api/auth/[...all]/route.ts proxies them to the Convex HTTP actions). No passwords exist.
 *
 * Sign-in with an e-mail code (OTP: 6 digits, valid 10 min, max 5 per hour per address):
 *   const { error } = await authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" });
 *     error.status 403 → address not allowed (bootstrap: only OWNER_EMAIL; afterwards invite-only;
 *                        expired/disabled member). error.message is the German text to show.
 *     error.status 429 → throttled ("Zu viele Codes angefordert — bitte in N Minuten erneut versuchen.")
 *     error.status 503 → mail could not be sent ("Code konnte nicht gesendet werden — …")
 *   const { data, error } = await authClient.signIn.emailOtp({ email, otp });
 *     First sign-in of OWNER_EMAIL creates the owner; an invited address joins with the invite's role.
 *     data.twoFactorRedirect === true → TOTP required: authClient.twoFactor.verifyTotp({ code, trustDevice? }).
 *
 * Passkeys (RP ID = BASE_DOMAIN, so app. and the portal share them):
 *   await authClient.signIn.passkey();                       // button
 *   await authClient.signIn.passkey({ autoFill: true });     // conditional UI on the e-mail field
 *                                                             //   (input needs autoComplete="username webauthn")
 *   await authClient.passkey.addPasskey({ name? });          // after sign-in (settings / onboarding)
 *   authClient.useListPasskeys(); authClient.passkey.deletePasskey({ id });
 *
 * Optional TOTP (passwordless accounts, `allowPasswordless`):
 *   authClient.twoFactor.enable({})            → { totpURI, backupCodes }  (render totpURI as QR code)
 *   authClient.twoFactor.verifyTotp({ code })  → confirms setup / completes a 2FA sign-in
 *   authClient.twoFactor.disable({})
 *
 * Session:
 *   const { data: session, isPending } = authClient.useSession();   // user + session, no role
 *   await authClient.signOut();                                      // then router.push("/anmelden")
 *   Role, expiry and TOTP mirror come from Convex: useQuery(api.members.me).
 *
 * Convex: wrap the app in <ConvexBetterAuthProvider client={convex} authClient={authClient}> from
 * "@convex-dev/better-auth/react"; the convexClient() plugin provides the Convex JWT (`authClient.convex.token()`).
 */
export const authClient = createAuthClient({
  ...(process.env.NEXT_PUBLIC_SITE_URL ? { baseURL: process.env.NEXT_PUBLIC_SITE_URL } : {}),
  plugins: [convexClient(), passkeyClient(), emailOTPClient(), twoFactorClient()],
});

export type AuthClient = typeof authClient;
