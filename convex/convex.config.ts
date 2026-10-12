import rateLimiter from "@convex-dev/rate-limiter/convex.config";
import { defineApp } from "convex/server";
import betterAuth from "./betterAuth/convex.config";

/**
 * Convex app definition.
 * - betterAuth: Local Install of @convex-dev/better-auth (02 §4.2; schema in convex/betterAuth/).
 * - rateLimiter: OTP throttle per e-mail address (02 §4.2) and, later, per API key.
 */
const app = defineApp();
app.use(betterAuth);
app.use(rateLimiter);

export default app;
