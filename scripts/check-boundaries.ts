/**
 * Lint step: architecture boundaries (02 §3). Run by `pnpm lint` after Biome.
 * Biome also restricts some imports in src/domain (biome.json overrides) for editor feedback;
 * this script is the authoritative check.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { checkSource } from "./boundaries";

const ROOT = join(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "_generated", ".next", ".git", "coverage"]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

const files = ["src", "convex"].flatMap((d) => walk(join(ROOT, d)));
const violations = files.flatMap((f) => checkSource(relative(ROOT, f).split(sep).join("/"), readFileSync(f, "utf8")));

for (const v of violations) console.error(`${v.file}:${v.line}  ${v.rule}  ${v.message}`);
if (violations.length) {
  console.error(`\n✖ ${violations.length} boundary violation(s)`);
  process.exit(1);
}
console.log(`✔ boundaries ok (${files.length} files)`);
