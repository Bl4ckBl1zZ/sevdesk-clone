/**
 * Architecture boundary rules (02 §3 "Dependency rules", CLAUDE.md §2/§3/§5). Pure: operates on a
 * repo-relative path and the file's source text. The CLI is scripts/check-boundaries.ts.
 */
import { builtinModules } from "node:module";
import { posix } from "node:path";

export interface Violation {
  file: string;
  line: number;
  rule: string;
  message: string;
}

const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** Only these folders may call ctx.db.insert/patch/replace/delete (GOBD-06, 02 §3). */
const DB_WRITE_ALLOWED = [/^convex\/model\//, /^convex\/betterAuth\//];
/** Tests may seed data directly through convex-test's `t.run(ctx => ctx.db.insert(...))`. */
const isTestFile = (f: string) => /\.(test|spec)\.tsx?$/.test(f) || f === "convex/test.setup.ts";

const DB_WRITE_RE = /\bdb\s*\.\s*(insert|patch|replace|delete)\s*\(/g;
const IMPORT_RE =
  /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g;

/** Non-deterministic globals forbidden in src/domain (all "now" values are passed in). */
const DOMAIN_IMPURE: Array<[RegExp, string]> = [
  [/\bDate\.now\s*\(/g, "Date.now() — pass `today`/`now` in"],
  [/\bnew\s+Date\s*\(\s*\)/g, "new Date() without arguments — pass `today`/`now` in"],
  [/\bMath\.random\s*\(/g, "Math.random() — inject randomness"],
  [/\bfetch\s*\(/g, "fetch() — no I/O in the domain layer"],
  [/\bprocess\.env\b/g, "process.env — configuration is passed in"],
];

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Strips // and /* *\/ comments while keeping offsets (so line numbers stay correct). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\/|(^|[^:"'`\\])\/\/[^\n]*/g, (m, prefix: string | undefined) => {
    const keep = prefix ?? "";
    return keep + m.slice(keep.length).replace(/[^\n]/g, " ");
  });
}

/** Resolves an import specifier to a repo-relative path, or null for packages. */
export function resolveSpecifier(file: string, spec: string): string | null {
  if (spec.startsWith("@/")) return posix.join("src", spec.slice(2));
  if (spec.startsWith("@convex/")) return posix.join("convex", spec.slice(8));
  if (spec.startsWith("@test/")) return posix.join("test", spec.slice(6));
  if (spec.startsWith(".")) return posix.normalize(posix.join(posix.dirname(file), spec));
  return null;
}

const pkgName = (spec: string) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : (spec.split("/")[0] ?? spec);

export function checkSource(file: string, rawSource: string): Violation[] {
  const out: Violation[] = [];
  const source = stripComments(rawSource);
  const add = (index: number, rule: string, message: string) =>
    out.push({ file, line: lineOf(source, index), rule, message });

  const inDomain = file.startsWith("src/domain/");
  const inConvex = file.startsWith("convex/") && !file.startsWith("convex/_generated/");
  const inSrc = file.startsWith("src/");
  const test = isTestFile(file);

  // ── 1. db writes only in convex/model/** (+ convex/betterAuth/**) ──────────────
  if (!test && !DB_WRITE_ALLOWED.some((re) => re.test(file)) && !file.startsWith("scripts/")) {
    for (const m of source.matchAll(DB_WRITE_RE)) {
      add(
        m.index ?? 0,
        "db-write-outside-model",
        `ctx.db.${m[1]}() is only allowed in convex/model/** (GOBD-06, CLAUDE.md §3)`,
      );
    }
  }

  // ── 2. imports ─────────────────────────────────────────────────────────────────
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec) continue;
    const idx = m.index ?? 0;
    const target = resolveSpecifier(file, spec);

    if (inDomain) {
      if (target !== null && !target.startsWith("src/domain/") && !(test && target.startsWith("test/"))) {
        add(idx, "domain-purity", `src/domain may only import src/domain (got "${spec}")`);
      }
      if (target === null) {
        const pkg = pkgName(spec);
        if (["react", "react-dom", "next", "convex", "convex-helpers", "convex-test", "server-only"].includes(pkg)) {
          add(idx, "domain-purity", `src/domain must not import "${spec}" (02 §3)`);
        } else if (pkg.startsWith("@convex-dev/") || pkg.startsWith("@react-pdf/") || pkg === "better-auth") {
          add(idx, "domain-purity", `src/domain must not import "${spec}" (02 §3)`);
        } else if (NODE_BUILTINS.has(spec) && !test) {
          add(idx, "domain-purity", `src/domain has no Node I/O ("${spec}")`);
        }
      }
    }

    if (inSrc && target?.startsWith("convex/") && !target.startsWith("convex/_generated/")) {
      add(idx, "src-imports-convex", `src/** may only import convex/_generated/** (got "${spec}")`);
    }

    if (inConvex && target?.startsWith("src/")) {
      const allowed = ["src/domain/", "src/pdf/", "src/emails/"].some((p) => target.startsWith(p));
      if (!allowed)
        add(idx, "convex-imports-src", `convex/** may import only src/domain, src/pdf, src/emails (got "${spec}")`);
    }
  }

  // ── 3. determinism in src/domain ───────────────────────────────────────────────
  if (inDomain && !test) {
    for (const [re, msg] of DOMAIN_IMPURE) {
      for (const m of source.matchAll(re)) add(m.index ?? 0, "domain-determinism", msg);
    }
  }

  return out;
}
