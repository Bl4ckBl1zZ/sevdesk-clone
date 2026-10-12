import { defineApp } from "convex/server";

/**
 * Convex app definition. Components are registered here, e.g.
 *   import rateLimiter from "@convex-dev/rate-limiter/convex.config";
 *   import betterAuth from "./betterAuth/convex.config"; // Local Install (02 §2)
 *   app.use(rateLimiter); app.use(betterAuth);
 */
const app = defineApp();

export default app;
