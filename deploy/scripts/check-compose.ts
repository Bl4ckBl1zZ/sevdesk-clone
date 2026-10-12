/**
 * `pnpm lint:deploy` — lints the production compose file (08 §3.1, SEC-01). Exit code 1 on any violation.
 * Usage: tsx deploy/scripts/check-compose.ts [compose-file …]   (default: deploy/compose/docker-compose.yml)
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";
import { lintCompose } from "./compose-lint";

const ROOT = join(import.meta.dirname, "..", "..");
const files = process.argv.slice(2);
if (files.length === 0) files.push(join(ROOT, "deploy/compose/docker-compose.yml"));

let failed = 0;
for (const file of files) {
  const violations = lintCompose(parse(readFileSync(file, "utf8")));
  const name = relative(process.cwd(), file);
  for (const v of violations) console.error(`${name}  ${v.service ?? "-"}  ${v.rule}  ${v.message}`);
  if (violations.length) failed += violations.length;
  else console.info(`✔ ${name}: only caddy is published, images pinned, Convex flags sane`);
}
if (failed) {
  console.error(`\n✖ ${failed} compose violation(s)`);
  process.exit(1);
}
