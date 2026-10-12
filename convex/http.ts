import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

/**
 * HTTP actions on the site origin (02 §4.1: `convex-site.` → backend:3211). Only Better Auth is mounted:
 * `/api/auth/*` (proxied by Next from `app.`) and `/api/auth/convex/jwks`. No other HTTP actions are public.
 */
const http = httpRouter();

authComponent.registerRoutes(http, createAuth);

export default http;
