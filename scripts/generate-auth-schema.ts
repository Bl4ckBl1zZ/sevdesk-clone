/**
 * Regenerates convex/betterAuth/generatedSchema.ts from the Better Auth options in convex/auth.ts
 * (Local Install, research 14 §1.5) — the equivalent of `npx auth generate` without the extra CLI dependency.
 *
 *   pnpm auth:schema
 *
 * Run after changing Better Auth plugins, then `pnpm convex codegen` and commit both.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAuthTables } from "better-auth/db";
import { createAuthOptions } from "../convex/auth";

const root = join(import.meta.dirname, "..");
const file = "convex/betterAuth/generatedSchema.ts";

// biome-ignore lint/suspicious/noExplicitAny: static options without a Convex ctx
const options = createAuthOptions({} as any);
const adapter = options.database(options);
if (!adapter.createSchema) throw new Error("the Convex adapter has no createSchema");
const tables = getAuthTables(options);
const process_cwd = process.cwd();
process.chdir(join(root, "convex/betterAuth"));
// The Convex adapter implements createSchema({ file, tables }); Better Auth's type declares (options, file).
const createSchema = adapter.createSchema as unknown as (a: {
  file: string;
  tables: typeof tables;
}) => Promise<{ code: string }>;
const result = await createSchema({ file: "generatedSchema.ts", tables });
process.chdir(process_cwd);
const code = result.code.replace(/ \* {3}cd convex\/betterAuth\n \* {3}npx auth generate/, " *   pnpm auth:schema");
writeFileSync(join(root, file), code);
console.log(`wrote ${file} (${Object.keys(tables).length} tables: ${Object.keys(tables).join(", ")})`);
