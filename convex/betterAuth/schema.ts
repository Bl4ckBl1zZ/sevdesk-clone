import { defineSchema } from "convex/server";
import { tables } from "./generatedSchema";

/**
 * Better Auth component schema (Local Install, 02 §4.2). `generatedSchema.ts` is generated from our Better Auth
 * options by `pnpm auth:schema` (scripts/generate-auth-schema.ts) — never edit it by hand; regenerate after
 * changing plugins in convex/auth.ts. Custom indexes go here.
 */
const schema = defineSchema({
  ...tables,
  // The passkey plugin looks credentials up by credentialID (`index: true` in its schema; the generator skips it).
  passkey: tables.passkey.index("credentialID", ["credentialID"]),
});

export default schema;
