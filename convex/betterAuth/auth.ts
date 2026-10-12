import { createAuth } from "../auth";

/** Static Better Auth instance for schema generation and client type inference (`inferAdditionalFields`). */
// biome-ignore lint/suspicious/noExplicitAny: the static instance has no Convex ctx by design
export const auth = createAuth({} as any);
