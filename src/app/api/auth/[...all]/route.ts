/** Better Auth endpoints on the app origin, proxied to the Convex HTTP actions (02 §4.1). */
import { handler } from "@/lib/auth-server";

export const { GET, POST } = handler;
